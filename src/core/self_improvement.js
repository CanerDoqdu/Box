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
import { normalizeDecisionQualityLabel, DECISION_QUALITY_LABEL } from "./athena_reviewer.js";
import { extractPostmortemEntries, migrateData, STATE_FILE_TYPE } from "./schema_registry.js";

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
  const labelCounts = {};
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
 * Primary state sources (replaces stale Moses artifacts):
 *   prometheus_analysis.json  — plans, projectHealth, requestBudget, waves
 *                               (replaces trump_analysis.json)
 *   evolution_progress.json   — completed task IDs
 *                               (replaces moses_coordination.completedTasks)
 *   worker_sessions.json      — per-worker status (unchanged)
 *   worker_${role}.json       — per-worker activityLog → dispatches
 *                               (replaces moses_coordination.dispatchLog)
 *
 * Legacy adapter:
 *   moses_coordination.json   — read and merged when present; absent on Athena-gated runs.
 *   Rollback: re-enable adapter-only mode by removing the prometheus/evolution reads above.
 *
 * Return contract:
 *   { totalPlans, completedCount, projectHealth, workerOutcomes, waves, dispatches,
 *     requestBudget, decisionQuality, timestamp, metricsSource, degraded, degradedReason }
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

  // ── Legacy adapter: moses_coordination.json ──────────────────────────────
  // Merged when present for backward-compatibility; absent on Athena-gated runs.
  const mosesState = await readJson(path.join(stateDir, "moses_coordination.json"), null);

  // ── Input validation — distinguish missing vs invalid ─────────────────────
  let degraded = false;
  let degradedReason = null;

  let plans = [];
  let projectHealth = "unknown";
  let requestBudget = {};
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
      .filter(([, t]) => t.status === "completed" || t.status === "done")
      .map(([id]) => id);
  }

  // Legacy adapter: merge Moses completedTasks when file is present.
  const legacyCompleted = Array.isArray(mosesState?.completedTasks)
    ? mosesState.completedTasks
    : [];
  const completedTasks = legacyCompleted.length > 0
    ? [...new Set([...completedFromEvolution, ...legacyCompleted])]
    : completedFromEvolution;

  // ── Determine metrics source ──────────────────────────────────────────────
  const sourceFiles = ["worker_sessions"];
  if (prometheusResult.ok) sourceFiles.unshift("prometheus_analysis");
  if (evolutionResult.ok)  sourceFiles.push("evolution_progress");
  if (mosesState !== null)  sourceFiles.push("moses_coordination(legacy)");
  const metricsSource = sourceFiles.join("+");

  // ── Per-worker outcome analysis ───────────────────────────────────────────
  const workerOutcomes = [];
  const workerActivityByRole = {};

  for (const [role, session] of Object.entries(workerSessions)) {
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
  // Replaces moses_coordination.dispatchLog — each worker's activityLog is the source.
  const allActivityEntries = [];
  for (const [role, activityLog] of Object.entries(workerActivityByRole)) {
    for (const entry of activityLog) {
      allActivityEntries.push({ role, ...entry });
    }
  }
  // Legacy adapter: merge Moses dispatchLog when present.
  const legacyDispatches = Array.isArray(mosesState?.dispatchLog) ? mosesState.dispatchLog : [];
  const dispatches = [...allActivityEntries, ...legacyDispatches].slice(-20);

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
      healthAuditSection = `\n## JESUS HEALTH AUDIT FINDINGS (hierarchical detection)\n${JSON.stringify(auditData.findings, null, 2)}\nAnalyze these findings — they represent issues that WORKERS and MOSES missed but JESUS caught.\nFor each finding, determine if the system is MISSING A CAPABILITY that caused the gap.\n`;
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
   These hints will be injected into the next cycle's prompts for the specified agent (trump, moses, or worker names).

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
   What problem existed that NO part of the system (workers, Moses, Trump, Jesus) addressed?
   What capability would have prevented the issue?
   Would this gap appear in OTHER repositories too? Set appliesToAllRepos=true if so.

Respond with ONLY valid JSON. No markdown, no explanation before or after.`;

  const args = buildAgentArgs({ agentSlug: "issachar", prompt, allowAll: true, noAskUser: true });
  const result = await spawnAsync(command, args, { env: process.env });
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

    // Apply the change
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
      applied.push({
        path: configKey,
        oldValue,
        newValue: suggestion.suggestedValue,
        reason: suggestion.reason
      });
    }
  }

  if (applied.length > 0) {
    await fs.writeFile(configPath, JSON.stringify(boxConfig, null, 2) + "\n", "utf8");
  }

  return applied;
}

// ── Main Self-Improvement Cycle ──────────────────────────────────────────────

export async function runSelfImprovementCycle(config) {
  const siConfig = config.selfImprovement || {};
  if (!siConfig.enabled) return null;

  const stateDir = config.paths?.stateDir || "state";

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

  // 6. Save improvement report
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
      metricsSource: outcomes.metricsSource,
      degraded: outcomes.degraded,
      degradedReason: outcomes.degradedReason
    },
    analysis: {
      systemHealthScore: analysis.systemHealthScore || 0,
      lessonsCount: newLessons.length,
      capabilityGapsCount: newGaps.length,
      configChangesApplied: appliedChanges.length,
      nextCyclePriorities: analysis.nextCyclePriorities || [],
      workerFeedback: analysis.workerFeedback || [],
      capabilityGaps: newGaps
    },
    appliedChanges
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
    `[SELF-IMPROVEMENT] Analysis complete — health=${healthScore}/100 | lessons=${newLessons.length} | config-changes=${appliedChanges.length} | ${lessonsStr}`
  );

  chatLog(stateDir, "SelfImprovement",
    `Cycle analysis: health=${healthScore}/100, lessons=${newLessons.length}, applied=${appliedChanges.length}`
  );

  return report;
}
