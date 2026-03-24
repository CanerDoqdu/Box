/**
 * Self-Improvement Repair Engine (Phase A & B)
 *
 * Phase A: Post-Athena-rejection systemic repair analysis
 * Phase B: Post-completion worker health audit
 *
 * Uses the self-improvement agent (Claude Sonnet 4.5) for structured analysis.
 * Replaces legacy issachar-based self-improvement for repair/audit flows.
 */

import path from "node:path";
import { readJson, writeJson, spawnAsync } from "./fs_utils.js";
import { buildAgentArgs, parseAgentOutput } from "./agent_loader.js";
import { warn } from "./logger.js";
import { appendEscalation, BLOCKING_REASON_CLASS, NEXT_ACTION } from "./escalation_queue.js";

// ── Gate decisions ──────────────────────────────────────────────────────────

export const REPAIR_GATE = Object.freeze({
  REPLAN_ONCE: "REPLAN_ONCE",
  STOP_AND_ESCALATE: "STOP_AND_ESCALATE",
});

export const HEALTH_GATE = Object.freeze({
  HEALTHY: "HEALTHY",
  UNHEALTHY: "UNHEALTHY",
});

// ── Phase A: Post-Rejection Repair ──────────────────────────────────────────

/**
 * Run self-improvement repair analysis after Athena rejects a Prometheus plan.
 *
 * @param {object} config
 * @param {object} params
 * @param {object} params.jesusDecision    — Jesus decision from Step 1
 * @param {object} params.prometheusPlan   — The rejected Prometheus plan payload
 * @param {object} params.athenaRejection  — { reason, corrections, summary }
 * @param {object} [params.systemHealth]   — Recent postmortems/health signals
 * @returns {Promise<object|null>} Structured repair analysis or null on failure
 */
export async function runRepairAnalysis(config, {
  jesusDecision,
  prometheusPlan,
  athenaRejection,
  systemHealth,
  repairHistory = [],
  priorRepairGuidance = null,
  attemptNumber = 1,
  maxAttempts = 1,
}) {
  const command = config.env?.copilotCliCommand || "copilot";

  const corrections = (athenaRejection?.corrections || [])
    .map((c, i) => (i + 1) + ". " + c)
    .join("\n");

  const prompt = [
    "## PHASE: POST-REJECTION REPAIR ANALYSIS",
    "",
    "You are the self-improvement agent. Analyze why Athena rejected the Prometheus plan and produce deep, systemic repair guidance.",
    "Do NOT produce a one-shot patch mindset. Produce constraints that prevent this class of failure across future cycles.",
    "",
    `## ATTEMPT CONTEXT`,
    `attemptNumber: ${attemptNumber}`,
    `maxAttempts: ${maxAttempts}`,
    "",
    "## PRIOR REPAIR GUIDANCE (carry-forward)",
    JSON.stringify(priorRepairGuidance || {}, null, 2),
    "",
    "## PRIOR REPAIR HISTORY (earlier failed attempts)",
    JSON.stringify(Array.isArray(repairHistory) ? repairHistory : [], null, 2),
    "",
    "## JESUS DECISION (Step 1 context)",
    JSON.stringify(jesusDecision || {}, null, 2),
    "",
    "## PROMETHEUS PLAN (rejected)",
    JSON.stringify(truncateForPrompt(prometheusPlan), null, 2),
    "",
    "## ATHENA REJECTION",
    "Reason: " + JSON.stringify(athenaRejection?.reason || "unknown"),
    "Corrections:",
    corrections,
    "Summary: " + (athenaRejection?.summary || "N/A"),
    "",
    "## SYSTEM HEALTH SIGNALS",
    JSON.stringify(systemHealth || {}, null, 2),
    "",
    "## TASK",
    "1. Identify the ROOT CAUSES of why Prometheus produced this rejected plan.",
    "2. Produce behaviorPatches — concrete constraints for Prometheus re-plan.",
    "3. Define repairedPlanConstraints that Prometheus must follow.",
    "4. Upgrade verification standards where Athena found them weak.",
    "5. Produce systemicFixes — project-wide safeguards so the same failure class does not recur.",
    "6. Produce resumeDirective — where orchestrator should resume when approved.",
    "7. Decide: REPLAN_ONCE (attempt re-plan) or STOP_AND_ESCALATE (too deep).",
    "",
    "Rule: If rejection is due to structural omissions (fields, gates, validation shape), prefer REPLAN_ONCE with stronger systemic constraints before escalation.",
    "",
    "Respond with ONLY valid JSON matching the Phase A output schema. No markdown.",
  ].join("\n");

  const args = buildAgentArgs({ agentSlug: "self-improvement", prompt, allowAll: false, noAskUser: true });

  let result;
  try {
    result = await spawnAsync(command, args, { env: process.env });
  } catch (err) {
    warn("[self-improvement-repair] agent spawn failed: " + String(err?.message || err));
    return null;
  }

  const raw = String(result?.stdout || result?.stderr || "");
  const parsed = parseAgentOutput(raw);

  if (parsed?.ok && parsed.parsed) {
    return normalizeRepairOutput(parsed.parsed);
  }

  // Fallback: try direct JSON extraction
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return normalizeRepairOutput(JSON.parse(jsonMatch[0]));
    } catch { /* fall through */ }
  }

  warn("[self-improvement-repair] failed to parse repair analysis output");
  return null;
}

// ── Phase B: Post-Completion Health Audit ────────────────────────────────────

/**
 * Run self-improvement health audit after workers complete successfully.
 *
 * @param {object} config
 * @param {object} params
 * @param {object} params.workerResults    — Worker execution summary
 * @param {Array}  params.postmortems      — Recent Athena postmortems
 * @param {object} [params.systemHealth]   — System health metrics
 * @returns {Promise<object|null>} Structured health audit or null on failure
 */
export async function runHealthAudit(config, { workerResults, postmortems, systemHealth }) {
  const command = config.env?.copilotCliCommand || "copilot";

  const prompt = [
    "## PHASE: POST-COMPLETION HEALTH AUDIT",
    "",
    "You are auditing worker health after a successful cycle completion.",
    "",
    "## WORKER RESULTS",
    JSON.stringify(workerResults || {}, null, 2),
    "",
    "## RECENT POSTMORTEMS (last 10)",
    JSON.stringify(postmortems || [], null, 2),
    "",
    "## SYSTEM HEALTH SIGNALS",
    JSON.stringify(systemHealth || {}, null, 2),
    "",
    "## TASK",
    "1. Assess overall worker health (error patterns, retry concentration, quality trends).",
    "2. Identify problem workers with recurring failures.",
    "3. Decide: HEALTHY (continue) or UNHEALTHY (escalate/guardrail).",
    "",
    "Respond with ONLY valid JSON matching the Phase B output schema. No markdown.",
  ].join("\n");

  const args = buildAgentArgs({ agentSlug: "self-improvement", prompt, allowAll: false, noAskUser: true });

  let result;
  try {
    result = await spawnAsync(command, args, { env: process.env });
  } catch (err) {
    warn("[self-improvement-health] agent spawn failed: " + String(err?.message || err));
    return null;
  }

  const raw = String(result?.stdout || result?.stderr || "");
  const parsed = parseAgentOutput(raw);

  if (parsed?.ok && parsed.parsed) {
    return normalizeHealthOutput(parsed.parsed);
  }

  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return normalizeHealthOutput(JSON.parse(jsonMatch[0]));
    } catch { /* fall through */ }
  }

  warn("[self-improvement-health] failed to parse health audit output");
  return null;
}

// ── Normalizers ─────────────────────────────────────────────────────────────

/**
 * Normalize repair output with safe defaults.
 */
export function normalizeRepairOutput(obj) {
  return {
    phase: "repair",
    rootCauses: Array.isArray(obj.rootCauses) ? obj.rootCauses : [],
    behaviorPatches: Array.isArray(obj.behaviorPatches) ? obj.behaviorPatches : [],
    repairedPlanConstraints: obj.repairedPlanConstraints || {},
    verificationUpgrades: Array.isArray(obj.verificationUpgrades) ? obj.verificationUpgrades : [],
    gateDecision: obj.gateDecision === REPAIR_GATE.STOP_AND_ESCALATE
      ? REPAIR_GATE.STOP_AND_ESCALATE
      : REPAIR_GATE.REPLAN_ONCE,
    gateReason: String(obj.gateReason || ""),
    systemicFixes: Array.isArray(obj.systemicFixes) ? obj.systemicFixes : [],
    resumeDirective: String(obj.resumeDirective || ""),
  };
}

/**
 * Normalize health audit output with safe defaults.
 */
export function normalizeHealthOutput(obj) {
  return {
    phase: "health_audit",
    workerHealth: obj.workerHealth || { overall: "HEALTHY", reason: "unknown", problemWorkers: [] },
    patterns: obj.patterns || { retryConcentration: "none", qualityTrend: "stable", recurringFailures: [] },
    recommendations: Array.isArray(obj.recommendations) ? obj.recommendations : [],
    gateDecision: obj.gateDecision === HEALTH_GATE.UNHEALTHY
      ? HEALTH_GATE.UNHEALTHY
      : HEALTH_GATE.HEALTHY,
    gateReason: String(obj.gateReason || ""),
  };
}

// ── State persistence ───────────────────────────────────────────────────────

/**
 * Persist a repair or health audit decision to versioned state.
 *
 * @param {object} config
 * @param {string} phase  — "repair" | "health_audit"
 * @param {object} analysis — The structured output from repair/health analysis
 * @param {object} [context] — Additional context (cycle info, attempt number)
 */
export async function persistSelfImprovementDecision(config, phase, analysis, context = {}) {
  const stateDir = config.paths?.stateDir || "state";
  const record = {
    phase,
    decidedAt: new Date().toISOString(),
    gateDecision: analysis.gateDecision,
    gateReason: analysis.gateReason,
    analysis,
    context,
  };

  // Append to versioned log
  const logPath = path.join(stateDir, "self_improvement_decisions.json");
  const existing = await readJson(logPath, { entries: [] });
  const entries = Array.isArray(existing.entries) ? existing.entries : [];
  entries.push(record);

  // Cap at 100 entries
  const trimmed = entries.length > 100 ? entries.slice(-100) : entries;
  await writeJson(logPath, { entries: trimmed, updatedAt: new Date().toISOString() });

  // Also write latest decision for quick access
  await writeJson(path.join(stateDir, "self_improvement_latest.json"), record);

  return record;
}

/**
 * Escalate a failed repair cycle to the escalation queue.
 */
export async function escalateRepairFailure(config, analysis, context = {}) {
  const cycleId = context.cycleId || Date.now();
  const reason = (analysis.gateReason || "unknown reason").slice(0, 200);

  return appendEscalation(config, {
    role: "self-improvement",
    taskFingerprint: "repair-failure-" + cycleId,
    taskSnippet: "Self-improvement repair failed: " + reason,
    blockingReasonClass: BLOCKING_REASON_CLASS.VERIFICATION_GATE,
    nextAction: NEXT_ACTION.ESCALATE_TO_HUMAN,
    attempts: context.athenaReviewCount || 2,
    metadata: {
      rootCauses: analysis.rootCauses,
      gateDecision: analysis.gateDecision,
      gateReason: analysis.gateReason,
    },
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Truncate large plan payloads to keep prompt within token budget.
 */
function truncateForPrompt(obj) {
  if (!obj) return obj;
  const str = JSON.stringify(obj);
  if (str.length <= 30_000) return obj;
  // Keep plans array summary + top-level fields
  const summary = { ...obj };
  if (Array.isArray(summary.plans)) {
    summary.plans = summary.plans.map(p => ({
      role: p.role,
      task: String(p.task || "").slice(0, 300),
      verification: String(p.verification || "").slice(0, 200),
      target_files: p.target_files,
      wave: p.wave,
    }));
  }
  // Remove large narrative fields
  delete summary.strategicNarrative;
  delete summary.rawOutput;
  return summary;
}
