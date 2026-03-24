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
import { runCriticPass } from "./plan_critic.js";
import { enrichPlansWithAC } from "./ac_compiler.js";
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

export function buildConcretePremortem(taskText, targetFiles = []) {
  const task = String(taskText || "target change").trim() || "target change";
  const targets = Array.isArray(targetFiles)
    ? targetFiles.map(v => String(v || "").trim()).filter(Boolean)
    : [];
  const targetSummary = targets.join(", ") || "targeted files";

  return {
    riskLevel: PREMORTEM_RISK_LEVEL.HIGH,
    scenario: `A high-risk change in ${targetSummary} could regress behavior while implementing ${task}.`,
    failurePaths: [
      `Dependency or routing changes in ${targetSummary} break an existing execution path.`,
      `The implementation for ${task} introduces incorrect dispatch under valid input.`
    ],
    mitigations: [
      `Keep behavior behind deterministic validation and targeted tests for ${targetSummary}.`,
      "Preserve rollback-safe defaults if any verification gate fails."
    ],
    detectionSignals: [
      `Targeted tests for ${targetSummary} fail immediately after the change.`,
      `Cycle telemetry indicates regression in the stage affected by ${task}.`
    ],
    guardrails: [
      `Require explicit verification before dispatch for changes touching ${targetSummary}.`,
      "Block promotion when outputs are ambiguous or degraded."
    ],
    rollbackPlan: `Revert changes in ${targetSummary} and restore the previous deterministic path.`
  };
}

function normalizeFollowUpTaskKey(text) {
  const s = String(text || "").toLowerCase();
  return s
    .replace(/[`'"()[\]{}]/g, " ")
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

function normalizePlanFromTask(task, index, fallbackWave = 1) {
  const src = (task && typeof task === "object") ? task : {};
  const taskText = String(src.task || src.title || src.task_id || src.id || `Task-${index + 1}`).trim();
  const verificationCommands = Array.isArray(src.verification_commands)
    ? src.verification_commands.map(v => String(v || "").trim()).filter(Boolean)
    : [];
  const verification = String(src.verification || verificationCommands[0] || "npm test").trim() || "npm test";
  const wave = normalizeWaveValue(src.wave, fallbackWave);

  return {
    ...src,
    role: String(src.role || "evolution-worker").trim() || "evolution-worker",
    task: taskText,
    priority: Number.isFinite(Number(src.priority)) ? Number(src.priority) : index + 1,
    wave,
    verification,
    title: String(src.title || taskText).trim(),
    scope: String(src.scope || "").trim(),
    task_id: String(src.task_id || src.id || taskText).trim(),
    description: String(src.description || "").trim(),
    waveLabel: String(src.waveLabel || "").trim(),
    verification_commands: verificationCommands.length > 0 ? verificationCommands : [verification],
    acceptance_criteria: Array.isArray(src.acceptance_criteria)
      ? src.acceptance_criteria.map(v => String(v || "").trim()).filter(Boolean)
      : [],
    dependencies: Array.isArray(src.dependencies)
      ? src.dependencies.map(v => String(v || "").trim()).filter(Boolean)
      : []
  };
}

function buildPlansFromAlternativeShape(input = {}) {
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
    const waveValue = normalizeWaveValue(waveObj.wave, i + 1);
    const waveTasks = Array.isArray(waveObj.tasks) ? waveObj.tasks : [];
    for (const waveTask of waveTasks) {
      if (waveTask && typeof waveTask === "object") {
        const asTask = normalizePlanFromTask(waveTask, tasks.length, waveValue);
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
      "system redesign directions",
      "worker model redesign",
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

export function normalizePrometheusParsedOutput(parsed, aiResult = {}) {
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
    plans = buildPlansFromBottlenecksShape(input);
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

  const executionStrategy = (input.executionStrategy && typeof input.executionStrategy === "object")
    ? input.executionStrategy
    : { waves: Array.isArray(input.waves) ? input.waves : [] };

  const requestBudget = (input.requestBudget && Number.isFinite(Number(input.requestBudget.estimatedPremiumRequestsTotal)))
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
  if (requestBudget._fallback) {
    parserConfidence = Math.max(0.1, parserConfidence - 0.1);
  }

  return {
    ...input,
    analysis: analysisText || "Prometheus analysis available but narrative was empty.",
    projectHealth,
    executionStrategy,
    requestBudget,
    parserConfidence: Math.round(parserConfidence * 100) / 100,
    plans
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

export async function runPrometheusAnalysis(config, options = {}) {
  const stateDir = config.paths?.stateDir || "state";

  // ── Freshness cache: skip if recent analysis exists ───────────────────────
  const freshnessMins = Number(config.runtime?.prometheusAnalysisFreshnessMinutes);
  if (Number.isFinite(freshnessMins) && freshnessMins > 0) {
    try {
      const existing = await readJson(path.join(stateDir, "prometheus_analysis.json"), null);
      if (existing?.analyzedAt) {
        const ageMs = Date.now() - new Date(existing.analyzedAt).getTime();
        if (ageMs < freshnessMins * 60_000) {
          // If cached file already has plans, return it as-is
          if (Array.isArray(existing.plans) && existing.plans.length > 0) {
            await appendProgress(config, `[PROMETHEUS] Fresh analysis exists (${Math.round(ageMs / 60_000)}m old, threshold=${freshnessMins}m) — reusing cached result`);
            return existing;
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
                filesInScope: [],
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
      const issuePatterns = {};
      const workerProblems = {};
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
${behaviorPatternsSection}${carryForwardSection}
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
Each packet must contain:
- **title**: Clear one-line description of the change
- **owner**: Which component/agent/worker should execute this (e.g., evolution-worker, prometheus, athena, orchestrator)
- **dependencies**: What must be completed first (list packet titles or "none")
- **acceptance_criteria**: Measurable conditions that prove this is done (not subjective)
- **verification**: Exact command(s) or check(s) to validate completion
- **leverage_rank**: Which dimension(s) from the EQUAL DIMENSION SET this improves

Write the entire response in English only.
If you include recommendations, rank them by capacity-increase leverage, not by fear or surface risk alone.
Security or governance recommendations must explain how they contribute to capacity increase rather than being presented as the default center of gravity.
You MUST emit a structured JSON companion block at the end of your response.
The JSON block must contain at minimum: { "projectHealth": "<healthy|warning|critical>", "totalPackets": <number>, "plans": [{ "title": "...", "owner": "...", "wave": <number> }] }
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

  appendLiveLogSync(stateDir, `\n[copilot_stream_end] ${ts()} exit=${result.status}\n`);

  const stdout = String(result?.stdout || "");
  const stderr = String(result?.stderr || "");
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
  if (result.status !== 0) {
    const error = `exited ${result.status}: ${(stderr || stdout).slice(0, 500)}`;
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
    const criticResult = runCriticPass(parsed.plans);
    if (criticResult.rejected.length > 0) {
      await appendProgress(config,
        `[PROMETHEUS][CRITIC] ${criticResult.rejected.length} plan(s) flagged by critic: ${criticResult.results.filter(r => !r.passed).map(r => r.issues.join("; ")).join(" | ")}`
      );
    }
    // Tag plans with critic scores for Athena visibility
    for (let i = 0; i < parsed.plans.length; i++) {
      parsed.plans[i]._criticScore = criticResult.results[i]?.score ?? null;
      parsed.plans[i]._criticIssues = criticResult.results[i]?.issues ?? [];
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
        filesInScope: [],
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
