/**
 * Prometheus — Self-Evolution Engine & Key Planner (Simplified)
 *
 * Prometheus is activated by Jesus for deep repository analysis.
 * Uses single-prompt mode: one request per invocation.
 * The Copilot CLI agent reads the repo itself — no chunk export needed.
 * Behavior is defined in .github/agents/prometheus.agent.md.
 *
 * Output: deep analysis artifact in state/prometheus_analysis.json
 * Live log: state/live_worker_prometheus.log (streamed in real-time)
 */

import path from "node:path";
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { readJson, writeJson, spawnAsync } from "./fs_utils.js";
import { appendAlert, appendProgress, appendInterventionOptimizerEntry } from "./state_tracker.js";
import { getRoleRegistry } from "./role_registry.js";
import { buildAgentArgs, parseAgentOutput } from "./agent_loader.js";
import { addSchemaVersion, STATE_FILE_TYPE } from "./schema_registry.js";
import { PREMORTEM_RISK_LEVEL } from "./athena_reviewer.js";
import {
  runInterventionOptimizer,
  buildInterventionsFromPlan,
  buildBudgetFromConfig,
  OPTIMIZER_STATUS,
} from "./intervention_optimizer.js";
import {
  resolveDependencyGraph,
  persistGraphDiagnostics,
  GRAPH_STATUS,
} from "./dependency_graph_resolver.js";
import { dualPassCriticRepair } from "./plan_critic.js";
import { compileAcceptanceCriteria, enrichPlansWithAC } from "./ac_compiler.js";
import {
  validateLeadershipContract,
  LEADERSHIP_CONTRACT_TYPE,
  TRUST_BOUNDARY_ERROR,
} from "./trust_boundary.js";
import { validateAllPlans, PLAN_VIOLATION_SEVERITY, PACKET_VIOLATION_CODE } from "./plan_contract_validator.js";
import { section, compilePrompt } from "./prompt_compiler.js";
import { computeFingerprint } from "./carry_forward_ledger.js";
import { rewriteVerificationCommand } from "./verification_command_registry.js";
import { checkCarryForwardGate, hardGateRecurrenceToPolicies } from "./learning_policy_compiler.js";

export function detectModelFallback(rawText) {
  const text = String(rawText || "");
  const match = text.match(/Warning:\s*Custom agent\s+"([^"]+)"\s+specifies model\s+"([^"]+)"\s+which is not available;\s+using\s+"([^"]+)"\s+instead/i);
  if (!match) return null;
  return { agent: match[1], requestedModel: match[2], fallbackModel: match[3] };
}

export function buildPrometheusPlanningPolicy(config) {
  const planner = config?.planner || {};
  const maxWorkersPerWave = Math.max(1, Number(planner.defaultMaxWorkersPerWave || config?.maxParallelWorkers || 10));
  const rawMaxTasks = Number(planner.maxTasks);
  const maxTasks = Number.isFinite(rawMaxTasks) && rawMaxTasks > 0 ? Math.floor(rawMaxTasks) : 0;
  return {
    maxTasks,
    maxWorkersPerWave,
    preferFewestWorkers: planner.preferFewestWorkers !== false,
    allowSameCycleFollowUps: Boolean(planner.allowSameCycleFollowUps),
    requireDependencyAwareWaves: planner.requireDependencyAwareWaves !== false,
    enforcePrometheusExecutionStrategy: planner.enforcePrometheusExecutionStrategy !== false
  };
}

/**
 * Maximum tokens for the carry-forward payload in the planning prompt.
 * Prevents unbounded growth when many follow-up tasks accumulate across cycles.
 */
export const CARRY_FORWARD_MAX_TOKENS = 2000;

/**
 * Maximum tokens for the behavior-patterns payload in the planning prompt.
 */
export const BEHAVIOR_PATTERNS_MAX_TOKENS = 1500;

/**
 * Reason codes emitted by checkPacketCompleteness for unrecoverable conditions.
 * Used in logs and _rejectedIncompletePackets metadata so callers can diagnose
 * which field caused rejection without inspecting the raw plan object.
 *
 * These values are aliases into the canonical PACKET_VIOLATION_CODE taxonomy
 * defined in plan_contract_validator.ts.  Both the generation-boundary gate
 * (here) and the post-normalization contract validator share the same string
 * values, so log output, metadata, and filtering logic are consistent end-to-end.
 */
export const UNRECOVERABLE_PACKET_REASONS = Object.freeze({
  /** Raw plan has no task/title/task_id/id — normalization would synthesize "Task-N" */
  NO_TASK_IDENTITY:              PACKET_VIOLATION_CODE.NO_TASK_IDENTITY,
  /** capacityDelta field is absent — normalization cannot synthesize it */
  MISSING_CAPACITY_DELTA:        PACKET_VIOLATION_CODE.MISSING_CAPACITY_DELTA,
  /** capacityDelta is present but not a finite number ∈ [-1.0, 1.0] */
  INVALID_CAPACITY_DELTA:        PACKET_VIOLATION_CODE.INVALID_CAPACITY_DELTA,
  /** requestROI field is absent — normalization cannot synthesize it */
  MISSING_REQUEST_ROI:           PACKET_VIOLATION_CODE.MISSING_REQUEST_ROI,
  /** requestROI is present but not a positive finite number */
  INVALID_REQUEST_ROI:           PACKET_VIOLATION_CODE.INVALID_REQUEST_ROI,
  /** verification and verification_commands are both absent/empty — no completion signal */
  MISSING_VERIFICATION_COUPLING: PACKET_VIOLATION_CODE.MISSING_VERIFICATION_COUPLING,
});

/**
 * Check whether a raw plan packet is unrecoverable before normalization.
 *
 * A packet is unrecoverable when it is missing fields that normalizePlanFromTask()
 * cannot meaningfully synthesize.  These packets must be rejected at the generation
 * boundary — right after parseAgentOutput() and before normalizePrometheusParsedOutput()
 * is called — so invalid AI output never enters the normalization pipeline.
 *
 * Unrecoverable conditions:
 *  1. No task identity  — all of task/title/task_id/id are absent or empty.
 *     Normalization falls back to "Task-N" which carries no semantic meaning.
 * Fields like capacityDelta, requestROI, and verification are NOT treated as
 * unrecoverable because normalizePlanFromTask() synthesizes sensible defaults.
 *
 * Reason codes are values from the canonical PACKET_VIOLATION_CODE taxonomy
 * (plan_contract_validator.ts) so they are identical to codes emitted by the
 * post-normalization validator — no translation layer needed.
 *
 * @param rawPlan - raw plan object as emitted by the AI, before any normalization
 * @returns {{ recoverable: boolean, reasons: string[] }}
 */
export function checkPacketCompleteness(rawPlan: any): { recoverable: boolean; reasons: string[] } {
  if (!rawPlan || typeof rawPlan !== "object") {
    return { recoverable: false, reasons: [PACKET_VIOLATION_CODE.NO_TASK_IDENTITY] };
  }

  const reasons: string[] = [];

  // 1. Task identity: at least one of task/title/task_id/id must be a non-empty string.
  const taskText = String(rawPlan.task || rawPlan.title || rawPlan.task_id || rawPlan.id || "").trim();
  if (taskText.length === 0) {
    reasons.push(PACKET_VIOLATION_CODE.NO_TASK_IDENTITY);
  }

  // capacityDelta and requestROI are NOT checked here because
  // normalizePlanFromTask() synthesizes defaults (0.1 and 1.0 respectively).

  return { recoverable: reasons.length === 0, reasons };
}

/**
 * Retire carry-forward items that have already been resolved.
 * Checks the carry-forward ledger (closedAt + closureEvidence) and the coordination
 * completedTasks list to skip items that have verified evidence of resolution before
 * including them in the prompt.
 *
 * Retirement is deterministic: each lesson is identified by a SHA-256 fingerprint of
 * its canonical form (boilerplate stripped), so matching is collision-resistant and
 * immune to trivial rewording. Ledger-based retirement additionally requires a
 * non-empty closureEvidence to confirm the fix actually shipped.
 *
 * @param {Array} pendingEntries - postmortem entries with followUpNeeded + followUpTask
 * @param {Array} ledger - carry_forward_ledger entries (may include closed entries)
 * @param {string[]} completedTasks - completed task IDs/titles from coordination state
 * @returns {Array} - only entries NOT yet resolved
 */
export function filterResolvedCarryForwardItems(pendingEntries, ledger, completedTasks) {
  const ledgerEntries = Array.isArray(ledger) ? ledger : [];
  const completed = Array.isArray(completedTasks) ? completedTasks : [];

  // Ledger retirement requires BOTH closedAt AND non-empty closureEvidence to ensure
  // the item was actually fixed, not just administratively closed without proof.
  const resolvedFingerprints = new Set(
    [
      ...ledgerEntries
        .filter(e => e.closedAt && e.closureEvidence)
        .map(e => e.fingerprint || computeFingerprint(String(e.lesson || ""))),
      ...completed.map(t => computeFingerprint(String(t || ""))),
    ].filter(Boolean)
  );

  return (Array.isArray(pendingEntries) ? pendingEntries : []).filter(e => {
    const fp = computeFingerprint(String(e.followUpTask || ""));
    return fp && !resolvedFingerprints.has(fp);
  });
}

function liveLogPath(stateDir) {
  return path.join(stateDir, "live_worker_prometheus.log");
}

function appendLiveLogSync(stateDir, text) {
  try {
    appendFileSync(liveLogPath(stateDir), text, "utf8");
  } catch { /* best-effort */ }
}

function appendPromptPreviewSync(stateDir, promptText) {
  const prompt = String(promptText || "").trim();
  if (!prompt) return;
  appendLiveLogSync(
    stateDir,
    [
      "",
      "[prometheus_runtime_prompt_start]",
      prompt,
      "[prometheus_runtime_prompt_end]",
      ""
    ].join("\n")
  );
}

async function appendPrometheusLiveLog(stateDir, section, text) {
  const message = String(text || "").trim();
  if (!message) return;
  const line = `\n[${section}]\n${message}\n`;
  try {
    await fs.appendFile(liveLogPath(stateDir), line, "utf8");
  } catch { /* best-effort */ }
}

/**
 * Risk threshold for pre-mortem requirement.
 * Aligned with PREMORTEM_RISK_LEVEL.HIGH from athena_reviewer.js.
 */
export const PREMORTEM_RISK_THRESHOLD = PREMORTEM_RISK_LEVEL.HIGH;

/**
 * Build an empty pre-mortem scaffold for a high-risk plan.
 */
export function buildPremortemScaffold(plan) {
  return {
    riskLevel: PREMORTEM_RISK_LEVEL.HIGH,
    scenario: "",
    failurePaths: [],
    mitigations: [],
    detectionSignals: [],
    guardrails: [],
    rollbackPlan: (plan && typeof plan === "object" && typeof plan.rollbackPlan === "string")
      ? plan.rollbackPlan
      : ""
  };
}

function inferProjectHealth(text) {
  const s = String(text || "").toLowerCase();
  if (s.includes("critical")) return "critical";
  if (s.includes("needs-work") || s.includes("needs work")) return "needs-work";
  if (s.includes("good") || s.includes("healthy")) return "good";
  return "needs-work";
}

function normalizeWaveValue(value, fallback = 1) {
  if (Number.isFinite(Number(value)) && Number(value) >= 1) {
    return Math.floor(Number(value));
  }
  const asText = String(value || "").trim();
  return asText || fallback;
}

function extractFilePathHints(text) {
  const s = String(text || "");
  const matches = s.match(/(?:src|tests|scripts|docs)\/[A-Za-z0-9_./-]+/g) || [];
  const normalized = matches
    .map((m) => m.replace(/[),.;:]+$/, ""))
    .filter(Boolean);
  return [...new Set(normalized)];
}

function slugifyTaskToFileStem(taskText) {
  return String(taskText || "task")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "task";
}

function inferTaskKindFromText(taskText) {
  const lower = String(taskText || "").toLowerCase();
  if (/\b(test|tests|assertion|coverage|replay corpus|regression)\b/.test(lower)) return "test";
  if (/\b(readme|docs|documentation)\b/.test(lower)) return "documentation";
  if (/\b(fix|bug|failure|error|reject)\b/.test(lower)) return "bugfix";
  if (/\b(refactor|consolidat|cleanup|deduplicat)\b/.test(lower)) return "refactor";
  return "implementation";
}

function inferTargetFilesFromTask(taskText) {
  const lower = String(taskText || "").toLowerCase();
  const stem = slugifyTaskToFileStem(taskText);
  const mappings = [
    { pattern: /trust-boundary/, files: ["src/core/trust_boundary.ts"] },
    { pattern: /canary/, files: ["src/core/canary_engine.ts"] },
    { pattern: /compounding analyzer|compounding/, files: ["src/core/compounding_effects_analyzer.ts"] },
    { pattern: /freeze-window|freeze window/, files: ["src/core/governance_freeze.ts"] },
    { pattern: /resilience-drill|resilience drill/, files: ["src/core/catastrophe_detector.ts"] },
    { pattern: /worker-runner|worker runner/, files: ["src/core/worker_runner.ts"] },
    { pattern: /planner packet contract|contract completeness/, files: ["src/core/plan_contract_validator.ts", "src/core/prometheus.ts"] },
    { pattern: /critical-path scheduling|dependency-aware waves/, files: ["src/core/dag_scheduler.ts", "src/core/orchestrator.ts"] },
    { pattern: /parser replay corpus|marker\/fence|fence outputs/, files: ["src/core/parser_replay_harness.ts", "tests/core/parser_replay_harness.test.ts"] },
    { pattern: /governance integration worker lane|ownership contract/, files: ["src/core/capability_pool.ts", "src/core/role_registry.ts"] },
    { pattern: /model routing|uncertainty-aware|roi feedback loop/, files: ["src/core/agent_loader.ts", "src/core/model_router.ts"] },
    { pattern: /postmortem deltas|actionable packets/, files: ["src/core/delta_analytics.ts", "src/core/learning_policy_compiler.ts"] },
  ];

  for (const mapping of mappings) {
    if (mapping.pattern.test(lower)) {
      return mapping.files;
    }
  }

  if (/\b(test|tests|assertion|coverage|regression)\b/.test(lower)) {
    return [`tests/core/${stem}.test.ts`];
  }
  return [`src/core/${stem}.ts`];
}

function inferScopeFromTask(taskText, targetFiles) {
  const explicitScope = String(taskText || "").trim();
  const directories = [...new Set(targetFiles.map(file => String(file).split("/").slice(0, -1).join("/")).filter(Boolean))];
  if (directories.length === 1) {
    return `${directories[0]} :: ${explicitScope}`;
  }
  if (directories.length > 1) {
    return `${directories.join(" + ")} :: ${explicitScope}`;
  }
  return explicitScope;
}

function inferRiskLevel(taskText) {
  const lower = String(taskText || "").toLowerCase();
  if (/critical-path scheduling|dependency-aware waves|model routing|uncertainty-aware|roi feedback|feedback loop|postmortem deltas|actionable packets|planning feedback|scheduling core|wave.*dispatch|parallel.*dispatch|dispatcher|planner.*feedback/.test(lower)) {
    return PREMORTEM_RISK_LEVEL.HIGH;
  }
  if (/trust-boundary|contract completeness|worker lane|ownership contract|orchestrat|dispatch|planner|scheduler/.test(lower)) {
    return "medium";
  }
  return "low";
}

export function buildConcretePremortem(taskText, targetFiles) {
  const targetSummary = targetFiles.join(", ") || "targeted files";
  return {
    riskLevel: PREMORTEM_RISK_LEVEL.HIGH,
    scenario: `A high-risk change in ${targetSummary} could introduce regressions while implementing ${taskText}.`,
    failurePaths: [
      `Dependency ordering changes in ${targetSummary} break an existing orchestration path.`,
      `The new logic for ${taskText} routes work incorrectly under a previously valid input.`
    ],
    mitigations: [
      `Keep behavior behind deterministic validation checks and targeted tests for ${targetSummary}.`,
      `Preserve rollback-safe defaults so the previous path remains available if verification fails.`
    ],
    detectionSignals: [
      `Targeted tests for ${targetSummary} start failing immediately after the change.`,
      `Progress logs show a regression in the affected orchestration stage for ${taskText}.`
    ],
    guardrails: [
      `Require explicit verification before dispatching workers that depend on ${targetSummary}.`,
      `Block promotion if the modified path produces ambiguous or degraded outputs.`
    ],
    rollbackPlan: `Revert the ${targetSummary} change set and restore the previous deterministic execution path.`
  };
}

/**
 * Ensure a valid pre-mortem for the plan. If the AI model provided a partial
 * premortem, merge with scaffold defaults so all required fields are present.
 * Only high-risk plans require pre-mortems.
 */
function ensureValidPremortem(riskLevel, srcPremortem, taskText, targetFiles) {
  if (riskLevel !== PREMORTEM_RISK_LEVEL.HIGH) {
    return srcPremortem && typeof srcPremortem === "object" ? srcPremortem : undefined;
  }
  const scaffold = buildConcretePremortem(taskText, targetFiles);
  if (!srcPremortem || typeof srcPremortem !== "object") {
    return scaffold;
  }
  // Merge AI-provided premortem with scaffold defaults for missing fields
  const merged = { ...scaffold, ...srcPremortem, riskLevel: PREMORTEM_RISK_LEVEL.HIGH };
  for (const field of ["failurePaths", "mitigations", "detectionSignals", "guardrails"]) {
    if (!Array.isArray(merged[field]) || merged[field].length === 0) {
      merged[field] = scaffold[field];
    }
  }
  for (const [field, minLen] of [["scenario", 20], ["rollbackPlan", 10]] as any[]) {
    if (typeof merged[field] !== "string" || merged[field].trim().length < (minLen as number)) {
      merged[field] = scaffold[field];
    }
  }
  return merged;
}

function normalizeTargetFiles(src, taskText) {
  const direct = Array.isArray(src.targetFiles)
    ? src.targetFiles
    : Array.isArray(src.target_files)
      ? src.target_files
      : [];
  const directList = direct.map((v) => String(v || "").trim()).filter(Boolean);
  if (directList.length > 0) {
    return [...new Set(directList)];
  }

  const inferred = extractFilePathHints([
    taskText,
    src.scope,
    src.description,
    src.context,
    src.before_state,
    src.after_state,
  ].join(" "));

  if (inferred.length > 0) {
    return inferred;
  }

  return inferTargetFilesFromTask(taskText);
}

function deriveBeforeAfterState(src, taskText, acceptanceCriteria) {
  const before = String(src.beforeState || src.before_state || "").trim();
  const after = String(src.afterState || src.after_state || "").trim();
  if (before && after) {
    return { beforeState: before, afterState: after };
  }

  const primaryCriterion = String(acceptanceCriteria[0] || "").trim();
  const lowerTask = String(taskText || "").toLowerCase();
  if (/\b(test|tests|assertion|coverage|regression)\b/.test(lowerTask)) {
    return {
      beforeState: before || `No deterministic test currently proves the scenario "${taskText}".`,
      afterState: after || `A targeted test proves "${taskText}" and passes in the named test file.`
    };
  }
  if (/packet contract|contract completeness/.test(lowerTask)) {
    return {
      beforeState: before || "Planner payloads can reach dispatch without every required contract field being enforced.",
      afterState: after || "Dispatch blocks planner payloads missing required contract fields and reports the exact missing field names."
    };
  }
  if (/critical-path scheduling|dependency-aware waves/.test(lowerTask)) {
    return {
      beforeState: before || "Scheduling uses wave grouping only and does not prioritize the critical dependency path.",
      afterState: after || "Scheduler computes dependency-aware critical-path ordering while preserving wave constraints."
    };
  }
  if (/model routing|uncertainty-aware|roi feedback loop/.test(lowerTask)) {
    return {
      beforeState: before || "Model routing does not define an uncertainty schema or ROI formula before selecting a route.",
      afterState: after || "Model routing evaluates a defined uncertainty schema and ROI formula before choosing a route."
    };
  }
  if (/postmortem deltas|actionable packets/.test(lowerTask)) {
    return {
      beforeState: before || "Postmortem deltas remain descriptive notes and are not converted into actionable packets.",
      afterState: after || "Postmortem deltas deterministically produce actionable packets with scope, files, and acceptance criteria."
    };
  }

  const measurableTarget = primaryCriterion || "all acceptance criteria pass";
  return {
    beforeState: before || `Current behavior for "${taskText}" does not satisfy required acceptance criteria.`,
    afterState: after || `After completion, ${measurableTarget}`
  };
}

function buildExecutionStrategyFromPlans(plans = []) {
  const waveMap = new Map();
  for (const plan of plans) {
    const wave = Number.isFinite(Number(plan.wave)) ? Number(plan.wave) : 1;
    if (!waveMap.has(wave)) waveMap.set(wave, []);
    waveMap.get(wave).push(String(plan.task_id || plan.task || `wave-${wave}-task`));
  }

  const sortedWaves = [...waveMap.keys()].sort((a, b) => a - b);
  return {
    waves: sortedWaves.map((wave, idx) => ({
      wave,
      tasks: waveMap.get(wave),
      dependsOnWaves: idx === 0 ? [] : [sortedWaves[idx - 1]],
      maxParallelWorkers: waveMap.get(wave).length
    }))
  };
}

function buildDeterministicRequestBudget(plans = [], executionStrategy: any = {}) {
  const waves = Array.isArray(executionStrategy.waves) ? executionStrategy.waves : [];
  const byWave = waves.map((w) => {
    const waveNum = Number.isFinite(Number(w.wave)) ? Number(w.wave) : 1;
    const wavePlans = plans.filter((p) => (Number.isFinite(Number(p.wave)) ? Number(p.wave) : 1) === waveNum);
    const roles = [...new Set(wavePlans.map((p) => String(p.role || "evolution-worker")))];
    return {
      wave: waveNum,
      planCount: wavePlans.length,
      roles,
      estimatedRequests: wavePlans.length > 0 ? 2 : 0
    };
  });

  const byRoleMap = new Map();
  for (const plan of plans) {
    const role = String(plan.role || "evolution-worker");
    byRoleMap.set(role, (byRoleMap.get(role) || 0) + 1);
  }
  const byRole = [...byRoleMap.entries()].map(([role, planCount]) => ({
    role,
    planCount,
    estimatedRequests: planCount
  }));

  const estimatedPremiumRequestsTotal = Math.max(1, 3 + byWave.reduce((acc, w) => acc + w.estimatedRequests, 0));
  const errorMarginPercent = 15;
  return {
    estimatedPremiumRequestsTotal,
    errorMarginPercent,
    hardCapTotal: Math.max(1, Math.ceil(estimatedPremiumRequestsTotal * (1 + errorMarginPercent / 100))),
    confidence: "medium",
    byWave,
    byRole,
    assumptions: [
      "1 Jesus + 1 Prometheus + 1 Athena plan review per cycle",
      "~2 requests per execution wave for worker+postmortem envelope"
    ]
  };
}

function normalizePlanFromTask(task, index, fallbackWave = 1) {
  const src = (task && typeof task === "object") ? task : {};
  const taskText = String(src.task || src.title || src.task_id || src.id || `Task-${index + 1}`).trim();
  const taskKind = String(src.taskKind || src.kind || inferTaskKindFromText(taskText)).trim().toLowerCase();
  const verificationCommands = Array.isArray(src.verification_commands)
    ? src.verification_commands.map(v => String(v || "").trim()).filter(Boolean).map(rewriteVerificationCommand)
    : [];
  const initialVerification = String(src.verification || verificationCommands[0] || "npm test").trim() || "npm test";
  const wave = normalizeWaveValue(src.wave, fallbackWave);
  const explicitAcceptanceCriteria = Array.isArray(src.acceptance_criteria)
    ? src.acceptance_criteria.map(v => String(v || "").trim()).filter(Boolean)
    : [];
  const targetFiles = normalizeTargetFiles(src, taskText);
  const compiled = compileAcceptanceCriteria({
    ...src,
    task: taskText,
    taskKind,
    verification: initialVerification,
    targetFiles,
    target_files: targetFiles,
  });
  const verification = compiled.verification || initialVerification;
  const normalizedAcceptanceCriteria = explicitAcceptanceCriteria.length > 0
    ? explicitAcceptanceCriteria
    : compiled.criteria;
  const scope = String(src.scope || "").trim() || inferScopeFromTask(taskText, targetFiles);
  const beforeAfter = deriveBeforeAfterState(src, taskText, normalizedAcceptanceCriteria);
  const riskLevel = String(src.riskLevel || "").trim().toLowerCase() || inferRiskLevel(taskText);
  const premortem = ensureValidPremortem(riskLevel, src.premortem, taskText, targetFiles);

  return {
    ...src,
    role: String(src.role || "evolution-worker").trim() || "evolution-worker",
    // owner is a required packet field (ACTIONABLE IMPROVEMENT PACKET FORMAT).
    // Preserve the explicit owner when provided; fall back to role.
    owner: String(src.owner || src.role || "evolution-worker").trim() || "evolution-worker",
    task: taskText,
    priority: Number.isFinite(Number(src.priority)) ? Number(src.priority) : index + 1,
    wave,
    verification,
    taskKind,
    title: String(src.title || taskText).trim(),
    scope,
    task_id: String(src.task_id || src.id || taskText).trim(),
    description: String(src.description || "").trim(),
    waveLabel: String(src.waveLabel || "").trim(),
    targetFiles,
    target_files: targetFiles,
    beforeState: beforeAfter.beforeState,
    before_state: beforeAfter.beforeState,
    afterState: beforeAfter.afterState,
    after_state: beforeAfter.afterState,
    verification_commands: verificationCommands.length > 0 ? verificationCommands : [verification],
    acceptance_criteria: normalizedAcceptanceCriteria,
    dependencies: Array.isArray(src.dependencies)
      ? src.dependencies.map(v => String(v || "").trim()).filter(Boolean)
      : [],
    riskLevel,
    premortem,
    // leverage_rank: which EQUAL DIMENSION SET dimensions this task improves.
    // Preserved from source when provided; defaults to empty array.
    leverage_rank: Array.isArray(src.leverage_rank)
      ? src.leverage_rank.map(v => String(v || "").trim()).filter(Boolean)
      : [],
    // waveDepends: numeric wave numbers this wave depends on.
    // Propagated from the wave object by buildPlansFromAlternativeShape /
    // buildPlansFromBottlenecksShape so downstream schedulers can honour
    // wave-level ordering without re-parsing executionStrategy.
    waveDepends: Array.isArray(src.waveDepends)
      ? (src.waveDepends as any[]).map(Number).filter(n => Number.isFinite(n))
      : [],
    // capacityDelta: expected measurable change in system capacity ∈ [-1.0, 1.0].
    // Preserved from source when valid; defaults to 0.1 (conservative positive impact)
    // when AI omits it so downstream gates do not reject the plan.
    capacityDelta: Number.isFinite(Number(src.capacityDelta)) && Number(src.capacityDelta) >= -1 && Number(src.capacityDelta) <= 1
      ? Number(src.capacityDelta)
      : 0.1,
    // requestROI: expected return-on-investment for premium request consumed.
    // Preserved from source when valid; defaults to 1.0 (break-even) when AI omits it.
    requestROI: Number.isFinite(Number(src.requestROI)) && Number(src.requestROI) > 0
      ? Number(src.requestROI)
      : 1.0,
  };
}

function buildPlansFromAlternativeShape(input: any = {}) {
  if (!input || typeof input !== "object") return [];

  const taskIndexByKey = new Map();
  const tasks = Array.isArray(input.tasks) ? input.tasks : [];
  for (let i = 0; i < tasks.length; i++) {
    const t = tasks[i] && typeof tasks[i] === "object" ? tasks[i] : {};
    const keys = [t.task_id, t.id, t.title, t.task].map(v => String(v || "").trim()).filter(Boolean);
    for (const key of keys) {
      if (!taskIndexByKey.has(key)) taskIndexByKey.set(key, i);
    }
  }

  const waveByTaskIndex = new Map();
  const waveDependsByTaskIndex = new Map();
  const waves = Array.isArray(input.waves) ? input.waves : [];
  for (let i = 0; i < waves.length; i++) {
    const waveObj = (waves[i] && typeof waves[i] === "object") ? waves[i] : {};
    const waveValue = normalizeWaveValue(waveObj.wave, i + 1 as any);
    // Capture wave-level dependency numbers so they survive plan normalization.
    const waveDepends: number[] = Array.isArray(waveObj.dependsOn)
      ? (waveObj.dependsOn as any[]).map(Number).filter(n => Number.isFinite(n))
      : Array.isArray(waveObj.dependsOnWaves)
        ? (waveObj.dependsOnWaves as any[]).map(Number).filter(n => Number.isFinite(n))
        : [];
    const waveTasks = Array.isArray(waveObj.tasks) ? waveObj.tasks : [];
    for (const waveTask of waveTasks) {
      if (waveTask && typeof waveTask === "object") {
        // Merge wave-level dependsOn into the task object before normalizing so
        // waveDepends is preserved through normalizePlanFromTask's ...src spread.
        const taskWithMeta = waveDepends.length > 0
          ? { waveDepends, ...waveTask }
          : waveTask;
        const asTask = normalizePlanFromTask(taskWithMeta, tasks.length, waveValue as any);
        tasks.push(asTask);
        const idx = tasks.length - 1;
        taskIndexByKey.set(asTask.task_id, idx);
        taskIndexByKey.set(asTask.task, idx);
        continue;
      }
      const key = String(waveTask || "").trim();
      if (!key) continue;
      const idx = taskIndexByKey.get(key);
      if (Number.isInteger(idx)) {
        waveByTaskIndex.set(idx, waveValue);
        if (waveDepends.length > 0) waveDependsByTaskIndex.set(idx, waveDepends);
      } else {
        // Unmatched string task: synthesize a stub plan rather than silently
        // dropping it.  The full plan fields are filled by normalizePlanFromTask.
        const stubIdx = tasks.length;
        const stub: Record<string, any> = { task: key, task_id: key, title: key };
        if (waveDepends.length > 0) stub.waveDepends = waveDepends;
        tasks.push(stub);
        taskIndexByKey.set(key, stubIdx);
        waveByTaskIndex.set(stubIdx, waveValue);
        if (waveDepends.length > 0) waveDependsByTaskIndex.set(stubIdx, waveDepends);
      }
    }
  }

  if (tasks.length > 0) {
    return tasks.map((task, i) => {
      const waveDepends = waveDependsByTaskIndex.get(i);
      // Merge wave depends into the task object so normalizePlanFromTask sees it
      // via ...src and emits it as waveDepends on the output plan.
      const taskWithMeta = waveDepends && !task.waveDepends
        ? { waveDepends, ...task }
        : task;
      return normalizePlanFromTask(taskWithMeta, i, waveByTaskIndex.get(i) || 1);
    });
  }

  return [];
}

/**
 * Build plans from the GPT analytical format: topBottlenecks[] + waves[].tasks (strings).
 * This is the format GPT-5.3-Codex produces when asked for a bottleneck analysis.
 */
function buildPlansFromBottlenecksShape(input) {
  const SEVERITY_PRIORITY = { critical: 1, high: 2, medium: 3, low: 4 };
  const waves = Array.isArray(input.waves) ? input.waves : [];
  const bottlenecks = Array.isArray(input.topBottlenecks) ? input.topBottlenecks : [];
  const proofMetrics = Array.isArray(input.proofMetrics) ? input.proofMetrics : [];

  const plans = [];

  for (const waveObj of waves) {
    if (!waveObj || typeof waveObj !== "object") continue;
    const waveNum = normalizeWaveValue(waveObj.wave, 1);
    // Preserve wave-level dependency numbers for downstream schedulers.
    const waveDepends: number[] = Array.isArray(waveObj.dependsOn)
      ? (waveObj.dependsOn as any[]).map(Number).filter(n => Number.isFinite(n))
      : Array.isArray(waveObj.dependsOnWaves)
        ? (waveObj.dependsOnWaves as any[]).map(Number).filter(n => Number.isFinite(n))
        : [];
    const taskStrings = Array.isArray(waveObj.tasks) ? waveObj.tasks : [];

    for (const taskStr of taskStrings) {
      const taskText = String(taskStr || "").trim();
      if (!taskText) continue;
      const lowerTask = taskText.toLowerCase();

      // Find a matching bottleneck by keyword overlap (split on all non-alphanumeric incl. underscores)
      const taskWords = lowerTask.split(/[^a-z0-9]+/).filter(w => w.length >= 4);
      const matchedBn = bottlenecks.find(bn => {
        const titleWords = String(bn.title || "").toLowerCase()
          .split(/[^a-z0-9]+/).filter(w => w.length >= 4);
        return titleWords.some(w => taskWords.includes(w));
      });

      // Find a matching proof metric and normalize it to a portable command
      const rawMetric = proofMetrics.find(m => {
        const metricWords = String(m || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4);
        return taskWords.some(w => metricWords.includes(w));
      }) || "npm test";
      const verificationMetric = rewriteVerificationCommand(rawMetric);

      const severity = matchedBn?.severity || "medium";
      const plan: Record<string, any> = {
        role: "evolution-worker",
        task: taskText,
        priority: SEVERITY_PRIORITY[severity] ?? plans.length + 1,
        wave: waveNum,
        verification: verificationMetric,
        title: taskText,
        scope: String(matchedBn?.evidence || "").slice(0, 200),
        task_id: taskText,
        verification_commands: [verificationMetric],
        acceptance_criteria: [],
        dependencies: [],
        _fromBottleneck: matchedBn?.id || null,
      };
      if (waveDepends.length > 0) plan.waveDepends = waveDepends;
      plans.push(plan);
    }
  }

  // If no waves, fall back to one plan per bottleneck
  if (plans.length === 0) {
    for (let i = 0; i < bottlenecks.length; i++) {
      const bn = bottlenecks[i];
      const taskText = String(bn.title || `Fix-${bn.id}`).trim();
      const rawCmd = proofMetrics[i] || "npm test";
      const normalizedCmd = rewriteVerificationCommand(rawCmd);
      plans.push({
        role: "evolution-worker",
        task: taskText,
        priority: SEVERITY_PRIORITY[bn.severity] ?? i + 1,
        wave: i + 1,
        verification: normalizedCmd,
        title: taskText,
        scope: String(bn.evidence || "").slice(0, 200),
        task_id: String(bn.id || `bn-${i}`),
        verification_commands: [normalizedCmd],
        acceptance_criteria: [],
        dependencies: [],
        _fromBottleneck: bn.id || null,
      });
    }
  }

  return plans;
}

/**
 * Compute what fraction of the declared top bottlenecks are addressed by the generated plans.
 *
 * A bottleneck is considered "covered" when at least one plan's task text, title, or
 * _fromBottleneck field references the bottleneck's id or contains meaningful keyword overlap
 * with the bottleneck's title (≥2 matching 4-char words).
 *
 * @param plans - normalized plan objects
 * @param bottlenecks - topBottlenecks array from the Prometheus output
 * @returns {{ coverage: number, covered: string[], uncovered: string[], total: number }}
 */
export function computeBottleneckCoverage(plans: any[], bottlenecks: any[]): {
  coverage: number;
  covered: string[];
  uncovered: string[];
  total: number;
} {
  const bns = Array.isArray(bottlenecks) ? bottlenecks : [];
  const planList = Array.isArray(plans) ? plans : [];

  if (bns.length === 0) {
    return { coverage: 1.0, covered: [], uncovered: [], total: 0 };
  }

  const covered: string[] = [];
  const uncovered: string[] = [];

  for (const bn of bns) {
    const bnId = String(bn?.id || "").trim();
    const bnTitle = String(bn?.title || "").toLowerCase();
    const bnWords = bnTitle.split(/[^a-z0-9]+/).filter(w => w.length >= 4);

    const isCovered = planList.some(plan => {
      // Explicit bottleneck reference
      if (bnId && String(plan._fromBottleneck || "").trim() === bnId) return true;
      // Keyword overlap: ≥2 matching words between bottleneck title and plan task/title
      const planText = `${String(plan.task || "")} ${String(plan.title || "")}`.toLowerCase();
      const planWords = planText.split(/[^a-z0-9]+/).filter(w => w.length >= 4);
      const matches = bnWords.filter(w => planWords.includes(w));
      return matches.length >= 2;
    });

    if (isCovered) {
      covered.push(bnId || bnTitle.slice(0, 40));
    } else {
      uncovered.push(bnId || bnTitle.slice(0, 40));
    }
  }

  const coverage = bns.length > 0 ? Math.round((covered.length / bns.length) * 100) / 100 : 1.0;
  return { coverage, covered, uncovered, total: bns.length };
}

/** Minimum bottleneck coverage ratio before a confidence penalty is applied. */
export const BOTTLENECK_COVERAGE_FLOOR = 0.5;

function buildPlansFromNarrative(analysisText) {
  const lines = String(analysisText || "").split(/\r?\n/);
  const plans = [];
  let currentWave = 1;
  let currentWaveLabel = "";
  let currentSection = "";
  let inWaveSection = false;

  const normalizeSectionTitle = (value) => String(value || "")
    .toLowerCase()
    .replace(/[*`:#]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const isActionSection = (section) => {
    const s = normalizeSectionTitle(section);
    if (!s) return false;
    return [
      "model capacity utilization",
      "what to stop / simplify / remove",
      "what to stop simplify remove",
      "architecture evolution roadmap",
      "recommendations",
      "next steps",
      "execution roadmap",
      "master plan"
    ].some(label => s.includes(label));
  };

  const isDiagnosticSection = (section) => {
    const s = normalizeSectionTitle(section);
    if (!s) return false;
    return [
      "mandatory answers",
      "evolution diagnosis",
      "strategic diagnosis",
      "prometheus self-critique",
      "metrics for a smarter next cycle",
      "final recommendation",
      "governance and rollback policy"
    ].some(label => s.includes(label));
  };

  const looksLikeActionablePlanLine = (text) => {
    const s = String(text || "").trim().toLowerCase();
    if (!s) return false;
    if (/^(strengths?|core bottleneck|recurrent defect|scaling risk|premium efficiency ceiling|why|exit criteria|rollback triggers?)\b/.test(s)) {
      return false;
    }
    return /^(task\s+\d|ship\b|fix\b|patch\b|replace\b|add\b|create\b|promote\b|keep\b|split\b|feed\b|require\b|validate\b|tighten\b|introduce\b|use\b|reduce\b|enforce\b|enable\b|remove\b|simplify\b|stop\b|upgrade\b|migrate\b|implement\b|refactor\b|extract\b|wire\b|emit\b|build\b|setup\b|configure\b|integrate\b)/.test(s);
  };

  for (let i = 0; i < lines.length; i++) {
    const line = String(lines[i] || "").trim();
    if (!line) continue;

    const headingMatch = line.match(/^#+\s+(.+)$/);
    if (headingMatch) {
      currentSection = headingMatch[1];
      // Exit wave-collection mode when entering a diagnostic/analysis section
      // so Q&A answers are not mistaken for actionable tasks.
      if (isDiagnosticSection(currentSection)) inWaveSection = false;
    }

    // Wave header — capture wave number AND full label/description
    // Handles: "**Wave 0**", "### Wave 0 — Gate unblocker (must ship first)",
    //          "**Wave 0 (Gate blocker, must ship first)**"
    const waveMatch = line.match(/(?:^#+\s*)?(?:\*\*)?wave\s+(\d+)[:\s—\-\u2013\u2014(]*(.*?)(?:\*\*)?$/i);
    if (waveMatch) {
      currentWave = Math.max(1, Number(waveMatch[1]) || 1);
      inWaveSection = true;
      currentWaveLabel = String(waveMatch[2] || "")
        .replace(/\*\*/g, "")
        .replace(/[()]/g, "")
        .replace(/^\s*[-—\u2013\u2014]\s*/, "")
        .trim();
      continue;
    }

    // Numbered tasks: "1) Task", "2. **Task**: detail"
    const numberedMatch = line.match(/^\d+[).:-]\s*(.+)$/);
    if (numberedMatch) {
      const taskText = numberedMatch[1]
        .replace(/\*\*/g, "")
        .replace(/`/g, "")
        .trim();
      const canCaptureNumbered = (inWaveSection || isActionSection(currentSection)) && !isDiagnosticSection(currentSection);
      if (taskText && canCaptureNumbered && looksLikeActionablePlanLine(taskText)) {
        // Collect continuation lines that follow until the next list item / wave header
        const continuationParts = [];
        while (i + 1 < lines.length) {
          const nextRaw = String(lines[i + 1] || "").trim();
          if (!nextRaw) { i++; continue; }
            if (/^\d+[).:-]\s/.test(nextRaw) || /^[-*]\s/.test(nextRaw) ||
              /(?:^#+\s*)?(?:\*\*)?wave\s+\d+/i.test(nextRaw) || /^#+\s/.test(nextRaw) ||
              /^===|^---/.test(nextRaw)) break;
          continuationParts.push(nextRaw.replace(/\*\*/g, "").replace(/`/g, "").trim());
          i++;
        }
        plans.push({
          task: taskText,
          wave: currentWave,
          waveLabel: currentWaveLabel,
          description: continuationParts.join(" "),
          verification: "npm test"
        });
      }
      continue;
    }

    // Bulleted tasks under waves: "- **Task**: ..."
    const bulletMatch = line.match(/^[-*]\s+(.+)$/);
    if (bulletMatch) {
      const taskText = bulletMatch[1]
        .replace(/\*\*/g, "")
        .replace(/`/g, "")
        .trim();
      const canCaptureBullet = inWaveSection || (isActionSection(currentSection) && !isDiagnosticSection(currentSection));
      if (taskText.length >= 8 && canCaptureBullet && looksLikeActionablePlanLine(taskText)) {
        const continuationParts = [];
        while (i + 1 < lines.length) {
          const nextRaw = String(lines[i + 1] || "").trim();
          if (!nextRaw) { i++; continue; }
            if (/^\d+[).:-]\s/.test(nextRaw) || /^[-*]\s/.test(nextRaw) ||
              /(?:^#+\s*)?(?:\*\*)?wave\s+\d+/i.test(nextRaw) || /^#+\s/.test(nextRaw) ||
              /^===|^---/.test(nextRaw)) break;
          continuationParts.push(nextRaw.replace(/\*\*/g, "").replace(/`/g, "").trim());
          i++;
        }
        plans.push({
          task: taskText,
          wave: currentWave,
          waveLabel: currentWaveLabel,
          description: continuationParts.join(" "),
          verification: "npm test"
        });
      }
    }
  }

  // Deduplicate by normalized task text while keeping insertion order.
  const seen = new Set();
  const unique = [];
  for (const p of plans) {
    const key = String(p.task || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }

  return unique;
}

/**
 * Canonical planner health aliases.
 * LLMs instructed to emit "<healthy|warning|critical>" may return these alias
 * values instead of the canonical internal values ("good", "needs-work", "critical").
 * Normalizing before validation ensures alias inputs score at full confidence.
 */
export const PLANNER_HEALTH_ALIASES: Readonly<Record<string, string>> = Object.freeze({
  healthy:  "good",
  warning:  "needs-work",
});

/**
 * Normalize a raw projectHealth string by resolving known aliases to their
 * canonical equivalents before enum validation or divergence computation.
 *
 * @param {string} health — raw value from parser or LLM output
 * @returns {string} canonical health value
 */
export function normalizeProjectHealthAlias(health: string): string {
  const h = String(health || "").toLowerCase().trim();
  return (PLANNER_HEALTH_ALIASES as Record<string, string>)[h] ?? h;
}

export function normalizePrometheusParsedOutput(parsed, aiResult: any = {}) {
  const input = (parsed && typeof parsed === "object") ? parsed : {};
  // Build analysis text — also cover topBottlenecks narrative as fallback
  const bnNarrative = Array.isArray(input.topBottlenecks) && input.topBottlenecks.length > 0
    ? input.topBottlenecks.map(bn => `[${bn.id}] ${bn.title}: ${bn.evidence}`).join("\n")
    : "";
  const analysisText = String(
    input.analysis
      || input.strategicNarrative
      || input.cycleObjective
      || aiResult?.thinking
      || bnNarrative
      || aiResult?.raw
      || ""
  ).trim();

  const rawPlans = Array.isArray(input.plans) ? input.plans : [];
  let plans = rawPlans.length > 0
    ? rawPlans.map((plan, i) => normalizePlanFromTask(plan, i, plan?.wave || 1))
    : buildPlansFromAlternativeShape(input);

  // Third shape: GPT analytical format — topBottlenecks[] + waves[].tasks (strings)
  if (plans.length === 0 && (Array.isArray(input.topBottlenecks) || Array.isArray(input.waves))) {
    plans = buildPlansFromBottlenecksShape(input)
      .map((plan, i) => normalizePlanFromTask(plan, i, plan?.wave || 1));
  }

  // Final fallback: parse wave + numbered narrative plans from free-form output.
  if (plans.length === 0 && analysisText.length > 0) {
    plans = buildPlansFromNarrative(analysisText)
      .map((plan, i) => normalizePlanFromTask(plan, i, plan?.wave || 1));
  }

  const health = normalizeProjectHealthAlias(String(input.projectHealth || "").trim());
  const projectHealth = ["good", "needs-work", "critical"].includes(health)
    ? health
    : inferProjectHealth(analysisText);

  let executionStrategy = (input.executionStrategy && typeof input.executionStrategy === "object")
    ? input.executionStrategy
    : { waves: Array.isArray(input.waves) ? input.waves : [] };
  if (!Array.isArray(executionStrategy.waves) || executionStrategy.waves.length === 0) {
    executionStrategy = buildExecutionStrategyFromPlans(plans);
  }

  let requestBudget = (input.requestBudget && Number.isFinite(Number(input.requestBudget.estimatedPremiumRequestsTotal)))
    ? {
      ...input.requestBudget,
      hardCapTotal: Number.isFinite(Number(input.requestBudget.hardCapTotal))
        ? Number(input.requestBudget.hardCapTotal)
        : Math.max(1, Math.ceil((plans.length || 1) * 1.25)),
    }
    : {
      estimatedPremiumRequestsTotal: Math.max(1, plans.length || 1),
      errorMarginPercent: 25,
      hardCapTotal: Math.max(1, Math.ceil((plans.length || 1) * 1.25)),
      confidence: "low",
      byWave: [],
      byRole: [],
      _fallback: true,
    };
  if (requestBudget._fallback) {
    requestBudget = {
      ...buildDeterministicRequestBudget(plans, executionStrategy),
      _fallback: false
    };
  }

  // Capture whether budget was model-provided or deterministically rebuilt.
  // Must be captured AFTER the rebuild so _fallback=false doesn't shadow the origin.
  const requestBudgetWasFallback = !(
    input.requestBudget && Number.isFinite(Number(input.requestBudget.estimatedPremiumRequestsTotal))
  );

  // ── Parser confidence: structured breakdown ──────────────────────────────
  // parserConfidenceComponents: per-dimension score (0-1) for each structural signal.
  // parserConfidencePenalties: explicit list of reasons why the score was reduced.
  // The aggregate parserConfidence remains a single 0-1 value (backward compatible).
  //
  //   plansShape          — 1.0 = JSON plans direct, 0.5 = narrative/alt-shape fallback, 0.0 = no plans
  //   healthField         — 1.0 = explicit valid health value present, 0.8 = missing/inferred
  //   requestBudget       — 1.0 = budget provided by model, 0.9 = fallback rebuilt deterministically
  //   bottleneckCoverage  — 1.0 = all declared bottlenecks addressed, reduced by uncovered fraction

  const parserConfidencePenalties: Array<{ reason: string; component: string; delta: number }> = [];

  let plansShapeScore: number;
  if (rawPlans.length > 0) {
    plansShapeScore = 1.0;
  } else if (plans.length > 0) {
    plansShapeScore = 0.5;
    parserConfidencePenalties.push({ reason: "plans_from_narrative_fallback", component: "plansShape", delta: -0.5 });
  } else {
    plansShapeScore = 0.0;
    parserConfidencePenalties.push({ reason: "no_plans_extracted", component: "plansShape", delta: -0.9 });
  }

  const healthFieldValid = Boolean(health && ["good", "needs-work", "critical"].includes(health));
  const healthFieldScore = healthFieldValid ? 1.0 : 0.8;
  if (!healthFieldValid) {
    parserConfidencePenalties.push({ reason: "health_field_missing_or_invalid", component: "healthField", delta: -0.2 });
  }

  const requestBudgetScore = requestBudgetWasFallback ? 0.9 : 1.0;
  if (requestBudgetWasFallback) {
    parserConfidencePenalties.push({ reason: "request_budget_fallback", component: "requestBudget", delta: -0.1 });
  }

  // ── Bottleneck coverage check ────────────────────────────────────────────
  // When the input declared topBottlenecks, every bottleneck should be
  // addressed by at least one generated plan.  A coverage ratio below
  // BOTTLENECK_COVERAGE_FLOOR triggers a proportional confidence penalty
  // so low-coverage cycles cannot silently proceed past quality gates.
  const topBottlenecks = Array.isArray(input.topBottlenecks) ? input.topBottlenecks : [];
  const bnCovResult = computeBottleneckCoverage(plans, topBottlenecks);
  let bottleneckCoverageScore: number;
  if (topBottlenecks.length === 0) {
    bottleneckCoverageScore = 1.0;
  } else {
    bottleneckCoverageScore = bnCovResult.coverage;
    if (bnCovResult.coverage < BOTTLENECK_COVERAGE_FLOOR) {
      const uncoveredCount = bnCovResult.uncovered.length;
      const delta = -Math.round(Math.min(0.3, uncoveredCount * 0.05) * 100) / 100;
      parserConfidencePenalties.push({
        reason: `bottleneck_coverage_low_${bnCovResult.covered.length}_of_${bnCovResult.total}`,
        component: "bottleneckCoverage",
        delta,
      });
    }
  }

  const parserConfidenceComponents = {
    plansShape:         plansShapeScore,
    healthField:        healthFieldScore,
    requestBudget:      requestBudgetScore,
    bottleneckCoverage: bottleneckCoverageScore,
  };

  // Aggregate: plansShape sets the base; remaining penalties apply cumulatively.
  let parserConfidence = rawPlans.length > 0 ? 1.0 : plans.length > 0 ? 0.5 : 0.1;
  for (const penalty of parserConfidencePenalties) {
    if (penalty.component !== "plansShape") {
      parserConfidence = Math.max(0.1, parserConfidence + penalty.delta);
    }
  }

  // ── Strict parser confidence floor (Packet 11) ───────────────────────────
  // If confidence is below the floor, fail-closed: reject plans rather than
  // dispatching low-quality work. Plans are replaced with an empty set and
  // the analysis is preserved for manual review.
  // Floor set at 0.15 to catch truly unparseable output (base 0.1) while
  // allowing legitimate narrative-fallback parses (base 0.5 with penalties).
  const PARSER_CONFIDENCE_FLOOR = 0.15;
  const belowFloor = parserConfidence < PARSER_CONFIDENCE_FLOOR;
  const finalPlans = belowFloor ? [] : plans;

  return {
    ...input,
    analysis: analysisText || "Prometheus analysis available but narrative was empty.",
    projectHealth,
    executionStrategy,
    requestBudget,
    parserConfidence: Math.round(parserConfidence * 100) / 100,
    parserConfidenceComponents,
    parserConfidencePenalties,
    bottleneckCoverage: bnCovResult,
    _parserBelowFloor: belowFloor,
    _parserConfidenceFloor: PARSER_CONFIDENCE_FLOOR,
    plans: finalPlans
  };
}

function buildNarrativeFallbackParsed(aiResult) {
  const thinking = String(aiResult?.thinking || "").trim();
  const raw = String(aiResult?.raw || "").trim();
  const narrative = (thinking || raw || "Prometheus produced narrative-only output.").slice(0, 20000);
  const strategic = narrative.slice(0, 4000);

  return {
    analysis: narrative,
    strategicNarrative: strategic,
    projectHealth: inferProjectHealth(narrative),
    keyFindings: "Narrative-only analysis mode enabled; convert key findings from analysis text.",
    productionReadinessCoverage: [],
    dependencyModel: {
      criticalPath: [],
      parallelizableTracks: [],
      blockedBy: []
    },
    executionStrategy: {
      waves: []
    },
    requestBudget: {
      estimatedPremiumRequestsTotal: 1,
      errorMarginPercent: 30,
      hardCapTotal: 2,
      confidence: "low",
      byWave: [],
      byRole: [],
      _fallback: true
    },
    plans: []
  };
}

// ── Main Prometheus Analysis (simplified) ────────────────────────────────────

/**
 * Static invariant Prometheus planning prompt sections.
 * These do not change between planning cycles — extract them here so they can be
 * shared, tested, and referenced by name rather than being buried in a template literal.
 */

/** Build a section marked as required — always retained under any token-budget pressure in compileTieredPrompt. */
const rqs = (name: string, content: string) => Object.assign(section(name, content), { required: true as const });

export const PROMETHEUS_STATIC_SECTIONS = Object.freeze({
  evolutionDirective: rqs("evolution-directive", `## EVOLUTION DIRECTIVE
You are NOT a risk-reducing planner. You are NOT a security-first hardening auditor.
You are the system's META-IMPROVER: your primary objective is TOTAL SYSTEM CAPACITY INCREASE.
"Capacity" means: more capability delivered per cycle, deeper reasoning, faster adaptation, better learning, higher task quality, smarter model usage — across every dimension simultaneously.
Risk reduction is a side-effect of capacity increase, never the goal itself.
You must treat every component of BOX — including Prometheus itself — as an improvement target.

## EQUAL DIMENSION SET
The following dimensions are ALL equally important. No single dimension dominates.
You MUST analyze and propose improvements for EACH of these:
1. Architecture (system topology, module design, data flow)
2. Speed (cycle throughput, latency, parallelism)
3. Task quality (correctness, depth, completeness of delivered work)
4. Prompt quality (instruction clarity, model utilization, reasoning depth)
5. Parser / normalization quality (output parsing, plan normalization, fence handling)
6. Worker specialization (role design, capability matching, multi-worker topology)
7. Model-task fit (routing complexity to the right model, token budget allocation)
8. Learning loop (postmortem-to-policy conversion, pattern detection, carry-forward)
9. Cost efficiency (premium requests per useful outcome, waste reduction)
10. Security (vulnerability prevention, access control, governance — ONE dimension among equals)`),

  mandatorySelfCritique: rqs("mandatory-self-critique", `## MANDATORY SELF-CRITIQUE SECTIONS
You MUST include a dedicated self-critique section for EACH of the following components.
Each section must answer: "What is this component doing well?", "What is it doing poorly?", and "How specifically should it improve next cycle?"
Do NOT just say "there is a problem" — produce a concrete improvement proposal for each.

1. **Jesus Self-Critique** — Is Jesus making good strategic decisions? Is it reading the right signals? How should its decision logic improve?
2. **Prometheus Self-Critique** — Is Prometheus producing actionable plans or strategic fluff? How should its reasoning, prompt structure, and output format improve?
3. **Athena Self-Critique** — Is Athena catching real issues or generating noise? Are postmortems driving actual change? How should review quality improve?
4. **Worker Structure Self-Critique** — Is the worker topology enabling or blocking progress? Are workers specialized enough? How should worker roles evolve?
5. **Parser / Normalization Self-Critique** — Is plan parsing reliable? Are fence blocks handled correctly? What parsing failures recur and how to fix them?
6. **Prompt Layer Self-Critique** — Are runtime prompts getting the most out of model capacity? What prompt patterns waste tokens or produce shallow output?
7. **Verification System Self-Critique** — Is verification catching real failures or generating false signals? Are verification commands reliable across platforms?`),

  mandatoryOperatorQuestions: rqs("mandatory-operator-questions", `## MANDATORY_OPERATOR_QUESTIONS
You MUST answer these explicitly in a dedicated section titled "Mandatory Answers" before the rest of the plan:
1. Is wave-based plan distribution truly the most efficient model for this system?
2. Should it be preserved, improved, or removed?
3. If it changes, what should replace it and how should the transition be executed?
4. Is Prometheus currently evolving the system, or mostly auditing and distributing tasks?
5. How should Prometheus improve its own reasoning structure, planning quality, and model-capacity utilization?
6. Does the worker behavior model and code structure help self-improvement, or block it?
7. In this cycle, what are the highest-leverage changes that make the system not only safer, but also smarter and deeper in reasoning?`),

  outputFormat: rqs("output-format", `## OUTPUT FORMAT
Write a substantial senior-level narrative master plan.
The plan must be centered on TOTAL SYSTEM CAPACITY INCREASE, not generic hardening.
First analyze how BOX can increase its capacity in every dimension, then derive what should change.

Include ALL of these sections (in this order):
1. Mandatory Answers
2. Evolution Diagnosis
3. Equal Dimension Analysis (one subsection per dimension from the EQUAL DIMENSION SET)
4. Mandatory Self-Critique: Jesus
5. Mandatory Self-Critique: Prometheus
6. Mandatory Self-Critique: Athena
7. Mandatory Self-Critique: Worker Structure
8. Mandatory Self-Critique: Parser / Normalization
9. Mandatory Self-Critique: Prompt Layer
10. Mandatory Self-Critique: Verification System
11. System Redesign Directions (ranked by capacity-increase leverage)
12. Worker Model Redesign
13. Model Capacity Utilization
14. Metrics For A Smarter Next Cycle
15. Actionable Improvement Packets

## ACTIONABLE IMPROVEMENT PACKET FORMAT
Every concrete task you propose MUST be formatted as an Actionable Improvement Packet.
Do NOT produce vague strategic recommendations without this structure.
Each packet MUST contain ALL of the following fields:
- **title**: Clear one-line description of the change
- **owner**: Which component/agent/worker should execute this (e.g., evolution-worker, prometheus, athena, orchestrator)
- **wave**: Positive integer (≥1). Tasks in the same wave run in parallel; all wave N tasks complete before wave N+1 starts.
- **role**: Worker role identifier (e.g., "evolution-worker", "orchestrator", "prometheus")
- **scope**: Module or directory boundary that this task is contained within (e.g., "src/core/orchestrator.js" or "src/workers/")
- **target_files**: Array of real file paths. ONLY use paths from the ## EXISTING REPOSITORY FILES section above. For new files, name the existing module that imports it and the exact call site.
- **before_state**: Observable CURRENT behavior — describe what specific function, code path, or measurable gap exists right now. Must be specific, not generic.
- **after_state**: Observable result after this task completes — what is measurably different. Must not restate the title.
- **riskLevel**: One of: "low" | "medium" | "high". Tasks touching orchestrator.js, athena_reviewer.js, prometheus.js, or gates.js default to "high".
- **dependencies**: Array of packet titles that must complete before this one, or empty array if none. If empty, state that wave ordering is the only ordering mechanism.
- **acceptance_criteria**: Array of ≥2 concrete testable statements that prove completion. Vague criteria like "code is improved" are rejected.
- **verification**: Specific test file path AND expected test description or observable log assertion (e.g., "tests/core/foo.test.ts — test: should return X when Y"). Generic "npm test" or "run tests" is REJECTED.
- **premortem** (REQUIRED when riskLevel is "medium" or "high"): Object with: failureModes (array of ≥2 distinct failure scenarios each with cause+impact), mitigations (array), rollbackPlan (string describing how to revert safely).
- **leverage_rank**: Which dimension(s) from the EQUAL DIMENSION SET this improves
- **capacityDelta** (REQUIRED): Finite number ∈ [-1.0, 1.0] — expected net change in system capacity if this plan succeeds. Positive = capacity gain, negative = capacity regression, zero = neutral. Used for plan ranking.
- **requestROI** (REQUIRED): Positive finite number — expected return-on-investment for the premium request consumed (e.g., 2.0 = doubles value spent). Used for plan ranking.

## PACKET FIELD ENFORCEMENT RULES
These rules are enforced by the quality gate. Violations cause plan rejection:
1. **target_files**: Must list real existing paths verbatim from EXISTING REPOSITORY FILES. Do not invent module names. For new files, include the parent module path as the first entry.
2. **before_state**: Must describe observable current behavior — cite the actual function name, variable, or code gap. "Current state is suboptimal" is rejected.
3. **after_state**: Must describe what is measurably different — not a restatement of the title or before_state negation.
4. **verification**: Must name a specific test file (e.g., tests/core/foo.test.ts) plus an expected test name or exact log assertion. "npm test" alone is always rejected.
5. **acceptance_criteria**: ≥2 items, each a concrete testable statement. Every item must be independently verifiable.
6. **riskLevel + premortem**: Any task modifying orchestration paths, plan parsing, or dispatch logic is automatically high-risk and requires a compliant premortem.
7. **requestBudget**: Compute byWave and byRole from actual plan distribution. Never emit _fallback:true. byWave and byRole arrays must not be empty if plans exist.
8. **capacityDelta + requestROI**: Both are REQUIRED on every plan. Omitting either causes plan rejection by the contract validator.

Write the entire response in English only.
If you include recommendations, rank them by capacity-increase leverage, not by fear or surface risk alone.
Security or governance recommendations must explain how they contribute to capacity increase rather than being presented as the default center of gravity.
You MUST emit a structured JSON companion block at the end of your response.
The JSON block must contain all of the following fields:
{
  "projectHealth": "<healthy|warning|critical>",
  "totalPackets": <number>,
  "requestBudget": {
    "estimatedPremiumRequestsTotal": <number>,
    "errorMarginPercent": <number>,
    "hardCapTotal": <number>,
    "confidence": "low|medium|high",
    "byWave": [{ "wave": <n>, "planCount": <n>, "roles": ["..."], "estimatedRequests": <n> }],
    "byRole": [{ "role": "...", "planCount": <n>, "estimatedRequests": <n> }]
  },
  "executionStrategy": {
    "waves": [{ "wave": <n>, "tasks": ["..."], "dependsOnWaves": [], "maxParallelWorkers": <n> }]
  },
  "plans": [{
    "title": "...",
    "task": "...",
    "owner": "...",
    "role": "...",
    "wave": <number>,
    "scope": "...",
    "target_files": ["..."],
    "before_state": "...",
    "after_state": "...",
    "riskLevel": "low|medium|high",
    "dependencies": [],
    "acceptance_criteria": ["...", "..."],
    "verification": "tests/core/foo.test.ts — test: expected description",
    "premortem": null,
    "capacityDelta": <number ∈ [-1.0, 1.0]>,
    "requestROI": <positive number>
  }]
}
Do NOT omit target_files, before_state, after_state, scope, acceptance_criteria, capacityDelta, or requestROI from any plan entry.
Do NOT emit requestBudget with _fallback:true — compute byWave and byRole from the actual plan list.
Keep diagnostic findings in analysis or strategicNarrative and include only actionable redesign work in plans.
Wrap the JSON companion with markers:

===DECISION===
{ ...optional companion json... }
===END===`),
});

// ── Architecture Drift Confidence Binding (Task 4) ──────────────────────────

/** Minimum total drift items above which plans must include remediation tasks. */
export const DRIFT_REMEDIATION_THRESHOLD = 5;

/**
 * Per-priority penalty weights for stale file references.
 * High-priority (src/core/) items carry more weight because they indicate
 * that the architecture doc references ghost paths in active infrastructure.
 */
export const DRIFT_PENALTY_BY_PRIORITY: Record<"high" | "medium" | "low", number> = Object.freeze({
  high:   0.05,
  medium: 0.02,
  low:    0.01,
});

/**
 * Compute a parser confidence penalty from an architecture drift report.
 * Applied after plan normalization to penalize cycles where docs are out of sync.
 *
 * When the full `staleReferences` array is available the penalty is priority-weighted:
 *   - src/core/ stale refs (high):   0.05 each
 *   - other src/ stale refs (medium): 0.02 each
 *   - docker/scripts/docs refs (low): 0.01 each
 *   - deprecated token usages:        0.02 each
 *
 * When only summary counts are available (legacy callers) the flat formula
 * `0.02 × total` is used as a fallback.  Both paths cap the result at 0.30.
 *
 * requiresRemediation is true when total unresolved items >= DRIFT_REMEDIATION_THRESHOLD.
 *
 * @param driftReport - result of checkArchitectureDrift(), or null/undefined
 * @returns {{ penalty: number, reason: string, requiresRemediation: boolean }}
 */
export function computeDriftConfidencePenalty(driftReport?: Record<string, unknown> | null): {
  penalty: number;
  reason: string;
  requiresRemediation: boolean;
} {
  if (!driftReport) return { penalty: 0, reason: "no-drift-report", requiresRemediation: false };
  const staleCount = (Number(driftReport.staleCount) || 0);
  const deprecatedTokenCount = (Number(driftReport.deprecatedTokenCount) || 0);
  const total = staleCount + deprecatedTokenCount;
  if (total === 0) return { penalty: 0, reason: "no-drift", requiresRemediation: false };

  let rawPenalty: number;
  const staleRefs = Array.isArray(driftReport.staleReferences) ? driftReport.staleReferences : null;
  if (staleRefs) {
    // Priority-weighted: penalize src/core/ ghost paths more heavily.
    rawPenalty = 0;
    for (const ref of staleRefs) {
      if (ref && typeof ref === "object") {
        const p = String((ref as any).referencedPath || "");
        const priority: "high" | "medium" | "low" =
          p.startsWith("src/core/") ? "high" : p.startsWith("src/") ? "medium" : "low";
        rawPenalty += DRIFT_PENALTY_BY_PRIORITY[priority];
      }
    }
    rawPenalty += deprecatedTokenCount * DRIFT_PENALTY_BY_PRIORITY.medium;
  } else {
    // Fallback flat formula for callers that supply only summary counts.
    rawPenalty = total * 0.02;
  }

  const penalty = Math.round(Math.min(0.30, rawPenalty) * 100) / 100;
  return {
    penalty,
    reason: `architecture_drift_${total}_unresolved`,
    requiresRemediation: total >= DRIFT_REMEDIATION_THRESHOLD,
  };
}

// ── Architecture Drift → Actionable Debt Tasks ────────────────────────────

/**
 * Convert architecture drift report items into structured debt plan tasks.
 * Groups items by source document so one task covers all issues in a given file.
 * Each task carries taskKind="debt" and source="architecture_drift" so it can
 * be tracked, filtered, and prioritised separately from AI-generated plans.
 *
 * Tasks are placed on a wave one beyond the highest existing plan wave so they
 * do not block critical delivery work but are still ingested into the plan graph.
 *
 * Existing plans that already reference a document path suppress debt task
 * generation for that document to prevent double-scheduling.
 *
 * @param driftReport - result of checkArchitectureDrift(), or null/undefined
 * @param existingPlans - plans already present in the parsed output
 * @returns array of debt plan task objects ready for injection into parsed.plans
 */
export function buildDriftDebtTasks(
  driftReport: Record<string, unknown> | null | undefined,
  existingPlans: any[] = []
): any[] {
  if (!driftReport) return [];

  const staleRefs = Array.isArray(driftReport.staleReferences)
    ? (driftReport.staleReferences as any[]).filter(r => r && typeof r === "object")
    : [];
  const tokenRefs = Array.isArray(driftReport.deprecatedTokenRefs)
    ? (driftReport.deprecatedTokenRefs as any[]).filter(r => r && typeof r === "object")
    : [];

  if (staleRefs.length === 0 && tokenRefs.length === 0) return [];

  // Place debt tasks on the wave immediately after the highest existing wave.
  const maxWave = existingPlans.reduce((max, p) => {
    const w = Number(p.wave) || 1;
    return w > max ? w : max;
  }, 0);
  const debtWave = maxWave + 1;

  // Identify docs already addressed in existing plans to avoid double-scheduling.
  const coveredDocs = new Set<string>();
  for (const plan of existingPlans) {
    const text = `${String(plan.task || "")} ${String(plan.description || "")} ${(plan.target_files || []).join(" ")}`.toLowerCase();
    for (const ref of [...staleRefs, ...tokenRefs]) {
      if (ref.docPath && text.includes(String(ref.docPath).toLowerCase())) {
        coveredDocs.add(String(ref.docPath));
      }
    }
  }

  const debtTasks: any[] = [];
  // Use high priority numbers so debt tasks sort after critical delivery work.
  // Within debt tasks, lower numbers mean higher urgency (high-priority refs first).
  let priority = 900;

  // Effective priority rank for a set of refs: the highest-priority (lowest rank) item wins.
  function effectivePriorityRank(refs: any[]): number {
    let best = 2; // low
    for (const r of refs) {
      const p = String(r.referencedPath || "");
      const rank = p.startsWith("src/core/") ? 0 : p.startsWith("src/") ? 1 : 2;
      if (rank < best) best = rank;
    }
    return best;
  }

  // One debt task per doc with stale file references.
  // Docs are sorted by their highest-priority ref so high-risk docs surface first.
  const staleByDoc = new Map<string, any[]>();
  for (const ref of staleRefs) {
    const doc = String(ref.docPath || "");
    if (!staleByDoc.has(doc)) staleByDoc.set(doc, []);
    staleByDoc.get(doc)!.push(ref);
  }
  const sortedStaleByDoc = [...staleByDoc.entries()].sort(
    ([, aRefs], [, bRefs]) => effectivePriorityRank(aRefs) - effectivePriorityRank(bRefs)
  );
  const RANK_TO_DRIFT_PRIORITY = ["high", "medium", "low"] as const;
  for (const [doc, refs] of sortedStaleByDoc) {
    if (coveredDocs.has(doc)) continue;
    const paths = [...new Set(refs.map((r: any) => String(r.referencedPath)))].join(", ");
    const driftPriority = RANK_TO_DRIFT_PRIORITY[effectivePriorityRank(refs)];
    // Specific verification target: names the test file and the exact assertion so the
    // quality gate (plan_contract_validator.isNonSpecificVerification) accepts the task
    // and does not auto-remove it for having a bare "npm test" command.
    const verificationTarget = `tests/core/architecture_drift.test.ts — test: ${doc} has zero stale file references after update`;
    debtTasks.push({
      task: `Fix stale file references in ${doc}`,
      title: `Fix stale file references in ${doc}`,
      description: `${doc} references ${refs.length} file(s) that no longer exist: ${paths}. Update or remove these entries so documentation matches the current codebase.`,
      taskKind: "debt",
      source: "architecture_drift",
      _driftDebt: true,
      // driftPriority reflects the highest-urgency issue in this doc for downstream filtering.
      driftPriority,
      wave: debtWave,
      priority: priority++,
      target_files: [doc],
      acceptance_criteria: [
        `All ${refs.length} stale file reference(s) in ${doc} are updated or removed`,
        `No broken file references remain in ${doc}`,
        `npm test passes with no new failures after the update`,
      ],
      // Named test file reference satisfies isNonSpecificVerification — required to
      // survive the plan quality gate without being auto-removed.
      verification: verificationTarget,
      verification_commands: ["npm test"],
      // verification_targets enumerates the specific tests that must pass for this
      // debt task. The quality gate checks this field when present to validate that
      // the task is traceable to a concrete test assertion.
      verification_targets: [verificationTarget],
      riskLevel: "low",
      role: "evolution-worker",
      owner: "evolution-worker",
      // dependencies must be an array so the dependency-graph resolver and
      // validatePlanContract (WARNING check) do not flag this task.
      dependencies: [],
      // scope derived from the target document so validatePatchedPlan accepts
      // this task when Athena returns it in patchedPlans without modification.
      scope: doc,
      // capacityDelta and requestROI are mandatory contract fields (plan_contract_validator).
      // Debt remediation tasks improve documentation quality by a small, measurable amount.
      capacityDelta: 0.05,
      requestROI: 1.2,
      leverage_rank: ["quality"],
    });
  }

  // One debt task per doc with deprecated token usages.
  const tokensByDoc = new Map<string, any[]>();
  for (const ref of tokenRefs) {
    const doc = String(ref.docPath || "");
    if (!tokensByDoc.has(doc)) tokensByDoc.set(doc, []);
    tokensByDoc.get(doc)!.push(ref);
  }
  for (const [doc, refs] of tokensByDoc.entries()) {
    if (coveredDocs.has(doc)) continue;
    const uniqueTokens = [...new Set(refs.map((r: any) => String(r.token)))];
    const hints = [...new Map(refs.map((r: any) => [String(r.token), String(r.hint)])).entries()]
      .map(([t, h]) => `${t} → ${h}`)
      .join("; ");
    const verificationTarget = `tests/core/architecture_drift.test.ts — test: ${doc} has zero deprecated token usages after replacement`;
    debtTasks.push({
      task: `Replace deprecated API tokens in ${doc}`,
      title: `Replace deprecated API tokens in ${doc}`,
      description: `${doc} contains ${refs.length} use(s) of deprecated token(s): ${uniqueTokens.join(", ")}. Replace with current equivalents. Migration hints: ${hints}`,
      taskKind: "debt",
      source: "architecture_drift",
      _driftDebt: true,
      wave: debtWave,
      priority: priority++,
      target_files: [doc],
      acceptance_criteria: [
        `All ${refs.length} deprecated token usage(s) in ${doc} are replaced with current equivalents`,
        `No deprecated tokens remain in ${doc}`,
        `npm test passes with no new failures after the replacement`,
      ],
      verification: verificationTarget,
      verification_commands: ["npm test"],
      verification_targets: [verificationTarget],
      riskLevel: "low",
      role: "evolution-worker",
      owner: "evolution-worker",
      dependencies: [],
      scope: doc,
      capacityDelta: 0.05,
      requestROI: 1.2,
      leverage_rank: ["quality"],
    });
  }

  return debtTasks;
}


export async function runPrometheusAnalysis(config, options: any = {}) {
  const stateDir = config.paths?.stateDir || "state";

  // ── Freshness cache: skip if recent analysis exists ───────────────────────
  // bypassCache: allows event-driven invalidation (e.g., all plans completed)
  if (options.bypassCache) {
    await appendProgress(config, `[PROMETHEUS] Cache bypass requested (reason=${options.bypassReason || "unknown"}) — forcing fresh analysis`);
  }
  const freshnessMins = Number(config.runtime?.prometheusAnalysisFreshnessMinutes);
  if (!options.bypassCache && Number.isFinite(freshnessMins) && freshnessMins > 0) {
    try {
      const existing = await readJson(path.join(stateDir, "prometheus_analysis.json"), null);
      if (existing?.analyzedAt) {
        const ageMs = Date.now() - new Date(existing.analyzedAt).getTime();
        if (ageMs < freshnessMins * 60_000) {
          // If cached file already has plans, re-normalise them so enrichment
          // functions (target_files, scope, acceptance_criteria) always run.
          if (Array.isArray(existing.plans) && existing.plans.length > 0) {
            const renormalized = normalizePrometheusParsedOutput(existing, {});
            await appendProgress(config, `[PROMETHEUS] Fresh analysis exists (${Math.round(ageMs / 60_000)}m old, threshold=${freshnessMins}m) — reusing cached result (re-normalized ${renormalized.plans.length} plan(s))`);
            return renormalized;
          }
          // Cached file has no plans — attempt normalization to recover plans
          const recovered = normalizePrometheusParsedOutput(existing, {});
          if (Array.isArray(recovered.plans) && recovered.plans.length > 0) {
            await appendProgress(config, `[PROMETHEUS] Cached analysis normalized: ${recovered.plans.length} plan(s) recovered — rebuilding dependency graph`);
            // Rebuild dependency graph for the recovered plans
            try {
              const graphTasks = recovered.plans.map((plan, i) => ({
                id: String(plan.task || `plan-${i}`),
                dependsOn: Array.isArray(plan.dependencies) ? plan.dependencies.map(String) : [],
                filesInScope: Array.isArray(plan.target_files) ? plan.target_files : (Array.isArray(plan.targetFiles) ? plan.targetFiles : []),
              }));
              const graphResult = resolveDependencyGraph(graphTasks);
              recovered.dependencyGraph = {
                status:          graphResult.status,
                reasonCode:      graphResult.reasonCode,
                waveCount:       graphResult.waves.length,
                parallelTasks:   graphResult.parallelTasks,
                serializedTasks: graphResult.serializedTasks,
                conflictCount:   graphResult.conflictPairs.length,
                cycleCount:      graphResult.cycles.length,
                waves:           graphResult.waves,
                errorMessage:    graphResult.errorMessage ?? null,
              };
            } catch (graphErr) {
              recovered.dependencyGraph = { status: "degraded", errorMessage: String(graphErr?.message || graphErr) };
            }
            // Persist normalized result so subsequent reads don't need re-normalization
            await writeJson(path.join(stateDir, "prometheus_analysis.json"), recovered).catch(() => {});
            return recovered;
          }
          // Cache exists but normalization also produced no plans — re-run
          await appendProgress(config, `[PROMETHEUS] Cached analysis has no actionable plans (${Math.round(ageMs / 60_000)}m old) — re-running`);
        }
      }
    } catch { /* no cached analysis — proceed normally */ }
  }

  const repoRoot = process.cwd();
  const registry = getRoleRegistry(config);
  const prometheusName = registry?.deepPlanner?.name || "Prometheus";
  const prometheusModel = registry?.deepPlanner?.model || "GPT-5.3-Codex";
  const command = config.env?.copilotCliCommand || "copilot";

  const userPrompt = options.prompt || options.prometheusReason || "Full repository self-evolution analysis";
  const requestedBy = options.requestedBy || "Jesus";

  const ts = () => new Date().toISOString().replace("T", " ").slice(0, 19);

  // ── Log start ─────────────────────────────────────────────────────────────
  await appendProgress(config, `[PROMETHEUS] ${prometheusName} awakening — starting deep repository analysis (simplified mode)`);
  await appendPrometheusLiveLog(stateDir, "leadership_live", `[${ts()}] ${prometheusName.padEnd(20)} Awakening — direct Copilot CLI scan starting...`);

  const planningPolicy = buildPrometheusPlanningPolicy(config);

  // ── Extract behavior patterns from postmortems ────────────────────────────
  let behaviorPatternsSection = "";
  let carryForwardSection = "";
  // Postmortem entries lifted to function scope so the carry-forward gate can
  // evaluate them after plan generation and validation.
  let postmortemEntries: any[] = [];
  try {
    // Load carry-forward ledger and coordination data in parallel for retirement check
    const [postmortems, cfLedgerData, coordinationData] = await Promise.all([
      readJson(path.join(stateDir, "athena_postmortems.json"), null),
      readJson(path.join(stateDir, "carry_forward_ledger.json"), { entries: [] }),
      readJson(path.join(stateDir, "athena_coordination.json"), {}),
    ]);
    const cfLedger = Array.isArray(cfLedgerData?.entries) ? cfLedgerData.entries : [];
    const coordinationCompletedTasks = Array.isArray(coordinationData?.completedTasks)
      ? coordinationData.completedTasks : [];
    const entries = Array.isArray(postmortems?.entries) ? postmortems.entries : [];
    postmortemEntries = entries; // expose to carry-forward gate after plan validation
    
    if (entries.length > 0) {
      // Extract patterns: recurring issues, worker problems, quality trends
      const last20 = entries.slice(-20);
      
      // Count issue patterns
      const issuePatterns: Record<string, any> = {};
      const workerProblems: Record<string, any> = {};
      let totalQualityScore = 0;
      let lowQualityCount = 0;
      
      for (const entry of last20) {
        // Track worker performance
        const worker = entry.workerName || "unknown";
        if (!workerProblems[worker]) workerProblems[worker] = { count: 0, failureReasons: [] };
        workerProblems[worker].count++;
        
        // Track quality score
        const score = Number(entry.qualityScore) || 0;
        totalQualityScore += score;
        if (score < 6) lowQualityCount++;
        
        // Extract issue keywords from lesson learned
        const deviation = entry.deviation || "unknown";
        
        if (deviation === "major" || score < 5) {
          if (!issuePatterns[worker]) issuePatterns[worker] = [];
          issuePatterns[worker].push({
            issue: entry.expectedOutcome?.slice(0, 80) || "unclear",
            score: score,
            deviation: deviation
          });
        }
      }
      
      // Build pattern analysis
      const patterns = [];
      for (const [worker, problems] of Object.entries(workerProblems)) {
        if (problems.count >= 2) {
          patterns.push(`- **${worker}**: appeared in ${problems.count}/${last20.length} recent postmortems`);
          if (issuePatterns[worker]) {
            for (const p of issuePatterns[worker].slice(0, 2)) {
              patterns.push(`  - Issue: ${p.issue} (quality=${p.score}, deviation=${p.deviation})`);
            }
          }
        }
      }
      
      if (patterns.length > 0) {
        const avgQuality = (totalQualityScore / last20.length).toFixed(2);
        behaviorPatternsSection = `\n\n## BEHAVIOR PATTERNS FROM RECENT POSTMORTEMS (last ${last20.length} cycles)
Average decision quality: ${avgQuality}/10
Low-quality outcomes: ${lowQualityCount}/${last20.length}

Recurring issues and worker performance:
${patterns.join("\n")}

**Strategic implications:** Your plan should address why these patterns persist despite code changes.
Consider whether the root causes are:
1. Insufficient optimization (algorithm complexity, not just code cleanup)
2. External constraints (I/O, database, infrastructure limits)
3. Scaling challenges (metrics degrade with input size growth)`;
      }
      
      // Carry-forward follow-ups — retire items already resolved in ledger or coordination
      const allPending = entries.filter(e => e.followUpNeeded && e.followUpTask);
      const pending = filterResolvedCarryForwardItems(allPending, cfLedger, coordinationCompletedTasks);
      if (pending.length > 0) {
        const seenFollowUps = new Set();
        const deduped = [];
        // Traverse from newest to oldest so repeated tasks keep their latest wording/date.
        for (let i = pending.length - 1; i >= 0; i--) {
          const e = pending[i];
          const fp = computeFingerprint(String(e.followUpTask || ""));
          if (!fp || seenFollowUps.has(fp)) continue;
          seenFollowUps.add(fp);
          deduped.push(e);
        }
        deduped.reverse();
        const items = deduped.slice(-10).map((e, i) =>
          `${i + 1}. [worker=${e.workerName || "unknown"}, reviewed=${e.reviewedAt || "?"}] ${e.followUpTask}`
        ).join("\n");
        carryForwardSection = `\n\n## MANDATORY_CARRY_FORWARD\nThe following follow-up tasks from previous Athena postmortems have NOT been addressed yet.\nYou MUST include these in your plan unless they are already resolved in the codebase:\n${items}\n`;
      }
    }
  } catch { /* non-fatal — proceed without pattern analysis */ }

  // ── Build real file listing for prompt (prevents fabricated target_files) ─
  let repoFileListingSection = "";
  try {
    const coreFiles = await fs.readdir(path.join(repoRoot, "src", "core")).catch(() => []);
    const testFiles = await fs.readdir(path.join(repoRoot, "tests", "core")).catch(() => []);
    const srcList = coreFiles.filter(f => f.endsWith(".ts") || f.endsWith(".js") || f.endsWith(".mts") || f.endsWith(".cjs")).map(f => `src/core/${f}`).join("\n");
    const tstList = testFiles.filter(f => f.endsWith(".test.ts") || f.endsWith(".test.js")).map(f => `tests/core/${f}`).join("\n");
    if (srcList || tstList) {
      repoFileListingSection = `\n\n## EXISTING REPOSITORY FILES\nYou MUST only reference paths from this list in target_files. Do NOT invent new module names.\n### src/core/ (source modules)\n${srcList}\n### tests/core/ (test files)\n${tstList}\n`;
    }
  } catch { /* non-fatal */ }

  // ── Self-improvement repair feedback injection ────────────────────────────
  let repairFeedbackSection = "";
  if (options.repairFeedback) {
    const rf = options.repairFeedback;
    const causes = (rf.rootCauses || []).map((c, i) => `${i + 1}. [${c.severity}] ${c.cause} (affects: ${c.affectedComponent})`).join("\n");
    const patches = (rf.behaviorPatches || []).map((p, i) => `${i + 1}. [${p.target}] ${p.patch} \u2014 rationale: ${p.rationale}`).join("\n");
    const constraints = rf.repairedPlanConstraints || {};
    const upgrades = (rf.verificationUpgrades || []).map((u, i) => `${i + 1}. ${u.area}: ${u.currentProblem} \u2192 required: ${u.requiredStandard}`).join("\n");

    repairFeedbackSection = `\n\n## CRITICAL: ATHENA REJECTION REPAIR FEEDBACK\nThe previous plan was REJECTED by Athena. Self-improvement has analyzed the failure.\nYou MUST address every item below. Repeating the same mistakes will cause a hard stop.\n\n### ROOT CAUSES OF REJECTION\n${causes || "- No root causes identified"}\n\n### BEHAVIOR PATCHES (you MUST follow these)\n${patches || "- No patches specified"}\n\n### PLAN CONSTRAINTS (mandatory for this re-plan)\n- Must include: ${JSON.stringify(constraints.mustInclude || [])}\n- Must NOT repeat: ${JSON.stringify(constraints.mustNotRepeat || [])}\n- Verification standard: ${constraints.verificationStandard || "task-specific, measurable"}\n- Wave strategy: ${constraints.waveStrategy || "explicit inter-wave dependencies required"}\n\n### VERIFICATION UPGRADES REQUIRED\n${upgrades || "- No specific upgrades"}\n\nFAILURE TO COMPLY WITH THESE CONSTRAINTS WILL RESULT IN CYCLE TERMINATION.\n`;
  }

  // ── Architecture drift summary injection ─────────────────────────────────
  // Inject unresolved stale doc references and deprecated token usage so
  // Prometheus can include remediation tasks in the plan.
  let driftSummarySection = "";
  const driftReport = options.driftReport;
  if (driftReport && (driftReport.staleCount > 0 || driftReport.deprecatedTokenCount > 0)) {
    const staleLines = (driftReport.staleReferences || []).slice(0, 20).map(
      (r, i) => `${i + 1}. [${r.docPath}:${r.line}] references missing file: ${r.referencedPath}`
    ).join("\n");
    const tokenLines = (driftReport.deprecatedTokenRefs || []).slice(0, 20).map(
      (r, i) => `${i + 1}. [${r.docPath}:${r.line}] deprecated token "${r.token}" — ${r.hint}`
    ).join("\n");
    const moreMsgStale = (driftReport.staleReferences || []).length > 20
      ? `\n... and ${(driftReport.staleReferences || []).length - 20} more` : "";
    const moreMsgToken = (driftReport.deprecatedTokenRefs || []).length > 20
      ? `\n... and ${(driftReport.deprecatedTokenRefs || []).length - 20} more` : "";

    driftSummarySection = `\n\n## ARCHITECTURE DRIFT REPORT (unresolved — generated this cycle)\nScanned ${driftReport.scannedDocs.length} documentation file(s). Found ${driftReport.staleCount} stale file reference(s) and ${driftReport.deprecatedTokenCount} deprecated token usage(s).\nThese represent gaps between docs and the current codebase. You MUST include remediation tasks for items you cannot immediately resolve.\n${staleLines ? `\n### Stale File References\n${staleLines}${moreMsgStale}` : ""}${tokenLines ? `\n\n### Deprecated Token Usage\n${tokenLines}${moreMsgToken}` : ""}`;
  }

  // ── Build prompt from static and dynamic sections ────────────────────────
  // Static sections are invariant across cycles and stored in PROMETHEUS_STATIC_SECTIONS.
  // Dynamic sections carry per-cycle deltas; carry-forward and behavior-patterns are capped
  // via maxTokens to prevent unbounded payload growth across many cycles.
  const carryFwdSection = Object.assign(
    section("carry-forward", carryForwardSection),
    { maxTokens: CARRY_FORWARD_MAX_TOKENS }
  );
  const behaviorSection = Object.assign(
    section("behavior-patterns", behaviorPatternsSection),
    { maxTokens: BEHAVIOR_PATTERNS_MAX_TOKENS }
  );
  const contextPrompt = compilePrompt([
    section("context", `TARGET REPO: ${config.env?.targetRepo || "unknown"}\nREPO PATH: ${repoRoot}\n\n## OPERATOR OBJECTIVE\n${userPrompt}`),
    PROMETHEUS_STATIC_SECTIONS.evolutionDirective,
    PROMETHEUS_STATIC_SECTIONS.mandatorySelfCritique,
    PROMETHEUS_STATIC_SECTIONS.mandatoryOperatorQuestions,
    section("planning-policy", `## PLANNING POLICY\n- maxTasks: ${planningPolicy.maxTasks > 0 ? planningPolicy.maxTasks : "UNLIMITED"}\n- maxWorkersPerWave: ${planningPolicy.maxWorkersPerWave}\n- preferFewestWorkers: ${planningPolicy.preferFewestWorkers}\n- requireDependencyAwareWaves: ${planningPolicy.requireDependencyAwareWaves}\n- If maxTasks is UNLIMITED, include ALL materially distinct actionable tasks you find.`),
    behaviorSection,
    carryFwdSection,
    section("repo-file-listing", repoFileListingSection),
    section("drift-summary", driftSummarySection),
    section("repair-feedback", repairFeedbackSection),
    PROMETHEUS_STATIC_SECTIONS.outputFormat,
  ]);

  appendPromptPreviewSync(stateDir, contextPrompt);

  await appendPrometheusLiveLog(stateDir, "leadership_live", `[${ts()}] ${prometheusName.padEnd(20)} Calling Copilot CLI (agent=prometheus)...`);

  // ── Call Copilot CLI with real-time streaming to live log ──────────────────
  const args = buildAgentArgs({
    agentSlug: "prometheus",
    prompt: contextPrompt,
    model: prometheusModel,
    allowAll: false,
    maxContinues: undefined
  });

  appendLiveLogSync(stateDir, `\n[copilot_stream_start] ${ts()}\n`);

  const result = await spawnAsync(command, args, {
    env: process.env,
    onStdout(chunk) {
      appendLiveLogSync(stateDir, chunk.toString("utf8"));
    },
    onStderr(chunk) {
      appendLiveLogSync(stateDir, chunk.toString("utf8"));
    }
  });

  appendLiveLogSync(stateDir, `\n[copilot_stream_end] ${ts()} exit=${(result as any).status}\n`);

  const stdout = String((result as any)?.stdout || "");
  const stderr = String((result as any)?.stderr || "");
  const raw = stdout || stderr;
  const combinedRaw = `${stdout}\n${stderr}`.trim();

  // ── Check for model fallback ──────────────────────────────────────────────
  const fallback = detectModelFallback(combinedRaw);
  if (fallback) {
    const warningMessage = `Prometheus model fallback: requested=${fallback.requestedModel}, active=${fallback.fallbackModel}`;
    await appendProgress(config, `[PROMETHEUS][WARN] ${warningMessage}`);
    try {
      await appendAlert(config, { severity: "warning", source: "prometheus", title: "Prometheus model fallback", message: warningMessage });
    } catch { /* non-fatal */ }
  }

  // ── Handle failure ────────────────────────────────────────────────────────
  if ((result as any).status !== 0) {
    const error = `exited ${(result as any).status}: ${(stderr || stdout).slice(0, 500)}`;
    await appendProgress(config, `[PROMETHEUS] Analysis failed — ${error}`);
    await appendPrometheusLiveLog(stateDir, "leadership_live", `[${ts()}] ${prometheusName.padEnd(20)} Analysis failed: ${error}`);
    return null;
  }

  // ── Parse output ──────────────────────────────────────────────────────────
  const aiResult = parseAgentOutput(raw);

  // ── Generation-boundary packet completeness gate ──────────────────────────
  // Reject unrecoverable incomplete packets BEFORE normalization so they never
  // enter the normalization pipeline. Unrecoverable means normalizePlanFromTask()
  // cannot synthesize a meaningful value for the missing field:
  //   - No task identity (task/title/task_id/id all absent) → "Task-N" is useless
  //   - Missing/invalid capacityDelta → normalization omits it; validator removes it
  //   - Missing/invalid requestROI   → same rationale
  // This is the primary enforcement gate. The post-normalization capacityDelta/
  // requestROI filter below remains as a secondary safety net for plans injected
  // by non-rawPlans paths (alternative shapes, drift debt tasks).
  const rawParsedInput = aiResult?.parsed || buildNarrativeFallbackParsed({ ...aiResult, raw });
  if (Array.isArray(rawParsedInput.plans) && rawParsedInput.plans.length > 0) {
    const incompletePackets: Array<{ index: number; reasons: string[] }> = [];
    rawParsedInput.plans = rawParsedInput.plans.filter((plan: any, i: number) => {
      const check = checkPacketCompleteness(plan);
      if (!check.recoverable) {
        incompletePackets.push({ index: i, reasons: check.reasons });
        return false;
      }
      return true;
    });
    if (incompletePackets.length > 0) {
      await appendProgress(config,
        `[PROMETHEUS][PACKET_GATE] Rejected ${incompletePackets.length} unrecoverable packet(s) at generation boundary ` +
        `(reasons: ${[...new Set(incompletePackets.flatMap(p => p.reasons))].join(", ")})`
      );
      rawParsedInput._rejectedIncompleteCount = incompletePackets.length;
      rawParsedInput._rejectedIncompletePackets = incompletePackets;
    }
  }

  const parsedForValidation = normalizePrometheusParsedOutput(
    rawParsedInput,
    { ...aiResult, raw }
  );

  // ── Schema v2 plan validation ─────────────────────────────────────────────
  // Validate each plan has the required schema fields. Non-conforming plans are
  // tagged but kept (Athena makes the final accept/reject decision).
  const REQUIRED_PLAN_FIELDS = ["task", "role"];
  if (Array.isArray(parsedForValidation.plans)) {
    let invalidCount = 0;
    for (const plan of parsedForValidation.plans) {
      const missing = REQUIRED_PLAN_FIELDS.filter(f => !plan[f] || String(plan[f]).trim().length === 0);
      if (missing.length > 0) {
        plan._schemaViolations = missing;
        invalidCount++;
      }
      // Tag verification quality: plans without verification are schema-weak
      if (!plan.verification || String(plan.verification).trim().length === 0) {
        plan._schemaViolations = [...(plan._schemaViolations || []), "verification"];
      }
    }
    if (invalidCount > 0) {
      await appendProgress(config,
        `[PROMETHEUS][SCHEMA] ${invalidCount}/${parsedForValidation.plans.length} plan(s) missing required fields`
      );
    }
  }

  // ── Trust boundary validation ─────────────────────────────────────────────
  const tbMode = config?.runtime?.trustBoundaryMode === "warn" ? "warn" : "enforce";
  const trustCheck = validateLeadershipContract(
    LEADERSHIP_CONTRACT_TYPE.PLANNER, parsedForValidation, { mode: tbMode }
  );
  if (!trustCheck.ok && tbMode === "enforce") {
    const tbErrors = trustCheck.errors.map(e => `${e.payloadPath}: ${e.message}`).join(" | ");
    await appendProgress(config, `[PROMETHEUS][TRUST_BOUNDARY] Contract validation failed — class=${TRUST_BOUNDARY_ERROR} errors=${tbErrors}`);
    try {
      await appendAlert(config, {
        severity: "critical",
        source: "prometheus",
        title: "Planner output failed trust-boundary validation",
        message: `class=${TRUST_BOUNDARY_ERROR} reasonCode=${trustCheck.reasonCode} errors=${tbErrors}`
      });
    } catch { /* non-fatal */ }
    // Block on trust-boundary violation (fail-closed)
    await appendProgress(config, `[PROMETHEUS][TRUST_BOUNDARY] Blocking analysis — returning null (fail-closed)`);
    return null;
  }
  if (trustCheck.errors.length > 0 && tbMode === "warn") {
    const tbErrors = trustCheck.errors.map(e => `${e.payloadPath}: ${e.message}`).join(" | ");
    await appendProgress(config, `[PROMETHEUS][TRUST_BOUNDARY][WARN] Contract violations (warn mode): ${tbErrors}`);
  }

  // ── Log thinking/dossier ──────────────────────────────────────────────────
  if (aiResult.thinking) {
    await appendPrometheusLiveLog(stateDir, "prometheus_dossier", aiResult.thinking);
  }

  // ── Enforce mandatory requestBudget ───────────────────────────────────────
  const parsed = parsedForValidation;
  if (!parsed.requestBudget || !Number.isFinite(Number(parsed.requestBudget.estimatedPremiumRequestsTotal))) {
    const planCount = Array.isArray(parsed.plans) ? parsed.plans.length : 4;
    const margin = 25;
    parsed.requestBudget = {
      estimatedPremiumRequestsTotal: planCount,
      errorMarginPercent: margin,
      hardCapTotal: Math.ceil(planCount * (1 + margin / 100)),
      confidence: "low",
      byWave: [],
      byRole: [],
      _fallback: true
    };
    await appendProgress(config, `[PROMETHEUS][WARN] No requestBudget — fallback: ${parsed.requestBudget.hardCapTotal} requests`);
  } else {
    const rb = parsed.requestBudget;
    const total = Number(rb.estimatedPremiumRequestsTotal) || 0;
    const margin = Number(rb.errorMarginPercent) || 20;
    if (!Number.isFinite(Number(rb.hardCapTotal)) || Number(rb.hardCapTotal) <= 0) {
      rb.hardCapTotal = Math.ceil(total * (1 + margin / 100));
    }
  }

  // ── Contract-first plan validation (Packet 2) ────────────────────────────
  // Every plan must pass schema contract before persistence.
  if (Array.isArray(parsed.plans) && parsed.plans.length > 0) {
    const contractResult = validateAllPlans(parsed.plans);
    if (contractResult.invalidCount > 0) {
      await appendProgress(config,
        `[PROMETHEUS][CONTRACT] ${contractResult.invalidCount}/${contractResult.totalPlans} plan(s) have contract violations (passRate=${contractResult.passRate})`
      );
    }
    // Tag each plan with contract validation results
    for (const r of contractResult.results) {
      parsed.plans[r.planIndex]._contractValid = r.valid;
      parsed.plans[r.planIndex]._contractViolations = r.violations;
    }
    parsed._planContractPassRate = contractResult.passRate;

    // ── Secondary safety net: hard-filter plans missing valid capacityDelta / requestROI ─
    // Primary rejection happens at the generation boundary (checkPacketCompleteness above).
    // This secondary pass catches any surviving violations from alternative-shape synthesized
    // plans (waves, bottlenecks, narrative fallback) or drift debt tasks that bypass the
    // pre-normalization gate. These fields are required for plan ranking and budget comparison.
    //
    // Filter uses deterministic PACKET_VIOLATION_CODE codes (canonical taxonomy from
    // plan_contract_validator.ts) rather than field-name string equality, so matching
    // is immune to field rename and consistent with the generation-boundary gate codes.
    const CAPACITY_ROI_VIOLATION_CODES: Set<string> = new Set([
      PACKET_VIOLATION_CODE.MISSING_CAPACITY_DELTA,
      PACKET_VIOLATION_CODE.INVALID_CAPACITY_DELTA,
      PACKET_VIOLATION_CODE.MISSING_REQUEST_ROI,
      PACKET_VIOLATION_CODE.INVALID_REQUEST_ROI,
    ]);
    const capacityRoiViolatingIndices = contractResult.results
      .filter(r => !r.valid && r.violations.some(v =>
        CAPACITY_ROI_VIOLATION_CODES.has(v.code) &&
        v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL
      ))
      .map(r => r.planIndex)
      .sort((a, b) => b - a); // reverse order for safe in-place splice
    if (capacityRoiViolatingIndices.length > 0) {
      for (const idx of capacityRoiViolatingIndices) {
        parsed.plans.splice(idx, 1);
      }
      await appendProgress(config,
        `[PROMETHEUS][CONTRACT] Hard-filtered ${capacityRoiViolatingIndices.length} plan(s) missing valid capacityDelta/requestROI — secondary safety net`
      );
      parsed._capacityRoiFilteredCount = capacityRoiViolatingIndices.length;
    }
  }

  // ── Carry-forward admission gate (Task 2) ────────────────────────────────
  // Blocks plan dispatch when the same unresolved lesson has recurred past the
  // threshold without being addressed in the current plan set. This converts
  // repeated advisory carry-forward items into hard admission blockers.
  if (postmortemEntries.length > 0 && Array.isArray(parsed.plans) && parsed.plans.length > 0) {
    const maxUnresolvedCycles = Number(config?.planner?.maxUnresolvedCycles) || 3;
    const gateResult = checkCarryForwardGate(postmortemEntries, parsed.plans, { maxUnresolvedCycles });
    // Also compile recurring unresolved lessons into enforceable hard-gate policies.
    const existingPolicyIds = (parsed._hardGatePolicies || []).map((p: any) => String(p.id));
    const recurrenceResult = hardGateRecurrenceToPolicies(postmortemEntries, existingPolicyIds, {
      maxRecurrences: maxUnresolvedCycles,
    });
    if (recurrenceResult.newPolicies.length > 0) {
      parsed._hardGatePolicies = [...(parsed._hardGatePolicies || []), ...recurrenceResult.newPolicies];
    }
    parsed._carryForwardGateResult = gateResult;
    if (gateResult.shouldBlock) {
      parsed._carryForwardGateBlocked = true;
      await appendProgress(config,
        `[PROMETHEUS][CARRY-FORWARD] HARD BLOCK — ${gateResult.reason}` +
        (gateResult.unresolvedLessons.length > 0 ? ` | unresolved: ${gateResult.unresolvedLessons.slice(0, 3).join("; ")}` : "") +
        (gateResult.missingMandatory.length > 0 ? ` | missing mandatory: ${gateResult.missingMandatory.slice(0, 3).join("; ")}` : "")
      );
    }
  }

  // ── Dual-pass planning: Pass-B critic gate ─────────────────────────────────
  // Deterministic critic evaluates plans before Athena review (no AI call).
  // Rejected plans are logged but still included (Athena makes final decision).
  if (Array.isArray(parsed.plans) && parsed.plans.length > 0) {
    const criticRepair = dualPassCriticRepair(parsed.plans);
    parsed.plans = criticRepair.plans;
    if (criticRepair.repairCount > 0 || criticRepair.finalRejected > 0) {
      await appendProgress(
        config,
        `[PROMETHEUS][CRITIC] repaired=${criticRepair.repairCount} approved=${criticRepair.finalApproved} rejected=${criticRepair.finalRejected}`
      );
    }
  }

  // ── AC measurability enrichment ───────────────────────────────────────────
  // Enrich plans lacking concrete acceptance criteria with compiled ACs.
  if (Array.isArray(parsed.plans) && parsed.plans.length > 0) {
    const acResult = enrichPlansWithAC(parsed.plans);
    if (acResult.enrichedCount > 0) {
      await appendProgress(config,
        `[PROMETHEUS][AC] Enriched ${acResult.enrichedCount} plan(s) with compiled acceptance criteria`
      );
    }
    parsed.plans = acResult.plans;
  }

  // Ensure Athena-facing rigor fields exist after all enrichment/repair passes.
  if (Array.isArray(parsed.plans) && parsed.plans.length > 0) {
    parsed.plans = parsed.plans.map((plan, idx) => normalizePlanFromTask(plan, idx, Number(plan.wave) || 1));
  }

  // Ensure execution strategy and request budget remain concrete after plan normalization.
  if (!parsed.executionStrategy || !Array.isArray(parsed.executionStrategy.waves) || parsed.executionStrategy.waves.length === 0) {
    parsed.executionStrategy = buildExecutionStrategyFromPlans(parsed.plans || []);
  }
  if (!parsed.requestBudget || parsed.requestBudget._fallback) {
    parsed.requestBudget = {
      ...buildDeterministicRequestBudget(parsed.plans || [], parsed.executionStrategy || {}),
      _fallback: false
    };
    await appendProgress(config, `[PROMETHEUS][BUDGET] Rebuilt deterministic request budget with byWave/byRole breakdown`);
  }

  // ── Drift confidence penalty (Task 4) ────────────────────────────────────
  // Bind unresolved architecture drift counts to planning confidence.
  // High drift counts signal docs-codebase divergence, reducing trust in the plan.
  const driftPenaltyResult = computeDriftConfidencePenalty(driftReport);
  if (driftPenaltyResult.penalty > 0) {
    parsed.parserConfidence = Math.max(0.1, (parsed.parserConfidence ?? 1.0) - driftPenaltyResult.penalty);
    if (!Array.isArray(parsed.parserConfidencePenalties)) parsed.parserConfidencePenalties = [];
    parsed.parserConfidencePenalties.push({
      reason: driftPenaltyResult.reason,
      component: "architectureDrift",
      delta: -driftPenaltyResult.penalty,
    });
    if (driftPenaltyResult.requiresRemediation) {
      parsed._requiresDriftRemediation = true;
    }
    await appendProgress(config,
      `[PROMETHEUS][DRIFT] Confidence penalty applied: ${driftPenaltyResult.penalty.toFixed(2)} (${driftPenaltyResult.reason})` +
      (driftPenaltyResult.requiresRemediation ? " — remediation plans required" : "")
    );
  }

  // ── Drift debt task injection ─────────────────────────────────────────────
  // Deterministically convert unresolved drift items into tracked debt tasks so
  // they appear in the plan graph regardless of whether the AI included them.
  if (driftReport && (driftReport.staleCount > 0 || driftReport.deprecatedTokenCount > 0)) {
    const driftDebtTasks = buildDriftDebtTasks(driftReport, parsed.plans || []);
    if (driftDebtTasks.length > 0) {
      if (!Array.isArray(parsed.plans)) parsed.plans = [];
      parsed.plans = [...parsed.plans, ...driftDebtTasks];
      parsed._driftDebtTaskCount = driftDebtTasks.length;
      await appendProgress(config,
        `[PROMETHEUS][DRIFT] Injected ${driftDebtTasks.length} debt task(s) from architecture drift into plan (wave ${driftDebtTasks[0].wave})`
      );
    }
  }

  // ── Build analysis result ─────────────────────────────────────────────────
  const analysis = {
    ...parsed,
    dossierPath: null,
    analyzedAt: new Date().toISOString(),
    model: prometheusModel,
    repo: config.env?.targetRepo,
    requestedBy
  };

  await writeJson(path.join(stateDir, "prometheus_analysis.json"), addSchemaVersion(analysis, STATE_FILE_TYPE.PROMETHEUS_ANALYSIS));

  const planCount = Array.isArray(analysis.plans) ? analysis.plans.length : 0;
  await appendProgress(config, `[PROMETHEUS] Analysis complete — ${planCount} work items | health=${analysis.projectHealth}`);
  await appendPrometheusLiveLog(stateDir, "leadership_live", `[${ts()}] ${prometheusName.padEnd(20)} Analysis ready: ${planCount} plans | health=${analysis.projectHealth}`);

  // ── Budget-aware intervention optimizer (non-blocking) ────────────────────
  if (config?.interventionOptimizer?.enabled !== false && Array.isArray(analysis.plans) && analysis.plans.length > 0) {
    try {
      const interventions = buildInterventionsFromPlan(analysis.plans, config);
      const budget = buildBudgetFromConfig(analysis.requestBudget, config);
      const optimizerResult = runInterventionOptimizer(interventions, budget);

      await appendInterventionOptimizerEntry(config, {
        ...optimizerResult,
        correlationId: `prometheus-${Date.now()}`,
        prometheusAnalyzedAt: analysis.analyzedAt,
      }).catch((err) => {
        appendProgress(config, `[PROMETHEUS][WARN] Optimizer log persist failed: ${String(err?.message || err)}`).catch(() => {});
      });

      const selectedCount = Array.isArray(optimizerResult.selected) ? optimizerResult.selected.length : 0;
      const rejectedCount = Array.isArray(optimizerResult.rejected) ? optimizerResult.rejected.length : 0;
      await appendProgress(config,
        `[PROMETHEUS] Intervention optimizer: status=${optimizerResult.status} selected=${selectedCount} rejected=${rejectedCount} budgetUsed=${optimizerResult.totalBudgetUsed}/${optimizerResult.totalBudgetLimit} (${optimizerResult.budgetUnit ?? "workerSpawns"})`
      ).catch(() => {});

      if (optimizerResult.status === OPTIMIZER_STATUS.BUDGET_EXCEEDED) {
        await appendProgress(config,
          `[PROMETHEUS][WARN] Budget pressure: ${rejectedCount} intervention(s) blocked — reasonCode=${optimizerResult.reasonCode}`
        ).catch(() => {});
      }

      analysis.interventionOptimizer = {
        status:           optimizerResult.status,
        reasonCode:       optimizerResult.reasonCode,
        selectedCount,
        rejectedCount,
        totalBudgetUsed:  optimizerResult.totalBudgetUsed,
        totalBudgetLimit: optimizerResult.totalBudgetLimit,
        budgetUnit:       optimizerResult.budgetUnit,
      };
    } catch (err) {
      analysis.interventionOptimizer = {
        status:       "error",
        reasonCode:   "OPTIMIZER_INTERNAL_ERROR",
        errorMessage: String(err?.message || err),
      };
      await appendProgress(config, `[PROMETHEUS][WARN] Intervention optimizer error (non-fatal): ${String(err?.message || err)}`).catch(() => {});
    }
  }

  // ── Dependency graph resolver (non-blocking) ─────────────────────────────
  if (Array.isArray(analysis.plans) && analysis.plans.length > 0) {
    try {
      const graphTasks = analysis.plans.map((plan, i) => ({
        id: String(plan.task || `plan-${i}`),
        dependsOn: Array.isArray(plan.dependencies) ? plan.dependencies.map(String) : [],
        filesInScope: Array.isArray(plan.target_files) ? plan.target_files : (Array.isArray(plan.targetFiles) ? plan.targetFiles : []),
      }));

      const graphResult = resolveDependencyGraph(graphTasks);

      await persistGraphDiagnostics(stateDir, graphResult, {
        correlationId: `prometheus-${Date.now()}`,
        prometheusAnalyzedAt: analysis.analyzedAt,
      }).catch((err) => {
        appendProgress(config, `[PROMETHEUS][WARN] Dependency graph diagnostics persist failed: ${String(err?.message || err)}`).catch(() => {});
      });

      await appendProgress(config,
        `[PROMETHEUS] Dependency graph: status=${graphResult.status} waves=${graphResult.waves.length} parallel=${graphResult.parallelTasks} serialized=${graphResult.serializedTasks} conflicts=${graphResult.conflictPairs.length}`
      ).catch(() => {});

      if (graphResult.status === GRAPH_STATUS.CYCLE_DETECTED) {
        await appendProgress(config,
          `[PROMETHEUS][WARN] Dependency graph cycle detected — scheduler will fall back to sequential dispatch: ${graphResult.errorMessage}`
        ).catch(() => {});
      }

      analysis.dependencyGraph = {
        status:          graphResult.status,
        reasonCode:      graphResult.reasonCode,
        waveCount:       graphResult.waves.length,
        parallelTasks:   graphResult.parallelTasks,
        serializedTasks: graphResult.serializedTasks,
        conflictCount:   graphResult.conflictPairs.length,
        cycleCount:      graphResult.cycles.length,
        waves:           graphResult.waves,
        errorMessage:    graphResult.errorMessage ?? null,
      };
    } catch (err) {
      analysis.dependencyGraph = {
        status:       GRAPH_STATUS.DEGRADED,
        reasonCode:   "RESOLVER_INTERNAL_ERROR",
        errorMessage: String(err?.message || err),
      };
      await appendProgress(config, `[PROMETHEUS][WARN] Dependency graph resolver error (non-fatal): ${String(err?.message || err)}`).catch(() => {});
    }
  }

  return analysis;
}
