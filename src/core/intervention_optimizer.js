/**
 * intervention_optimizer.js — Budget-aware intervention optimizer for BOX.
 *
 * An "Intervention" is the domain concept for a planned unit of work dispatched
 * to a specific worker role in a specific execution wave.
 *
 * ── Domain definitions (deterministic, machine-checkable) ────────────────────
 *
 * INTERVENTION object shape (all fields required unless noted):
 *   id                  {string}  — unique identifier for this intervention
 *   type                {string}  — enum: "task" | "split" | "followup"
 *   wave                {integer} — execution wave number (>= 1)
 *   role                {string}  — worker role name (non-empty)
 *   title               {string}  — short description (non-empty)
 *   successProbability  {number}  — P(success) ∈ [0.0, 1.0]
 *   impact              {number}  — gain if success ∈ [0.0, 1.0]
 *   riskCost            {number}  — cost if failure ∈ [0.0, 1.0]
 *   sampleCount         {integer} — historical observations (>= 0)
 *   budgetCost          {integer} — worker spawns consumed (>= 1)
 *
 * BUDGET object shape:
 *   maxWorkerSpawns     {integer} — total spawn budget (>= 1; unit: workerSpawns)
 *   maxWorkersPerWave   {integer} — per-wave spawn cap (optional; defaults to maxWorkerSpawns)
 *   byRole              {object}  — per-role spawn caps: { [roleName]: integer } (optional)
 *
 * ── Expected-value formula (deterministic) ───────────────────────────────────
 *
 *   SPARSE_DATA_THRESHOLD = 3   — minimum sample count for full confidence
 *
 *   confidenceMultiplier(n) = min(1.0, n / SPARSE_DATA_THRESHOLD)
 *     n = 0  → 0.000  (no data — maximum confidence penalty)
 *     n = 1  → 0.333
 *     n = 2  → 0.667
 *     n >= 3 → 1.000  (full confidence)
 *
 *   adjustedSuccessProbability = successProbability × confidenceMultiplier(sampleCount)
 *
 *   EV = adjustedSuccessProbability × impact
 *      − (1 − adjustedSuccessProbability) × riskCost
 *
 * ── Budget reconciliation (all three constraints must be satisfied) ───────────
 *
 *   1. totalBudget  — Σ budgetCost of selected interventions ≤ maxWorkerSpawns
 *   2. byWaveBudget — per-wave Σ budgetCost ≤ maxWorkersPerWave
 *   3. byRoleBudget — per-role Σ budgetCost ≤ byRole[role] (when configured)
 *
 *   Selection algorithm: greedy by descending EV.
 *   An intervention is blocked if accepting it would violate any active constraint.
 *   Blocked interventions appear in `rejected[]` with an explicit `reasonCode`.
 *
 * ── Budget unit ───────────────────────────────────────────────────────────────
 *   Unit: "workerSpawns" — integer count of worker process spawns.
 *   Source: box.config.json → runtime.runtimeBudget.maxWorkerSpawnsPerCycle
 *
 * ── Persistence ───────────────────────────────────────────────────────────────
 *   Log file: state/intervention_optimizer_log.json
 *   Schema version: OPTIMIZER_LOG_SCHEMA_VERSION (integer, currently 1)
 *   Required fields in each entry: schemaVersion, generatedAt, status, reasonCode,
 *     budgetUnit, totalBudgetLimit, totalBudgetUsed, byWaveBudgetLimit,
 *     byWaveUsed, byRoleBudgetLimits, byRoleUsed, selected, rejected
 *
 * Risk level: HIGH — modification of prometheus.js, state_tracker.js, and this
 *   new module requires careful isolation. All optimizer calls are non-blocking
 *   and never fail the parent orchestration flow.
 */

import path from "node:path";
import { readJson, writeJson } from "./fs_utils.js";
import { applyClassificationToSuccessProbability } from "./failure_classifier.js";

// ── Budget unit ───────────────────────────────────────────────────────────────

/**
 * Canonical budget unit identifier. Written into every persisted record so that
 * log consumers know what integer counts represent.
 */
export const BUDGET_UNIT = "workerSpawns";

// ── Intervention type enum ────────────────────────────────────────────────────

/**
 * Canonical Intervention type values.
 *   task      — a primary planned task assigned to one worker
 *   split     — a sub-task split from a larger task
 *   followup  — a follow-up task generated after a prior worker's output
 */
export const INTERVENTION_TYPE = Object.freeze({
  TASK:      "task",
  SPLIT:     "split",
  FOLLOWUP:  "followup",
});

// ── Optimizer status enum ─────────────────────────────────────────────────────

/**
 * Top-level status codes returned by runInterventionOptimizer.
 * Written to the `status` field in every persisted log entry.
 */
export const OPTIMIZER_STATUS = Object.freeze({
  /** All interventions scheduled without budget violations. */
  OK:              "ok",
  /**
   * One or more interventions were rejected for budget reasons.
   * The schedule was created for the remaining interventions.
   */
  BUDGET_EXCEEDED: "budget_exceeded",
  /**
   * Input validation failed — no schedule was created.
   * Check `errorMessage` for the human-readable explanation and
   * `reasonCode` for the machine-readable reason.
   */
  INVALID_INPUT:   "invalid_input",
  /** Interventions array was valid but empty — no schedule created. */
  EMPTY_INPUT:     "empty_input",
});

// ── Optimizer reason code enum ────────────────────────────────────────────────

/**
 * Machine-readable reason codes for the top-level optimizer result.
 * Callers must inspect this field; silent fallback is not allowed.
 */
export const OPTIMIZER_REASON_CODE = Object.freeze({
  /** Schedule created, all interventions accepted. */
  VALID:                      "VALID",
  /** No interventions were provided. */
  EMPTY_INPUT:                "EMPTY_INPUT",
  /** Required input (interventions array or budget) was null/undefined. */
  MISSING_INPUT:              "MISSING_INPUT",
  /** An individual intervention failed schema validation. */
  INVALID_INTERVENTION:       "INVALID_INTERVENTION",
  /** Budget object failed validation. */
  INVALID_BUDGET:             "INVALID_BUDGET",
  /** At least one intervention was dropped — total spawn budget exceeded. */
  BUDGET_TOTAL_EXCEEDED:      "BUDGET_TOTAL_EXCEEDED",
  /** At least one intervention was dropped — wave spawn budget exceeded. */
  BUDGET_WAVE_EXCEEDED:       "BUDGET_WAVE_EXCEEDED",
  /** At least one intervention was dropped — role spawn budget exceeded. */
  BUDGET_ROLE_EXCEEDED:       "BUDGET_ROLE_EXCEEDED",
});

// ── Per-intervention rejection reason codes ───────────────────────────────────

/**
 * Machine-readable reason codes attached to each entry in the `rejected[]` array.
 */
export const INTERVENTION_REJECTION_CODE = Object.freeze({
  BUDGET_TOTAL: "BUDGET_TOTAL",
  BUDGET_WAVE:  "BUDGET_WAVE",
  BUDGET_ROLE:  "BUDGET_ROLE",
});

// ── Intervention validation error codes ──────────────────────────────────────

/**
 * Reason codes returned by validateIntervention.
 * Distinguishes missing input from invalid field values.
 */
export const INTERVENTION_ERROR_CODE = Object.freeze({
  /** Input is null/undefined (missing entirely). */
  MISSING_INPUT:  "MISSING_INPUT",
  /** Input is not a plain object (wrong type). */
  INVALID_TYPE:   "INVALID_TYPE",
  /** A required field is absent from the object. */
  MISSING_FIELD:  "MISSING_FIELD",
  /** A field is present but its value is invalid. */
  INVALID_FIELD:  "INVALID_FIELD",
});

// ── Sparse data constant ──────────────────────────────────────────────────────

/**
 * Minimum number of historical observations (sampleCount) required before the
 * optimizer applies full confidence to an intervention's successProbability.
 *
 * Below this threshold the confidence penalty formula applies:
 *   confidenceMultiplier = min(1.0, sampleCount / SPARSE_DATA_THRESHOLD)
 *
 * Formula is deterministic and testable:
 *   sampleCount = 0 → multiplier = 0.000
 *   sampleCount = 1 → multiplier = 0.333
 *   sampleCount = 2 → multiplier = 0.667
 *   sampleCount >= 3 → multiplier = 1.000
 */
export const SPARSE_DATA_THRESHOLD = 3;

// ── Schema version ────────────────────────────────────────────────────────────

/**
 * Schema version for intervention_optimizer_log.json.
 * Bump (integer) when the persisted schema changes incompatibly.
 */
export const OPTIMIZER_LOG_SCHEMA_VERSION = 1;

// ── Intervention schema ───────────────────────────────────────────────────────

/**
 * Canonical Intervention schema: required field names and type constraints.
 * Used by validateIntervention for deterministic, machine-checkable validation.
 */
export const INTERVENTION_SCHEMA = Object.freeze({
  required: Object.freeze([
    "id", "type", "wave", "role", "title",
    "successProbability", "impact", "riskCost",
    "sampleCount", "budgetCost",
  ]),
  typeEnum: Object.freeze(Object.values(INTERVENTION_TYPE)),
});

// ── Validation ────────────────────────────────────────────────────────────────

/**
 * Validate a single Intervention object against INTERVENTION_SCHEMA.
 *
 * Distinguishes missing input from invalid input:
 *   null/undefined input  → ok=false, code=MISSING_INPUT
 *   non-object input      → ok=false, code=INVALID_TYPE
 *   absent required field → ok=false, code=MISSING_FIELD, field=<name>
 *   invalid field value   → ok=false, code=INVALID_FIELD, field=<name>
 *   fully valid           → ok=true,  code=null
 *
 * @param {any} intervention
 * @returns {{ ok: boolean, code: string|null, field?: string, message: string }}
 */
export function validateIntervention(intervention) {
  if (intervention === null || intervention === undefined) {
    return {
      ok: false,
      code: INTERVENTION_ERROR_CODE.MISSING_INPUT,
      message: "intervention is required (got null/undefined)",
    };
  }
  if (typeof intervention !== "object" || Array.isArray(intervention)) {
    return {
      ok: false,
      code: INTERVENTION_ERROR_CODE.INVALID_TYPE,
      message: "intervention must be a plain object",
    };
  }

  // Required field presence check
  for (const field of INTERVENTION_SCHEMA.required) {
    if (!(field in intervention)) {
      return {
        ok: false,
        code: INTERVENTION_ERROR_CODE.MISSING_FIELD,
        field,
        message: `required field '${field}' is missing`,
      };
    }
  }

  // type: must be one of INTERVENTION_TYPE values
  if (!INTERVENTION_SCHEMA.typeEnum.includes(intervention.type)) {
    return {
      ok: false,
      code: INTERVENTION_ERROR_CODE.INVALID_FIELD,
      field: "type",
      message: `type must be one of: ${INTERVENTION_SCHEMA.typeEnum.join(", ")}; got '${intervention.type}'`,
    };
  }

  // wave: must be a positive integer
  if (!Number.isInteger(intervention.wave) || intervention.wave < 1) {
    return {
      ok: false,
      code: INTERVENTION_ERROR_CODE.INVALID_FIELD,
      field: "wave",
      message: `wave must be a positive integer; got ${intervention.wave}`,
    };
  }

  // id, role, title: must be non-empty strings
  for (const field of ["id", "role", "title"]) {
    if (typeof intervention[field] !== "string" || intervention[field].trim() === "") {
      return {
        ok: false,
        code: INTERVENTION_ERROR_CODE.INVALID_FIELD,
        field,
        message: `${field} must be a non-empty string`,
      };
    }
  }

  // successProbability, impact, riskCost: numbers in [0.0, 1.0]
  for (const field of ["successProbability", "impact", "riskCost"]) {
    const v = intervention[field];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 1) {
      return {
        ok: false,
        code: INTERVENTION_ERROR_CODE.INVALID_FIELD,
        field,
        message: `${field} must be a finite number between 0.0 and 1.0; got ${v}`,
      };
    }
  }

  // sampleCount: non-negative integer
  if (!Number.isInteger(intervention.sampleCount) || intervention.sampleCount < 0) {
    return {
      ok: false,
      code: INTERVENTION_ERROR_CODE.INVALID_FIELD,
      field: "sampleCount",
      message: `sampleCount must be a non-negative integer; got ${intervention.sampleCount}`,
    };
  }

  // budgetCost: positive integer (>= 1)
  if (!Number.isInteger(intervention.budgetCost) || intervention.budgetCost < 1) {
    return {
      ok: false,
      code: INTERVENTION_ERROR_CODE.INVALID_FIELD,
      field: "budgetCost",
      message: `budgetCost must be a positive integer (>= 1); got ${intervention.budgetCost}`,
    };
  }

  return { ok: true, code: null, message: "valid" };
}

/**
 * Validate a Budget object.
 *
 * Distinguishes missing input from invalid input:
 *   null/undefined         → ok=false, code=MISSING_INPUT
 *   invalid maxWorkerSpawns → ok=false, code=INVALID_FIELD
 *   fully valid            → ok=true,  code=null
 *
 * @param {any} budget
 * @returns {{ ok: boolean, code: string|null, field?: string, message: string }}
 */
export function validateBudget(budget) {
  if (budget === null || budget === undefined) {
    return {
      ok: false,
      code: INTERVENTION_ERROR_CODE.MISSING_INPUT,
      message: "budget is required (got null/undefined)",
    };
  }
  if (typeof budget !== "object" || Array.isArray(budget)) {
    return {
      ok: false,
      code: INTERVENTION_ERROR_CODE.INVALID_TYPE,
      message: "budget must be a plain object",
    };
  }

  // maxWorkerSpawns: required positive integer
  if (!("maxWorkerSpawns" in budget)) {
    return {
      ok: false,
      code: INTERVENTION_ERROR_CODE.MISSING_FIELD,
      field: "maxWorkerSpawns",
      message: "required field 'maxWorkerSpawns' is missing",
    };
  }
  if (!Number.isInteger(budget.maxWorkerSpawns) || budget.maxWorkerSpawns < 1) {
    return {
      ok: false,
      code: INTERVENTION_ERROR_CODE.INVALID_FIELD,
      field: "maxWorkerSpawns",
      message: `budget.maxWorkerSpawns must be a positive integer; got ${budget.maxWorkerSpawns}`,
    };
  }

  // maxWorkersPerWave: optional positive integer
  if (budget.maxWorkersPerWave !== undefined) {
    if (!Number.isInteger(budget.maxWorkersPerWave) || budget.maxWorkersPerWave < 1) {
      return {
        ok: false,
        code: INTERVENTION_ERROR_CODE.INVALID_FIELD,
        field: "maxWorkersPerWave",
        message: `budget.maxWorkersPerWave must be a positive integer when provided; got ${budget.maxWorkersPerWave}`,
      };
    }
  }

  // byRole: optional object with positive integer values
  if (budget.byRole !== undefined) {
    if (typeof budget.byRole !== "object" || Array.isArray(budget.byRole)) {
      return {
        ok: false,
        code: INTERVENTION_ERROR_CODE.INVALID_FIELD,
        field: "byRole",
        message: "budget.byRole must be a plain object when provided",
      };
    }
    for (const [role, cap] of Object.entries(budget.byRole)) {
      if (!Number.isInteger(cap) || cap < 1) {
        return {
          ok: false,
          code: INTERVENTION_ERROR_CODE.INVALID_FIELD,
          field: `byRole.${role}`,
          message: `budget.byRole.${role} must be a positive integer; got ${cap}`,
        };
      }
    }
  }

  return { ok: true, code: null, message: "valid" };
}

// ── Expected-value computation ────────────────────────────────────────────────

/**
 * Compute the confidence multiplier for a given sample count.
 *
 * Formula: min(1.0, sampleCount / SPARSE_DATA_THRESHOLD)
 *   n < SPARSE_DATA_THRESHOLD → fractional multiplier (confidence penalty)
 *   n >= SPARSE_DATA_THRESHOLD → 1.0 (full confidence)
 *
 * @param {number} sampleCount — non-negative integer
 * @returns {number} — multiplier in [0.0, 1.0]
 */
export function computeConfidenceMultiplier(sampleCount) {
  return Math.min(1.0, sampleCount / SPARSE_DATA_THRESHOLD);
}

/**
 * Apply the confidence penalty to a raw successProbability.
 *
 * adjustedSuccessProbability = successProbability × confidenceMultiplier(sampleCount)
 *
 * @param {number} successProbability — raw P(success) in [0.0, 1.0]
 * @param {number} sampleCount — historical observation count (>= 0)
 * @returns {number} — adjusted P(success) in [0.0, 1.0]
 */
export function applyConfidencePenalty(successProbability, sampleCount) {
  return successProbability * computeConfidenceMultiplier(sampleCount);
}

/**
 * Compute the Expected Value (EV) for an Intervention.
 *
 * Formula:
 *   adjustedP = successProbability × confidenceMultiplier(sampleCount)
 *   EV = adjustedP × impact − (1 − adjustedP) × riskCost
 *
 * The EV is not clamped — it may be negative when riskCost is high
 * and/or confidence is low.
 *
 * @param {object} intervention — validated Intervention object
 * @returns {{ adjustedSuccessProbability: number, ev: number }}
 */
export function computeExpectedValue(intervention) {
  const adjustedP = applyConfidencePenalty(
    intervention.successProbability,
    intervention.sampleCount,
  );
  const ev = adjustedP * intervention.impact - (1 - adjustedP) * intervention.riskCost;
  return { adjustedSuccessProbability: adjustedP, ev };
}

// ── Ranking ───────────────────────────────────────────────────────────────────

/**
 * Rank a list of interventions by descending Expected Value (EV).
 *
 * Applies confidence penalties and attaches `ev` and
 * `adjustedSuccessProbability` to each ranked entry.
 * Does not mutate the input array.
 *
 * @param {object[]} interventions — array of validated Intervention objects
 * @returns {object[]} — new array sorted by descending EV, each item decorated with ev
 */
export function rankInterventions(interventions) {
  return interventions
    .map((intervention) => {
      const { adjustedSuccessProbability, ev } = computeExpectedValue(intervention);
      return { ...intervention, adjustedSuccessProbability, ev };
    })
    .sort((a, b) => b.ev - a.ev);
}

// ── Budget reconciliation ─────────────────────────────────────────────────────

/**
 * Greedily select interventions by descending EV while respecting all three
 * budget constraints simultaneously.
 *
 * Reconciliation semantics (all three enforced concurrently):
 *   1. total    — running Σ budgetCost of accepted interventions ≤ maxWorkerSpawns
 *   2. by-wave  — per-wave Σ budgetCost ≤ maxWorkersPerWave (defaults to maxWorkerSpawns)
 *   3. by-role  — per-role Σ budgetCost ≤ byRole[role] (only when role is in byRole map)
 *
 * An intervention is accepted only if it satisfies ALL active constraints.
 * Rejected interventions are annotated with a machine-readable `reasonCode`.
 *
 * @param {object[]} ranked — EV-ranked interventions (output of rankInterventions)
 * @param {object} budget   — validated Budget object
 * @returns {object} — reconciliation result with selected/rejected arrays and usage tallies
 */
export function reconcileBudgets(ranked, budget) {
  const maxTotal    = budget.maxWorkerSpawns;
  const maxPerWave  = budget.maxWorkersPerWave ?? maxTotal;
  const byRoleLimits = budget.byRole ?? {};

  let totalUsed = 0;
  const byWaveUsed  = {};
  const byRoleUsed  = {};
  const selected    = [];
  const rejected    = [];

  for (const intervention of ranked) {
    const waveKey = String(intervention.wave);
    const role    = intervention.role;
    const cost    = intervention.budgetCost;

    // Constraint 1: total budget
    if (totalUsed + cost > maxTotal) {
      rejected.push({
        ...intervention,
        rejectionReason: `total budget exceeded (used=${totalUsed}, cost=${cost}, limit=${maxTotal})`,
        reasonCode: INTERVENTION_REJECTION_CODE.BUDGET_TOTAL,
      });
      continue;
    }

    // Constraint 2: per-wave budget
    const waveUsed = byWaveUsed[waveKey] ?? 0;
    if (waveUsed + cost > maxPerWave) {
      rejected.push({
        ...intervention,
        rejectionReason: `wave ${waveKey} budget exceeded (waveUsed=${waveUsed}, cost=${cost}, limit=${maxPerWave})`,
        reasonCode: INTERVENTION_REJECTION_CODE.BUDGET_WAVE,
      });
      continue;
    }

    // Constraint 3: per-role budget (only when configured)
    if (byRoleLimits[role] !== undefined) {
      const roleUsed = byRoleUsed[role] ?? 0;
      if (roleUsed + cost > byRoleLimits[role]) {
        rejected.push({
          ...intervention,
          rejectionReason: `role '${role}' budget exceeded (roleUsed=${roleUsed}, cost=${cost}, limit=${byRoleLimits[role]})`,
          reasonCode: INTERVENTION_REJECTION_CODE.BUDGET_ROLE,
        });
        continue;
      }
    }

    // Accept
    selected.push(intervention);
    totalUsed             += cost;
    byWaveUsed[waveKey]    = (byWaveUsed[waveKey] ?? 0) + cost;
    byRoleUsed[role]       = (byRoleUsed[role] ?? 0) + cost;
  }

  // Derive top-level status and reason code from the first rejection type found
  let status     = OPTIMIZER_STATUS.OK;
  let reasonCode = OPTIMIZER_REASON_CODE.VALID;

  if (rejected.length > 0) {
    status = OPTIMIZER_STATUS.BUDGET_EXCEEDED;
    const firstCode = rejected[0].reasonCode;
    if (firstCode === INTERVENTION_REJECTION_CODE.BUDGET_TOTAL) {
      reasonCode = OPTIMIZER_REASON_CODE.BUDGET_TOTAL_EXCEEDED;
    } else if (firstCode === INTERVENTION_REJECTION_CODE.BUDGET_WAVE) {
      reasonCode = OPTIMIZER_REASON_CODE.BUDGET_WAVE_EXCEEDED;
    } else {
      reasonCode = OPTIMIZER_REASON_CODE.BUDGET_ROLE_EXCEEDED;
    }
  }

  return {
    status,
    reasonCode,
    totalBudgetUsed:     totalUsed,
    totalBudgetLimit:    maxTotal,
    byWaveBudgetLimit:   maxPerWave,
    byWaveUsed,
    byRoleBudgetLimits:  { ...byRoleLimits },
    byRoleUsed,
    selected,
    rejected,
  };
}

// ── Main optimizer entry point ────────────────────────────────────────────────

/**
 * Run the budget-aware intervention optimizer.
 *
 * Steps:
 *   1. Validate budget (missing vs invalid — explicit reason codes)
 *   2. Validate interventions array (must be non-null array)
 *   3. Validate each individual intervention against INTERVENTION_SCHEMA
 *   4. Apply failure classifications to successProbability (AC #5 — intervention prioritisation)
 *   5. Rank interventions by descending Expected Value (with confidence penalties)
 *   6. Greedily reconcile budgets (total, by-wave, by-role simultaneously)
 *   7. Return structured result with full selection rationale
 *
 * AC #5 / Athena missing item #2 — failure classification integration:
 *   When options.failureClassifications is provided as an object keyed by role name,
 *   each intervention's successProbability is adjusted before ranking via
 *   applyClassificationToSuccessProbability().  This is the observable behavioral
 *   change that "feeds intervention prioritization": interventions for roles with
 *   prior failures receive lower EV scores and are ranked lower (or rejected first
 *   under budget pressure).
 *
 *   options.failureClassifications: { [role: string]: ClassificationResult }
 *
 * No silent fallbacks. All failure modes set an explicit `status` and `reasonCode`.
 *
 * @param {any[]} interventions — array of Intervention objects to evaluate
 * @param {object} budget       — Budget object (must include maxWorkerSpawns)
 * @param {object} [options]    — optional settings
 *   @param {object} [options.failureClassifications] — { [role]: ClassificationResult }
 * @returns {object}            — optimizer result conforming to OPTIMIZER_RESULT_SCHEMA
 */
export function runInterventionOptimizer(interventions, budget, options = {}) {
  const generatedAt = new Date().toISOString();

  // Validate budget first (fail fast on missing/invalid budget)
  const budgetValidation = validateBudget(budget);
  if (!budgetValidation.ok) {
    return {
      schemaVersion:       OPTIMIZER_LOG_SCHEMA_VERSION,
      generatedAt,
      status:              OPTIMIZER_STATUS.INVALID_INPUT,
      reasonCode:          OPTIMIZER_REASON_CODE.INVALID_BUDGET,
      errorMessage:        budgetValidation.message,
      invalidField:        budgetValidation.field ?? null,
      budgetUnit:          BUDGET_UNIT,
      totalBudgetLimit:    0,
      totalBudgetUsed:     0,
      byWaveBudgetLimit:   0,
      byWaveUsed:          {},
      byRoleBudgetLimits:  {},
      byRoleUsed:          {},
      selected:            [],
      rejected:            [],
    };
  }

  const maxTotal  = budget.maxWorkerSpawns;
  const maxWave   = budget.maxWorkersPerWave ?? maxTotal;
  const byRoleLimits = budget.byRole ?? {};

  // Validate interventions array (missing vs invalid distinction)
  if (interventions === null || interventions === undefined) {
    return {
      schemaVersion:       OPTIMIZER_LOG_SCHEMA_VERSION,
      generatedAt,
      status:              OPTIMIZER_STATUS.INVALID_INPUT,
      reasonCode:          OPTIMIZER_REASON_CODE.MISSING_INPUT,
      errorMessage:        "interventions is required (got null/undefined)",
      invalidField:        null,
      budgetUnit:          BUDGET_UNIT,
      totalBudgetLimit:    maxTotal,
      totalBudgetUsed:     0,
      byWaveBudgetLimit:   maxWave,
      byWaveUsed:          {},
      byRoleBudgetLimits:  { ...byRoleLimits },
      byRoleUsed:          {},
      selected:            [],
      rejected:            [],
    };
  }

  if (!Array.isArray(interventions)) {
    return {
      schemaVersion:       OPTIMIZER_LOG_SCHEMA_VERSION,
      generatedAt,
      status:              OPTIMIZER_STATUS.INVALID_INPUT,
      reasonCode:          OPTIMIZER_REASON_CODE.MISSING_INPUT,
      errorMessage:        "interventions must be an array",
      invalidField:        null,
      budgetUnit:          BUDGET_UNIT,
      totalBudgetLimit:    maxTotal,
      totalBudgetUsed:     0,
      byWaveBudgetLimit:   maxWave,
      byWaveUsed:          {},
      byRoleBudgetLimits:  { ...byRoleLimits },
      byRoleUsed:          {},
      selected:            [],
      rejected:            [],
    };
  }

  // Empty array is valid input (distinct from missing/invalid)
  if (interventions.length === 0) {
    return {
      schemaVersion:       OPTIMIZER_LOG_SCHEMA_VERSION,
      generatedAt,
      status:              OPTIMIZER_STATUS.EMPTY_INPUT,
      reasonCode:          OPTIMIZER_REASON_CODE.EMPTY_INPUT,
      errorMessage:        "no interventions provided",
      budgetUnit:          BUDGET_UNIT,
      totalBudgetLimit:    maxTotal,
      totalBudgetUsed:     0,
      byWaveBudgetLimit:   maxWave,
      byWaveUsed:          {},
      byRoleBudgetLimits:  { ...byRoleLimits },
      byRoleUsed:          {},
      selected:            [],
      rejected:            [],
    };
  }

  // Validate each intervention — fail fast on first invalid (gives index + field)
  for (let i = 0; i < interventions.length; i++) {
    const vr = validateIntervention(interventions[i]);
    if (!vr.ok) {
      return {
        schemaVersion:       OPTIMIZER_LOG_SCHEMA_VERSION,
        generatedAt,
        status:              OPTIMIZER_STATUS.INVALID_INPUT,
        reasonCode:          OPTIMIZER_REASON_CODE.INVALID_INTERVENTION,
        errorMessage:        `interventions[${i}]: ${vr.message}`,
        invalidField:        vr.field ?? null,
        budgetUnit:          BUDGET_UNIT,
        totalBudgetLimit:    maxTotal,
        totalBudgetUsed:     0,
        byWaveBudgetLimit:   maxWave,
        byWaveUsed:          {},
        byRoleBudgetLimits:  { ...byRoleLimits },
        byRoleUsed:          {},
        selected:            [],
        rejected:            [],
      };
    }
  }

  // Apply failure classifications to successProbability before ranking (AC #5)
  // failureClassifications: { [role: string]: ClassificationResult }
  // Observable change: adjusted interventions are ranked lower under budget pressure.
  const failureClassifications = options?.failureClassifications;
  let failureClassificationsApplied = 0;
  let adjustedInterventions = interventions;

  if (failureClassifications && typeof failureClassifications === "object" && !Array.isArray(failureClassifications)) {
    adjustedInterventions = interventions.map((intervention) => {
      const classification = failureClassifications[intervention.role];
      if (!classification) return intervention;
      const adjustedSP = applyClassificationToSuccessProbability(intervention.successProbability, classification);
      if (adjustedSP === intervention.successProbability) return intervention;
      failureClassificationsApplied += 1;
      return { ...intervention, successProbability: adjustedSP };
    });
  }

  // Rank by descending EV (with confidence penalties applied)
  const ranked = rankInterventions(adjustedInterventions);

  // Reconcile all three budget constraints simultaneously
  const reconciled = reconcileBudgets(ranked, budget);

  return {
    schemaVersion:  OPTIMIZER_LOG_SCHEMA_VERSION,
    generatedAt,
    budgetUnit:     BUDGET_UNIT,
    failureClassificationsApplied,
    ...reconciled,
  };
}

// ── Prometheus plan → Intervention adapter ────────────────────────────────────

/**
 * Convert a Prometheus plan array into Intervention objects.
 *
 * Prometheus plans carry strategic metadata but not historical performance data.
 * This adapter applies configurable defaults for the probability/impact/cost fields.
 * sampleCount defaults to SPARSE_DATA_THRESHOLD (full confidence baseline) so that
 * newly planned interventions are ranked by their relative impact/priority rather
 * than being penalized for zero historical data. Override via config if needed.
 *
 * Wave parsing: Prometheus uses string wave ids ("wave-1", "wave-2", etc.).
 * The numeric wave is extracted from the trailing integer; defaults to 1 if unparseable.
 *
 * @param {object[]} plans   — Prometheus plans array (from prometheus_analysis.json)
 * @param {object}   config  — box.config.json config object
 * @returns {object[]}       — array of Intervention objects ready for the optimizer
 */
export function buildInterventionsFromPlan(plans, config) {
  if (!Array.isArray(plans) || plans.length === 0) return [];

  const opts = config?.interventionOptimizer ?? {};
  const defaultSuccessP   = Number(opts.defaultSuccessProbability ?? 0.8);
  const _defaultImpact    = Number(opts.defaultImpact ?? 0.7); // impact is derived from plan priority instead
  const defaultRiskCost   = Number(opts.defaultRiskCost ?? 0.3);
  const defaultSampleCount = Number.isInteger(opts.defaultSampleCount)
    ? opts.defaultSampleCount
    : SPARSE_DATA_THRESHOLD;

  return plans.map((plan, index) => {
    // Parse wave number from "wave-1", "wave-2", etc.
    const waveStr  = String(plan?.wave ?? "wave-1");
    const waveMatch = waveStr.match(/(\d+)/);
    const wave     = waveMatch ? Math.max(1, parseInt(waveMatch[1], 10)) : 1;

    // Derive impact from priority (1–10 → 0.1–1.0)
    const rawPriority = Number(plan?.priority ?? 5);
    const impact = Math.min(1.0, Math.max(0.1, rawPriority / 10));

    return {
      id:                  String(plan?.id ?? `plan-${index + 1}`),
      type:                INTERVENTION_TYPE.TASK,
      wave,
      role:                String(plan?.role ?? "unknown").trim() || "unknown",
      title:               String(plan?.task ?? plan?.title ?? `task-${index + 1}`).trim() || `task-${index + 1}`,
      successProbability:  defaultSuccessP,
      impact,
      riskCost:            defaultRiskCost,
      sampleCount:         defaultSampleCount,
      budgetCost:          1,
    };
  });
}

/**
 * Build a Budget object from a Prometheus requestBudget and box.config.json.
 *
 * Budget unit: workerSpawns (integer).
 * Sources (in priority order):
 *   1. requestBudget.hardCapTotal (from Prometheus AI output)
 *   2. config.runtime.runtimeBudget.maxWorkerSpawnsPerCycle
 *   3. config.runtime.runtimeBudget.maxTasksPerCycle (fallback)
 *   4. Hardcoded default: 12
 *
 * @param {object} requestBudget — Prometheus requestBudget object
 * @param {object} config        — box.config.json config object
 * @returns {object}             — Budget object for runInterventionOptimizer
 */
export function buildBudgetFromConfig(requestBudget, config) {
  const runtimeBudget = config?.runtime?.runtimeBudget ?? {};
  const plannerMaxWorkersPerWave = Math.max(
    1,
    Number(config?.planner?.defaultMaxWorkersPerWave ?? config?.maxParallelWorkers ?? 10),
  );

  // Derive total budget from requestBudget or runtime config
  const hardCap = Number(requestBudget?.hardCapTotal);
  const configSpawns = Number(runtimeBudget.maxWorkerSpawnsPerCycle);
  const configTasks  = Number(runtimeBudget.maxTasksPerCycle);
  const maxWorkerSpawns = (Number.isFinite(hardCap) && hardCap > 0)
    ? hardCap
    : (Number.isFinite(configSpawns) && configSpawns > 0)
      ? configSpawns
      : (Number.isFinite(configTasks) && configTasks > 0)
        ? configTasks
        : 12;

  // Per-wave budget from requestBudget.byWave or planner config
  let maxWorkersPerWave = plannerMaxWorkersPerWave;
  if (Array.isArray(requestBudget?.byWave) && requestBudget.byWave.length > 0) {
    const maxWaveEntry = requestBudget.byWave.reduce(
      (acc, w) => Math.max(acc, Number(w?.count ?? w?.budget ?? 0)),
      0,
    );
    if (maxWaveEntry > 0) maxWorkersPerWave = maxWaveEntry;
  }

  // Per-role budget from requestBudget.byRole or optimizer config
  const byRole = {};
  if (Array.isArray(requestBudget?.byRole)) {
    for (const entry of requestBudget.byRole) {
      const roleName = String(entry?.role ?? "");
      const cap = Number(entry?.count ?? entry?.budget ?? 0);
      if (roleName && Number.isFinite(cap) && cap > 0) {
        byRole[roleName] = cap;
      }
    }
  }

  return {
    maxWorkerSpawns: Math.max(1, Math.floor(maxWorkerSpawns)),
    maxWorkersPerWave: Math.max(1, Math.floor(maxWorkersPerWave)),
    ...(Object.keys(byRole).length > 0 ? { byRole } : {}),
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * Append an optimizer result entry to state/intervention_optimizer_log.json.
 *
 * Called by prometheus.js integration after each optimizer run.
 * Never throws — all errors are returned in a result object so the caller can
 * log them without crashing the orchestration flow.
 *
 * Log file schema:
 *   { schemaVersion, updatedAt, entries: [...result objects] }
 *   Each entry conforms to OPTIMIZER_RESULT_SCHEMA (all required fields present).
 *   Maximum retained entries: 100 (LIFO trim).
 *
 * @param {string} stateDir — absolute path to state directory
 * @param {object} result   — optimizer result from runInterventionOptimizer
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function persistOptimizerLog(stateDir, result) {
  try {
    const logFile = path.join(stateDir, "intervention_optimizer_log.json");
    const existing = await readJson(logFile, {
      schemaVersion: OPTIMIZER_LOG_SCHEMA_VERSION,
      updatedAt:     new Date().toISOString(),
      entries:       [],
    });

    const entries = Array.isArray(existing.entries) ? existing.entries : [];
    entries.push({ ...result, savedAt: new Date().toISOString() });

    const trimmed = entries.length > 100 ? entries.slice(-100) : entries;

    await writeJson(logFile, {
      schemaVersion: OPTIMIZER_LOG_SCHEMA_VERSION,
      updatedAt:     new Date().toISOString(),
      entries:       trimmed,
    });

    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}
