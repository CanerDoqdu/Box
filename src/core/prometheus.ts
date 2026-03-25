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
import { validateAllPlans } from "./plan_contract_validator.js";

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

function normalizeFollowUpTaskKey(text) {
  const s = String(text || "").toLowerCase();
  return s
    .replace(/[`'"(){}]|\[|\]/g, " ")
    .replace(/create\s+and\s+complete\s+a\s+task\s+to\s+/g, "")
    .replace(/create\s+a\s+dedicated\s+task\s+to\s+/g, "")
    .replace(/this\s+is\s+now\s+a\s+gate\s*-?\s*blocking\s+item[^.]*\.?/g, "")
    .replace(/athena\s+must\s+(block|reject)[^.]*\.?/g, "")
    .replace(/this\s+fix\s+must\s+ship[^.]*\.?/g, "")
    .replace(/blocking\s+defect[^:]*:\s*/g, "")
    .replace(/\b(five|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)\s+consecutive\s+postmortem\s+audit\s+records\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
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
    { pattern: /trust-boundary/, files: ["src/core/trust_boundary.js"] },
    { pattern: /canary/, files: ["src/core/canary_engine.js"] },
    { pattern: /compounding analyzer|compounding/, files: ["src/core/compounding_effects_analyzer.js"] },
    { pattern: /freeze-window|freeze window/, files: ["src/core/governance_freeze.js"] },
    { pattern: /resilience-drill|resilience drill/, files: ["src/core/catastrophe_detector.js"] },
    { pattern: /worker-runner|worker runner/, files: ["src/core/worker_runner.js"] },
    { pattern: /planner packet contract|contract completeness/, files: ["src/core/plan_contract_validator.js", "src/core/prometheus.js"] },
    { pattern: /critical-path scheduling|dependency-aware waves/, files: ["src/core/dag_scheduler.js", "src/core/orchestrator.js"] },
    { pattern: /parser replay corpus|marker\/fence|fence outputs/, files: ["src/core/parser_replay_harness.js", "tests/core/parser_replay_harness.test.js"] },
    { pattern: /governance integration worker lane|ownership contract/, files: ["src/core/capability_pool.js", "src/core/role_registry.js"] },
    { pattern: /model routing|uncertainty-aware|roi feedback loop/, files: ["src/core/agent_loader.js", "src/core/model_router.js"] },
    { pattern: /postmortem deltas|actionable packets/, files: ["src/core/delta_analytics.js", "src/core/learning_policy_compiler.js"] },
  ];

  for (const mapping of mappings) {
    if (mapping.pattern.test(lower)) {
      return mapping.files;
    }
  }

  if (/\b(test|tests|assertion|coverage|regression)\b/.test(lower)) {
    return [`tests/core/${stem}.test.js`];
  }
  return [`src/core/${stem}.js`];
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
    ? src.verification_commands.map(v => String(v || "").trim()).filter(Boolean)
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
  const waves = Array.isArray(input.waves) ? input.waves : [];
  for (let i = 0; i < waves.length; i++) {
    const waveObj = (waves[i] && typeof waves[i] === "object") ? waves[i] : {};
    const waveValue = normalizeWaveValue(waveObj.wave, i + 1 as any);
    const waveTasks = Array.isArray(waveObj.tasks) ? waveObj.tasks : [];
    for (const waveTask of waveTasks) {
      if (waveTask && typeof waveTask === "object") {
        const asTask = normalizePlanFromTask(waveTask, tasks.length, waveValue as any);
        tasks.push(asTask);
        const idx = tasks.length - 1;
        taskIndexByKey.set(asTask.task_id, idx);
        taskIndexByKey.set(asTask.task, idx);
        continue;
      }
      const key = String(waveTask || "").trim();
      if (!key) continue;
      const idx = taskIndexByKey.get(key);
      if (Number.isInteger(idx)) waveByTaskIndex.set(idx, waveValue);
    }
  }

  if (tasks.length > 0) {
    return tasks.map((task, i) => normalizePlanFromTask(task, i, waveByTaskIndex.get(i) || 1));
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

      // Find a matching proof metric
      const verificationMetric = proofMetrics.find(m => {
        const metricWords = String(m || "").toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 4);
        return taskWords.some(w => metricWords.includes(w));
      }) || "npm test";

      const severity = matchedBn?.severity || "medium";
      plans.push({
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
      });
    }
  }

  // If no waves, fall back to one plan per bottleneck
  if (plans.length === 0) {
    for (let i = 0; i < bottlenecks.length; i++) {
      const bn = bottlenecks[i];
      const taskText = String(bn.title || `Fix-${bn.id}`).trim();
      plans.push({
        role: "evolution-worker",
        task: taskText,
        priority: SEVERITY_PRIORITY[bn.severity] ?? i + 1,
        wave: i + 1,
        verification: proofMetrics[i] || "npm test",
        title: taskText,
        scope: String(bn.evidence || "").slice(0, 200),
        task_id: String(bn.id || `bn-${i}`),
        verification_commands: [proofMetrics[i] || "npm test"],
        acceptance_criteria: [],
        dependencies: [],
        _fromBottleneck: bn.id || null,
      });
    }
  }

  return plans;
}

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

  const health = String(input.projectHealth || "").trim();
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

  // Parser confidence: score 0-1 indicating how structured the AI output was.
  // 1.0 = JSON plans parsed directly; 0.5 = narrative fallback used; lower = less signal
  let parserConfidence = 1.0;
  if (rawPlans.length === 0 && plans.length > 0) {
    // Plans came from narrative/alternative shape parsing
    parserConfidence = 0.5;
  }
  if (plans.length === 0) {
    parserConfidence = 0.1;
  }
  if (!health || !["good", "needs-work", "critical"].includes(health)) {
    parserConfidence = Math.max(0.1, parserConfidence - 0.2);
  }
  if (requestBudget._fallback) parserConfidence = Math.max(0.1, parserConfidence - 0.1);

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
  try {
    const postmortems = await readJson(path.join(stateDir, "athena_postmortems.json"), null);
    const entries = Array.isArray(postmortems?.entries) ? postmortems.entries : [];
    
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
      
      // Carry-forward follow-ups
      const pending = entries.filter(e => e.followUpNeeded && e.followUpTask);
      if (pending.length > 0) {
        const seenFollowUps = new Set();
        const deduped = [];
        // Traverse from newest to oldest so repeated tasks keep their latest wording/date.
        for (let i = pending.length - 1; i >= 0; i--) {
          const e = pending[i];
          const key = normalizeFollowUpTaskKey(e.followUpTask);
          if (!key || seenFollowUps.has(key)) continue;
          seenFollowUps.add(key);
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
    const srcList = coreFiles.filter(f => f.endsWith(".js") || f.endsWith(".cjs")).map(f => `src/core/${f}`).join("\n");
    const tstList = testFiles.filter(f => f.endsWith(".js")).map(f => `tests/core/${f}`).join("\n");
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

  // ── Build prompt — Copilot reads the repo itself ──────────────────────────
  const contextPrompt = `TARGET REPO: ${config.env?.targetRepo || "unknown"}
REPO PATH: ${repoRoot}

## OPERATOR OBJECTIVE
${userPrompt}

## EVOLUTION DIRECTIVE
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
10. Security (vulnerability prevention, access control, governance — ONE dimension among equals)

## MANDATORY SELF-CRITIQUE SECTIONS
You MUST include a dedicated self-critique section for EACH of the following components.
Each section must answer: "What is this component doing well?", "What is it doing poorly?", and "How specifically should it improve next cycle?"
Do NOT just say "there is a problem" — produce a concrete improvement proposal for each.

1. **Jesus Self-Critique** — Is Jesus making good strategic decisions? Is it reading the right signals? How should its decision logic improve?
2. **Prometheus Self-Critique** — Is Prometheus producing actionable plans or strategic fluff? How should its reasoning, prompt structure, and output format improve?
3. **Athena Self-Critique** — Is Athena catching real issues or generating noise? Are postmortems driving actual change? How should review quality improve?
4. **Worker Structure Self-Critique** — Is the worker topology enabling or blocking progress? Are workers specialized enough? How should worker roles evolve?
5. **Parser / Normalization Self-Critique** — Is plan parsing reliable? Are fence blocks handled correctly? What parsing failures recur and how to fix them?
6. **Prompt Layer Self-Critique** — Are runtime prompts getting the most out of model capacity? What prompt patterns waste tokens or produce shallow output?
7. **Verification System Self-Critique** — Is verification catching real failures or generating false signals? Are verification commands reliable across platforms?

## MANDATORY_OPERATOR_QUESTIONS
You MUST answer these explicitly in a dedicated section titled "Mandatory Answers" before the rest of the plan:
1. Is wave-based plan distribution truly the most efficient model for this system?
2. Should it be preserved, improved, or removed?
3. If it changes, what should replace it and how should the transition be executed?
4. Is Prometheus currently evolving the system, or mostly auditing and distributing tasks?
5. How should Prometheus improve its own reasoning structure, planning quality, and model-capacity utilization?
6. Does the worker behavior model and code structure help self-improvement, or block it?
7. In this cycle, what are the highest-leverage changes that make the system not only safer, but also smarter and deeper in reasoning?

## PLANNING POLICY
- maxTasks: ${planningPolicy.maxTasks > 0 ? planningPolicy.maxTasks : "UNLIMITED"}
- maxWorkersPerWave: ${planningPolicy.maxWorkersPerWave}
- preferFewestWorkers: ${planningPolicy.preferFewestWorkers}
- requireDependencyAwareWaves: ${planningPolicy.requireDependencyAwareWaves}
- If maxTasks is UNLIMITED, include ALL materially distinct actionable tasks you find.
${behaviorPatternsSection}${carryForwardSection}${repoFileListingSection}${repairFeedbackSection}
## OUTPUT FORMAT
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
- **verification**: Specific test file path AND expected test description or observable log assertion (e.g., "tests/core/foo.test.js — test: should return X when Y"). Generic "npm test" or "run tests" is REJECTED.
- **premortem** (REQUIRED when riskLevel is "medium" or "high"): Object with: failureModes (array of ≥2 distinct failure scenarios each with cause+impact), mitigations (array), rollbackPlan (string describing how to revert safely).
- **leverage_rank**: Which dimension(s) from the EQUAL DIMENSION SET this improves

## PACKET FIELD ENFORCEMENT RULES
These rules are enforced by the quality gate. Violations cause plan rejection:
1. **target_files**: Must list real existing paths verbatim from EXISTING REPOSITORY FILES. Do not invent module names. For new files, include the parent module path as the first entry.
2. **before_state**: Must describe observable current behavior — cite the actual function name, variable, or code gap. "Current state is suboptimal" is rejected.
3. **after_state**: Must describe what is measurably different — not a restatement of the title or before_state negation.
4. **verification**: Must name a specific test file (e.g., tests/core/foo.test.js) plus an expected test name or exact log assertion. "npm test" alone is always rejected.
5. **acceptance_criteria**: ≥2 items, each a concrete testable statement. Every item must be independently verifiable.
6. **riskLevel + premortem**: Any task modifying orchestration paths, plan parsing, or dispatch logic is automatically high-risk and requires a compliant premortem.
7. **requestBudget**: Compute byWave and byRole from actual plan distribution. Never emit _fallback:true. byWave and byRole arrays must not be empty if plans exist.

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
    "verification": "tests/core/foo.test.js — test: expected description",
    "premortem": null
  }]
}
Do NOT omit target_files, before_state, after_state, scope, or acceptance_criteria from any plan entry.
Do NOT emit requestBudget with _fallback:true — compute byWave and byRole from the actual plan list.
Keep diagnostic findings in analysis or strategicNarrative and include only actionable redesign work in plans.
Wrap the JSON companion with markers:

===DECISION===
{ ...optional companion json... }
===END===`;

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
  const parsedForValidation = normalizePrometheusParsedOutput(
    aiResult?.parsed || buildNarrativeFallbackParsed({ ...aiResult, raw }),
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
