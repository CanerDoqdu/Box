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
import { rankLessonsByRelevance } from "./lesson_halflife.js";
import { detectRecurrences } from "./recurrence_detector.js";
import {
  addSchemaVersion,
  extractPostmortemEntries,
  migrateData,
  recordMigrationTelemetry,
  STATE_FILE_TYPE,
  MIGRATION_REASON
} from "./schema_registry.js";
import {
  validateLeadershipContract,
  LEADERSHIP_CONTRACT_TYPE,
  TRUST_BOUNDARY_ERROR,
} from "./trust_boundary.js";
import { checkForbiddenCommands } from "./verification_command_registry.js";
import { validateEvidenceEnvelope } from "./evidence_envelope.js";
import type { EvidenceEnvelope } from "./evidence_envelope.js";

// ── Rubric calibration ───────────────────────────────────────────────────────

/**
 * Taxonomy of rationale classes used in Athena plan review and calibration.
 *
 * Positive classes signal plan quality indicators.
 * Negative classes signal plan deficiency indicators.
 *
 * These values are used in calibration fixtures (expectedRationaleClasses) and in
 * the heuristic scoring function (scoreCalibrationPlan). New values must be added
 * here before being referenced in fixtures or tests.
 *
 * @enum {string}
 */
export const RATIONALE_CLASS = Object.freeze({
  // ── Positive (plan quality indicators) ────────────────────────────────────
  /** Goal expressed in measurable, observable terms */
  MEASURABLE_GOAL:          "MEASURABLE_GOAL",
  /** Success criterion is explicit and unambiguous */
  CLEAR_SUCCESS_CRITERION:  "CLEAR_SUCCESS_CRITERION",
  /** Verification uses a concrete command, test, or check */
  CONCRETE_VERIFICATION:    "CONCRETE_VERIFICATION",
  /** Files, modules, or boundaries are explicitly named */
  SCOPE_DEFINED:            "SCOPE_DEFINED",
  /** Wave/dependency ordering is correct and consistent */
  DEPENDENCY_CORRECT:       "DEPENDENCY_CORRECT",
  // ── Negative (plan deficiency indicators) ─────────────────────────────────
  /** Goal uses vague language (e.g. "improve", "refactor" without specifics) */
  VAGUE_GOAL:               "VAGUE_GOAL",
  /** No verification command, test, or check is provided */
  NO_VERIFICATION:          "NO_VERIFICATION",
  /** No files, modules, or boundaries are specified */
  MISSING_SCOPE:            "MISSING_SCOPE",
  /** Required fields are absent or incomplete */
  SPEC_INCOMPLETE:          "SPEC_INCOMPLETE",
  /** Wave ordering creates circular or contradictory dependencies */
  CIRCULAR_DEPENDENCY:      "CIRCULAR_DEPENDENCY"
});

/** Set of all valid RATIONALE_CLASS values for O(1) lookup. */
export const VALID_RATIONALE_CLASSES = new Set(Object.values(RATIONALE_CLASS));

/**
 * Score categories used in calibration deviation calculation.
 * Maps a numeric heuristic score [0–10] to a verdict category.
 *
 * Formula: score ≥ 7 → "approved" | score ≤ 3 → "rejected" | else → "ambiguous"
 * Range: [0.0, 1.0], unit: fraction (0.0 = no drift, 1.0 = complete drift)
 *
 * @enum {string}
 */
export const CALIBRATION_VERDICT = Object.freeze({
  APPROVED:  "approved",
  AMBIGUOUS: "ambiguous",
  REJECTED:  "rejected"
});

/**
 * Derive the verdict category from a numeric heuristic score.
 * Score thresholds: ≥7 → approved, ≤3 → rejected, 4–6 → ambiguous.
 *
 * @param {number} score - integer 0–10
 * @returns {string} - a CALIBRATION_VERDICT value
 */
export function verdictFromScore(score) {
  if (score >= 7) return CALIBRATION_VERDICT.APPROVED;
  if (score <= 3) return CALIBRATION_VERDICT.REJECTED;
  return CALIBRATION_VERDICT.AMBIGUOUS;
}

/** Words in a task description that signal vague/non-measurable goals. */
const VAGUE_TASK_PATTERNS = [
  /\bimprove\b/i,
  /\brefactor\b(?!\s+\w+\s+to\b)/i,
  /\bclean\s+up\b/i,
  /\benhance\b/i,
  /\boptimize\b(?!\s+[\w.]+\s+from\b)/i,
  /\bfix\s+(the\s+)?codebase\b/i
];

/**
 * Apply heuristic scoring to a single calibration fixture.
 *
 * Scoring rubric (deterministic, no AI):
 *   +2  task field is present, non-empty, and contains no vague patterns
 *   +2  verification field is present, non-empty, and is a concrete command
 *   +2  files array is non-empty (scope defined)
 *   +2  context field describes measurable success criterion (≥20 chars with criterion words)
 *   +1  priority and wave are both defined integers
 *   +1  task mentions a specific file path or function name
 *
 * Total: 0–10. Category: ≥7 → approved, ≤3 → rejected, 4–6 → ambiguous.
 *
 * Returns the assigned rationale classes alongside the numeric score.
 *
 * @param {object} fixture - parsed calibration fixture (schemaVersion 1)
 * @returns {{ score: number, scoreCategory: string, rationaleClasses: string[] }}
 */
export function scoreCalibrationPlan(fixture) {
  if (!fixture || typeof fixture !== "object") {
    return { score: 0, scoreCategory: CALIBRATION_VERDICT.REJECTED, rationaleClasses: [RATIONALE_CLASS.SPEC_INCOMPLETE] };
  }
  const plan = fixture.plan || {};
  const classes = [];
  let score = 0;

  // ── Task quality ──────────────────────────────────────────────────────────
  const task = typeof plan.task === "string" ? plan.task.trim() : "";
  if (task.length > 0) {
    const isVague = VAGUE_TASK_PATTERNS.some(p => p.test(task)) && task.length < 80;
    if (isVague) {
      classes.push(RATIONALE_CLASS.VAGUE_GOAL);
    } else {
      classes.push(RATIONALE_CLASS.MEASURABLE_GOAL);
      score += 2;
    }
  } else {
    classes.push(RATIONALE_CLASS.VAGUE_GOAL);
    classes.push(RATIONALE_CLASS.SPEC_INCOMPLETE);
  }

  // ── Verification ─────────────────────────────────────────────────────────
  const verification = typeof plan.verification === "string" ? plan.verification.trim() : "";
  if (verification.length > 0) {
    classes.push(RATIONALE_CLASS.CONCRETE_VERIFICATION);
    score += 2;
  } else {
    classes.push(RATIONALE_CLASS.NO_VERIFICATION);
  }

  // ── Scope (files) ────────────────────────────────────────────────────────
  const files = Array.isArray(plan.files) ? plan.files.filter(f => typeof f === "string" && f.trim().length > 0) : [];
  if (files.length > 0) {
    classes.push(RATIONALE_CLASS.SCOPE_DEFINED);
    score += 2;
  } else {
    classes.push(RATIONALE_CLASS.MISSING_SCOPE);
  }

  // ── Context / success criterion ───────────────────────────────────────────
  const context = typeof plan.context === "string" ? plan.context.trim() : "";
  const CRITERION_WORDS = /\b(success\s+crit|criterion|criteria|pass|should|must|expect|measur|result|output|retryCount|field|return)\b/i;
  if (context.length >= 20 && CRITERION_WORDS.test(context)) {
    classes.push(RATIONALE_CLASS.CLEAR_SUCCESS_CRITERION);
    score += 2;
  } else if (context.length > 0) {
    // Partial context present but not a clear criterion — no SPEC_INCOMPLETE unless task also vague
    score += 0;
  } else if (!classes.includes(RATIONALE_CLASS.SPEC_INCOMPLETE)) {
    classes.push(RATIONALE_CLASS.SPEC_INCOMPLETE);
  }

  // ── Priority + wave ───────────────────────────────────────────────────────
  if (Number.isInteger(plan.priority) && Number.isInteger(plan.wave)) {
    classes.push(RATIONALE_CLASS.DEPENDENCY_CORRECT);
    score += 1;
  }

  // ── Specific file path or function reference in task ──────────────────────
  if (/\b(src\/|tests\/|\.js\b|\.ts\b|\(\)|function\s|class\s)/.test(task)) {
    score += 1;
  }

  return {
    score: Math.min(10, Math.max(0, score)),
    scoreCategory: verdictFromScore(score),
    rationaleClasses: classes
  };
}

/**
 * Compute the deviation score across a set of calibration fixture results.
 *
 * Formula:
 *   deviationScore = number_of_mismatches / total_fixtures
 *
 * Range: [0.0, 1.0]
 * Unit:  fraction (0.0 = no drift, 1.0 = every fixture produced wrong verdict)
 *
 * A mismatch is when the actualCategory (derived from heuristic score) does not
 * equal fixture.expectedVerdict.
 *
 * @param {{ fixture: object, actualCategory: string }[]} results
 * @returns {{ deviationScore: number, total: number, mismatches: number, details: object[] }}
 */
export function computeCalibrationDeviation(results) {
  if (!Array.isArray(results) || results.length === 0) {
    return { deviationScore: 0.0, total: 0, mismatches: 0, details: [] };
  }
  const details = results.map(r => {
    const expected = r.fixture?.expectedVerdict ?? "unknown";
    const actual = r.actualCategory ?? "unknown";
    return {
      fixtureId: r.fixture?.fixtureId ?? "unknown",
      expected,
      actual,
      match: expected === actual
    };
  });
  const mismatches = details.filter(d => !d.match).length;
  const deviationScore = mismatches / results.length;
  return {
    deviationScore: Math.round(deviationScore * 10000) / 10000,
    total: results.length,
    mismatches,
    details
  };
}

/**
 * Run all fixtures through the heuristic scorer and compute deviation.
 * Pure function — no I/O, fully offline.
 *
 * @param {object[]} fixtures - array of parsed calibration fixture objects
 * @returns {{ deviationScore: number, total: number, mismatches: number, details: object[], results: object[] }}
 */
export function runCalibration(fixtures) {
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    return { deviationScore: 0.0, total: 0, mismatches: 0, details: [], results: [] };
  }
  const results = fixtures.map(fixture => {
    const scored = scoreCalibrationPlan(fixture);
    return { fixture, ...scored };
  });
  const deviation = computeCalibrationDeviation(
    results.map(r => ({ fixture: r.fixture, actualCategory: r.scoreCategory }))
  );

  // Capacity dimension: track which rationale classes are consistently missed
  const missedClasses = new Map();
  for (const r of results) {
    const expected = r.fixture?.expectedRationaleClasses || [];
    const matched = (r as any).matchedClasses || [];
    const matchedSet = new Set(matched);
    for (const cls of expected) {
      if (!matchedSet.has(cls)) {
        missedClasses.set(cls, (missedClasses.get(cls) || 0) + 1);
      }
    }
  }
  const capacityGaps = [...missedClasses.entries()]
    .filter(([, count]) => count >= 2)
    .map(([cls, count]) => ({ rationaleClass: cls, missedCount: count }))
    .sort((a, b) => b.missedCount - a.missedCount);

  return { ...deviation, results, capacityGaps };
}

/**
 * Task class taxonomy for class-segmented calibration.
 * @enum {string}
 */
export const TASK_CLASS = Object.freeze({
  IMPLEMENTATION: "implementation",
  TEST: "test",
  REFACTOR: "refactor",
  BUGFIX: "bugfix",
  GOVERNANCE: "governance",
  DOCUMENTATION: "documentation",
  INFRASTRUCTURE: "infrastructure",
  UNKNOWN: "unknown",
});

/**
 * Infer task class from a plan fixture.
 *
 * @param {object} fixture
 * @returns {string} one of TASK_CLASS values
 */
export function inferTaskClass(fixture) {
  const task = String(fixture?.plan?.task || "").toLowerCase();
  const role = String(fixture?.plan?.role || "").toLowerCase();
  if (/\btests?\b|\.test\.|spec\b/.test(task) || role === "test" || role === "qa") return TASK_CLASS.TEST;
  if (/\bbug\b|fix\b|patch\b|hotfix/.test(task) || role === "bugfix") return TASK_CLASS.BUGFIX;
  if (/\brefactor\b|cleanup|restructur/.test(task)) return TASK_CLASS.REFACTOR;
  if (/\bdoc\b|readme|documentation/.test(task) || role === "documentation") return TASK_CLASS.DOCUMENTATION;
  if (/\bgovern|policy|compliance|audit/.test(task) || role === "governance") return TASK_CLASS.GOVERNANCE;
  if (/\binfra|docker|ci|deploy|pipeline/.test(task) || role === "devops" || role === "infrastructure") return TASK_CLASS.INFRASTRUCTURE;
  if (/\bimplement|add|create|build|introduce/.test(task) || role === "implementation" || role === "backend" || role === "frontend") return TASK_CLASS.IMPLEMENTATION;
  return TASK_CLASS.UNKNOWN;
}

/**
 * Run calibration segmented by task class.
 * Returns per-class deviation scores and FP/FN rates.
 *
 * @param {object[]} fixtures
 * @returns {{ overall: object, byClass: Record<string, { deviationScore: number, total: number, mismatches: number, falsePositiveRate: number, falseNegativeRate: number }> }}
 */
export function computeCalibrationByTaskClass(fixtures) {
  const overall = runCalibration(fixtures);
  const byClass: Record<string, any> = {};

  // Group fixtures by task class
  const groups = new Map();
  for (const fixture of (fixtures || [])) {
    const cls = inferTaskClass(fixture);
    if (!groups.has(cls)) groups.set(cls, []);
    groups.get(cls).push(fixture);
  }

  for (const [cls, classFixtures] of groups) {
    const results = classFixtures.map(fixture => {
      const scored = scoreCalibrationPlan(fixture);
      return { fixture, ...scored };
    });
    const deviation = computeCalibrationDeviation(
      results.map(r => ({ fixture: r.fixture, actualCategory: r.scoreCategory }))
    );

    // FP = scored as rejected but expected approved; FN = scored as approved but expected rejected
    let fp = 0, fn = 0;
    for (const r of results) {
      const expected = r.fixture?.expectedVerdict;
      if (r.scoreCategory === CALIBRATION_VERDICT.REJECTED && expected === "approved") fp++;
      if (r.scoreCategory === CALIBRATION_VERDICT.APPROVED && expected === "rejected") fn++;
    }

    byClass[cls] = {
      deviationScore: deviation.deviationScore,
      total: deviation.total,
      mismatches: deviation.mismatches,
      falsePositiveRate: results.length > 0 ? Math.round((fp / results.length) * 10000) / 10000 : 0,
      falseNegativeRate: results.length > 0 ? Math.round((fn / results.length) * 10000) / 10000 : 0,
    };
  }

  return { overall, byClass };
}

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

// ── Pre-mortem Schema ────────────────────────────────────────────────────────

/**
 * Risk threshold for pre-mortem requirement.
 * Only HIGH-risk interventions require a pre-mortem before dispatch.
 * Athena hardening note (T-026): task scope mentioned "medium/high" but Athena
 * flagged dispatch pipeline gating as high blast-radius — use "high" only.
 *
 * @enum {string}
 */
export const PREMORTEM_RISK_LEVEL = Object.freeze({
  HIGH: "high"
});

/**
 * Status codes returned by validatePremortem.
 *
 * @enum {string}
 */
export const PREMORTEM_STATUS = Object.freeze({
  /** All required fields present and valid. */
  PASS:       "pass",
  /** Pre-mortem object present but one or more fields are missing or invalid. */
  INCOMPLETE: "incomplete",
  /** Pre-mortem object absent, null, or riskLevel is not "high". */
  BLOCKED:    "blocked"
});

/**
 * Reason codes returned by validatePremortem.
 * Distinguishes missing input from invalid input — no silent fallback.
 *
 * @enum {string}
 */
export const PREMORTEM_VALIDATION_REASON = Object.freeze({
  OK:               "OK",
  /** Pre-mortem object is null/undefined/not-an-object. */
  MISSING_FIELD:    "MISSING_FIELD",
  /** Pre-mortem present but one or more fields fail validation. */
  INVALID_FIELD:    "INVALID_FIELD",
  /** riskLevel field present but not "high". */
  WRONG_RISK_LEVEL: "WRONG_RISK_LEVEL"
});

/**
 * Canonical list of required pre-mortem fields.
 * All fields must be present and valid for status=PASS.
 *
 * Field        Type       Constraint
 * ─────────────────────────────────────────────────────────────────────
 * scenario        string     min 20 chars  — narrative of what could go wrong
 * failurePaths    string[]   min 1 item    — discrete failure modes enumerated
 * mitigations     string[]   min 1 item    — per-failure mitigation strategies
 * detectionSignals string[]  min 1 item    — observable signals of failure onset
 * guardrails      string[]   min 1 item    — checks/gates preventing cascading failure
 * rollbackPlan    string     min 10 chars  — safe rollback procedure
 * riskLevel       "high"                   — must be PREMORTEM_RISK_LEVEL.HIGH
 */
export const PREMORTEM_REQUIRED_FIELDS = Object.freeze([
  "scenario",
  "failurePaths",
  "mitigations",
  "detectionSignals",
  "guardrails",
  "rollbackPlan",
  "riskLevel"
]);

/** Minimum string lengths for pre-mortem string fields. */
const PREMORTEM_MIN_STRLEN = Object.freeze({
  scenario:    20,
  rollbackPlan: 10
});

/** Minimum array lengths for pre-mortem array fields. */
const PREMORTEM_MIN_ARRLEN = Object.freeze({
  failurePaths:     1,
  mitigations:      1,
  detectionSignals: 1,
  guardrails:       1
});

/**
 * Validate a pre-mortem object against the canonical schema.
 *
 * Distinguishes:
 *   - Missing input  (null/undefined/not-object) → BLOCKED,    reason=MISSING_FIELD
 *   - Wrong riskLevel (not "high")               → BLOCKED,    reason=WRONG_RISK_LEVEL
 *   - Invalid/incomplete fields                  → INCOMPLETE, reason=INVALID_FIELD
 *   - All fields present and valid               → PASS,       reason=OK
 *
 * Never returns a silent fallback — callers must check `status` before trusting the result.
 *
 * @param {unknown} input
 * @returns {{ status: string, reason: string, errors: string[] }}
 */
export function validatePremortem(input) {
  if (!input || typeof input !== "object") {
    return {
      status: PREMORTEM_STATUS.BLOCKED,
      reason: PREMORTEM_VALIDATION_REASON.MISSING_FIELD,
      errors: ["pre-mortem must be a non-null object"]
    };
  }

  const pm = input;

  // riskLevel must be "high" — only high-risk plans require pre-mortems
  if (!("riskLevel" in pm)) {
    return {
      status: PREMORTEM_STATUS.BLOCKED,
      reason: PREMORTEM_VALIDATION_REASON.MISSING_FIELD,
      errors: ["riskLevel is required"]
    };
  }
  if (pm.riskLevel !== PREMORTEM_RISK_LEVEL.HIGH) {
    return {
      status: PREMORTEM_STATUS.BLOCKED,
      reason: PREMORTEM_VALIDATION_REASON.WRONG_RISK_LEVEL,
      errors: [`riskLevel must be "${PREMORTEM_RISK_LEVEL.HIGH}", got "${pm.riskLevel}"`]
    };
  }

  const errors = [];

  // Validate string fields with minimum length
  for (const [field, minLen] of Object.entries(PREMORTEM_MIN_STRLEN)) {
    if (!(field in pm)) {
      errors.push(`${field} is required`);
    } else if (typeof pm[field] !== "string" || pm[field].trim().length < minLen) {
      errors.push(`${field} must be a string with at least ${minLen} characters`);
    }
  }

  // Validate array fields with minimum length
  for (const [field, minLen] of Object.entries(PREMORTEM_MIN_ARRLEN)) {
    if (!(field in pm)) {
      errors.push(`${field} is required`);
    } else if (!Array.isArray(pm[field]) || pm[field].length < minLen) {
      errors.push(`${field} must be an array with at least ${minLen} item(s)`);
    }
  }

  if (errors.length > 0) {
    return {
      status: PREMORTEM_STATUS.INCOMPLETE,
      reason: PREMORTEM_VALIDATION_REASON.INVALID_FIELD,
      errors
    };
  }

  return {
    status: PREMORTEM_STATUS.PASS,
    reason: PREMORTEM_VALIDATION_REASON.OK,
    errors: []
  };
}

/**
 * Check all high-risk plans for valid pre-mortems.
 * Returns an array of human-readable violation strings.
 * An empty array means all high-risk plans have valid pre-mortems.
 *
 * A plan is considered high-risk when plan.riskLevel === "high".
 * High-risk plans MUST include a `premortem` section that passes validatePremortem.
 *
 * @param {Array<object>} plans
 * @returns {string[]} violations
 */
export function checkPlanPremortemGate(plans) {
  const violations = [];
  if (!Array.isArray(plans)) return violations;

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    if (!plan || typeof plan !== "object") continue;
    if (plan.riskLevel !== PREMORTEM_RISK_LEVEL.HIGH) continue;

    const validation = validatePremortem(plan.premortem);
    if (validation.status !== PREMORTEM_STATUS.PASS) {
      const label = plan.task || plan.role || `index ${i}`;
      violations.push(
        `plan[${i}] "${label}": high-risk intervention requires a valid pre-mortem — ${validation.errors.join("; ")}`
      );
    }
  }

  return violations;
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
  const result: any = await spawnAsync(command, args, { env: process.env });
  const stdout = String(result?.stdout || "");
  const stderr = String(result?.stderr || "");
  if (result.status !== 0) {
    return { ok: false, raw: stdout || stderr, parsed: null, thinking: "", error: `exited ${result.status}` };
  }
  return parseAgentOutput(stdout || stderr);
}

function pickReviewerPayload(raw) {
  const candidates = [
    raw,
    raw?.decision,
    raw?.review,
    raw?.reviewer,
    raw?.result,
  ];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) continue;
    if (
      typeof candidate.approved === "boolean"
      || Array.isArray(candidate.corrections)
      || Array.isArray(candidate.planReviews)
      || typeof candidate.summary === "string"
      || typeof candidate.reason === "string"
    ) {
      return candidate;
    }
  }
  return raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
}

function collectReviewerCorrections(payload, planReviews) {
  if (Array.isArray(payload?.corrections)) {
    return payload.corrections.map((item) => String(item || "").trim()).filter(Boolean);
  }

  const fromReviews = [];
  for (const review of planReviews) {
    if (Array.isArray(review?.issues) && review.issues.length > 0) {
      const prefix = Number.isInteger(review.planIndex) ? `plan[${review.planIndex}]` : "plan";
      fromReviews.push(`${prefix}: ${review.issues.map((item) => String(item || "").trim()).filter(Boolean).join("; ")}`);
    }
  }
  return fromReviews.filter(Boolean);
}

function inferApprovalFromReviewerPayload(payload, normalizedPlanReviews, corrections) {
  if (typeof payload?.approved === "boolean") return payload.approved;

  const status = String(payload?.status || payload?.verdict || "").trim().toLowerCase();
  if (["approved", "approve", "pass", "passed", "accept", "accepted"].includes(status)) return true;
  if (["rejected", "reject", "fail", "failed", "blocked"].includes(status)) return false;

  if (corrections.length > 0) return false;

  const hasNegativeReview = normalizedPlanReviews.some((review) =>
    review.measurable === false
    || review.successCriteriaClear === false
    || review.verificationConcrete === false
    || review.scopeDefined === false
    || review.preMortemComplete === false
    || (Array.isArray(review.issues) && review.issues.length > 0)
  );
  if (hasNegativeReview) return false;

  const text = `${payload?.summary || ""} ${payload?.reason || ""} ${payload?.assessment || ""}`.toLowerCase();
  if (/\b(approve|approved|passes|pass|acceptable|looks good|ready)\b/.test(text)) return true;
  if (/\b(reject|rejected|fail|failed|block|blocked|insufficient|missing)\b/.test(text)) return false;

  return false;
}

function buildFallbackPlanReview(plan, index) {
  const files = Array.isArray(plan?.target_files)
    ? plan.target_files
    : Array.isArray(plan?.targetFiles)
      ? plan.targetFiles
      : [];
  const acceptanceCriteria = Array.isArray(plan?.acceptance_criteria) ? plan.acceptance_criteria : [];
  const premortemCheck = plan?.riskLevel === PREMORTEM_RISK_LEVEL.HIGH
    ? validatePremortem(plan?.premortem)
    : { status: PREMORTEM_STATUS.PASS, errors: [] };

  return {
    planIndex: index,
    role: String(plan?.role || "unknown"),
    measurable: String(plan?.task || "").trim().length >= 10,
    successCriteriaClear: acceptanceCriteria.length > 0,
    verificationConcrete: String(plan?.verification || "").trim().length >= 5,
    scopeDefined: files.length > 0 || String(plan?.scope || "").trim().length > 0,
    preMortemComplete: premortemCheck.status === PREMORTEM_STATUS.PASS,
    issues: [],
    suggestion: ""
  };
}

function normalizePlanReviewEntry(entry, plan, index) {
  const fallback = buildFallbackPlanReview(plan, index);
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    return fallback;
  }

  return {
    planIndex: Number.isInteger(entry.planIndex) ? entry.planIndex : fallback.planIndex,
    role: String(entry.role || fallback.role),
    measurable: typeof entry.measurable === "boolean" ? entry.measurable : fallback.measurable,
    successCriteriaClear: typeof entry.successCriteriaClear === "boolean" ? entry.successCriteriaClear : fallback.successCriteriaClear,
    verificationConcrete: typeof entry.verificationConcrete === "boolean" ? entry.verificationConcrete : fallback.verificationConcrete,
    scopeDefined: typeof entry.scopeDefined === "boolean" ? entry.scopeDefined : fallback.scopeDefined,
    preMortemComplete: typeof entry.preMortemComplete === "boolean" ? entry.preMortemComplete : fallback.preMortemComplete,
    issues: Array.isArray(entry.issues) ? entry.issues.map((item) => String(item || "").trim()).filter(Boolean) : [],
    suggestion: String(entry.suggestion || ""),
  };
}

/**
 * Mandatory fields that MUST be present (as explicit values, not synthesized) in every
 * actionable packet returned by the AI reviewer. If any of these are absent, `runAthenaPlanReview`
 * will issue an explicit rejection rather than proceeding with synthesized fallbacks.
 *
 * - `approved`    — must be an explicit boolean or an unambiguous status/verdict string
 * - `planReviews` — must be an explicit array (not built from plan data as a fallback)
 */
export const MANDATORY_ACTIONABLE_PACKET_FIELDS = Object.freeze(["approved", "planReviews"] as const);

// ── Patched-plan validation (Task 3) ─────────────────────────────────────────

/**
 * Patterns that indicate an unresolved placeholder value in target_files.
 * Any path matching one of these patterns blocks approval.
 */
const TARGET_FILE_PLACEHOLDER_PATTERNS: RegExp[] = [
  /^\.{2,}$/,         // "..." or "...."
  /^<[^>]+>$/,        // "<placeholder>", "<file>", "<path/to/file>"
  /^\[.*\]$/,         // "[...]", "[placeholder]"
  /^path\/to\//i,     // "path/to/..."  (generic non-real path)
];

/** Return true when the given string looks like an unresolved placeholder. */
function isTargetFilePlaceholder(filePath: string): boolean {
  const s = String(filePath || "").trim();
  if (!s) return true;
  return TARGET_FILE_PLACEHOLDER_PATTERNS.some(p => p.test(s));
}

/**
 * Validate a single patched plan for unresolved target-file placeholders and missing mandatory
 * packet fields. Called after Athena returns patchedPlans so approval can be blocked when the
 * AI failed to properly resolve all placeholder values.
 *
 * Mandatory fields checked: target_files (non-empty, no placeholders), scope, acceptance_criteria.
 *
 * @param plan - a single entry from patchedPlans
 * @returns {{ valid: boolean, issues: string[] }}
 */
export function validatePatchedPlan(plan: unknown): { valid: boolean; issues: string[] } {
  if (!plan || typeof plan !== "object") {
    return { valid: false, issues: ["patched plan is not an object"] };
  }
  const p = plan as Record<string, unknown>;
  const issues: string[] = [];

  // target_files: must be a non-empty array with no placeholder values
  const targetFiles: unknown[] | null = Array.isArray(p.target_files) ? p.target_files
    : Array.isArray(p.targetFiles) ? p.targetFiles : null;
  if (!targetFiles || targetFiles.length === 0) {
    issues.push("target_files is missing or empty");
  } else {
    const placeholders = targetFiles
      .map(f => String(f || "").trim())
      .filter(f => isTargetFilePlaceholder(f));
    if (placeholders.length > 0) {
      issues.push(`target_files contains unresolved placeholder(s): ${placeholders.slice(0, 3).join(", ")}`);
    }
  }

  // scope: must be a non-empty string
  if (!p.scope || String(p.scope).trim().length === 0) {
    issues.push("scope is missing or empty");
  }

  // acceptance_criteria: must be a non-empty array
  const ac = Array.isArray(p.acceptance_criteria) ? p.acceptance_criteria : null;
  if (!ac || ac.length === 0) {
    issues.push("acceptance_criteria is missing or empty");
  }

  return { valid: issues.length === 0, issues };
}

// ── Patched-plan normalization at handoff (Task 2) ───────────────────────────

/**
 * Idempotent normalization of patched plans at the Athena → dispatch handoff seam.
 *
 * Athena may return patchedPlans that passed validatePatchedPlan but still lack
 * dispatch-critical fields (dependencies array, canonical role, positive wave).
 * This function ensures those fields are present with safe defaults so the
 * orchestrator's dependency-graph resolver and contract validator never see gaps.
 *
 * Idempotent: applying twice produces an identical result.
 *
 * @param plans - validated patchedPlans array from Athena
 * @returns new array with each plan carrying all dispatch-required fields
 */
export function normalizePatchedPlansForDispatch(plans: unknown[]): Record<string, unknown>[] {
  if (!Array.isArray(plans)) return [];
  return plans.map((plan) => {
    if (!plan || typeof plan !== "object") return plan as Record<string, unknown>;
    const p = plan as Record<string, unknown>;
    return {
      ...p,
      // Normalise target_files alias so dispatch always finds the canonical field.
      target_files: Array.isArray(p.target_files) ? p.target_files
        : Array.isArray(p.targetFiles) ? p.targetFiles : [],
      // dependencies must be an array for the dependency-graph resolver.
      dependencies: Array.isArray(p.dependencies) ? p.dependencies : [],
      // role must be a non-empty string for worker dispatch routing.
      role: p.role && String(p.role).trim() ? String(p.role).trim() : "evolution-worker",
      // wave must be a positive integer; malformed values fall back to 1.
      wave: Number.isFinite(Number(p.wave)) && Number(p.wave) >= 1 ? Number(p.wave) : 1,
    };
  });
}

/**
 * Reason code returned by revalidatePatchedPlansAfterNormalization when all plans pass.
 * Callers must check `valid` before trusting plan content.
 */
export const PATCHED_PLAN_REVALIDATION_REASON = Object.freeze({
  OK: "OK",
  FAILED: "PATCHED_PLAN_CONTRACT_FAILED",
});

/**
 * Prepare patched plans for dispatch handoff in a single atomic operation.
 *
 * This function MUST be called on every patchedPlans array before it enters the dispatch
 * pipeline — regardless of whether the array is empty or non-empty. It combines
 * normalizePatchedPlansForDispatch (idempotent field defaults) with
 * revalidatePatchedPlansAfterNormalization (contract re-validation), returning a single
 * result that callers must check before trusting the normalized plans.
 *
 * Fails closed: any contract violation sets valid=false with an explicit code and list of
 * violations so callers can block dispatch rather than proceeding with invalid plans.
 *
 * Idempotent: calling twice on the same input produces an identical result.
 *
 * @param plans - patchedPlans array from Athena (may be empty — empty returns valid=true)
 * @returns {{ plans, valid, violations, code }}
 */
export function preparePatchedPlansForDispatch(plans: unknown[]): {
  plans: Record<string, unknown>[];
  valid: boolean;
  violations: string[];
  code: string;
} {
  const normalized = normalizePatchedPlansForDispatch(Array.isArray(plans) ? plans : []);
  const check = revalidatePatchedPlansAfterNormalization(normalized);
  return {
    plans: normalized,
    valid: check.valid,
    violations: check.violations,
    code: check.code,
  };
}

/**
 * Run deterministic contract re-validation on normalized patched plans.
 *
 * Called after normalizePatchedPlansForDispatch to ensure that the normalization
 * step did not silently produce plans that violate dispatch-critical constraints.
 * Fails closed: any violation returns valid=false with an explicit reason code and
 * a human-readable list of per-plan violations.
 *
 * Checks (deterministic, no AI):
 *   - task  : non-empty string, ≥ 5 chars
 *   - role  : non-empty string (normalization defaults to "evolution-worker")
 *   - wave  : finite integer ≥ 1
 *   - target_files : non-empty array after normalization
 *   - scope : non-empty string
 *   - acceptance_criteria : non-empty array
 *   - verification : absent or not a forbidden command
 *
 * @param plans - normalized output of normalizePatchedPlansForDispatch
 * @returns { valid, violations, code }
 */
export function revalidatePatchedPlansAfterNormalization(
  plans: Record<string, unknown>[]
): { valid: boolean; violations: string[]; code: string } {
  if (!Array.isArray(plans) || plans.length === 0) {
    return { valid: true, violations: [], code: PATCHED_PLAN_REVALIDATION_REASON.OK };
  }

  const allViolations: string[] = [];

  for (let i = 0; i < plans.length; i++) {
    const p = plans[i];
    if (!p || typeof p !== "object") {
      allViolations.push(`plan[${i}]: not an object`);
      continue;
    }

    const planViolations: string[] = [];

    // task: must be a non-empty string of at least 5 characters
    if (!p.task || String(p.task).trim().length < 5) {
      planViolations.push("task is missing or too short (< 5 chars)");
    }

    // role: must be non-empty after normalization
    if (!p.role || String(p.role).trim().length === 0) {
      planViolations.push("role is empty after normalization");
    }

    // wave: must be a finite integer >= 1 after normalization
    const wave = Number(p.wave);
    if (!Number.isFinite(wave) || wave < 1) {
      planViolations.push(`wave must be >= 1 after normalization, got: ${p.wave}`);
    }

    // target_files: must be a non-empty array after normalization
    const targetFiles = Array.isArray(p.target_files) ? p.target_files : [];
    if (targetFiles.length === 0) {
      planViolations.push("target_files is empty after normalization");
    }

    // scope: must be a non-empty string
    if (!p.scope || String(p.scope).trim().length === 0) {
      planViolations.push("scope is empty after normalization");
    }

    // acceptance_criteria: must be a non-empty array
    const ac = Array.isArray(p.acceptance_criteria) ? p.acceptance_criteria : [];
    if (ac.length === 0) {
      planViolations.push("acceptance_criteria is empty after normalization");
    }

    // verification: if present, must not be a forbidden command
    if (p.verification) {
      const forbidden = checkForbiddenCommands(String(p.verification));
      if (forbidden.forbidden) {
        for (const v of forbidden.violations) {
          planViolations.push(`verification contains forbidden command: ${v.reason}`);
        }
      }
    }

    if (planViolations.length > 0) {
      const label = String(p.task || `plan ${i}`).slice(0, 60);
      allViolations.push(`plan[${i}] "${label}": ${planViolations.join("; ")}`);
    }
  }

  const valid = allViolations.length === 0;
  return {
    valid,
    violations: allViolations,
    code: valid ? PATCHED_PLAN_REVALIDATION_REASON.OK : PATCHED_PLAN_REVALIDATION_REASON.FAILED,
  };
}


const EXPLICIT_APPROVAL_STATUS_VALUES = new Set([
  "approved", "approve", "pass", "passed", "accept", "accepted",
  "rejected", "reject", "fail", "failed", "blocked"
]);

export function normalizeAthenaReviewPayload(raw, plans = []) {
  const payload = pickReviewerPayload(raw);
  const synthesizedFields = [];
  // `missingFields` tracks fields that had NO basis in the payload (truly absent, not just aliased).
  // Used by runAthenaPlanReview to trigger explicit rejection rather than silent synthesis.
  const missingFields: string[] = [];

  let normalizedPlanReviews: any[];
  if (Array.isArray(payload.planReviews)) {
    normalizedPlanReviews = payload.planReviews.map((entry, index) => normalizePlanReviewEntry(entry, plans[index], index));
  } else if (Array.isArray(payload.plan_reviews)) {
    // `plan_reviews` is an accepted alias — data is present, just differently named
    normalizedPlanReviews = payload.plan_reviews.map((entry, index) => normalizePlanReviewEntry(entry, plans[index], index));
    synthesizedFields.push("planReviews");
  } else {
    // No plan review data at all — fallback built entirely from plan metadata
    normalizedPlanReviews = plans.map((plan, index) => buildFallbackPlanReview(plan, index));
    synthesizedFields.push("planReviews");
    missingFields.push("planReviews");
  }

  const corrections = collectReviewerCorrections(payload, normalizedPlanReviews);
  if (!Array.isArray(payload.corrections)) synthesizedFields.push("corrections");

  const approved = inferApprovalFromReviewerPayload(payload, normalizedPlanReviews, corrections);
  if (typeof payload.approved !== "boolean") {
    synthesizedFields.push("approved");
    // Only "missing" if there is no unambiguous status/verdict string either.
    // An explicit status such as "approved" or "rejected" is an acceptable alias.
    const statusStr = String(payload?.status || payload?.verdict || "").trim().toLowerCase();
    if (!EXPLICIT_APPROVAL_STATUS_VALUES.has(statusStr)) {
      missingFields.push("approved");
    }
  }

  // ── Extract patchedPlans if Athena provided in-place repairs ─────────────
  const patchedPlans = Array.isArray(payload.patchedPlans) ? payload.patchedPlans : null;
  const appliedFixes = Array.isArray(payload.appliedFixes)
    ? payload.appliedFixes.map((item) => String(item || "").trim()).filter(Boolean)
    : [];
  const unresolvedIssues = Array.isArray(payload.unresolvedIssues)
    ? payload.unresolvedIssues.map((item) => String(item || "").trim()).filter(Boolean)
    : [];

  return {
    payload: {
      approved,
      overallScore: Number.isFinite(Number(payload.overallScore)) ? Number(payload.overallScore) : 0,
      summary: String(payload.summary || payload.reason || payload.assessment || ""),
      planReviews: normalizedPlanReviews,
      corrections,
      missingMetrics: Array.isArray(payload.missingMetrics) ? payload.missingMetrics.map((item) => String(item || "").trim()).filter(Boolean) : [],
      lessonsFromPast: String(payload.lessonsFromPast || ""),
      patchedPlans,
      appliedFixes,
      unresolvedIssues,
    },
    synthesizedFields: [...new Set(synthesizedFields)],
    missingFields,
  };
}

function truncatePromptText(value, maxLength = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 3)}...`;
}

function summarizePremortemForPrompt(plan) {
  if (plan?.riskLevel !== PREMORTEM_RISK_LEVEL.HIGH) return "none";
  const validation = validatePremortem(plan?.premortem);
  const pm = plan?.premortem && typeof plan.premortem === "object" ? plan.premortem : {};
  return JSON.stringify({
    status: validation.status,
    scenario: truncatePromptText(pm.scenario || "", 80),
    failurePaths: Array.isArray(pm.failurePaths) ? pm.failurePaths.length : 0,
    mitigations: Array.isArray(pm.mitigations) ? pm.mitigations.length : 0,
    detectionSignals: Array.isArray(pm.detectionSignals) ? pm.detectionSignals.length : 0,
    guardrails: Array.isArray(pm.guardrails) ? pm.guardrails.length : 0,
  });
}

// ── Plan Quality Scoring (deterministic pre-gate) ────────────────────────────

/**
 * Score a single plan item's structural quality (0-100).
 * Used as a fast pre-gate before the AI plan review call.
 *
 * @param {object} plan
 * @returns {{ score: number, issues: string[] }}
 */
export function scorePlanQuality(plan) {
  let score = 100;
  const issues = [];

  if (!plan || typeof plan !== "object") return { score: 0, issues: ["plan is not an object"] };

  if (!plan.task || String(plan.task).trim().length < 10) {
    score -= 30; issues.push("task description too short or missing");
  }
  if (!plan.role || String(plan.role).trim().length < 2) {
    score -= 20; issues.push("role not specified");
  }
  if (!plan.verification || String(plan.verification).trim().length < 5) {
    score -= 20; issues.push("verification method missing or too vague");
  }
  if (plan.wave === undefined || plan.wave === null) {
    score -= 10; issues.push("wave not assigned");
  }
  const vague = /\b(improve|refactor|update|fix stuff|make better)\b/i;
  if (vague.test(String(plan.task || ""))) {
    score -= 15; issues.push("task uses vague language");
  }
  // capacityDelta and requestROI are mandatory ranking inputs.
  // Plans missing either cannot be ordered by cost-effectiveness.
  if (!("capacityDelta" in plan) || !Number.isFinite(Number(plan.capacityDelta))) {
    score -= 15; issues.push("capacityDelta missing or invalid — required for ranking");
  }
  if (!("requestROI" in plan) || !Number.isFinite(Number(plan.requestROI)) || Number(plan.requestROI) <= 0) {
    score -= 15; issues.push("requestROI missing or invalid — required for ranking");
  }

  return { score: Math.max(0, score), issues };
}

/**
 * Compute a composite ranking score for a single plan.
 *
 * Formula: requestROI × (1 + capacityDelta)
 *
 * Rationale:
 *   - requestROI captures cost-effectiveness (higher = more return per premium request)
 *   - capacityDelta captures net system capacity change ([-1, 1] → multiplier [0, 2])
 *   - Plans with negative capacityDelta (risky or regressive) are down-ranked
 *   - Plans missing either field score 0 (will be filtered before ranking)
 *
 * @param {object} plan
 * @returns {number} ranking score ≥ 0
 */
export function computePlanRankScore(plan: Record<string, any>): number {
  if (!plan || typeof plan !== "object") return 0;
  const roi = Number(plan.requestROI);
  const delta = Number(plan.capacityDelta);
  if (!Number.isFinite(roi) || roi <= 0) return 0;
  if (!Number.isFinite(delta)) return 0;
  return roi * (1 + delta);
}

/**
 * Rank plans by composite ROI score (requestROI × (1 + capacityDelta)), descending.
 *
 * Plans missing or having invalid capacityDelta/requestROI sort to the end.
 * The original array is NOT mutated — a new sorted array is returned.
 * Within equal scores, original order is preserved (stable sort).
 *
 * @param {object[]} plans
 * @returns {object[]} sorted copy of plans, highest score first
 */
export function rankPlansByROI(plans: any[]): any[] {
  if (!Array.isArray(plans)) return [];
  return [...plans].sort((a, b) => computePlanRankScore(b) - computePlanRankScore(a));
}

/** Minimum quality score for a plan to pass the deterministic pre-gate. */
export const PLAN_QUALITY_MIN_SCORE = 40;

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

  // ── Deterministic plan quality pre-gate ────────────────────────────────────
  const qualityFailures = [];
  for (let i = 0; i < plans.length; i++) {
    const { score, issues } = scorePlanQuality(plans[i]);
    if (score < PLAN_QUALITY_MIN_SCORE) {
      qualityFailures.push(`plan[${i}] "${plans[i]?.task || plans[i]?.role || "?"}": score=${score} — ${issues.join("; ")}`);
    }
  }
  if (qualityFailures.length > 0) {
    const message = `${qualityFailures.length} plan(s) below quality threshold (${PLAN_QUALITY_MIN_SCORE})`;
    await appendProgress(config, `[ATHENA] Plan quality pre-gate FAILED — ${message}`);
    chatLog(stateDir, athenaName, `Plan quality pre-gate failed: ${message}`);
    return {
      approved: false,
      reason: { code: "LOW_PLAN_QUALITY", message },
      corrections: qualityFailures
    };
  }

  // ── Deterministic pre-mortem gate (runs before AI, always enforced) ────────
  // High-risk plans (riskLevel="high") must include a valid pre-mortem section.
  // This gate is never bypassed by athenaFailOpen — it is a structural requirement.
  const preMortemViolations = checkPlanPremortemGate(plans);
  if (preMortemViolations.length > 0) {
    const message = `${preMortemViolations.length} high-risk plan(s) missing valid pre-mortem`;
    await appendProgress(config, `[ATHENA] Pre-mortem gate FAILED — ${message} — blocking dispatch`);
    chatLog(stateDir, athenaName, `Pre-mortem gate failed: ${message}`);
    await appendAlert(config, {
      severity: ALERT_SEVERITY.CRITICAL,
      source: "athena_reviewer",
      title: "High-risk plan missing pre-mortem — dispatch blocked",
      message: `code=MISSING_PREMORTEM violations=${JSON.stringify(preMortemViolations)}`
    });
    return {
      approved: false,
      reason: { code: "MISSING_PREMORTEM", message },
      corrections: preMortemViolations,
      preMortemViolations
    };
  }

  const plansSummary = plans.map((p, i) => {
    const preMortemTag = p.riskLevel === "high" ? " [HIGH-RISK:premortem=present]" : "";
    const targetFiles = Array.isArray(p.target_files)
      ? p.target_files
      : Array.isArray(p.targetFiles)
        ? p.targetFiles
        : [];
    const ac = Array.isArray(p.acceptance_criteria) ? p.acceptance_criteria : [];
    const deps = Array.isArray(p.dependencies) ? p.dependencies : [];
      const targetFilesPreview = JSON.stringify(targetFiles.slice(0, 5));
      const acceptancePreview = JSON.stringify(ac.slice(0, 3).map((item) => truncatePromptText(item, 100)));
    return `  ${i + 1}. role=${p.role} task="${p.task}" priority=${p.priority} wave=${p.wave} riskLevel=${p.riskLevel || "low"}${preMortemTag}
       scope="${truncatePromptText(p.scope || "", 100)}"
       target_files=${targetFilesPreview}${targetFiles.length > 5 ? ` (+${targetFiles.length - 5} more)` : ""}
     dependencies=${JSON.stringify(deps)}
       before_state="${truncatePromptText(p.before_state || p.beforeState || "", 120)}"
       after_state="${truncatePromptText(p.after_state || p.afterState || "", 120)}"
       acceptance_criteria=${acceptancePreview}${ac.length > 3 ? ` (+${ac.length - 3} more)` : ""}
       premortem=${summarizePremortemForPrompt(p)}
       verification="${truncatePromptText(p.verification || "NONE", 120)}"`;
  }).join("\n");

  const contextPrompt = `TARGET REPO: ${config.env?.targetRepo || "unknown"}

## YOUR MISSION — PLAN QUALITY REVIEW & IN-PLACE REPAIR

You are Athena — BOX Quality Gate & Plan Editor.
Prometheus has produced a plan. Your job is to validate it AND FIX any issues you find — all in this single response.

**CRITICAL WORKFLOW:**
1. Review each plan item against the quality criteria below.
2. If you find fixable issues (dependency conflicts, missing numeric thresholds, vague acceptance criteria, wave conflicts, missing fields), FIX THEM DIRECTLY and return the corrected plans in "patchedPlans".
3. Set "approved": true if you were able to fix all issues. Only set "approved": false if there are UNFIXABLE structural problems (e.g., the entire plan is fundamentally wrong, or the task is impossible).
4. List what you fixed in "appliedFixes" and anything you could NOT fix in "unresolvedIssues".

**Quality criteria for each plan item:**
1. Is the goal measurable? (not vague like "improve" or "refactor")
2. Is there a clear success criterion? (what does "done" look like?)
3. Is the verification method concrete? (a test, a command, a check — not "verify it works")
4. Are file paths and scope specified?
5. Are dependencies between plans correct? (two plans modifying the same file must NOT be in the same wave — add a dependency to serialize them)
6. Do acceptance_criteria contain measurable numeric thresholds where applicable?
7. For HIGH-RISK plans (riskLevel=high): does the pre-mortem cover failure paths, mitigations, and guardrails?

**COMMON FIXES you should apply directly:**
- Two plans touching the same file in the same wave → add dependency from the later plan to the earlier one, increment its wave number
- Vague acceptance criteria → rewrite with numeric threshold (e.g., "fallback rate < 5%")
- Missing verification → add a concrete test command
- Missing scope → fill from target_files

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
  "appliedFixes": ["list of fixes you applied to the plans"],
  "unresolvedIssues": ["list of issues you could NOT fix — only if approved=false"],
  "patchedPlans": [
    {
      "role": "worker name",
      "task": "exact task description (fixed if needed)",
      "priority": 1,
      "wave": 1,
      "dependencies": [],
      "target_files": ["file paths"],
      "scope": "scope description",
      "before_state": "current state",
      "after_state": "desired state",
      "acceptance_criteria": ["measurable criteria with numeric thresholds"],
      "verification": "concrete test command",
      "riskLevel": "low"
    }
  ],
  "planReviews": [
    {
      "planIndex": 0,
      "role": "worker name",
      "measurable": true/false,
      "successCriteriaClear": true/false,
      "verificationConcrete": true/false,
      "scopeDefined": true/false,
      "preMortemComplete": true/false,
      "issues": ["list of problems found (before fix)"],
      "suggestion": "what was fixed or why it could not be fixed"
    }
  ],
  "corrections": ["only if approved=false: list of mandatory corrections that need external intervention"],
  "missingMetrics": ["metrics that should be tracked but aren't"],
  "lessonsFromPast": "any relevant observations from past postmortems"
}
===END===

IMPORTANT: Always include "patchedPlans" with the FULL corrected plan array. Even if no changes were needed, return the original plans as-is in patchedPlans. This ensures the orchestrator always has a validated plan set.`;

  const aiResult = await callCopilotAgent(command, "athena", contextPrompt, config, athenaModel);

  if (!aiResult.ok || !aiResult.parsed) {
    // Rollback: if runtime.athenaFailOpen is explicitly enabled, restore legacy permissive behavior.
    if (config.runtime?.athenaFailOpen === true) {
      await appendProgress(config, `[ATHENA] Plan review AI call failed — ${(aiResult as any).error || "no JSON"} — auto-approving (fail-open mode active)`);
      chatLog(stateDir, athenaName, `AI failed: ${(aiResult as any).error || "no JSON"} — auto-approve (fail-open)`);
      return { approved: true, reason: { code: "AI_CALL_FAILED_FAILOPEN", message: (aiResult as any).error || "no JSON" }, corrections: [] };
    }

    // Fail-closed: AI failure must never silently approve the plan.
    const reason = { code: "AI_CALL_FAILED", message: (aiResult as any).error || "No JSON returned from AI" };
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

  // ── Trust boundary validation ────────────────────────────────────────────
  const tbMode = config?.runtime?.trustBoundaryMode === "warn" ? "warn" : "enforce";
  const normalizedReview = normalizeAthenaReviewPayload(aiResult.parsed, plans);
  if (normalizedReview.synthesizedFields.length > 0) {
    await appendProgress(config,
      `[ATHENA] Reviewer payload normalized before trust-boundary validation — synthesized=${normalizedReview.synthesizedFields.join(",")}`
    );
  }

  // ── Mandatory actionable-packet field guard ─────────────────────────────
  // Explicit rejection when the AI omits fields that must not be synthesized.
  // Aliases (e.g. plan_reviews, status) are accepted; pure fallback synthesis is not.
  const missingMandatory = normalizedReview.missingFields.filter(
    (f) => (MANDATORY_ACTIONABLE_PACKET_FIELDS as readonly string[]).includes(f)
  );
  if (missingMandatory.length > 0) {
    const reason = {
      code: "MISSING_ACTIONABLE_PACKET_FIELDS",
      message: `Reviewer response is missing mandatory fields (${missingMandatory.join(", ")}) — explicit values required, synthesis not permitted`
    };
    await appendProgress(config, `[ATHENA] Plan review REJECTED — ${reason.message}`);
    chatLog(stateDir, athenaName, `Plan review rejected: missing mandatory fields ${missingMandatory.join(", ")}`);
    await appendAlert(config, {
      severity: ALERT_SEVERITY.CRITICAL,
      source: "athena_reviewer",
      title: "Reviewer response missing mandatory actionable-packet fields — plan blocked",
      message: `code=${reason.code} fields=${missingMandatory.join(",")}`
    });
    return { approved: false, reason, corrections: [] };
  }

  const trustCheck = validateLeadershipContract(
    LEADERSHIP_CONTRACT_TYPE.REVIEWER, normalizedReview.payload, { mode: tbMode }
  );
  if (!trustCheck.ok && tbMode === "enforce") {
    const tbErrors = trustCheck.errors.map(e => `${e.payloadPath}: ${e.message}`).join(" | ");
    const reason = {
      code: "TRUST_BOUNDARY_VIOLATION",
      message: `Reviewer output failed contract validation — class=${TRUST_BOUNDARY_ERROR} reasonCode=${trustCheck.reasonCode}: ${tbErrors}`
    };
    await appendProgress(config, `[ATHENA][TRUST_BOUNDARY] Reviewer output blocked — ${reason.message}`);
    await appendAlert(config, {
      severity: ALERT_SEVERITY.CRITICAL,
      source: "athena_reviewer",
      title: "Reviewer output failed trust-boundary validation — plan blocked",
      message: `code=${reason.code} errors=${tbErrors}`
    });
    return { approved: false, reason, corrections: [] };
  }
  if (trustCheck.errors.length > 0 && tbMode === "warn") {
    const tbErrors = trustCheck.errors.map(e => `${e.payloadPath}: ${e.message}`).join(" | ");
    await appendProgress(config, `[ATHENA][TRUST_BOUNDARY][WARN] Contract violations (warn mode, not blocking): ${tbErrors}`);
  }

  const d = normalizedReview.payload;
  const approved = d.approved !== false;
  const corrections = Array.isArray(d.corrections) ? d.corrections : [];

  const result = {
    approved,
    overallScore: d.overallScore || 0,
    summary: d.summary || "",
    planReviews: Array.isArray(d.planReviews) ? d.planReviews : [],
    corrections,
    missingMetrics: Array.isArray(d.missingMetrics) ? d.missingMetrics : [],
    patchedPlans: Array.isArray(d.patchedPlans) ? d.patchedPlans : null,
    appliedFixes: Array.isArray(d.appliedFixes) ? d.appliedFixes : [],
    unresolvedIssues: Array.isArray(d.unresolvedIssues) ? d.unresolvedIssues : [],
    reviewedAt: new Date().toISOString(),
    model: athenaModel
  };

  // ── Patched-plan validation gate ─────────────────────────────────────────
  // Block approval when Athena's patchedPlans contain unresolved target-file placeholders
  // or are missing mandatory packet fields (target_files, scope, acceptance_criteria).
  // Individual-plan validation runs before normalization so raw AI output is checked first.
  if (Array.isArray(result.patchedPlans) && result.patchedPlans.length > 0) {
    const patchedPlanIssues: string[] = [];
    for (let pi = 0; pi < result.patchedPlans.length; pi++) {
      const vResult = validatePatchedPlan(result.patchedPlans[pi]);
      if (!vResult.valid) {
        patchedPlanIssues.push(`plan[${pi}]: ${vResult.issues.join("; ")}`);
      }
    }
    if (patchedPlanIssues.length > 0) {
      const blockReason = {
        code: "PATCHED_PLAN_VALIDATION_FAILED",
        message: `Patched plans contain unresolved placeholders or missing mandatory fields: ${patchedPlanIssues.join(" | ")}`
      };
      await appendProgress(config, `[ATHENA] Plan review BLOCKED — ${blockReason.message}`);
      chatLog(stateDir, athenaName, `Patched plan validation failed: ${patchedPlanIssues.join(" | ")}`);
      await appendAlert(config, {
        severity: ALERT_SEVERITY.CRITICAL,
        source: "athena_reviewer",
        title: "Patched plans contain unresolved placeholders or missing mandatory fields",
        message: `code=${blockReason.code} issues=${patchedPlanIssues.slice(0, 3).join(" | ")}`
      });
      return {
        ...result,
        approved: false,
        corrections: [...corrections, ...patchedPlanIssues],
        reason: blockReason,
      };
    }
  }

  // ── Patched-plan normalization + contract re-validation at handoff ────────
  // Required for EVERY patchedPlans array (including empty) before dispatch handoff.
  // preparePatchedPlansForDispatch atomically normalizes dispatch-critical fields and
  // re-validates the contract — fails closed on any violation so dispatch never receives
  // plans that bypass the normalization pipeline.
  if (Array.isArray(result.patchedPlans)) {
    const handoff = preparePatchedPlansForDispatch(result.patchedPlans);
    if (!handoff.valid) {
      const blockReason = {
        code: handoff.code,
        message: `Normalized patched plans failed contract re-validation: ${handoff.violations.join(" | ")}`
      };
      await appendProgress(config, `[ATHENA] Patched plan contract re-validation FAILED — ${blockReason.message}`);
      chatLog(stateDir, athenaName, `Contract re-validation failed: ${handoff.violations.join(" | ")}`);
      await appendAlert(config, {
        severity: ALERT_SEVERITY.CRITICAL,
        source: "athena_reviewer",
        title: "Patched plans failed contract re-validation after normalization",
        message: `code=${blockReason.code} violations=${handoff.violations.slice(0, 3).join(" | ")}`
      });
      return {
        ...result,
        approved: false,
        corrections: [...corrections, ...handoff.violations],
        reason: blockReason,
      };
    }
    result.patchedPlans = handoff.plans;
  }

  await writeJson(path.join(stateDir, "athena_plan_review.json"), result);

  if (approved) {
    const fixCount = result.appliedFixes.length;
    const fixMsg = fixCount > 0 ? ` (${fixCount} fix(es) applied in-place)` : "";
    await appendProgress(config, `[ATHENA] Plan APPROVED (score=${result.overallScore}/10)${fixMsg} — ${result.summary}`);
    chatLog(stateDir, athenaName, `Plan approved: score=${result.overallScore}/10${fixMsg}`);
  } else {
    await appendProgress(config, `[ATHENA] Plan REJECTED — corrections needed: ${corrections.join("; ")}`);
    chatLog(stateDir, athenaName, `Plan rejected: ${corrections.join("; ")}`);
  }

  return result;
}

// ── Deterministic postmortem fast-path ───────────────────────────────────────

/**
 * Check if the current worker result is materially identical to the last postmortem.
 * If so, the AI postmortem call can be skipped (review-on-delta mode).
 *
 * @param {object} workerResult
 * @param {object[]} pastPostmortems
 * @returns {boolean} true if result is a duplicate of the last postmortem
 */
function isDuplicateResult(workerResult, pastPostmortems) {
  if (!Array.isArray(pastPostmortems) || pastPostmortems.length === 0) return false;
  const last = pastPostmortems[pastPostmortems.length - 1];
  if (!last) return false;
  const workerName = workerResult?.roleName || workerResult?.role || "";
  if (last.workerName !== workerName) return false;
  const currentSummary = String(workerResult?.summary || "").slice(0, 200);
  const lastOutcome = String(last.actualOutcome || "").slice(0, 200);
  return currentSummary.length > 20 && currentSummary === lastOutcome;
}

/**
 * Classify a postmortem's defect channel: "product" vs "infra".
 * Infra defects are environment/tooling issues (glob, CI, Docker, etc.)
 * that do not reflect actual code quality problems.
 *
 * @param {object} opts
 * @param {string} [opts.deviation] — "none" | "minor" | "major"
 * @param {string} [opts.lessonLearned]
 * @param {string} [opts.actualOutcome]
 * @param {string} [opts.primaryClass] — failure_classifier class if available
 * @returns {{ channel: "product"|"infra", tag: string|null }}
 */
export function classifyDefectChannel(opts: any = {}) {
  const lesson = String(opts.lessonLearned || "").toLowerCase();
  const outcome = String(opts.actualOutcome || "").toLowerCase();
  const combined = `${lesson} ${outcome}`;

  const infraPatterns = [
    /glob/i, /false.?fail/i, /ci\b.*\bpipeline/i, /docker/i,
    /timeout/i, /enoent/i, /permission denied/i, /rate.?limit/i,
    /network/i, /dns/i, /certificate/i
  ];
  for (const p of infraPatterns) {
    if (p.test(combined)) {
      const tag = p.source.includes("glob") || p.source.includes("false") ? "infra_false_fail" : "infra_env";
      return { channel: "infra", tag };
    }
  }

  if (opts.primaryClass === "environment" || opts.primaryClass === "external_api") {
    return { channel: "infra", tag: "infra_env" };
  }

  return { channel: "product", tag: null };
}

/**
 * Build a deterministic postmortem record for clean worker passes.
 * Avoids an AI premium-request call when all verification evidence is green.
 *
 * @param {object} workerResult  — worker execution result
 * @param {object} originalPlan  — original plan dispatched to worker
 * @param {object} dql           — decision quality label from computeDecisionQualityLabel
 * @returns {object} postmortem record matching the AI postmortem schema
 */
function computeDeterministicPostmortem(workerResult, originalPlan, dql) {
  const workerName = workerResult?.roleName || workerResult?.role || "unknown";
  return {
    workerName,
    taskCompleted: true,
    expectedOutcome: originalPlan?.task || "task completion",
    actualOutcome: `Worker completed successfully. BUILD=pass; TESTS=pass.`,
    deviation: "none",
    successCriteriaMet: true,
    lessonLearned: "Clean pass — no issues detected by verification gate.",
    qualityScore: 8,
    followUpNeeded: false,
    followUpTask: "",
    recommendation: "proceed",
    defectChannel: "product",
    defectChannelTag: null,
    decisionQualityLabel: dql.label,
    decisionQualityLabelReason: dql.reason,
    decisionQualityStatus: dql.status,
    reviewedAt: new Date().toISOString(),
    model: "deterministic"
  };
}

// ── Postmortem (post-work review) ────────────────────────────────────────────

export async function runAthenaPostmortem(
  config,
  workerResult: EvidenceEnvelope & {
    /** Legacy alias for roleName — kept for backward compatibility. */
    role?: string;
    /** Legacy alias for prUrl — kept for backward compatibility. */
    pr?: string;
    /** Explicit outcome value: "merged" | "reopen" | "rollback" | "timeout". */
    outcome?: string;
    /** Legacy raw output string — summary is preferred. */
    raw?: string;
    /** Legacy alias for filesTouched — kept for backward compatibility. */
    filesChanged?: string[] | string;
  },
  originalPlan
) {
  const stateDir = config.paths?.stateDir || "state";
  const registry = getRoleRegistry(config);
  const athenaName = registry?.qualityReviewer?.name || "Athena";
  const athenaModel = registry?.qualityReviewer?.model || "Claude Sonnet 4.6";
  const command = config.env?.copilotCliCommand || "copilot";

  // ── Evidence envelope structural validation (admission control) ─────────────
  // Validates the envelope before any field access so that Athena's fast-path
  // gate and AI prompt never receive structurally invalid input.
  // Fail-closed: throw so the caller (evolution_executor) escalates the task.
  const envelopeValidation = validateEvidenceEnvelope(workerResult);
  if (!envelopeValidation.valid) {
    const errMsg = `[ATHENA] Evidence envelope invalid — ${envelopeValidation.errors.join("; ")}`;
    await appendProgress(config, errMsg);
    throw new Error(errMsg);
  }

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

  // ── Deterministic fast-path: skip AI call for clean passes ──────────────
  const forceAi = config?.athena?.forceAiPostmortem === true;
  const isCleanPass = workerStatus === "done"
    && verificationPassed === true
    && workerResult?.verificationEvidence?.build === "pass"
    && workerResult?.verificationEvidence?.tests === "pass";

  if (isCleanPass && !forceAi) {
    const postmortem = computeDeterministicPostmortem(workerResult, originalPlan, dql);
    await appendProgress(config,
      `[ATHENA] Deterministic postmortem (fast-path): ${workerName} — score=${postmortem.qualityScore}/10 deviation=none recommendation=proceed model=deterministic`
    );
    chatLog(stateDir, athenaName, `Deterministic postmortem: ${workerName} — clean pass, AI call skipped`);

    // Persist to history
    const postmortemsFilePath = path.join(stateDir, "athena_postmortems.json");
    const rawPostmortems = await readJson(postmortemsFilePath, null);
    let history = [];
    if (rawPostmortems !== null) {
      const migrated = migrateData(rawPostmortems, STATE_FILE_TYPE.ATHENA_POSTMORTEMS);
      history = migrated.ok ? extractPostmortemEntries(migrated.data) : [];
    }
    history.push(postmortem);
    if (history.length > 50) history.splice(0, history.length - 50);
    await writeJson(postmortemsFilePath, addSchemaVersion(history, STATE_FILE_TYPE.ATHENA_POSTMORTEMS));
    await writeJson(path.join(stateDir, "athena_latest_postmortem.json"), postmortem);

    return postmortem;
  }

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

  // Rank past lessons by time-decayed relevance (lesson_halflife integration)
  const rankedLessons = rankLessonsByRelevance(pastPostmortems, { limit: 5 });
  const recentLessons = rankedLessons.length > 0
    ? rankedLessons.map(l => `${l.lesson} (relevance=${l.weight.toFixed(2)})`).join("\n  - ")
    : pastPostmortems.slice(-5).map(p => p.lessonLearned || "").filter(Boolean).join("\n  - ");

  // Detect recurring defect patterns and include them in postmortem context
  const recurrenceMatches = detectRecurrences(pastPostmortems);
  const recurrenceContext = recurrenceMatches.length > 0
    ? `\n\nRECURRING PATTERNS (${recurrenceMatches.length}):\n${recurrenceMatches.map(r => `- ${r.pattern} (count=${r.count}, severity=${r.severity})`).join("\n")}`
    : "";

  // ── Review-on-delta: skip AI call if result is identical to last postmortem ──
  if (isDuplicateResult(workerResult, pastPostmortems)) {
    const lastPm = pastPostmortems[pastPostmortems.length - 1];
    const dupPm = {
      ...lastPm,
      reviewedAt: new Date().toISOString(),
      model: "duplicate-skip",
      decisionQualityLabel: dql.label,
      decisionQualityLabelReason: dql.reason,
      decisionQualityStatus: dql.status,
    };
    await appendProgress(config, `[ATHENA] Duplicate result detected for ${workerName} — reusing last postmortem (review-on-delta)`);
    chatLog(stateDir, athenaName, `Duplicate result: ${workerName} — AI call skipped`);
    pastPostmortems.push(dupPm);
    if (pastPostmortems.length > 50) pastPostmortems.splice(0, pastPostmortems.length - 50);
    await writeJson(postmortemsFilePath, addSchemaVersion(pastPostmortems, STATE_FILE_TYPE.ATHENA_POSTMORTEMS));
    await writeJson(path.join(stateDir, "athena_latest_postmortem.json"), dupPm);
    return dupPm;
  }

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

## RECENT LESSONS LEARNED (ranked by relevance)
${recentLessons ? `  - ${recentLessons}` : "  (no previous lessons)"}
${recurrenceContext}

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
    await appendProgress(config, `[ATHENA] Postmortem AI call failed — ${(aiResult as any).error || "no JSON"}`);
    chatLog(stateDir, athenaName, `Postmortem AI failed: ${(aiResult as any).error || "no JSON"}`);
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

  // Classify defect channel
  const dc = classifyDefectChannel({
    deviation: postmortem.deviation,
    lessonLearned: postmortem.lessonLearned,
    actualOutcome: postmortem.actualOutcome
  });
  (postmortem as any).defectChannel = dc.channel;
  (postmortem as any).defectChannelTag = dc.tag;

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
