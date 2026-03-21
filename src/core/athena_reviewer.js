/**
 * Athena — Quality Gate & Postmortem Reviewer
 *
 * Athena is called at two points in every cycle:
 *
 *   1. PRE-WORK (Plan Review): After Prometheus produces a plan,
 *      Athena validates it: "Is the goal measurable? Are success criteria clear?
 *      Are acceptance tests defined?" If not, she rejects it back to Prometheus.
 *
 *   2. POST-WORK (Postmortem): After a worker finishes (merge/PR),
 *      Athena runs a short postmortem: "What was expected? What actually happened?
 *      What did we learn?" She records lessons for future cycles.
 *
 * Athena uses exactly 1 premium request per invocation (single-prompt, no autopilot).
 */

import path from "node:path";
import { readJson, writeJson, spawnAsync } from "./fs_utils.js";
import { appendProgress, appendAlert, ALERT_SEVERITY } from "./state_tracker.js";
import { getRoleRegistry } from "./role_registry.js";
import { buildAgentArgs, parseAgentOutput, logAgentThinking } from "./agent_loader.js";
import { chatLog } from "./logger.js";
import {
  addSchemaVersion,
  extractPostmortemEntries,
  migrateData,
  recordMigrationTelemetry,
  STATE_FILE_TYPE,
  MIGRATION_REASON
} from "./schema_registry.js";

// ── Canonical postmortem schema ──────────────────────────────────────────────

/**
 * Canonical values for Athena's postmortem `recommendation` field.
 * New schema (written by runAthenaPostmortem since BOX v1).
 *
 * @enum {string}
 */
export const POSTMORTEM_RECOMMENDATION = Object.freeze({
  PROCEED: "proceed",   // task succeeded — count toward completedTasks
  REWORK:  "rework",    // task needs another attempt
  ESCALATE: "escalate"  // task needs human intervention
});

/**
 * Decision quality labels for postmortem entries.
 * Assigned deterministically from the task outcome via LABEL_OUTCOME_MAP.
 *
 * @enum {string}
 */
export const DECISION_QUALITY_LABEL = Object.freeze({
  CORRECT:         "correct",          // outcome==merged — plan executed and merged as expected
  DELAYED_CORRECT: "delayed-correct",  // outcome==reopen — completed after extra iteration
  INCORRECT:       "incorrect",        // outcome==rollback — plan executed but result was rolled back
  INCONCLUSIVE:    "inconclusive"      // outcome==timeout or unknown — result indeterminate
});

/**
 * Reason codes returned by computeDecisionQualityLabel.
 * Distinguishes missing input from invalid input — no silent fallback allowed.
 *
 * @enum {string}
 */
export const DECISION_QUALITY_REASON = Object.freeze({
  OK:            "OK",
  /** outcome field was absent from the worker result */
  MISSING_INPUT: "MISSING_INPUT",
  /** outcome field was present but not a known value in LABEL_OUTCOME_MAP */
  INVALID_INPUT: "INVALID_INPUT"
});

/**
 * Explicit label-to-outcome mapping table.
 * Workers and tests must use this table; do not infer labels from ad-hoc string matching.
 *
 * outcome       → decisionQualityLabel
 * ─────────────────────────────────────
 * merged        → correct
 * reopen        → delayed-correct
 * rollback      → incorrect
 * timeout       → inconclusive
 *
 * All other values → INVALID_INPUT (label=inconclusive, degraded status)
 */
export const LABEL_OUTCOME_MAP = Object.freeze({
  merged:   DECISION_QUALITY_LABEL.CORRECT,
  reopen:   DECISION_QUALITY_LABEL.DELAYED_CORRECT,
  rollback: DECISION_QUALITY_LABEL.INCORRECT,
  timeout:  DECISION_QUALITY_LABEL.INCONCLUSIVE
});

/** All valid outcome keys as a Set for O(1) lookup. */
const VALID_OUTCOMES = new Set(Object.keys(LABEL_OUTCOME_MAP));

/**
 * Compute the decision quality label for a postmortem outcome.
 *
 * Distinguishes:
 *   - Missing input  (outcome is null/undefined) → inconclusive, reason=MISSING_INPUT
 *   - Invalid input  (outcome present but unknown) → inconclusive + degraded status, reason=INVALID_INPUT
 *   - Valid input    → mapped label, reason=OK
 *
 * Never returns a silent fallback — callers must check `reason` before trusting `label`.
 *
 * @param {string|null|undefined} outcome
 * @returns {{ label: string, reason: string, status: "ok"|"degraded" }}
 */
export function computeDecisionQualityLabel(outcome) {
  if (outcome === null || outcome === undefined || outcome === "") {
    return {
      label: DECISION_QUALITY_LABEL.INCONCLUSIVE,
      reason: DECISION_QUALITY_REASON.MISSING_INPUT,
      status: "degraded"
    };
  }
  const key = String(outcome).toLowerCase().trim();
  if (!VALID_OUTCOMES.has(key)) {
    return {
      label: DECISION_QUALITY_LABEL.INCONCLUSIVE,
      reason: DECISION_QUALITY_REASON.INVALID_INPUT,
      status: "degraded"
    };
  }
  return {
    label: LABEL_OUTCOME_MAP[key],
    reason: DECISION_QUALITY_REASON.OK,
    status: "ok"
  };
}

/**
 * Normalize the decisionQualityLabel field on a postmortem entry.
 * For legacy entries that pre-date T-012, the field will be absent — default to inconclusive.
 * For entries written after T-012, the field must be a valid DECISION_QUALITY_LABEL value.
 *
 * @param {object} pm - postmortem record
 * @returns {string} - a DECISION_QUALITY_LABEL value
 */
export function normalizeDecisionQualityLabel(pm) {
  if (!pm || typeof pm !== "object") return DECISION_QUALITY_LABEL.INCONCLUSIVE;
  const existing = pm.decisionQualityLabel;
  if (!existing) return DECISION_QUALITY_LABEL.INCONCLUSIVE;
  const validLabels = new Set(Object.values(DECISION_QUALITY_LABEL));
  return validLabels.has(existing) ? existing : DECISION_QUALITY_LABEL.INCONCLUSIVE;
}

/**
 * Reason codes returned by normalizePostmortemVerdict.
 * Callers must check this field before trusting `pass`.
 *
 * @enum {string}
 */
export const POSTMORTEM_PARSE_REASON = Object.freeze({
  OK: "OK",
  /** Neither `recommendation` nor legacy `verdict` field is present. */
  MISSING_VERDICT: "MISSING_VERDICT",
  /** `recommendation` is present but not a known POSTMORTEM_RECOMMENDATION value. */
  INVALID_RECOMMENDATION: "INVALID_RECOMMENDATION"
});

/** All valid recommendation strings as a Set for O(1) lookup. */
const VALID_RECOMMENDATIONS = new Set(Object.values(POSTMORTEM_RECOMMENDATION));

/**
 * Normalize a postmortem record's pass/fail status.
 *
 * Strategy: normalize on read (no silent fallback for critical state).
 *   - New schema  (has `recommendation`): pass iff recommendation === "proceed"
 *   - Legacy schema (has `verdict`, no `recommendation`): pass iff verdict === "pass"
 *   - Unknown (neither field): degrade — pass=false, reason=MISSING_VERDICT
 *
 * @param {object} pm - postmortem record from athena_postmortems.json
 * @returns {{ pass: boolean, schema: "new"|"legacy"|"unknown", reason: string }}
 */
export function normalizePostmortemVerdict(pm) {
  if (!pm || typeof pm !== "object") {
    return { pass: false, schema: "unknown", reason: POSTMORTEM_PARSE_REASON.MISSING_VERDICT };
  }

  // New schema: recommendation field takes precedence
  if ("recommendation" in pm) {
    const rec = pm.recommendation;
    if (!VALID_RECOMMENDATIONS.has(rec)) {
      return { pass: false, schema: "new", reason: POSTMORTEM_PARSE_REASON.INVALID_RECOMMENDATION };
    }
    return { pass: rec === POSTMORTEM_RECOMMENDATION.PROCEED, schema: "new", reason: POSTMORTEM_PARSE_REASON.OK };
  }

  // Legacy schema fallback: verdict field (backward compatibility)
  if ("verdict" in pm) {
    return { pass: pm.verdict === "pass", schema: "legacy", reason: POSTMORTEM_PARSE_REASON.OK };
  }

  // Neither field present — degrade explicitly, never silent
  return { pass: false, schema: "unknown", reason: POSTMORTEM_PARSE_REASON.MISSING_VERDICT };
}

// ── AI call (single-prompt, 1 request) ──────────────────────────────────────

async function callCopilotAgent(command, agentSlug, contextPrompt, config, model) {
  // Single-prompt mode: no autopilot, no continues — exactly 1 premium request
  const args = buildAgentArgs({
    agentSlug,
    prompt: contextPrompt,
    model,
    allowAll: false,
    maxContinues: undefined
  });
  const result = await spawnAsync(command, args, { env: process.env });
  const stdout = String(result?.stdout || "");
  const stderr = String(result?.stderr || "");
  if (result.status !== 0) {
    return { ok: false, raw: stdout || stderr, parsed: null, thinking: "", error: `exited ${result.status}` };
  }
  return parseAgentOutput(stdout || stderr);
}

// ── Plan Review (pre-work gate) ─────────────────────────────────────────────

export async function runAthenaPlanReview(config, prometheusAnalysis) {
  const stateDir = config.paths?.stateDir || "state";
  const registry = getRoleRegistry(config);
  const athenaName = registry?.qualityReviewer?.name || "Athena";
  const athenaModel = registry?.qualityReviewer?.model || "Claude Sonnet 4.6";
  const command = config.env?.copilotCliCommand || "copilot";

  await appendProgress(config, `[ATHENA] Plan review starting — validating Prometheus plan`);
  chatLog(stateDir, athenaName, "Plan review starting...");

  if (!prometheusAnalysis || !prometheusAnalysis.plans) {
    await appendProgress(config, `[ATHENA] No Prometheus plan to review — skipping`);
    return { approved: false, reason: "No plan provided", corrections: [] };
  }

  const plans = Array.isArray(prometheusAnalysis.plans) ? prometheusAnalysis.plans : [];
  const plansSummary = plans.map((p, i) => {
    return `  ${i + 1}. role=${p.role} task="${p.task}" priority=${p.priority} wave=${p.wave}\n     verification="${p.verification || "NONE"}"`;
  }).join("\n");

  const contextPrompt = `TARGET REPO: ${config.env?.targetRepo || "unknown"}

## YOUR MISSION — PLAN QUALITY REVIEW

You are Athena — BOX Quality Gate & Postmortem Reviewer.
Prometheus has produced a plan. Your job is to validate it BEFORE any worker starts.

For EACH plan item, check:
1. Is the goal measurable? (not vague like "improve" or "refactor")
2. Is there a clear success criterion? (what does "done" look like?)
3. Is the verification method concrete? (a test, a command, a check — not "verify it works")
4. Are file paths and scope specified?
5. Are dependencies between plans correct?

## PROMETHEUS PLAN TO REVIEW

Project Health: ${prometheusAnalysis.projectHealth || "unknown"}
Analysis: ${String(prometheusAnalysis.analysis || "").slice(0, 2000)}
Key Findings: ${String(prometheusAnalysis.keyFindings || "").slice(0, 1000)}

Plans (${plans.length}):
${plansSummary}

Execution Strategy: ${JSON.stringify(prometheusAnalysis.executionStrategy || {}, null, 2).slice(0, 1500)}

Request Budget: ${JSON.stringify(prometheusAnalysis.requestBudget || {}, null, 2).slice(0, 500)}

## OUTPUT FORMAT

Respond with your assessment, then:

===DECISION===
{
  "approved": true/false,
  "overallScore": 1-10,
  "summary": "Brief assessment of plan quality",
  "planReviews": [
    {
      "planIndex": 0,
      "role": "worker name",
      "measurable": true/false,
      "successCriteriaClear": true/false,
      "verificationConcrete": true/false,
      "scopeDefined": true/false,
      "issues": ["list of problems if any"],
      "suggestion": "how to fix if rejected"
    }
  ],
  "corrections": ["list of mandatory corrections before execution"],
  "missingMetrics": ["metrics that should be tracked but aren't"],
  "lessonsFromPast": "any relevant observations from past postmortems"
}
===END===`;

  const aiResult = await callCopilotAgent(command, "athena", contextPrompt, config, athenaModel);

  if (!aiResult.ok || !aiResult.parsed) {
    // Rollback: if runtime.athenaFailOpen is explicitly enabled, restore legacy permissive behavior.
    if (config.runtime?.athenaFailOpen === true) {
      await appendProgress(config, `[ATHENA] Plan review AI call failed — ${aiResult.error || "no JSON"} — auto-approving (fail-open mode active)`);
      chatLog(stateDir, athenaName, `AI failed: ${aiResult.error || "no JSON"} — auto-approve (fail-open)`);
      return { approved: true, reason: { code: "AI_CALL_FAILED_FAILOPEN", message: aiResult.error || "no JSON" }, corrections: [] };
    }

    // Fail-closed: AI failure must never silently approve the plan.
    const reason = { code: "AI_CALL_FAILED", message: aiResult.error || "No JSON returned from AI" };
    await appendProgress(config, `[ATHENA] Plan review AI call failed — ${reason.message} — blocking plan (fail-closed)`);
    chatLog(stateDir, athenaName, `AI failed: ${reason.message} — plan blocked`);
    await appendAlert(config, {
      severity: ALERT_SEVERITY.CRITICAL,
      source: "athena_reviewer",
      title: "Plan review AI call failed — plan blocked",
      message: `code=${reason.code} message=${reason.message}`
    });
    return { approved: false, reason, corrections: [] };
  }

  logAgentThinking(stateDir, athenaName, aiResult.thinking);

  const d = aiResult.parsed;
  const approved = d.approved !== false;
  const corrections = Array.isArray(d.corrections) ? d.corrections : [];

  const result = {
    approved,
    overallScore: d.overallScore || 0,
    summary: d.summary || "",
    planReviews: Array.isArray(d.planReviews) ? d.planReviews : [],
    corrections,
    missingMetrics: Array.isArray(d.missingMetrics) ? d.missingMetrics : [],
    reviewedAt: new Date().toISOString(),
    model: athenaModel
  };

  await writeJson(path.join(stateDir, "athena_plan_review.json"), result);

  if (approved) {
    await appendProgress(config, `[ATHENA] Plan APPROVED (score=${result.overallScore}/10) — ${result.summary}`);
    chatLog(stateDir, athenaName, `Plan approved: score=${result.overallScore}/10`);
  } else {
    await appendProgress(config, `[ATHENA] Plan REJECTED — corrections needed: ${corrections.join("; ")}`);
    chatLog(stateDir, athenaName, `Plan rejected: ${corrections.join("; ")}`);
  }

  return result;
}

// ── Postmortem (post-work review) ────────────────────────────────────────────

export async function runAthenaPostmortem(config, workerResult, originalPlan) {
  const stateDir = config.paths?.stateDir || "state";
  const registry = getRoleRegistry(config);
  const athenaName = registry?.qualityReviewer?.name || "Athena";
  const athenaModel = registry?.qualityReviewer?.model || "Claude Sonnet 4.6";
  const command = config.env?.copilotCliCommand || "copilot";

  await appendProgress(config, `[ATHENA] Postmortem starting — reviewing worker result`);
  chatLog(stateDir, athenaName, "Postmortem review starting...");

  const workerName = workerResult?.roleName || workerResult?.role || "unknown";
  const workerStatus = workerResult?.status || "unknown";
  const workerPr = workerResult?.pr || workerResult?.prUrl || "none";
  const workerSummary = workerResult?.summary || workerResult?.raw?.slice(0, 2000) || "no summary";
  const filesChanged = workerResult?.filesChanged || workerResult?.filesTouched || "unknown";

  // Derive task outcome for decision quality labeling.
  // Explicit outcome values (merged, reopen, rollback, timeout) map deterministically.
  // If workerResult.outcome is absent, infer a best-effort value from status/PR fields.
  const rawOutcome = workerResult?.outcome
    || (workerStatus === "done" && workerPr !== "none" ? "merged" : null)
    || (workerStatus === "timeout" ? "timeout" : null)
    || (workerStatus === "rollback" ? "rollback" : null)
    || null;
  const dql = computeDecisionQualityLabel(rawOutcome);

  // Evolution executor passes local verification results and pre-review context
  const verificationOutput = workerResult?.verificationOutput || null;
  const verificationPassed = workerResult?.verificationPassed;
  const preReviewAssessment = workerResult?.preReviewAssessment || null;
  const preReviewIssues = Array.isArray(workerResult?.preReviewIssues)
    ? workerResult.preReviewIssues
    : [];

  const planTask = originalPlan?.task || "unknown task";
  const planVerification = originalPlan?.verification || "no verification defined";
  const planContext = String(originalPlan?.context || "").slice(0, 2000);

  // Load previous postmortems for learning — migrate v0→v1 on read
  const postmortemsFilePath = path.join(stateDir, "athena_postmortems.json");
  const rawPostmortems = await readJson(postmortemsFilePath, null);
  let pastPostmortems;
  if (rawPostmortems !== null) {
    const migrated = migrateData(rawPostmortems, STATE_FILE_TYPE.ATHENA_POSTMORTEMS);
    if (!migrated.ok) {
      // Unknown future version or corrupt — fail closed, log telemetry, degrade gracefully
      await recordMigrationTelemetry(stateDir, {
        fileType: STATE_FILE_TYPE.ATHENA_POSTMORTEMS,
        filePath: postmortemsFilePath,
        fromVersion: migrated.fromVersion,
        toVersion: migrated.toVersion,
        success: false,
        reason: migrated.reason
      });
      if (migrated.reason === MIGRATION_REASON.UNKNOWN_FUTURE_VERSION) {
        await appendProgress(config,
          `[ATHENA] WARNING: athena_postmortems.json has unknown future schemaVersion (${migrated.fromVersion}) — ignoring history to avoid data corruption`
        );
      }
      pastPostmortems = [];
    } else {
      if (migrated.reason === MIGRATION_REASON.OK) {
        // Record telemetry only for actual migrations (not ALREADY_CURRENT)
        await recordMigrationTelemetry(stateDir, {
          fileType: STATE_FILE_TYPE.ATHENA_POSTMORTEMS,
          filePath: postmortemsFilePath,
          fromVersion: migrated.fromVersion,
          toVersion: migrated.toVersion,
          success: true,
          reason: migrated.reason
        });
      }
      pastPostmortems = extractPostmortemEntries(migrated.data);
    }
  } else {
    pastPostmortems = [];
  }
  const recentLessons = pastPostmortems.slice(-5).map(p => p.lessonLearned || "").filter(Boolean).join("\n  - ");

  const contextPrompt = `TARGET REPO: ${config.env?.targetRepo || "unknown"}

## YOUR MISSION — POSTMORTEM REVIEW

You are Athena — BOX Quality Gate & Postmortem Reviewer.
A worker has completed their task. Review the result against the original plan.

## ORIGINAL PLAN
Task: ${planTask}
Expected Verification: ${planVerification}
Context: ${planContext}

## WORKER RESULT
Worker: ${workerName}
Status: ${workerStatus}
PR: ${workerPr}
Files Changed: ${filesChanged}
Summary: ${workerSummary}

## LOCAL VERIFICATION RESULTS
${verificationPassed !== undefined ? `All commands passed: ${verificationPassed}` : "(not available)"}
${verificationOutput ? verificationOutput : ""}

## PRE-REVIEW CONTEXT (what Athena flagged before execution)
${preReviewAssessment ? `Assessment given to worker: ${preReviewAssessment}` : "(no pre-review data)"}
${preReviewIssues.length > 0 ? `Issues flagged pre-execution:\n${preReviewIssues.map(i => `  - ${i}`).join("\n")}` : ""}

## RECENT LESSONS LEARNED
${recentLessons ? `  - ${recentLessons}` : "  (no previous lessons)"}

## EVALUATE

1. Did the worker achieve what was planned?
2. Was the success criterion met?
3. What was expected vs what actually happened?
4. What should the system learn from this for future cycles?
5. Were there unexpected issues or deviations?

## OUTPUT FORMAT

===DECISION===
{
  "workerName": "${workerName}",
  "taskCompleted": true/false,
  "expectedOutcome": "what was supposed to happen",
  "actualOutcome": "what actually happened",
  "deviation": "none | minor | major",
  "successCriteriaMet": true/false,
  "lessonLearned": "one clear, actionable lesson for future cycles",
  "qualityScore": 1-10,
  "followUpNeeded": true/false,
  "followUpTask": "if follow-up needed, describe what",
  "recommendation": "proceed | rework | escalate"
}
===END===`;

  const aiResult = await callCopilotAgent(command, "athena", contextPrompt, config, athenaModel);

  if (!aiResult.ok || !aiResult.parsed) {
    await appendProgress(config, `[ATHENA] Postmortem AI call failed — ${aiResult.error || "no JSON"}`);
    chatLog(stateDir, athenaName, `Postmortem AI failed: ${aiResult.error || "no JSON"}`);
    return {
      workerName,
      taskCompleted: workerStatus === "done",
      recommendation: "proceed",
      lessonLearned: "",
      decisionQualityLabel: dql.label,
      decisionQualityLabelReason: dql.reason,
      decisionQualityStatus: dql.status,
      reviewedAt: new Date().toISOString()
    };
  }

  logAgentThinking(stateDir, athenaName, aiResult.thinking);

  const d = aiResult.parsed;
  const postmortem = {
    workerName: d.workerName || workerName,
    taskCompleted: d.taskCompleted !== false,
    expectedOutcome: d.expectedOutcome || "",
    actualOutcome: d.actualOutcome || "",
    deviation: d.deviation || "none",
    successCriteriaMet: d.successCriteriaMet !== false,
    lessonLearned: d.lessonLearned || "",
    qualityScore: d.qualityScore || 0,
    followUpNeeded: d.followUpNeeded === true,
    followUpTask: d.followUpTask || "",
    recommendation: d.recommendation || "proceed",
    decisionQualityLabel: dql.label,
    decisionQualityLabelReason: dql.reason,
    decisionQualityStatus: dql.status,
    reviewedAt: new Date().toISOString(),
    model: athenaModel
  };

  // Append to postmortem history (keep last 50)
  const history = Array.isArray(pastPostmortems) ? pastPostmortems : [];
  history.push(postmortem);
  if (history.length > 50) history.splice(0, history.length - 50);
  await writeJson(postmortemsFilePath, addSchemaVersion(history, STATE_FILE_TYPE.ATHENA_POSTMORTEMS));

  // Also write latest for dashboard visibility
  await writeJson(path.join(stateDir, "athena_latest_postmortem.json"), postmortem);

  await appendProgress(config,
    `[ATHENA] Postmortem: ${workerName} — score=${postmortem.qualityScore}/10 deviation=${postmortem.deviation} recommendation=${postmortem.recommendation} decisionQualityLabel=${postmortem.decisionQualityLabel}`
  );
  chatLog(stateDir, athenaName,
    `Postmortem: ${workerName} score=${postmortem.qualityScore}/10 → ${postmortem.recommendation}`
  );

  return postmortem;
}
