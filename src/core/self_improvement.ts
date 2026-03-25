/**
 * Self-Improvement Engine
 *
 * Runs after each complete cycle to analyze outcomes and generate system improvements.
 * NOT deterministic — uses AI to analyze what worked, what failed, and what to change.
 *
 * Responsibilities:
 *   1. Analyze cycle outcomes (worker results, timeouts, PR quality, retries)
 *   2. Generate improvement proposals via AI (prompt tweaks, config adjustments, strategy changes)
 *   3. Store learnings in knowledge memory (state/knowledge_memory.json)
 *   4. Apply safe improvements automatically (config tuning, prompt hints)
 *   5. Flag risky improvements for human review
 *
 * Reads: selfImprovement config from box.config.json
 * Writes: state/knowledge_memory.json, state/improvement_reports.json
 */

import path from "node:path";
import fs from "node:fs/promises";
import { readJson, readJsonSafe, READ_JSON_REASON, writeJson, spawnAsync } from "./fs_utils.js";
import { appendProgress } from "./state_tracker.js";
import { buildAgentArgs, parseAgentOutput } from "./agent_loader.js";
import { chatLog, warn } from "./logger.js";
import { normalizeDecisionQualityLabel, DECISION_QUALITY_LABEL, PREMORTEM_RISK_LEVEL } from "./athena_reviewer.js";
import { extractPostmortemEntries, migrateData, STATE_FILE_TYPE } from "./schema_registry.js";
import { loadRegistry, getRunningExperimentsForPath } from "./experiment_registry.js";
import { getCanaryConfig, startCanary, processRunningCanaries } from "./canary_engine.js";
import { runShadowEvaluation, SHADOW_STATUS } from "./shadow_policy_evaluator.js";
import {
  enforceGovernance,
  recordApprovalEvidence,
  GOVERNANCE_CONTRACT_VERSION
} from "./governance_contract.js";
import {
  evaluateFreezeGate,
  FREEZE_GATE_RESULT
} from "./governance_freeze.js";
import { isGuardrailActive } from "./guardrail_executor.js";
import { GUARDRAIL_ACTION } from "./catastrophe_detector.js";

// ── Decision Quality Weights ──────────────────────────────────────────────────

/**
 * Explicit weights for each decision quality label.
 * Used to compute a weighted quality score from recent postmortems.
 *
 * correct         = 1.0  — plan succeeded exactly as expected
 * delayed-correct = 0.6  — plan succeeded after an extra iteration
 * incorrect       = 0.0  — plan was executed but result was rolled back
 * inconclusive    = 0.3  — outcome was unknown (timeout, missing data)
 */
export const DECISION_QUALITY_WEIGHTS = Object.freeze({
  [DECISION_QUALITY_LABEL.CORRECT]:         1.0,
  [DECISION_QUALITY_LABEL.DELAYED_CORRECT]: 0.6,
  [DECISION_QUALITY_LABEL.INCORRECT]:       0.0,
  [DECISION_QUALITY_LABEL.INCONCLUSIVE]:    0.3
});

/**
 * Compute a weighted decision quality score from an array of postmortem entries.
 * Returns a value in [0, 1] or null if no entries with labels are present.
 *
 * @param {Array<object>} postmortems
 * @returns {{ score: number|null, labelCounts: Record<string, number>, total: number }}
 */
export function computeWeightedDecisionScore(postmortems) {
  if (!Array.isArray(postmortems) || postmortems.length === 0) {
    return { score: null, labelCounts: {}, total: 0 };
  }
  const labelCounts: Record<string, any> = {};
  for (const label of Object.values(DECISION_QUALITY_LABEL)) {
    labelCounts[label] = 0;
  }
  let weightedSum = 0;
  let count = 0;
  for (const pm of postmortems) {
    const label = normalizeDecisionQualityLabel(pm);
    labelCounts[label] = (labelCounts[label] || 0) + 1;
    weightedSum += DECISION_QUALITY_WEIGHTS[label] ?? DECISION_QUALITY_WEIGHTS[DECISION_QUALITY_LABEL.INCONCLUSIVE];
    count++;
  }
  return {
    score: count > 0 ? weightedSum / count : null,
    labelCounts,
    total: count
  };
}

// ── Outcome Degraded Reason Codes ────────────────────────────────────────────

/**
 * Machine-readable reason codes for degraded outcome collection.
 * Returned in the `degradedReason` field of collectCycleOutcomes when `degraded: true`.
 *
 * Distinguishes missing input (ABSENT) from invalid input (INVALID).
 *
 *   PROMETHEUS_ABSENT   — prometheus_analysis.json not found (ENOENT)
 *   PROMETHEUS_INVALID  — prometheus_analysis.json found but fails structure validation
 *   EVOLUTION_ABSENT    — evolution_progress.json not found (ENOENT)
 *   EVOLUTION_INVALID   — evolution_progress.json found but fails structure validation
 *   NO_ACTIVE_DATA      — both prometheus plans and evolution progress are empty
 */
export const OUTCOME_DEGRADED_REASON = Object.freeze({
  PROMETHEUS_ABSENT:  "PROMETHEUS_ABSENT",
  PROMETHEUS_INVALID: "PROMETHEUS_INVALID",
  EVOLUTION_ABSENT:   "EVOLUTION_ABSENT",
  EVOLUTION_INVALID:  "EVOLUTION_INVALID",
  NO_ACTIVE_DATA:     "NO_ACTIVE_DATA"
});

// shouldTriggerSelfImprovement stub removed — real implementation is below

// ── Pre-mortem Quality Scoring ────────────────────────────────────────────────

/**
 * Explicit scoring rubric for pre-mortem quality.
 * Each key maps to its max points and a description of the pass condition.
 * Total max score: 10 points.
 *
 * Rubric:
 *   scenario        (2 pts) — string with >= 20 chars describing what could go wrong
 *   failurePaths    (2 pts) — array with >= 2 discrete failure modes enumerated
 *   mitigations     (2 pts) — array with >= failurePaths.length mitigation strategies
 *   detectionSignals (1 pt) — array with >= 1 observable failure signal
 *   guardrails      (1 pt)  — array with >= 1 check preventing cascading failure
 *   rollbackPlan    (2 pts) — string with >= 10 chars describing safe rollback
 */
export const PREMORTEM_QUALITY_RUBRIC = Object.freeze({
  scenario:         { maxPoints: 2, description: "scenario string with >= 20 characters" },
  failurePaths:     { maxPoints: 2, description: "failurePaths array with >= 2 items" },
  mitigations:      { maxPoints: 2, description: "mitigations array with >= failurePaths.length items" },
  detectionSignals: { maxPoints: 1, description: "detectionSignals array with >= 1 item" },
  guardrails:       { maxPoints: 1, description: "guardrails array with >= 1 item" },
  rollbackPlan:     { maxPoints: 2, description: "rollbackPlan string with >= 10 characters" }
});

/** Maximum possible pre-mortem quality score. */
export const PREMORTEM_MAX_SCORE = 10;

/**
 * Score a pre-mortem object against the PREMORTEM_QUALITY_RUBRIC.
 * Returns a deterministic score in [0, PREMORTEM_MAX_SCORE].
 *
 * Status values:
 *   "blocked"    — input is null/undefined/not-an-object (score=0)
 *   "inadequate" — score < 6  (fails minimum quality threshold)
 *   "adequate"   — score >= 6 (meets minimum threshold)
 *   "complete"   — score = 10 (all rubric criteria met)
 *
 * @param {unknown} premortem
 * @returns {{ score: number, maxScore: number, scorePercent: number, status: string, details: Array }}
 */
export function scorePremortemQuality(premortem) {
  if (!premortem || typeof premortem !== "object") {
    return { score: 0, maxScore: PREMORTEM_MAX_SCORE, scorePercent: 0, status: "blocked", details: [] };
  }

  let score = 0;
  const details = [];

  // scenario: string >= 20 chars → 2 pts
  const scenarioOk = typeof premortem.scenario === "string" && premortem.scenario.trim().length >= 20;
  details.push({ key: "scenario", pass: scenarioOk, points: scenarioOk ? 2 : 0, maxPoints: 2 });
  if (scenarioOk) score += 2;

  // failurePaths: array >= 2 items → 2 pts
  const fpLen = Array.isArray(premortem.failurePaths) ? premortem.failurePaths.length : 0;
  const failurePathsOk = fpLen >= 2;
  details.push({ key: "failurePaths", pass: failurePathsOk, points: failurePathsOk ? 2 : 0, maxPoints: 2 });
  if (failurePathsOk) score += 2;

  // mitigations: array >= max(1, failurePaths.length) → 2 pts
  const mitLen = Array.isArray(premortem.mitigations) ? premortem.mitigations.length : 0;
  const mitigationsOk = mitLen >= Math.max(1, fpLen);
  details.push({ key: "mitigations", pass: mitigationsOk, points: mitigationsOk ? 2 : 0, maxPoints: 2 });
  if (mitigationsOk) score += 2;

  // detectionSignals: array >= 1 → 1 pt
  const dsOk = Array.isArray(premortem.detectionSignals) && premortem.detectionSignals.length >= 1;
  details.push({ key: "detectionSignals", pass: dsOk, points: dsOk ? 1 : 0, maxPoints: 1 });
  if (dsOk) score += 1;

  // guardrails: array >= 1 → 1 pt
  const grOk = Array.isArray(premortem.guardrails) && premortem.guardrails.length >= 1;
  details.push({ key: "guardrails", pass: grOk, points: grOk ? 1 : 0, maxPoints: 1 });
  if (grOk) score += 1;

  // rollbackPlan: string >= 10 chars → 2 pts
  const rpOk = typeof premortem.rollbackPlan === "string" && premortem.rollbackPlan.trim().length >= 10;
  details.push({ key: "rollbackPlan", pass: rpOk, points: rpOk ? 2 : 0, maxPoints: 2 });
  if (rpOk) score += 2;

  const status = score === PREMORTEM_MAX_SCORE ? "complete"
    : score >= 6 ? "adequate"
    : "inadequate";

  return {
    score,
    maxScore: PREMORTEM_MAX_SCORE,
    scorePercent: Math.round((score / PREMORTEM_MAX_SCORE) * 100),
    status,
    details
  };
}

/**
 * Score all high-risk plan pre-mortems from a Prometheus analysis and persist results.
 *
 * Reads high-risk plans (riskLevel="high") with premortem sections from prometheusAnalysis.
 * Scores each pre-mortem using scorePremortemQuality and appends to state/premortem_scores.json.
 *
 * Storage schema: { scores: [...], lastScoredAt: string }
 * Each score entry: { planIndex, taskId, score, maxScore, scorePercent, status, details, scoredAt }
 *
 * @param {object} config
 * @param {object|null} prometheusAnalysis — result from prometheus_analysis.json
 * @returns {Promise<{ scores: Array, averageScore: number|null }>}
 */
export async function scoreAndStorePremortemQuality(config, prometheusAnalysis) {
  const stateDir = config.paths?.stateDir || "state";

  const plans = Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans : [];
  const highRiskPlans = plans.filter(p =>
    p && typeof p === "object" && p.riskLevel === PREMORTEM_RISK_LEVEL.HIGH && p.premortem
  );

  if (highRiskPlans.length === 0) {
    return { scores: [], averageScore: null };
  }

  const scores = highRiskPlans.map((plan, idx) => ({
    planIndex: idx,
    taskId: plan.taskId || plan.task || `plan-${idx}`,
    ...scorePremortemQuality(plan.premortem),
    scoredAt: new Date().toISOString()
  }));

  // Persist to state/premortem_scores.json — append-only, capped at 200
  const scoresPath = path.join(stateDir, "premortem_scores.json");
  const existing = await readJson(scoresPath, { scores: [], lastScoredAt: null });
  existing.scores.push(...scores);
  if (existing.scores.length > 200) {
    existing.scores = existing.scores.slice(-200);
  }
  existing.lastScoredAt = new Date().toISOString();
  await writeJson(scoresPath, existing);

  const totalScore = scores.reduce((sum, s) => sum + s.score, 0);
  const averageScore = scores.length > 0 ? totalScore / scores.length : null;

  return { scores, averageScore };
}

// ── Knowledge Memory ─────────────────────────────────────────────────────────

async function loadKnowledgeMemory(stateDir) {
  return readJson(path.join(stateDir, "knowledge_memory.json"), {
    lessons: [],
    configTunings: [],
    promptHints: [],
    lastUpdated: null
  });
}

async function saveKnowledgeMemory(stateDir, memory) {
  memory.lastUpdated = new Date().toISOString();
  await writeJson(path.join(stateDir, "knowledge_memory.json"), memory);
}

// ── Cycle Outcome Collector ──────────────────────────────────────────────────

/**
 * Normalized outcome collector — Athena-gated architecture.
 *
 * Primary state sources (replaces stale legacy artifacts):
 *   prometheus_analysis.json  — plans, projectHealth, requestBudget, waves
 *   evolution_progress.json   — completed task IDs
 *   worker_sessions.json      — per-worker status (unchanged)
 *   worker_${role}.json       — per-worker activityLog → dispatches
 *
 * Return contract:
 *   { totalPlans, completedCount, projectHealth, workerOutcomes, waves, dispatches,
 *     requestBudget, decisionQuality, athenaPlanReview, timestamp, metricsSource,
 *     degraded, degradedReason }
 *
 *   degraded:      true when a critical source file is absent or invalid.
 *   degradedReason: OUTCOME_DEGRADED_REASON code or null.
 *   metricsSource: pipe-joined list of files that contributed data.
 *
 * @param {object} config
 * @returns {Promise<object>}
 */
export async function collectCycleOutcomes(config) {
  const stateDir = config.paths?.stateDir || "state";

  // ── Primary state sources (Athena-gated architecture) ────────────────────
  // Use readJsonSafe to distinguish MISSING (ENOENT) from INVALID (parse error).
  const [prometheusResult, evolutionResult] = await Promise.all([
    readJsonSafe(path.join(stateDir, "prometheus_analysis.json")),
    readJsonSafe(path.join(stateDir, "evolution_progress.json"))
  ]);
  const workerSessions = await readJson(path.join(stateDir, "worker_sessions.json"), {});

  // ── Input validation — distinguish missing vs invalid ─────────────────────
  let degraded = false;
  let degradedReason = null;

  let plans = [];
  let projectHealth = "unknown";
  let requestBudget: Record<string, any> = {};
  let waves = [];

  if (!prometheusResult.ok) {
    degraded = true;
    degradedReason = prometheusResult.reason === READ_JSON_REASON.MISSING
      ? OUTCOME_DEGRADED_REASON.PROMETHEUS_ABSENT
      : OUTCOME_DEGRADED_REASON.PROMETHEUS_INVALID;
  } else if (!Array.isArray(prometheusResult.data?.plans)) {
    // File present but missing required `plans` array — treat as invalid structure.
    degraded = true;
    degradedReason = OUTCOME_DEGRADED_REASON.PROMETHEUS_INVALID;
  } else {
    plans = prometheusResult.data.plans;
    projectHealth = prometheusResult.data.projectHealth || "unknown";
    requestBudget = prometheusResult.data.requestBudget || {};
    waves = Array.isArray(prometheusResult.data.executionStrategy?.waves)
      ? prometheusResult.data.executionStrategy.waves
      : [];
  }

  // Derive completed task IDs from evolution_progress.tasks.
  let completedFromEvolution = [];
  if (!evolutionResult.ok) {
    if (!degraded) {
      degraded = true;
      degradedReason = evolutionResult.reason === READ_JSON_REASON.MISSING
        ? OUTCOME_DEGRADED_REASON.EVOLUTION_ABSENT
        : OUTCOME_DEGRADED_REASON.EVOLUTION_INVALID;
    }
  } else if (evolutionResult.data?.tasks !== null && typeof evolutionResult.data?.tasks !== "object") {
    if (!degraded) {
      degraded = true;
      degradedReason = OUTCOME_DEGRADED_REASON.EVOLUTION_INVALID;
    }
  } else {
    const taskMap = evolutionResult.data?.tasks || {};
    completedFromEvolution = Object.entries(taskMap)
      .filter(([, t]) => (t as any).status === "completed" || (t as any).status === "done")
      .map(([id]) => id);
  }

  const completedTasks = completedFromEvolution;

  // ── Determine metrics source ──────────────────────────────────────────────
  const sourceFiles = ["worker_sessions"];
  if (prometheusResult.ok) sourceFiles.unshift("prometheus_analysis");
  if (evolutionResult.ok)  sourceFiles.push("evolution_progress");
  const metricsSource = sourceFiles.join("+");

  // ── Per-worker outcome analysis ───────────────────────────────────────────
  const workerOutcomes = [];
  const workerActivityByRole: Record<string, any> = {};

  for (const [role, session] of Object.entries(workerSessions) as any[]) {
    const workerFile = await readJson(
      path.join(stateDir, `worker_${role.replace(/\s+/g, "_")}.json`),
      null
    );
    const activityLog = Array.isArray(workerFile?.activityLog) ? workerFile.activityLog : [];
    workerActivityByRole[role] = activityLog;

    const lastEntry = activityLog[activityLog.length - 1];
    const timeouts  = activityLog.filter(e => e.status === "timeout").length;
    const failures  = activityLog.filter(e => e.status === "error" || e.status === "failed").length;
    const successes = activityLog.filter(e => e.status === "done").length;
    const totalDispatches = activityLog.length;
    const hasPR = Boolean(lastEntry?.pr);

    workerOutcomes.push({
      role,
      status:          String(session?.status || lastEntry?.status || "unknown"),
      totalDispatches,
      timeouts,
      failures,
      successes,
      hasPR,
      pr:        lastEntry?.pr || null,
      lastError: activityLog.filter(e => e.error).pop()?.error || null
    });
  }

  // ── Build dispatch log from worker activityLog entries ───────────────────
  // Each worker's activityLog is the source of dispatch data.
  const allActivityEntries = [];
  for (const [role, activityLog] of Object.entries(workerActivityByRole)) {
    for (const entry of activityLog) {
      allActivityEntries.push({ role, ...entry });
    }
  }
  const dispatches = allActivityEntries.slice(-20);

  // ── Decision quality from recent postmortems ──────────────────────────────
  let decisionQuality = { score: null, labelCounts: {}, total: 0 };
  try {
    const rawPostmortems = await readJson(path.join(stateDir, "athena_postmortems.json"), null);
    if (rawPostmortems !== null) {
      const migrated = migrateData(rawPostmortems, STATE_FILE_TYPE.ATHENA_POSTMORTEMS);
      if (migrated.ok) {
        const entries = extractPostmortemEntries(migrated.data);
        decisionQuality = computeWeightedDecisionScore(entries.slice(-20));
      }
    }
  } catch { /* no postmortem data — degrade gracefully */ }

  // ── Latest approved/rejected Athena plan review feedback ─────────────────
  let athenaPlanReview = null;
  try {
    const rawPlanReview = await readJson(path.join(stateDir, "athena_plan_review.json"), null);
    if (rawPlanReview && typeof rawPlanReview === "object") {
      athenaPlanReview = {
        approved: rawPlanReview.approved === true,
        overallScore: Number.isFinite(Number(rawPlanReview.overallScore))
          ? Number(rawPlanReview.overallScore)
          : null,
        summary: String(rawPlanReview.summary || ""),
        corrections: Array.isArray(rawPlanReview.corrections)
          ? rawPlanReview.corrections.map((item) => String(item || "").trim()).filter(Boolean)
          : [],
        reviewedAt: rawPlanReview.reviewedAt || null,
      };
    }
  } catch { /* no plan-review data — degrade gracefully */ }

  return {
    totalPlans:      plans.length,
    completedCount:  completedTasks.length,
    projectHealth,
    workerOutcomes,
    waves: waves.map(w => ({
      id: w.id,
      workers: w.workers,
      completedTasks: completedTasks.filter(t =>
        String(t).toLowerCase().includes(String(w.id).toLowerCase())
      )
    })),
    dispatches,
    requestBudget,
    decisionQuality,
    athenaPlanReview,
    timestamp: new Date().toISOString(),
    // Athena-gated metadata fields
    metricsSource,
    degraded,
    degradedReason
  };
}

// ── AI-Driven Analysis ───────────────────────────────────────────────────────

async function analyzeWithAI(config, outcomes, knowledgeMemory) {
  const command = config.env?.copilotCliCommand || "copilot";
  const previousLessons = (knowledgeMemory.lessons || []).slice(-5)
    .map(l => `- [${l.source}] ${l.lesson}`).join("\n") || "None yet.";
  const previousGaps = (knowledgeMemory.capabilityGaps || []).slice(-5)
    .map(g => `- [${g.severity}] ${g.gap} → ${g.proposedFix || "no fix proposed"}`).join("\n") || "None yet.";

  // Load health audit findings if available
  const stateDir = config.paths?.stateDir || "state";
  let healthAuditSection = "";
  try {
    const auditData = JSON.parse(
      await fs.readFile(path.join(stateDir, "health_audit_findings.json"), "utf8")
    );
    if (Array.isArray(auditData?.findings) && auditData.findings.length > 0) {
      healthAuditSection = `\n## JESUS HEALTH AUDIT FINDINGS (hierarchical detection)\n${JSON.stringify(auditData.findings, null, 2)}\nAnalyze these findings — they represent issues that WORKERS and ATHENA missed but JESUS caught.\nFor each finding, determine if the system is MISSING A CAPABILITY that caused the gap.\n`;
    }
  } catch { /* no audit data */ }

  const prompt = `You are the BOX self-improvement analyzer. Your job is to analyze the results of a completed
automation cycle and produce actionable improvements for the next cycle.

## CYCLE OUTCOMES
${JSON.stringify(outcomes, null, 2)}

## DECISION QUALITY SIGNALS (weighted)
Score: ${outcomes.decisionQuality?.score !== null ? (outcomes.decisionQuality.score * 100).toFixed(1) + "%" : "N/A"}
Label counts: ${JSON.stringify(outcomes.decisionQuality?.labelCounts || {})}
Total postmortems analyzed: ${outcomes.decisionQuality?.total || 0}
Weight table: correct=1.0, delayed-correct=0.6, incorrect=0.0, inconclusive=0.3

Use the decision quality score as a weighted signal in your health assessment and next-cycle priorities.
A score below 0.5 (50%) signals systematic execution problems; incorrect labels deserve root-cause analysis.

## PREVIOUS LESSONS LEARNED
${previousLessons}

## PREVIOUSLY DETECTED CAPABILITY GAPS
${previousGaps}
${healthAuditSection}

## ANALYSIS REQUIREMENTS
Analyze the cycle outcomes and produce a JSON response with these fields:

1. "lessons" — Array of objects with { "lesson": string, "source": string, "category": string, "severity": "info"|"warning"|"critical" }
   Categories: "timeout", "prompt-quality", "worker-efficiency", "wave-ordering", "retry-strategy", "config-tuning", "missing-tooling"
   Each lesson should be a concrete, actionable insight. Not generic advice.

2. "configSuggestions" — Array of objects with { "path": string, "currentValue": any, "suggestedValue": any, "reason": string, "autoApply": boolean }
   Only suggest config changes that are SAFE to auto-apply. Set autoApply=true only for:
   - Timeout adjustments within reasonable bounds (5-60 min)
   - Worker retry count changes (1-5)
   - Polling interval changes
   Set autoApply=false for anything that changes system behavior significantly.

3. "promptHints" — Array of objects with { "targetAgent": string, "hint": string, "reason": string }
  These hints will be injected into the next cycle's prompts for the specified agent (trump, athena, or worker names).

4. "workerFeedback" — Array of objects with { "worker": string, "assessment": "excellent"|"good"|"needs-improvement"|"poor", "reason": string, "suggestion": string }

5. "systemHealthScore" — Number 0-100 representing overall cycle health.

6. "nextCyclePriorities" — Array of strings describing what the next cycle should focus on.

7. "capabilityGaps" — CRITICAL: Array of objects describing what the system was STRUCTURALLY MISSING.
   Each object: { "gap": string, "severity": "critical"|"important"|"minor", "capability": string, "proposedFix": string, "appliesToAllRepos": boolean }
   
   Examples of capability gaps:
   - "Workers had no prompt for managing GitHub Actions variables" → proposedFix: "Add GitHub variable management instructions to worker context"
   - "System did not detect stale branches after PR merge" → proposedFix: "Add post-merge branch cleanup to orchestrator"
   - "No worker was assigned GitHub repo settings (branch protection)" → proposedFix: "Add repo-settings task to Noah's capabilities"
   - "Workers couldn't fix CI because they didn't know the failing test" → proposedFix: "Inject CI failure logs into worker context"
   
   IMPORTANT: Think about what went WRONG or what was MISSED in this cycle.
   What problem existed that NO part of the system (workers, Athena, Trump, Jesus) addressed?
   What capability would have prevented the issue?
   Would this gap appear in OTHER repositories too? Set appliesToAllRepos=true if so.

Respond with ONLY valid JSON. No markdown, no explanation before or after.`;

  const args = buildAgentArgs({ agentSlug: "self-improvement", prompt, allowAll: false, noAskUser: true });
  const result: any = await spawnAsync(command, args, { env: process.env });
  const stdout = String(result?.stdout || "");
  const stderr = String(result?.stderr || "");
  const raw = stdout || stderr;

  const parsed = parseAgentOutput(raw);
  if (parsed?.ok && parsed.parsed) {
    return parsed.parsed;
  }

  // Try direct JSON parse from raw
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch { /* fall through */ }
  }

  return null;
}

// ── Apply Safe Improvements ──────────────────────────────────────────────────

/**
 * Apply auto-approved config suggestions and tag each change with active experiment IDs.
 *
 * AC1 enforcement modes:
 *   soft (default): changes are applied and tagged with experiment IDs when available;
 *     a warning is logged if no experiment covers the path, but the change is NOT blocked.
 *   hard: changes are blocked (skipped with explicit warning) if no running experiment
 *     covers the config path. Enable via selfImprovement.experimentEnforcement = "hard".
 *
 * Applied change objects include `experimentIds: string[]` for traceability.
 * Blocked changes include `status: "blocked"` and `blockReason` for observability.
 */
async function applyConfigSuggestions(config, suggestions) {
  if (!Array.isArray(suggestions)) return [];
  const applied = [];
  const configPath = path.join(config.rootDir || ".", "box.config.json");

  let boxConfig;
  try {
    boxConfig = JSON.parse(await fs.readFile(configPath, "utf8"));
  } catch {
    return applied;
  }

  const coreProtected = config.selfImprovement?.coreProtectedModules || [];
  const stateDir = config.paths?.stateDir || "state";

  // ── Shadow policy evaluation before applying any changes (T-017) ──────────
  // Map auto-apply suggestions to shadow change descriptors.
  const shadowChanges = suggestions
    .filter(s => s?.autoApply)
    .map(s => ({
      type:     "config",
      path:     String(s.path || ""),
      oldValue: s.currentValue,
      newValue: s.suggestedValue,
    }));

  let shadowEvalResult = null;
  if (shadowChanges.length > 0) {
    try {
      const shadowPolicy  = config.selfImprovement?.shadowPolicy  || {};
      const currentPolicy = await import("./policy_engine.js").then(m => m.loadPolicy(config));
      shadowEvalResult = await runShadowEvaluation(currentPolicy, shadowChanges, {
        stateDir,
        threshold:   typeof shadowPolicy.threshold   === "number" ? shadowPolicy.threshold   : undefined,
        cycleWindow: typeof shadowPolicy.cycleWindow === "number" ? shadowPolicy.cycleWindow : undefined,
        owner:       "self-improvement",
      });

      const shadowStatus = shadowEvalResult.status;
      if (shadowStatus === SHADOW_STATUS.BLOCKED) {
        warn(`[self-improvement] shadow policy evaluation blocked config promotion — blockReason=${shadowEvalResult.blockReason} delta=${shadowEvalResult.delta}`);
        // Record all candidate changes as shadow-blocked (explicit status, no silent fallback).
        for (const s of suggestions.filter(s => s?.autoApply)) {
          applied.push({
            path:        String(s.path || ""),
            status:      "shadow-blocked",
            blockReason: shadowEvalResult.blockReason,
            shadowEval:  {
              delta:          shadowEvalResult.delta,
              confidence:     shadowEvalResult.confidence,
              sampleSize:     shadowEvalResult.sampleSize,
              successCriteria: shadowEvalResult.successCriteria,
            },
            suggestedValue: s.suggestedValue,
            reason:         s.reason,
          });
        }
        return applied;
      }

      if (shadowStatus === SHADOW_STATUS.DEGRADED) {
        warn(`[self-improvement] shadow policy evaluation degraded — degradedReason=${shadowEvalResult.degradedReason} — proceeding with soft enforcement`);
      }
    } catch (err) {
      // Shadow eval is advisory — a thrown error must not block config application.
      warn(`[self-improvement] shadow policy evaluation error (non-fatal): ${String(err?.message || err)}`);
    }
  }

  // ── Governance contract enforcement (T-031) ───────────────────────────────
  // Load policy once for governance classification of all config changes.
  let governancePolicy;
  try {
    governancePolicy = await import("./policy_engine.js").then(m => m.loadPolicy(config));
  } catch {
    // Non-fatal: policy unavailable → governance classification uses safe defaults
    governancePolicy = {};
  }

  // AC1: load registry once; mode is "soft" unless explicitly set to "hard"
  const enforcementMode = config.selfImprovement?.experimentEnforcement === "hard" ? "hard" : "soft";
  let registry;
  try {
    registry = await loadRegistry(stateDir);
  } catch {
    // Registry not yet initialised — treat as empty; soft mode continues normally
    registry = { schemaVersion: 1, experiments: [] };
  }

  // AC1: determine if canary routing is enabled for staged config changes
  const canaryConfig = getCanaryConfig(config);

  for (const suggestion of suggestions) {
    if (!suggestion.autoApply) continue;

    const configKey = String(suggestion.path || "");

    // Safety: never auto-modify core protected paths
    if (coreProtected.some(mod => configKey.includes(mod))) continue;

    // Safety: only allow specific known-safe config paths
    const safeConfigPaths = [
      "workerTimeoutMinutes",
      "maxRetries",
      "workers.pollIntervalMs",
      "planner.stalledWaveEscalationCycles",
      "systemGuardian.staleWorkerMinutes",
      "systemGuardian.cooldownMinutes"
    ];
    if (!safeConfigPaths.some(safe => configKey.includes(safe))) continue;

    // ── Governance enforcement gate (T-031) ─────────────────────────────────
    // Classify risk and hard-block high/critical changes without dual approval.
    const governanceChange = {
      riskScore:    0.3, // config suggestions via self-improvement are generally low/medium risk
      changeType:   "config",
      filesChanged: [configPath]
    };
    const approvalEvidence = suggestion.approvalEvidence || {};
    const govResult = enforceGovernance(governanceChange, approvalEvidence, governancePolicy);
    if (!govResult.ok) {
      // Hard-block — no silent fallback (AC3, AC10 resolved)
      warn(`[self-improvement] governance contract hard-blocked config change at ${configKey} — ${govResult.blockReason}`);
      applied.push({
        path:        configKey,
        status:      "governance-blocked",
        blockReason: govResult.blockReason,
        riskLevel:   govResult.riskLevel,
        suggestedValue: suggestion.suggestedValue,
        reason:      suggestion.reason
      });
      continue;
    }

    // AC1: tag with running experiment IDs covering this config path
    const experimentIds = getRunningExperimentsForPath(registry, configKey);

    if (enforcementMode === "hard" && experimentIds.length === 0) {
      // Hard mode: block the change and record it with an explicit status
      warn(`[self-improvement] hard enforcement blocked config change at ${configKey} — no running experiment covers this path`);
      applied.push({
        path: configKey,
        status: "blocked",
        blockReason: "NO_EXPERIMENT_COVERAGE",
        experimentIds: [],
        suggestedValue: suggestion.suggestedValue,
        reason: suggestion.reason
      });
      continue;
    }

    if (experimentIds.length === 0) {
      // Soft mode: log warning but apply
      warn(`[self-improvement] no experiment covers config path ${configKey} — applying without experiment tag (soft enforcement)`);
    }

    // AC1 / T-022: route through canary when enabled (staged rollout before global promotion)
    if (canaryConfig.enabled) {
      // Resolve current (control) value from the in-memory boxConfig for provenance
      const keys = configKey.split(".");
      let   ctrl = boxConfig;
      for (const k of keys) {
        ctrl = (ctrl && typeof ctrl === "object") ? ctrl[k] : undefined;
      }
      const controlValue = ctrl;

      const primaryExperimentId = experimentIds.length > 0 ? experimentIds[0] : null;
      try {
        const canaryResult = await startCanary(
          config, configKey, controlValue, suggestion.suggestedValue, primaryExperimentId
        );
        if (canaryResult.ok) {
          applied.push({
            path:          configKey,
            status:        "canary_started",
            canaryId:      canaryResult.canaryId,
            controlValue,
            canaryValue:   suggestion.suggestedValue,
            reason:        suggestion.reason,
            experimentIds
          });
          continue;
        }
        // If canary is ALREADY_RUNNING for this path, fall through to direct apply
        if (canaryResult.status !== "ALREADY_RUNNING") {
          warn(`[self-improvement] canary start failed for ${configKey}: ${canaryResult.status}`);
          applied.push({
            path:         configKey,
            status:       "canary_start_failed",
            failReason:   canaryResult.status,
            experimentIds,
            suggestedValue: suggestion.suggestedValue,
            reason:       suggestion.reason
          });
          continue;
        }
      } catch (err) {
        warn(`[self-improvement] canary routing error for ${configKey}: ${String(err?.message || err)}`);
        // Fall through to direct apply on unexpected error
      }
    }

    // Direct apply (canary disabled, or canary already running for this path)
    const keys = configKey.split(".");
    let target = boxConfig;
    for (let i = 0; i < keys.length - 1; i++) {
      if (target && typeof target === "object" && keys[i] in target) {
        target = target[keys[i]];
      } else {
        target = null;
        break;
      }
    }

    if (target && typeof target === "object") {
      const lastKey = keys[keys.length - 1];
      const oldValue = target[lastKey];
      target[lastKey] = suggestion.suggestedValue;

      const appliedEntry = {
        path: configKey,
        status: "applied",
        oldValue,
        newValue: suggestion.suggestedValue,
        reason: suggestion.reason,
        experimentIds,
        riskLevel: govResult.riskLevel,
        shadowEval: shadowEvalResult ? {
          delta:           shadowEvalResult.delta,
          confidence:      shadowEvalResult.confidence,
          sampleSize:      shadowEvalResult.sampleSize,
          successCriteria: shadowEvalResult.successCriteria,
        } : null,
      };
      applied.push(appliedEntry);

      // Record approval evidence for audit (T-031 AC4)
      const evidence = {
        changeId:        `si-${Date.now()}-${configKey.replace(/[^a-z0-9]/gi, "_")}`,
        changedBy:       "self-improvement",
        changedAt:       new Date().toISOString(),
        riskLevel:       govResult.riskLevel,
        filesChanged:    [configPath],
        approvals:       Array.isArray(approvalEvidence.approvals) ? approvalEvidence.approvals : [],
        contractVersion: GOVERNANCE_CONTRACT_VERSION
      };
      recordApprovalEvidence(evidence, config).catch(err => {
        warn(`[self-improvement] approval evidence record failed (non-fatal): ${String(err?.message || err)}`);
      });
    }
  }

  const actuallyApplied = applied.filter(c => c.status === "applied");
  if (actuallyApplied.length > 0) {
    await fs.writeFile(configPath, JSON.stringify(boxConfig, null, 2) + "\n", "utf8");
  }

  return applied;
}

// ── Main Self-Improvement Cycle ──────────────────────────────────────────────

// ── Monthly Postmortem Generator ─────────────────────────────────────────────

/**
 * Risk: MEDIUM (mislabeled "low" in original task brief).
 * A faulty postmortem that corrupts next-quarter strategy seeds is a medium-risk outcome.
 * All generated output is validated before write; status="degraded" when data is partial.
 */

/**
 * Status values for a monthly postmortem document.
 * @enum {string}
 */
export const MONTHLY_POSTMORTEM_STATUS = Object.freeze({
  OK:                "ok",
  INSUFFICIENT_DATA: "insufficient_data",
  DEGRADED:          "degraded"
});

/**
 * Decision quality trend values for a monthly postmortem.
 * Computed deterministically from first-half vs second-half weighted scores.
 * @enum {string}
 */
export const POSTMORTEM_DECISION_TREND = Object.freeze({
  IMPROVING:         "improving",
  STABLE:            "stable",
  DEGRADING:         "degrading",
  INSUFFICIENT_DATA: "insufficient_data"
});

/**
 * Severity weights used in the compounding-effect score formula.
 * score = occurrences × severityWeight × recencyFactor
 * @type {Readonly<Record<string, number>>}
 */
export const COMPOUNDING_SEVERITY_WEIGHT = Object.freeze({
  critical: 3,
  warning:  2,
  info:     1
});

/**
 * Canonical schema for monthly_postmortem_YYYY-MM.json.
 *
 * Required top-level fields, enum values, counterfactual template fields,
 * and seed question format rules are all specified here for machine-checkable
 * validation (Athena AC1–AC5 resolved).
 *
 * Output file: state/monthly_postmortem_{monthKey}.json
 */
export const MONTHLY_POSTMORTEM_SCHEMA = Object.freeze({
  schemaVersion: 1,

  /** Minimum recorded cycles before status="ok" is set (vs "insufficient_data"). */
  minCycleCount: 3,

  /** Maximum compounding effects returned. */
  maxCompoundingEffects: 5,

  /** Time window for decision quality trend (days). */
  trendTimeWindowDays: 30,

  required: Object.freeze([
    "schemaVersion", "monthKey", "generatedAt", "status",
    "cycleCount", "experimentOutcomes", "compoundingEffects",
    "decisionQualityTrend", "seedQuestion"
  ]),

  statusEnum:                      Object.freeze(["ok", "insufficient_data", "degraded"]),
  trendEnum:                       Object.freeze(["improving", "stable", "degrading", "insufficient_data"]),
  confidenceLevelEnum:             Object.freeze(["high", "medium", "low"]),
  compoundingEffectSeverityEnum:   Object.freeze(["critical", "warning", "info"]),

  /** Required fields on each counterfactual note (Athena AC3 resolved). */
  counterfactualRequiredFields: Object.freeze([
    "experimentId", "hypothesis", "failureReason", "alternative", "preventionStrategy"
  ]),

  /** Required fields on the seedQuestion object (Athena AC5 resolved). */
  seedQuestionRequiredFields: Object.freeze(["question", "rationale", "dataPoints"]),

  /** Confidence level thresholds based on total postmortem count. */
  trendConfidenceThresholds: Object.freeze({ HIGH: 10, MEDIUM: 5 }),

  /**
   * Minimum score delta (absolute) required to classify trend as improving/degrading.
   * Below this threshold → "stable".
   */
  trendDeltaThreshold: 0.05,

  /** Seed question format rule: must end in "?" and have >= this many characters. */
  seedQuestionMinLength: 20
});

// ── Compounding Effect Scoring ─────────────────────────────────────────────────

/**
 * Compute recency factor for a lesson based on its addedAt timestamp
 * relative to the end of the given month.
 *
 * recencyFactor:
 *   1.0 — within last 7 days of the month
 *   0.7 — 8–14 days before end of month
 *   0.5 — older than 14 days before end of month
 *
 * @param {string|null|undefined} addedAt — ISO timestamp
 * @param {Date} monthEnd
 * @returns {number}
 */
function computeRecencyFactor(addedAt, monthEnd) {
  if (!addedAt) return 0.5;
  const ts = new Date(addedAt).getTime();
  if (!Number.isFinite(ts)) return 0.5;
  const daysDiff = (monthEnd.getTime() - ts) / (1000 * 60 * 60 * 24);
  if (daysDiff <= 7)  return 1.0;
  if (daysDiff <= 14) return 0.7;
  return 0.5;
}

/**
 * Compute top-N compounding effects from monthly improvement reports.
 *
 * Scoring formula (Athena AC2 resolved):
 *   score = occurrences × severityWeight × recencyFactor
 *   severityWeight : critical=3, warning=2, info=1  (COMPOUNDING_SEVERITY_WEIGHT)
 *   recencyFactor  : 1.0 last 7 days of month, 0.7 8–14 days, 0.5 older
 *
 * Grouping: lessons are grouped by their `category` field.
 * Pattern = "<category>: <most common lesson text in that group>" (capped at 200 chars).
 * Evidence = array of report cycleAt timestamps where the category appeared (capped at 10).
 *
 * @param {object[]} reports — improvement_reports entries for the month
 * @param {string}   monthKey — "YYYY-MM"
 * @param {number}   [maxN]
 * @returns {object[]}
 */
export function computeCompoundingEffects(reports, monthKey, maxN = MONTHLY_POSTMORTEM_SCHEMA.maxCompoundingEffects) {
  if (!Array.isArray(reports) || reports.length === 0) return [];

  const [year, month] = monthKey.split("-").map(Number);
  const monthEnd = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

  /** @type {Map<string, { occurrences: number, severity: string, evidence: string[], lessonTexts: string[], scoreSum: number }>} */
  const categoryMap = new Map();

  for (const report of reports) {
    const cycleAt = String(report?.cycleAt || "");
    const lessons = Array.isArray(report?.analysis?.lessons) ? report.analysis.lessons : [];

    for (const lesson of lessons) {
      const category     = String(lesson?.category || "unknown");
      const severity     = String(lesson?.severity  || "info");
      const lessonText   = String(lesson?.lesson    || "");
      const addedAt      = lesson?.addedAt || cycleAt;
      const recency      = computeRecencyFactor(addedAt, monthEnd);
      const severityW    = COMPOUNDING_SEVERITY_WEIGHT[severity] ?? COMPOUNDING_SEVERITY_WEIGHT.info;
      const itemScore    = severityW * recency;

      if (!categoryMap.has(category)) {
        categoryMap.set(category, {
          occurrences: 0, severity, evidence: [], lessonTexts: [], scoreSum: 0
        });
      }

      const entry = categoryMap.get(category);
      entry.occurrences += 1;
      entry.scoreSum    += itemScore;

      if (cycleAt && !entry.evidence.includes(cycleAt)) entry.evidence.push(cycleAt);
      if (lessonText && !entry.lessonTexts.includes(lessonText)) entry.lessonTexts.push(lessonText);

      // Promote to highest severity seen in this category
      const existingW = COMPOUNDING_SEVERITY_WEIGHT[entry.severity] ?? 1;
      if (severityW > existingW) entry.severity = severity;
    }
  }

  const effects = [];
  for (const [category, data] of categoryMap) {
    const domSeverityW = COMPOUNDING_SEVERITY_WEIGHT[data.severity] ?? 1;
    const avgRecency   = data.occurrences > 0
      ? data.scoreSum / (data.occurrences * domSeverityW)
      : 0.5;
    const score = data.occurrences * domSeverityW * avgRecency;

    effects.push({
      pattern:     `${category}: ${data.lessonTexts[0] || "No details"}`.slice(0, 200),
      score:       Math.round(score * 100) / 100,
      occurrences: data.occurrences,
      severity:    data.severity,
      recentAt:    data.evidence[data.evidence.length - 1] || null,
      evidence:    data.evidence.slice(-10)
    });
  }

  effects.sort((a, b) => b.score - a.score || b.occurrences - a.occurrences);
  return effects.slice(0, maxN);
}

// ── Counterfactual Notes ───────────────────────────────────────────────────────

/**
 * Build counterfactual notes for rolled-back experiments.
 *
 * Template fields (Athena AC3 resolved — any string no longer satisfies criterion):
 *   experimentId       — stable experiment ID
 *   hypothesis         — hypothesisId of what we expected to be true
 *   failureReason      — statusReason from the experiment record, or "UNKNOWN"
 *   alternative        — deterministically derived counterfactual statement
 *   preventionStrategy — deterministically derived prevention advice
 *
 * @param {object[]} experiments
 * @returns {object[]}
 */
export function buildCounterfactuals(experiments) {
  if (!Array.isArray(experiments)) return [];

  return experiments
    .filter(e => e.status === "rolled_back")
    .map(exp => {
      const failureReason  = String(exp.statusReason || "UNKNOWN");
      const hypo           = String(exp.hypothesisId  || "unknown-hypothesis");

      const alternative = failureReason === "UNKNOWN"
        ? `Test "${hypo}" with a narrower interventionScope limited to a single config key`
        : `Instead of "${hypo}", address the root cause (${failureReason.slice(0, 80)}) first, then re-test`;

      const preventionStrategy = failureReason === "UNKNOWN"
        ? "Define explicit stop conditions and measurable success criteria before starting next experiment"
        : `Resolve "${failureReason.slice(0, 100)}" before attempting a similar intervention`;

      return {
        experimentId:       String(exp.experimentId || ""),
        hypothesis:         hypo,
        failureReason,
        alternative,
        preventionStrategy
      };
    });
}

// ── Decision Quality Trend for Month ──────────────────────────────────────────

/**
 * Compute decision quality trend for a given calendar month.
 *
 * Time window: all postmortems whose timestamp falls within the month (AC4 resolved).
 *
 * Trend computation:
 *   Split postmortems at day 15 (month midpoint).
 *   scoreBefore = weighted score of entries in days 1–14.
 *   scoreAfter  = weighted score of entries in days 15–end.
 *   trend = "improving"        if scoreAfter  > scoreBefore + trendDeltaThreshold
 *           "degrading"        if scoreBefore > scoreAfter  + trendDeltaThreshold
 *           "stable"           otherwise (both halves present, delta within threshold)
 *           "insufficient_data" if < 2 postmortems in window
 *
 * Confidence scale (AC4 resolved):
 *   "high"   — ≥ 10 postmortems in window
 *   "medium" — 5–9
 *   "low"    — 1–4
 *
 * @param {object[]} postmortems — athena postmortem entries
 * @param {string}   monthKey    — "YYYY-MM"
 * @returns {object}
 */
export function computeDecisionQualityTrendForMonth(postmortems, monthKey) {
  const timeWindowDays  = MONTHLY_POSTMORTEM_SCHEMA.trendTimeWindowDays;
  const deltaThreshold  = MONTHLY_POSTMORTEM_SCHEMA.trendDeltaThreshold;
  const { HIGH, MEDIUM } = MONTHLY_POSTMORTEM_SCHEMA.trendConfidenceThresholds;

  const empty = (trend) => ({
    trend,
    confidence: "low",
    timeWindowDays,
    scoreBefore: null,
    scoreAfter:  null,
    totalPostmortems: 0
  });

  if (!Array.isArray(postmortems) || postmortems.length === 0) {
    return empty(POSTMORTEM_DECISION_TREND.INSUFFICIENT_DATA);
  }

  const [year, month] = monthKey.split("-").map(Number);
  const monthStart = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd   = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));
  const midpoint   = new Date(Date.UTC(year, month - 1, 15));

  function pmTimestamp(pm) {
    const raw = pm?.timestamp || pm?.reviewedAt || pm?.addedAt || null;
    if (!raw) return null;
    const t = new Date(raw).getTime();
    return Number.isFinite(t) ? t : null;
  }

  const inMonth = postmortems.filter(pm => {
    const t = pmTimestamp(pm);
    return t !== null && t >= monthStart.getTime() && t <= monthEnd.getTime();
  });

  const total      = inMonth.length;
  const confidence = total >= HIGH ? "high" : total >= MEDIUM ? "medium" : "low";

  if (total < 2) {
    return { ...empty(POSTMORTEM_DECISION_TREND.INSUFFICIENT_DATA), confidence, totalPostmortems: total };
  }

  const midMs     = midpoint.getTime();
  const firstHalf = inMonth.filter(pm => pmTimestamp(pm) <  midMs);
  const secHalf   = inMonth.filter(pm => pmTimestamp(pm) >= midMs);

  const { score: scoreBefore } = computeWeightedDecisionScore(firstHalf);
  const { score: scoreAfter  } = computeWeightedDecisionScore(secHalf);

  let trend;
  if (scoreBefore === null && scoreAfter === null) {
    trend = POSTMORTEM_DECISION_TREND.INSUFFICIENT_DATA;
  } else if (scoreBefore !== null && scoreAfter !== null) {
    if      (scoreAfter  > scoreBefore + deltaThreshold) trend = POSTMORTEM_DECISION_TREND.IMPROVING;
    else if (scoreBefore > scoreAfter  + deltaThreshold) trend = POSTMORTEM_DECISION_TREND.DEGRADING;
    else                                                  trend = POSTMORTEM_DECISION_TREND.STABLE;
  } else {
    // One half has no labeled postmortems — not enough data to call direction
    trend = POSTMORTEM_DECISION_TREND.STABLE;
  }

  return {
    trend,
    confidence,
    timeWindowDays,
    scoreBefore: scoreBefore !== null ? Math.round(scoreBefore * 10000) / 10000 : null,
    scoreAfter:  scoreAfter  !== null ? Math.round(scoreAfter  * 10000) / 10000 : null,
    totalPostmortems: total
  };
}

// ── Seed Question Generator ────────────────────────────────────────────────────

/**
 * Generate a next-cycle strategy seed question from computed postmortem data.
 *
 * Format rules (Athena AC5 resolved — distinguishes from static no-op strings):
 *   - question must end in "?"
 *   - question must be >= MONTHLY_POSTMORTEM_SCHEMA.seedQuestionMinLength characters
 *   - dataPoints must contain >= 1 entry referencing an actual computed value
 *   - rationale must explain why this specific question was generated
 *
 * Priority order:
 *   1. Degrading decision quality  → ask about root cause of the regression
 *   2. Top compounding effect       → ask about structural fix for the pattern
 *   3. Rolled-back experiments      → ask about the best counterfactual intervention
 *   4. Default throughput question  → ask about cycle completion rate improvement
 *
 * @param {object[]} compoundingEffects
 * @param {object}   decisionQualityTrend
 * @param {object}   experimentOutcomes
 * @param {string}   monthKey
 * @returns {{ question: string, rationale: string, dataPoints: string[] }}
 */
export function generateSeedQuestion(compoundingEffects, decisionQualityTrend, experimentOutcomes, monthKey) {
  const minLen    = MONTHLY_POSTMORTEM_SCHEMA.seedQuestionMinLength;
  const topEffect = Array.isArray(compoundingEffects) ? compoundingEffects[0] : null;
  const trend     = decisionQualityTrend?.trend;
  const rolledBackCount = Array.isArray(experimentOutcomes?.counterfactuals)
    ? experimentOutcomes.counterfactuals.length
    : 0;

  let question;
  let rationale;
  const dataPoints = [];

  if (trend === POSTMORTEM_DECISION_TREND.DEGRADING
      && decisionQualityTrend.scoreBefore !== null
      && decisionQualityTrend.scoreAfter  !== null) {
    const pct1 = (decisionQualityTrend.scoreBefore * 100).toFixed(1);
    const pct2 = (decisionQualityTrend.scoreAfter  * 100).toFixed(1);
    question   = `What specific failure mode caused decision quality to degrade from ${pct1}% to ${pct2}% in ${monthKey}?`;
    rationale  = `Decision quality trended ${trend} (scoreBefore=${pct1}%, scoreAfter=${pct2}%); root-cause identification is highest priority for next quarter.`;
    dataPoints.push(
      `decisionQualityTrend.scoreBefore=${pct1}%`,
      `decisionQualityTrend.scoreAfter=${pct2}%`,
      `trend=${trend}`
    );
  } else if (topEffect) {
    const patSnip = topEffect.pattern.slice(0, 80);
    question  = `What structural change would eliminate the "${patSnip}" pattern that recurred ${topEffect.occurrences} time(s) in ${monthKey}?`;
    rationale = `Top compounding effect "${topEffect.pattern.slice(0, 60)}" scored ${topEffect.score} (occurrences=${topEffect.occurrences}, severity=${topEffect.severity}); structural remediation is the priority.`;
    dataPoints.push(
      `compoundingEffects[0].pattern=${topEffect.pattern.slice(0, 60)}`,
      `compoundingEffects[0].occurrences=${topEffect.occurrences}`,
      `compoundingEffects[0].score=${topEffect.score}`
    );
  } else if (rolledBackCount > 0) {
    const first = experimentOutcomes.counterfactuals[0];
    const frSnip = String(first.failureReason || "UNKNOWN").slice(0, 60);
    question  = `Given that experiment "${first.experimentId}" failed due to "${frSnip}", what alternative intervention should be trialled next quarter?`;
    rationale = `${rolledBackCount} experiment(s) were rolled back in ${monthKey}; counterfactual analysis indicates alternative approach required.`;
    dataPoints.push(
      `experimentOutcomes.counterfactuals[0].experimentId=${first.experimentId}`,
      `experimentOutcomes.counterfactuals[0].failureReason=${frSnip}`,
      `experimentOutcomes.rolled_back=${rolledBackCount}`
    );
  } else {
    const completed = Number(experimentOutcomes?.completed ?? 0);
    const total     = Number(experimentOutcomes?.total     ?? 0);
    const pct       = total > 0 ? Math.round((completed / total) * 100) : 0;
    question  = `What process improvement would increase the ${monthKey} experiment completion rate beyond ${pct}%?`;
    rationale = `No degrading quality trend or compounding effects detected; default throughput question generated for ${monthKey}.`;
    dataPoints.push(
      `experimentOutcomes.completed=${completed}`,
      `experimentOutcomes.total=${total}`,
      `monthKey=${monthKey}`
    );
  }

  // Enforce format rules
  if (!question.endsWith("?")) question = `${question}?`;
  if (question.length < minLen) {
    question = `${question} (${monthKey})`;
    if (!question.endsWith("?")) question = `${question}?`;
  }

  return { question, rationale, dataPoints };
}

// ── Main Monthly Postmortem Generator ─────────────────────────────────────────

/**
 * Generate a monthly evolution postmortem for the specified month.
 *
 * Scope: BUILD step — this generator did not previously exist in self_improvement.js
 * or state_tracker.js (Athena missing item #1 resolved).
 *
 * Reads:
 *   state/improvement_reports.json  — cycle lessons and analytics
 *   state/experiment_registry.json  — experiments (for counterfactuals)
 *   state/athena_postmortems.json   — decision quality postmortems
 *
 * Returns a structured result; caller must pass postmortem to persistMonthlyPostmortem
 * to write state/monthly_postmortem_{monthKey}.json.
 *
 * Status values:
 *   "ok"               — sufficient data, full report generated
 *   "insufficient_data" — cycleCount < minCycleCount (3); stub returned, no write recommended
 *   "degraded"          — generated with partial data; degradedSources lists affected fields
 *
 * Validation: missing vs invalid input produces distinct reason codes (degradedSources).
 * No silent fallback: degraded state sets explicit status + degradedSources array.
 *
 * @param {object}  config
 * @param {string}  [monthKey] — "YYYY-MM"; defaults to current month
 * @returns {Promise<{ ok: boolean, status: string, postmortem: object|null, reason?: string }>}
 */
export async function generateMonthlyPostmortem(config, monthKey) {
  const stateDir          = config?.paths?.stateDir || "state";
  const now               = new Date();
  const defaultMonthKey   = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
  const resolvedMonthKey  = monthKey || defaultMonthKey;

  const [reportsRaw, registryRaw, postmortemsRaw] = await Promise.all([
    readJsonSafe(path.join(stateDir, "improvement_reports.json")),
    readJsonSafe(path.join(stateDir, "experiment_registry.json")),
    readJsonSafe(path.join(stateDir, "athena_postmortems.json"))
  ]);

  const degradedSources = [];

  // ── Improvement reports ────────────────────────────────────────────────────
  let allReports = [];
  if (!reportsRaw.ok) {
    degradedSources.push(
      reportsRaw.reason === READ_JSON_REASON.MISSING
        ? "IMPROVEMENT_REPORTS_ABSENT"
        : "IMPROVEMENT_REPORTS_INVALID"
    );
  } else {
    allReports = Array.isArray(reportsRaw.data?.reports) ? reportsRaw.data.reports : [];
  }

  // Filter to the target month
  const [year, month] = resolvedMonthKey.split("-").map(Number);
  const monthStart    = new Date(Date.UTC(year, month - 1, 1));
  const monthEnd      = new Date(Date.UTC(year, month, 0, 23, 59, 59, 999));

  const monthlyReports = allReports.filter(r => {
    if (!r?.cycleAt) return false;
    const ts = new Date(r.cycleAt).getTime();
    return Number.isFinite(ts) && ts >= monthStart.getTime() && ts <= monthEnd.getTime();
  });

  const cycleCount = monthlyReports.length;

  // ── Insufficient data check (Athena missing item #7 resolved) ─────────────
  const minCycles = MONTHLY_POSTMORTEM_SCHEMA.minCycleCount;
  if (cycleCount < minCycles) {
    const insufficiencyReason =
      `INSUFFICIENT_CYCLES:${cycleCount}_recorded_minimum_${minCycles}_required`;
    const stub = {
      schemaVersion:       MONTHLY_POSTMORTEM_SCHEMA.schemaVersion,
      monthKey:            resolvedMonthKey,
      generatedAt:         new Date().toISOString(),
      status:              MONTHLY_POSTMORTEM_STATUS.INSUFFICIENT_DATA,
      insufficiencyReason,
      cycleCount,
      experimentOutcomes:  { total: 0, completed: 0, rolled_back: 0, counterfactuals: [] },
      compoundingEffects:  [],
      decisionQualityTrend: {
        trend:            POSTMORTEM_DECISION_TREND.INSUFFICIENT_DATA,
        confidence:       "low",
        timeWindowDays:   MONTHLY_POSTMORTEM_SCHEMA.trendTimeWindowDays,
        scoreBefore:      null,
        scoreAfter:       null,
        totalPostmortems: 0
      },
      seedQuestion: null
    };
    return { ok: true, status: MONTHLY_POSTMORTEM_STATUS.INSUFFICIENT_DATA, postmortem: stub };
  }

  // ── Experiment outcomes and counterfactuals ────────────────────────────────
  let allExperiments = [];
  if (!registryRaw.ok) {
    degradedSources.push(
      registryRaw.reason === READ_JSON_REASON.MISSING
        ? "EXPERIMENT_REGISTRY_ABSENT"
        : "EXPERIMENT_REGISTRY_INVALID"
    );
  } else {
    allExperiments = Array.isArray(registryRaw.data?.experiments) ? registryRaw.data.experiments : [];
  }

  const monthlyExperiments = allExperiments.filter(e => {
    const ts = new Date(e?.createdAt || e?.startedAt || 0).getTime();
    return Number.isFinite(ts) && ts >= monthStart.getTime() && ts <= monthEnd.getTime();
  });

  const counterfactuals = buildCounterfactuals(monthlyExperiments);
  const experimentOutcomes = {
    total:          monthlyExperiments.length,
    completed:      monthlyExperiments.filter(e => e.status === "completed").length,
    rolled_back:    monthlyExperiments.filter(e => e.status === "rolled_back").length,
    counterfactuals
  };

  // ── Compounding effects ────────────────────────────────────────────────────
  const compoundingEffects = computeCompoundingEffects(monthlyReports, resolvedMonthKey);

  // ── Decision quality trend ─────────────────────────────────────────────────
  let postmortems = [];
  if (!postmortemsRaw.ok) {
    degradedSources.push(
      postmortemsRaw.reason === READ_JSON_REASON.MISSING
        ? "ATHENA_POSTMORTEMS_ABSENT"
        : "ATHENA_POSTMORTEMS_INVALID"
    );
  } else {
    try {
      const migrated = migrateData(postmortemsRaw.data, STATE_FILE_TYPE.ATHENA_POSTMORTEMS);
      if (migrated.ok) {
        postmortems = extractPostmortemEntries(migrated.data);
      } else {
        degradedSources.push("ATHENA_POSTMORTEMS_MIGRATION_FAILED");
      }
    } catch {
      degradedSources.push("ATHENA_POSTMORTEMS_MIGRATION_ERROR");
    }
  }

  const decisionQualityTrend = computeDecisionQualityTrendForMonth(postmortems, resolvedMonthKey);

  // ── Seed question ──────────────────────────────────────────────────────────
  const seedQuestion = generateSeedQuestion(
    compoundingEffects, decisionQualityTrend, experimentOutcomes, resolvedMonthKey
  );

  // ── Final status ───────────────────────────────────────────────────────────
  const status = degradedSources.length > 0
    ? MONTHLY_POSTMORTEM_STATUS.DEGRADED
    : MONTHLY_POSTMORTEM_STATUS.OK;

  const postmortem = {
    schemaVersion:       MONTHLY_POSTMORTEM_SCHEMA.schemaVersion,
    monthKey:            resolvedMonthKey,
    generatedAt:         new Date().toISOString(),
    status,
    insufficiencyReason: null,
    ...(degradedSources.length > 0 ? { degradedSources } : {}),
    cycleCount,
    experimentOutcomes,
    compoundingEffects,
    decisionQualityTrend,
    seedQuestion
  };

  return { ok: true, status, postmortem };
}

/**
 * Quality-signal gate for self-improvement.
 * Returns true only if recent decision quality is degraded, escalation was recommended,
 * or enough cycles have elapsed since the last self-improvement run.
 *
 * @param {object} config
 * @param {string} stateDir
 * @returns {Promise<{ shouldRun: boolean, reason: string }>}
 */
export async function shouldTriggerSelfImprovement(config, stateDir) {
  const siConfig = config.selfImprovement || {};

  // Config override: always run if forceEveryComplete is true
  if (siConfig.forceEveryComplete === true) {
    return { shouldRun: true, reason: "forceEveryComplete=true" };
  }

  // Read recent postmortems
  const { readJson } = await import("./fs_utils.js");
  const postmortemsFilePath = path.join(stateDir, "athena_postmortems.json");
  const rawPms = await readJson(postmortemsFilePath, null);
  let recentPms = [];
  if (rawPms !== null) {
    const { migrateData, extractPostmortemEntries, STATE_FILE_TYPE } = await import("./schema_registry.js");
    const migrated = migrateData(rawPms, STATE_FILE_TYPE.ATHENA_POSTMORTEMS);
    recentPms = migrated.ok ? extractPostmortemEntries(migrated.data).slice(-5) : [];
  }

  // (a) Weighted decision score < 0.75 over last 5 postmortems
  const scoreResult = computeWeightedDecisionScore(recentPms);
  if (scoreResult.score !== null && scoreResult.score < 0.75) {
    return { shouldRun: true, reason: `decision_quality_low (score=${scoreResult.score.toFixed(2)})` };
  }

  // (b) Any postmortem recommended escalation
  const hasEscalation = recentPms.some(pm => pm.recommendation === "escalate");
  if (hasEscalation) {
    return { shouldRun: true, reason: "escalation_recommended" };
  }

  // (c) 3+ cycles since last self-improvement run
  const siStatePath = path.join(stateDir, "self_improvement_state.json");
  const siState = await readJson(siStatePath, {});
  const cyclesSinceLast = typeof siState.cyclesSinceLastRun === "number" ? siState.cyclesSinceLastRun : Infinity;
  if (cyclesSinceLast >= 3) {
    return { shouldRun: true, reason: `cycles_elapsed (${cyclesSinceLast} >= 3)` };
  }

  return { shouldRun: false, reason: `quality_ok (score=${scoreResult.score?.toFixed(2) ?? "n/a"}, cycles=${cyclesSinceLast})` };
}

export async function runSelfImprovementCycle(config) {
  const siConfig = config.selfImprovement || {};
  if (!siConfig.enabled) return null;

  const stateDir = config.paths?.stateDir || "state";

  // Guardrail gate: halt self-improvement if FREEZE_SELF_IMPROVEMENT guardrail is active.
  // This is set automatically when a catastrophe scenario (e.g. RUNAWAY_RETRIES,
  // MASS_BLOCKED_TASKS) is detected. Gated by systemGuardian.enabled for rollback safety.
  if (config.systemGuardian?.enabled !== false) {
    try {
      const frozen = await isGuardrailActive(config, GUARDRAIL_ACTION.FREEZE_SELF_IMPROVEMENT);
      if (frozen) {
        warn("[self-improvement] FREEZE_SELF_IMPROVEMENT guardrail active — skipping cycle");
        await appendProgress(config,
          "[SELF-IMPROVEMENT] Skipped: FREEZE_SELF_IMPROVEMENT guardrail is active (catastrophe scenario detected). Revert guardrail to resume."
        );
        return null;
      }
    } catch (err) {
      // Non-fatal: guardrail check failure must not block; continue with improvement
      warn(`[self-improvement] FREEZE_SELF_IMPROVEMENT guardrail check failed (non-fatal): ${String(err?.message || err)}`);
    }
  }

  // Governance freeze gate (T-040): self-improvement cycles are high-risk by default.
  // Blocked during month-12 freeze unless a critical incident override is provided.
  const freezeCheck = evaluateFreezeGate(config, {
    riskLevel:       "high",
    taskType:        "self_improvement",
    criticalOverride: siConfig.criticalOverride || null
  });
  if (!freezeCheck.allowed) {
    warn(`[self-improvement] governance freeze blocked cycle: ${freezeCheck.reason}`);
    await appendProgress(config,
      `[SELF-IMPROVEMENT] Skipped: governance freeze is active (result=${freezeCheck.result} reason=${freezeCheck.reason}). Provide criticalOverride to proceed.`
    );
    return { status: "freeze_blocked", reason: freezeCheck.reason, result: freezeCheck.result };
  }
  if (freezeCheck.result === FREEZE_GATE_RESULT.ALLOWED && freezeCheck.overrideApproved) {
    await appendProgress(config,
      `[SELF-IMPROVEMENT] Critical override granted: incidentId=${freezeCheck.overrideApproved.incidentId}`
    );
  }

  await appendProgress(config, "[SELF-IMPROVEMENT] Starting post-cycle analysis...");

  // 1. Collect cycle outcomes
  const outcomes = await collectCycleOutcomes(config);

  // Log degraded state explicitly — no silent fallback for critical state.
  if (outcomes.degraded) {
    warn(`[self-improvement] outcome collection degraded: ${outcomes.degradedReason} — source=${outcomes.metricsSource}`);
    await appendProgress(config,
      `[SELF-IMPROVEMENT] Degraded outcome collection: reason=${outcomes.degradedReason} source=${outcomes.metricsSource}`
    );
  }

  if (outcomes.totalPlans === 0 && outcomes.completedCount === 0) {
    await appendProgress(config, "[SELF-IMPROVEMENT] No plans or progress found — skipping analysis");
    return null;
  }

  // 2. Load existing knowledge
  const knowledgeMemory = await loadKnowledgeMemory(stateDir);

  // 3. Analyze with AI
  let analysis;
  try {
    analysis = await analyzeWithAI(config, outcomes, knowledgeMemory);
  } catch (err) {
    warn(`[self-improvement] AI analysis failed: ${String(err?.message || err)}`);
    await appendProgress(config, `[SELF-IMPROVEMENT] AI analysis failed: ${String(err?.message || err).slice(0, 200)}`);
    return null;
  }

  if (!analysis) {
    await appendProgress(config, "[SELF-IMPROVEMENT] AI returned no usable analysis");
    return null;
  }

  // 4. Store lessons in knowledge memory
  const newLessons = Array.isArray(analysis.lessons) ? analysis.lessons : [];
  for (const lesson of newLessons) {
    lesson.addedAt = new Date().toISOString();
    knowledgeMemory.lessons.push(lesson);
  }

  // Cap knowledge memory size
  const maxLessons = siConfig.maxReports || 200;
  if (knowledgeMemory.lessons.length > maxLessons) {
    knowledgeMemory.lessons = knowledgeMemory.lessons.slice(-maxLessons);
  }

  // Store prompt hints for next cycle
  if (Array.isArray(analysis.promptHints)) {
    knowledgeMemory.promptHints = analysis.promptHints;
  }

  // Store capability gaps — these feed back into Jesus's health audit
  const newGaps = Array.isArray(analysis.capabilityGaps) ? analysis.capabilityGaps : [];
  if (newGaps.length > 0) {
    if (!Array.isArray(knowledgeMemory.capabilityGaps)) knowledgeMemory.capabilityGaps = [];
    for (const gap of newGaps) {
      gap.detectedAt = new Date().toISOString();
      // Avoid duplicate gaps
      const isDuplicate = knowledgeMemory.capabilityGaps.some(
        existing => existing.gap === gap.gap
      );
      if (!isDuplicate) {
        knowledgeMemory.capabilityGaps.push(gap);
      }
    }
    // Cap capability gaps
    if (knowledgeMemory.capabilityGaps.length > 50) {
      knowledgeMemory.capabilityGaps = knowledgeMemory.capabilityGaps.slice(-50);
    }
    await appendProgress(config, `[SELF-IMPROVEMENT] ${newGaps.length} capability gap(s) detected: ${newGaps.map(g => g.gap).join("; ").slice(0, 300)}`);
  }

  await saveKnowledgeMemory(stateDir, knowledgeMemory);

  // 5. Apply safe config suggestions
  let appliedChanges = [];
  if (Array.isArray(analysis.configSuggestions)) {
    try {
      appliedChanges = await applyConfigSuggestions(config, analysis.configSuggestions);
    } catch (err) {
      warn(`[self-improvement] config apply error: ${String(err?.message || err)}`);
    }
  }

  // 5a. Process running canary experiments — record metrics and advance state
  let canaryResults = [];
  try {
    canaryResults = await processRunningCanaries(config, outcomes, `si-${Date.now()}`);
    if (canaryResults.length > 0) {
      const summary = canaryResults.map(r => `${r.canaryId}→${r.action}`).join(", ");
      await appendProgress(config, `[SELF-IMPROVEMENT] Canary cycle results: ${summary}`);
    }
  } catch (err) {
    warn(`[self-improvement] canary processing error: ${String(err?.message || err)}`);
  }

  // 6. Save improvement report
  const appliedCount = appliedChanges.filter(c => c.status === "applied").length;
  const blockedCount = appliedChanges.filter(c => c.status === "blocked").length;
  const canaryStartedCount = appliedChanges.filter(c => c.status === "canary_started").length;
  const report = {
    cycleAt: new Date().toISOString(),
    outcomes: {
      totalPlans: outcomes.totalPlans,
      completedCount: outcomes.completedCount,
      workerOutcomes: outcomes.workerOutcomes.map(w => ({
        role: w.role,
        status: w.status,
        timeouts: w.timeouts,
        failures: w.failures,
        hasPR: w.hasPR
      })),
      decisionQuality: outcomes.decisionQuality,
      athenaPlanReview: outcomes.athenaPlanReview,
      metricsSource: outcomes.metricsSource,
      degraded: outcomes.degraded,
      degradedReason: outcomes.degradedReason
    },
    analysis: {
      systemHealthScore: analysis.systemHealthScore || 0,
      lessonsCount: newLessons.length,
      capabilityGapsCount: newGaps.length,
      configChangesApplied: appliedCount,
      configChangesBlocked: blockedCount,
      configChangesCanaryStarted: canaryStartedCount,
      nextCyclePriorities: analysis.nextCyclePriorities || [],
      workerFeedback: analysis.workerFeedback || [],
      capabilityGaps: newGaps
    },
    appliedChanges,
    canaryResults
  };

  // 7. Score pre-mortem quality for high-risk plans (AC5: post-cycle pre-mortem scoring)
  // Reads prometheus_analysis.json and scores any high-risk plan pre-mortems.
  // Results are stored in state/premortem_scores.json and summarized in the report.
  let premortemScoring = { scores: [], averageScore: null };
  try {
    const prometheusResult = await readJsonSafe(path.join(stateDir, "prometheus_analysis.json"));
    const prometheusData = prometheusResult.ok ? prometheusResult.data : null;
    premortemScoring = await scoreAndStorePremortemQuality(config, prometheusData);
    if (premortemScoring.scores.length > 0) {
      await appendProgress(config,
        `[SELF-IMPROVEMENT] Pre-mortem quality scored: ${premortemScoring.scores.length} high-risk plan(s) | averageScore=${premortemScoring.averageScore?.toFixed(1) ?? "N/A"}/${PREMORTEM_MAX_SCORE}`
      );
    }
  } catch (err) {
    // Non-fatal: pre-mortem scoring failure must not block the improvement report
    warn(`[self-improvement] pre-mortem scoring failed: ${String(err?.message || err)}`);
  }
  (report as any).premortemScoring = {
    scoredCount: premortemScoring.scores.length,
    averageScore: premortemScoring.averageScore,
    maxScore: PREMORTEM_MAX_SCORE
  };

  // Append to reports log
  const reportsPath = path.join(stateDir, "improvement_reports.json");
  const existingReports = await readJson(reportsPath, { reports: [] });
  existingReports.reports.push(report);

  // Cap reports
  if (existingReports.reports.length > (siConfig.maxReports || 200)) {
    existingReports.reports = existingReports.reports.slice(-(siConfig.maxReports || 200));
  }
  await writeJson(reportsPath, existingReports);

  const healthScore = analysis.systemHealthScore || 0;
  const lessonsStr = newLessons.map(l => `[${l.severity}] ${l.lesson}`).join("; ").slice(0, 300);
  await appendProgress(config,
    `[SELF-IMPROVEMENT] Analysis complete — health=${healthScore}/100 | lessons=${newLessons.length} | config-changes=${appliedCount} | config-blocked=${blockedCount} | canary-started=${canaryStartedCount} | ${lessonsStr}`
  );

  chatLog(stateDir, "SelfImprovement",
    `Cycle analysis: health=${healthScore}/100, lessons=${newLessons.length}, applied=${appliedCount}, blocked=${blockedCount}`
  );

  return report;
}
