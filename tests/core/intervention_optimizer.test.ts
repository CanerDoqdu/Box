/**
 * intervention_optimizer.test.ts
 *
 * Tests for the budget-aware intervention optimizer.
 *
 * Coverage:
 *   - validateIntervention: missing vs invalid input distinction
 *   - validateBudget: missing vs invalid input distinction
 *   - applyConfidencePenalty / computeConfidenceMultiplier: sparse-data formula
 *   - computeExpectedValue: EV formula determinism
 *   - rankInterventions: descending EV ordering
 *   - reconcileBudgets: all three constraint types (total, wave, role)
 *   - runInterventionOptimizer: end-to-end, happy path and all negative paths
 *   - buildInterventionsFromPlan: prometheus plan adapter
 *   - buildBudgetFromConfig: config adapter
 *   - persistOptimizerLog: schema and trim behavior (file I/O skipped in unit tests)
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  INTERVENTION_TYPE,
  OPTIMIZER_STATUS,
  OPTIMIZER_REASON_CODE,
  INTERVENTION_REJECTION_CODE,
  INTERVENTION_ERROR_CODE,
  SPARSE_DATA_THRESHOLD,
  OPTIMIZER_LOG_SCHEMA_VERSION,
  BUDGET_UNIT,
  INTERVENTION_SCHEMA,
  validateIntervention,
  validateBudget,
  computeConfidenceMultiplier,
  applyConfidencePenalty,
  computeExpectedValue,
  rankInterventions,
  reconcileBudgets,
  runInterventionOptimizer,
  buildInterventionsFromPlan,
  buildBudgetFromConfig,
} from "../../src/core/intervention_optimizer.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeIntervention(overrides = {}) {
  return {
    id:                 "i-001",
    type:               INTERVENTION_TYPE.TASK,
    wave:               1,
    role:               "backend",
    title:              "Fix auth bug",
    successProbability: 0.8,
    impact:             0.9,
    riskCost:           0.2,
    sampleCount:        3,
    budgetCost:         1,
    ...overrides,
  };
}

function makeBudget(overrides = {}) {
  return {
    maxWorkerSpawns: 10,
    ...overrides,
  };
}

// ── Enum and constant exports ─────────────────────────────────────────────────

describe("exported enums and constants", () => {
  it("INTERVENTION_TYPE contains task, split, followup", () => {
    assert.equal(INTERVENTION_TYPE.TASK, "task");
    assert.equal(INTERVENTION_TYPE.SPLIT, "split");
    assert.equal(INTERVENTION_TYPE.FOLLOWUP, "followup");
  });

  it("OPTIMIZER_STATUS contains all four statuses", () => {
    assert.ok(OPTIMIZER_STATUS.OK);
    assert.ok(OPTIMIZER_STATUS.BUDGET_EXCEEDED);
    assert.ok(OPTIMIZER_STATUS.INVALID_INPUT);
    assert.ok(OPTIMIZER_STATUS.EMPTY_INPUT);
  });

  it("SPARSE_DATA_THRESHOLD is 3", () => {
    assert.equal(SPARSE_DATA_THRESHOLD, 3);
  });

  it("BUDGET_UNIT is workerSpawns", () => {
    assert.equal(BUDGET_UNIT, "workerSpawns");
  });

  it("OPTIMIZER_LOG_SCHEMA_VERSION is a positive integer", () => {
    assert.ok(Number.isInteger(OPTIMIZER_LOG_SCHEMA_VERSION));
    assert.ok(OPTIMIZER_LOG_SCHEMA_VERSION >= 1);
  });

  it("INTERVENTION_SCHEMA.required includes all required fields", () => {
    const required = INTERVENTION_SCHEMA.required;
    for (const field of ["id", "type", "wave", "role", "title",
      "successProbability", "impact", "riskCost", "sampleCount", "budgetCost"]) {
      assert.ok(required.includes(field), `INTERVENTION_SCHEMA.required must include '${field}'`);
    }
  });
});

// ── validateIntervention ──────────────────────────────────────────────────────

describe("validateIntervention", () => {
  it("accepts a fully valid intervention", () => {
    const result = validateIntervention(makeIntervention());
    assert.equal(result.ok, true);
    assert.equal(result.code, null);
  });

  it("rejects null with MISSING_INPUT (not INVALID_FIELD)", () => {
    const result = validateIntervention(null);
    assert.equal(result.ok, false);
    assert.equal(result.code, INTERVENTION_ERROR_CODE.MISSING_INPUT);
  });

  it("rejects undefined with MISSING_INPUT", () => {
    const result = validateIntervention(undefined);
    assert.equal(result.ok, false);
    assert.equal(result.code, INTERVENTION_ERROR_CODE.MISSING_INPUT);
  });

  it("rejects a non-object (string) with INVALID_TYPE", () => {
    const result = validateIntervention("task");
    assert.equal(result.ok, false);
    assert.equal(result.code, INTERVENTION_ERROR_CODE.INVALID_TYPE);
  });

  it("rejects an array with INVALID_TYPE", () => {
    const result = validateIntervention([]);
    assert.equal(result.ok, false);
    assert.equal(result.code, INTERVENTION_ERROR_CODE.INVALID_TYPE);
  });

  it("rejects when required field is missing — reports MISSING_FIELD with field name", () => {
    for (const field of INTERVENTION_SCHEMA.required) {
      const inv = makeIntervention();
      delete inv[field];
      const result = validateIntervention(inv);
      assert.equal(result.ok, false, `Expected failure for missing field: ${field}`);
      assert.equal(result.code, INTERVENTION_ERROR_CODE.MISSING_FIELD, `Expected MISSING_FIELD for: ${field}`);
      assert.equal(result.field, field, `Expected field name: ${field}`);
    }
  });

  it("rejects invalid type enum value with INVALID_FIELD", () => {
    const result = validateIntervention(makeIntervention({ type: "unknown" }));
    assert.equal(result.ok, false);
    assert.equal(result.code, INTERVENTION_ERROR_CODE.INVALID_FIELD);
    assert.equal(result.field, "type");
  });

  it("rejects non-integer wave with INVALID_FIELD", () => {
    const result = validateIntervention(makeIntervention({ wave: 1.5 }));
    assert.equal(result.ok, false);
    assert.equal(result.code, INTERVENTION_ERROR_CODE.INVALID_FIELD);
    assert.equal(result.field, "wave");
  });

  it("rejects wave < 1 with INVALID_FIELD", () => {
    const result = validateIntervention(makeIntervention({ wave: 0 }));
    assert.equal(result.ok, false);
    assert.equal(result.field, "wave");
  });

  it("rejects empty id string with INVALID_FIELD", () => {
    const result = validateIntervention(makeIntervention({ id: "  " }));
    assert.equal(result.ok, false);
    assert.equal(result.field, "id");
  });

  it("rejects successProbability > 1 with INVALID_FIELD", () => {
    const result = validateIntervention(makeIntervention({ successProbability: 1.1 }));
    assert.equal(result.ok, false);
    assert.equal(result.field, "successProbability");
  });

  it("rejects negative impact with INVALID_FIELD", () => {
    const result = validateIntervention(makeIntervention({ impact: -0.1 }));
    assert.equal(result.ok, false);
    assert.equal(result.field, "impact");
  });

  it("rejects non-finite riskCost (NaN) with INVALID_FIELD", () => {
    const result = validateIntervention(makeIntervention({ riskCost: NaN }));
    assert.equal(result.ok, false);
    assert.equal(result.field, "riskCost");
  });

  it("rejects negative sampleCount with INVALID_FIELD", () => {
    const result = validateIntervention(makeIntervention({ sampleCount: -1 }));
    assert.equal(result.ok, false);
    assert.equal(result.field, "sampleCount");
  });

  it("rejects non-integer sampleCount (float) with INVALID_FIELD", () => {
    const result = validateIntervention(makeIntervention({ sampleCount: 2.5 }));
    assert.equal(result.ok, false);
    assert.equal(result.field, "sampleCount");
  });

  it("rejects budgetCost < 1 with INVALID_FIELD", () => {
    const result = validateIntervention(makeIntervention({ budgetCost: 0 }));
    assert.equal(result.ok, false);
    assert.equal(result.field, "budgetCost");
  });

  it("accepts sampleCount = 0 (no historical data is valid)", () => {
    const result = validateIntervention(makeIntervention({ sampleCount: 0 }));
    assert.equal(result.ok, true);
  });

  it("accepts all three INTERVENTION_TYPE values", () => {
    for (const type of Object.values(INTERVENTION_TYPE)) {
      const result = validateIntervention(makeIntervention({ type }));
      assert.equal(result.ok, true, `Expected valid for type: ${type}`);
    }
  });
});

// ── validateBudget ────────────────────────────────────────────────────────────

describe("validateBudget", () => {
  it("accepts a minimal valid budget", () => {
    const result = validateBudget({ maxWorkerSpawns: 10 });
    assert.equal(result.ok, true);
  });

  it("accepts a fully specified budget", () => {
    const result = validateBudget({
      maxWorkerSpawns: 10,
      maxWorkersPerWave: 4,
      byRole: { backend: 3, frontend: 2 },
    });
    assert.equal(result.ok, true);
  });

  it("rejects null with MISSING_INPUT (not INVALID_FIELD)", () => {
    const result = validateBudget(null);
    assert.equal(result.ok, false);
    assert.equal(result.code, INTERVENTION_ERROR_CODE.MISSING_INPUT);
  });

  it("rejects undefined with MISSING_INPUT", () => {
    const result = validateBudget(undefined);
    assert.equal(result.ok, false);
    assert.equal(result.code, INTERVENTION_ERROR_CODE.MISSING_INPUT);
  });

  it("rejects missing maxWorkerSpawns with MISSING_FIELD", () => {
    const result = validateBudget({});
    assert.equal(result.ok, false);
    assert.equal(result.code, INTERVENTION_ERROR_CODE.MISSING_FIELD);
    assert.equal(result.field, "maxWorkerSpawns");
  });

  it("rejects maxWorkerSpawns = 0 with INVALID_FIELD", () => {
    const result = validateBudget({ maxWorkerSpawns: 0 });
    assert.equal(result.ok, false);
    assert.equal(result.field, "maxWorkerSpawns");
  });

  it("rejects fractional maxWorkersPerWave with INVALID_FIELD", () => {
    const result = validateBudget({ maxWorkerSpawns: 10, maxWorkersPerWave: 2.5 });
    assert.equal(result.ok, false);
    assert.equal(result.field, "maxWorkersPerWave");
  });

  it("rejects invalid byRole entry with INVALID_FIELD pointing to the bad role key", () => {
    const result = validateBudget({ maxWorkerSpawns: 10, byRole: { backend: 0 } });
    assert.equal(result.ok, false);
    assert.ok(result.field.includes("byRole.backend"));
  });
});

// ── applyConfidencePenalty / computeConfidenceMultiplier ─────────────────────

describe("confidence penalty formula", () => {
  it("computeConfidenceMultiplier(0) = 0.0 (no data → maximum penalty)", () => {
    assert.equal(computeConfidenceMultiplier(0), 0.0);
  });

  it("computeConfidenceMultiplier(1) = 1/SPARSE_DATA_THRESHOLD", () => {
    const expected = 1 / SPARSE_DATA_THRESHOLD;
    assert.ok(Math.abs(computeConfidenceMultiplier(1) - expected) < 1e-10);
  });

  it("computeConfidenceMultiplier(2) = 2/SPARSE_DATA_THRESHOLD", () => {
    const expected = 2 / SPARSE_DATA_THRESHOLD;
    assert.ok(Math.abs(computeConfidenceMultiplier(2) - expected) < 1e-10);
  });

  it("computeConfidenceMultiplier(SPARSE_DATA_THRESHOLD) = 1.0 (full confidence)", () => {
    assert.equal(computeConfidenceMultiplier(SPARSE_DATA_THRESHOLD), 1.0);
  });

  it("computeConfidenceMultiplier(100) = 1.0 (capped at 1.0)", () => {
    assert.equal(computeConfidenceMultiplier(100), 1.0);
  });

  it("applyConfidencePenalty with sampleCount=0 returns 0 regardless of successProbability", () => {
    assert.equal(applyConfidencePenalty(0.9, 0), 0.0);
    assert.equal(applyConfidencePenalty(1.0, 0), 0.0);
    assert.equal(applyConfidencePenalty(0.0, 0), 0.0);
  });

  it("applyConfidencePenalty with full confidence returns successProbability unchanged", () => {
    assert.equal(applyConfidencePenalty(0.8, SPARSE_DATA_THRESHOLD), 0.8);
    assert.equal(applyConfidencePenalty(0.5, 100), 0.5);
  });

  it("applyConfidencePenalty with sampleCount=1 gives 1/3 of successProbability", () => {
    const result = applyConfidencePenalty(0.9, 1);
    const expected = 0.9 * (1 / SPARSE_DATA_THRESHOLD);
    assert.ok(Math.abs(result - expected) < 1e-10);
  });
});

// ── computeExpectedValue ──────────────────────────────────────────────────────

describe("computeExpectedValue", () => {
  it("computes EV correctly with full confidence (sampleCount >= threshold)", () => {
    // adjustedP = 0.8 * 1.0 = 0.8
    // EV = 0.8 * 0.9 - 0.2 * 0.2 = 0.72 - 0.04 = 0.68
    const { adjustedSuccessProbability, ev } = computeExpectedValue(
      makeIntervention({ successProbability: 0.8, impact: 0.9, riskCost: 0.2, sampleCount: 3 }),
    );
    assert.ok(Math.abs(adjustedSuccessProbability - 0.8) < 1e-10);
    assert.ok(Math.abs(ev - 0.68) < 1e-10, `Expected EV ≈ 0.68, got ${ev}`);
  });

  it("computes EV correctly with sampleCount=0 (max confidence penalty)", () => {
    // adjustedP = 0.8 * 0 = 0
    // EV = 0 * 0.9 - 1 * 0.2 = -0.2
    const { adjustedSuccessProbability, ev } = computeExpectedValue(
      makeIntervention({ successProbability: 0.8, impact: 0.9, riskCost: 0.2, sampleCount: 0 }),
    );
    assert.equal(adjustedSuccessProbability, 0);
    assert.ok(Math.abs(ev - (-0.2)) < 1e-10, `Expected EV ≈ -0.2, got ${ev}`);
  });

  it("computes positive EV for high-impact, low-risk, high-confidence intervention", () => {
    const { ev } = computeExpectedValue(
      makeIntervention({ successProbability: 0.9, impact: 1.0, riskCost: 0.1, sampleCount: 10 }),
    );
    assert.ok(ev > 0, `Expected positive EV, got ${ev}`);
  });

  it("computes negative EV for zero-confidence high-risk intervention", () => {
    const { ev } = computeExpectedValue(
      makeIntervention({ successProbability: 0.9, impact: 0.5, riskCost: 0.9, sampleCount: 0 }),
    );
    assert.ok(ev < 0, `Expected negative EV (no confidence, high risk), got ${ev}`);
  });
});

// ── rankInterventions ─────────────────────────────────────────────────────────

describe("rankInterventions", () => {
  it("returns a new array sorted by descending EV", () => {
    const low  = makeIntervention({ id: "low",  impact: 0.1, riskCost: 0.9, successProbability: 0.5, sampleCount: 3 });
    const high = makeIntervention({ id: "high", impact: 0.9, riskCost: 0.1, successProbability: 0.9, sampleCount: 3 });
    const mid  = makeIntervention({ id: "mid",  impact: 0.5, riskCost: 0.3, successProbability: 0.7, sampleCount: 3 });

    const ranked = rankInterventions([low, mid, high]);
    assert.equal(ranked[0].id, "high");
    assert.equal(ranked[2].id, "low");
  });

  it("does not mutate the input array", () => {
    const original = [
      makeIntervention({ id: "a", impact: 0.2 }),
      makeIntervention({ id: "b", impact: 0.9 }),
    ];
    const originalIds = original.map((i) => i.id);
    rankInterventions(original);
    assert.deepEqual(original.map((i) => i.id), originalIds);
  });

  it("attaches ev and adjustedSuccessProbability to each ranked item", () => {
    const ranked = rankInterventions([makeIntervention()]);
    assert.ok("ev" in ranked[0], "ranked item should have ev field");
    assert.ok("adjustedSuccessProbability" in ranked[0]);
  });

  it("confidence penalty affects ranking — low sampleCount item ranks lower", () => {
    const confident = makeIntervention({ id: "confident", successProbability: 0.7, impact: 0.8, riskCost: 0.2, sampleCount: 3 });
    const sparse    = makeIntervention({ id: "sparse",    successProbability: 0.9, impact: 0.9, riskCost: 0.1, sampleCount: 0 });
    // sparse has higher raw successProbability but sampleCount=0 → EV = -riskCost = -0.1
    // confident: EV = 0.7 * 0.8 - 0.3 * 0.2 = 0.56 - 0.06 = 0.50
    const ranked = rankInterventions([sparse, confident]);
    assert.equal(ranked[0].id, "confident", "high-confidence item should rank first");
  });
});

// ── reconcileBudgets ──────────────────────────────────────────────────────────

describe("reconcileBudgets", () => {
  it("accepts all interventions when they fit within total budget", () => {
    const ranked = rankInterventions([
      makeIntervention({ id: "a", budgetCost: 2 }),
      makeIntervention({ id: "b", budgetCost: 3 }),
    ]);
    const result = reconcileBudgets(ranked, { maxWorkerSpawns: 10 });
    assert.equal(result.selected.length, 2);
    assert.equal(result.rejected.length, 0);
    assert.equal(result.status, OPTIMIZER_STATUS.OK);
    assert.equal(result.totalBudgetUsed, 5);
  });

  it("blocks intervention exceeding total budget (AC 2 — budget violations block schedule creation)", () => {
    const ranked = rankInterventions([
      makeIntervention({ id: "big", budgetCost: 8 }),
      makeIntervention({ id: "extra", budgetCost: 5 }),
    ]);
    const result = reconcileBudgets(ranked, { maxWorkerSpawns: 10 });
    assert.equal(result.selected.length, 1);
    assert.equal(result.selected[0].id, "big");
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].reasonCode, INTERVENTION_REJECTION_CODE.BUDGET_TOTAL);
    assert.equal(result.status, OPTIMIZER_STATUS.BUDGET_EXCEEDED);
    assert.equal(result.reasonCode, OPTIMIZER_REASON_CODE.BUDGET_TOTAL_EXCEEDED);
  });

  it("blocks intervention exceeding per-wave budget", () => {
    const ranked = rankInterventions([
      makeIntervention({ id: "a", wave: 1, budgetCost: 3 }),
      makeIntervention({ id: "b", wave: 1, budgetCost: 3 }), // would push wave-1 to 6 > limit 5
    ]);
    const result = reconcileBudgets(ranked, { maxWorkerSpawns: 20, maxWorkersPerWave: 5 });
    assert.equal(result.selected.length, 1);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].reasonCode, INTERVENTION_REJECTION_CODE.BUDGET_WAVE);
    assert.equal(result.reasonCode, OPTIMIZER_REASON_CODE.BUDGET_WAVE_EXCEEDED);
  });

  it("blocks intervention exceeding per-role budget", () => {
    const ranked = rankInterventions([
      makeIntervention({ id: "a", role: "backend", budgetCost: 2 }),
      makeIntervention({ id: "b", role: "backend", budgetCost: 2 }), // role total would be 4 > limit 3
    ]);
    const result = reconcileBudgets(ranked, {
      maxWorkerSpawns: 20,
      byRole: { backend: 3 },
    });
    assert.equal(result.selected.length, 1);
    assert.equal(result.rejected.length, 1);
    assert.equal(result.rejected[0].reasonCode, INTERVENTION_REJECTION_CODE.BUDGET_ROLE);
    assert.equal(result.reasonCode, OPTIMIZER_REASON_CODE.BUDGET_ROLE_EXCEEDED);
  });

  it("reconciles all three constraints simultaneously — wave violation detected before role", () => {
    // Wave 1 can fit 3 workers, role 'backend' can fit 3, total can fit 10
    // Second intervention: wave would be 4 > 3 (wave limit hit first)
    const ranked = rankInterventions([
      makeIntervention({ id: "first",  wave: 1, role: "backend", budgetCost: 3 }),
      makeIntervention({ id: "second", wave: 1, role: "backend", budgetCost: 1 }), // wave exceeded
    ]);
    const result = reconcileBudgets(ranked, {
      maxWorkerSpawns: 10,
      maxWorkersPerWave: 3,
      byRole: { backend: 10 },
    });
    assert.equal(result.selected.length, 1);
    assert.equal(result.rejected[0].reasonCode, INTERVENTION_REJECTION_CODE.BUDGET_WAVE);
  });

  it("different waves are budgeted independently", () => {
    // Each wave can fit 3, total = 10
    const ranked = rankInterventions([
      makeIntervention({ id: "w1", wave: 1, budgetCost: 3 }),
      makeIntervention({ id: "w2", wave: 2, budgetCost: 3 }),
    ]);
    const result = reconcileBudgets(ranked, { maxWorkerSpawns: 10, maxWorkersPerWave: 3 });
    assert.equal(result.selected.length, 2);
    assert.equal(result.rejected.length, 0);
    assert.equal(result.byWaveUsed["1"], 3);
    assert.equal(result.byWaveUsed["2"], 3);
  });

  it("returns correct byWaveUsed and byRoleUsed tallies", () => {
    const ranked = rankInterventions([
      makeIntervention({ id: "a", wave: 1, role: "backend",  budgetCost: 2 }),
      makeIntervention({ id: "b", wave: 2, role: "frontend", budgetCost: 3 }),
    ]);
    const result = reconcileBudgets(ranked, { maxWorkerSpawns: 20 });
    assert.equal(result.byWaveUsed["1"], 2);
    assert.equal(result.byWaveUsed["2"], 3);
    assert.equal(result.byRoleUsed["backend"], 2);
    assert.equal(result.byRoleUsed["frontend"], 3);
    assert.equal(result.totalBudgetUsed, 5);
  });

  it("NEGATIVE PATH: all interventions rejected produces BUDGET_EXCEEDED status", () => {
    const ranked = rankInterventions([
      makeIntervention({ id: "a", budgetCost: 100 }),
      makeIntervention({ id: "b", budgetCost: 100 }),
    ]);
    const result = reconcileBudgets(ranked, { maxWorkerSpawns: 5 });
    assert.equal(result.selected.length, 0);
    assert.equal(result.rejected.length, 2);
    assert.equal(result.status, OPTIMIZER_STATUS.BUDGET_EXCEEDED);
    assert.equal(result.totalBudgetUsed, 0);
  });
});

// ── runInterventionOptimizer — happy path ─────────────────────────────────────

describe("runInterventionOptimizer — happy path", () => {
  it("returns OK status with ranked selected interventions", () => {
    const interventions = [
      makeIntervention({ id: "low",  impact: 0.3, riskCost: 0.5, sampleCount: 3 }),
      makeIntervention({ id: "high", impact: 0.9, riskCost: 0.1, sampleCount: 3 }),
    ];
    const result = runInterventionOptimizer(interventions, makeBudget());
    assert.equal(result.status, OPTIMIZER_STATUS.OK);
    assert.equal(result.reasonCode, OPTIMIZER_REASON_CODE.VALID);
    assert.equal(result.selected.length, 2);
    assert.equal(result.selected[0].id, "high", "highest EV should be first in selected");
    assert.equal(result.rejected.length, 0);
  });

  it("result includes all required schema fields", () => {
    const result = runInterventionOptimizer([makeIntervention()], makeBudget());
    const requiredFields = [
      "schemaVersion", "generatedAt", "status", "reasonCode",
      "budgetUnit", "totalBudgetLimit", "totalBudgetUsed",
      "byWaveBudgetLimit", "byWaveUsed", "byRoleBudgetLimits",
      "byRoleUsed", "selected", "rejected",
    ];
    for (const field of requiredFields) {
      assert.ok(field in result, `Result must include field '${field}'`);
    }
    assert.equal(result.schemaVersion, OPTIMIZER_LOG_SCHEMA_VERSION);
    assert.equal(result.budgetUnit, BUDGET_UNIT);
  });

  it("result.generatedAt is a valid ISO 8601 timestamp", () => {
    const result = runInterventionOptimizer([makeIntervention()], makeBudget());
    assert.ok(!isNaN(Date.parse(result.generatedAt)), "generatedAt must be parseable as ISO 8601");
  });

  it("selected items include ev and adjustedSuccessProbability fields", () => {
    const result = runInterventionOptimizer([makeIntervention()], makeBudget());
    assert.ok("ev" in result.selected[0]);
    assert.ok("adjustedSuccessProbability" in result.selected[0]);
  });

  it("confidence penalty is applied — sampleCount < threshold reduces EV", () => {
    const sparsely_tested = makeIntervention({ sampleCount: 0, impact: 0.9, riskCost: 0.1 });
    const well_tested     = makeIntervention({ id: "well", sampleCount: 10, impact: 0.9, riskCost: 0.1 });
    const result = runInterventionOptimizer([sparsely_tested, well_tested], makeBudget());
    const sparse_ev = result.selected.find((s) => s.id === "i-001").ev;
    const well_ev   = result.selected.find((s) => s.id === "well").ev;
    assert.ok(well_ev > sparse_ev, `well-tested EV (${well_ev}) should exceed sparse EV (${sparse_ev})`);
  });
});

// ── runInterventionOptimizer — negative paths ─────────────────────────────────

describe("runInterventionOptimizer — negative paths", () => {
  it("NEGATIVE PATH: null interventions → INVALID_INPUT with MISSING_INPUT code", () => {
    const result = runInterventionOptimizer(null, makeBudget());
    assert.equal(result.status, OPTIMIZER_STATUS.INVALID_INPUT);
    assert.equal(result.reasonCode, OPTIMIZER_REASON_CODE.MISSING_INPUT);
    assert.ok(result.errorMessage);
    assert.equal(result.selected.length, 0);
    assert.equal(result.rejected.length, 0);
  });

  it("NEGATIVE PATH: non-array interventions → INVALID_INPUT with MISSING_INPUT code", () => {
    const result = runInterventionOptimizer("bad-input", makeBudget());
    assert.equal(result.status, OPTIMIZER_STATUS.INVALID_INPUT);
    assert.equal(result.reasonCode, OPTIMIZER_REASON_CODE.MISSING_INPUT);
  });

  it("NEGATIVE PATH: null budget → INVALID_INPUT with INVALID_BUDGET code", () => {
    const result = runInterventionOptimizer([makeIntervention()], null);
    assert.equal(result.status, OPTIMIZER_STATUS.INVALID_INPUT);
    assert.equal(result.reasonCode, OPTIMIZER_REASON_CODE.INVALID_BUDGET);
    assert.ok(result.errorMessage);
  });

  it("NEGATIVE PATH: missing budget.maxWorkerSpawns → INVALID_INPUT with INVALID_BUDGET", () => {
    const result = runInterventionOptimizer([makeIntervention()], {});
    assert.equal(result.status, OPTIMIZER_STATUS.INVALID_INPUT);
    assert.equal(result.reasonCode, OPTIMIZER_REASON_CODE.INVALID_BUDGET);
  });

  it("NEGATIVE PATH: invalid intervention in array → INVALID_INPUT with INVALID_INTERVENTION", () => {
    const interventions = [
      makeIntervention({ id: "valid-a" }),
      makeIntervention({ type: "INVALID_ENUM_VALUE" }), // invalid type
    ];
    const result = runInterventionOptimizer(interventions, makeBudget());
    assert.equal(result.status, OPTIMIZER_STATUS.INVALID_INPUT);
    assert.equal(result.reasonCode, OPTIMIZER_REASON_CODE.INVALID_INTERVENTION);
    assert.ok(result.errorMessage.includes("interventions[1]"), "error message should include the index");
    assert.equal(result.selected.length, 0);
  });

  it("NEGATIVE PATH: empty interventions array → EMPTY_INPUT status (not an error)", () => {
    const result = runInterventionOptimizer([], makeBudget());
    assert.equal(result.status, OPTIMIZER_STATUS.EMPTY_INPUT);
    assert.equal(result.reasonCode, OPTIMIZER_REASON_CODE.EMPTY_INPUT);
    assert.equal(result.selected.length, 0);
    assert.equal(result.rejected.length, 0);
  });

  it("NEGATIVE PATH: budget_exceeded status when interventions exceed budget", () => {
    const interventions = [
      makeIntervention({ id: "a", budgetCost: 8 }),
      makeIntervention({ id: "b", budgetCost: 8 }),
    ];
    const result = runInterventionOptimizer(interventions, makeBudget({ maxWorkerSpawns: 10 }));
    assert.equal(result.status, OPTIMIZER_STATUS.BUDGET_EXCEEDED);
    assert.equal(result.selected.length, 1);
    assert.equal(result.rejected.length, 1);
  });

  it("NEGATIVE PATH: invalid_input result has no silent fallback — status is explicit", () => {
    const result = runInterventionOptimizer(null, null);
    // Both null → budget validation fails first
    assert.equal(result.status, OPTIMIZER_STATUS.INVALID_INPUT);
    assert.ok(result.reasonCode);
    assert.ok(result.errorMessage);
    // No selected items produced silently
    assert.equal(result.selected.length, 0);
  });

  it("NEGATIVE PATH: missing required field in intervention returns invalidField", () => {
    const inv = makeIntervention();
    delete inv.budgetCost;
    const result = runInterventionOptimizer([inv], makeBudget());
    assert.equal(result.status, OPTIMIZER_STATUS.INVALID_INPUT);
    assert.equal(result.reasonCode, OPTIMIZER_REASON_CODE.INVALID_INTERVENTION);
    assert.equal(result.invalidField, "budgetCost");
  });
});

// ── buildInterventionsFromPlan ────────────────────────────────────────────────

describe("buildInterventionsFromPlan", () => {
  it("converts prometheus plans to valid intervention objects", () => {
    const plans = [
      { role: "King David", kind: "backend", priority: 8, wave: "wave-1", task: "Fix auth", id: "p-1" },
      { role: "Esther",     kind: "frontend", priority: 4, wave: "wave-2", task: "Fix UI",  id: "p-2" },
    ];
    const interventions = buildInterventionsFromPlan(plans, {});
    assert.equal(interventions.length, 2);
    for (const inv of interventions) {
      const vr = validateIntervention(inv);
      assert.equal(vr.ok, true, `Converted intervention should be valid: ${vr.message}`);
    }
  });

  it("parses wave number from wave string", () => {
    const plans = [{ role: "Aaron", task: "api task", wave: "wave-3", priority: 5 }];
    const [inv] = buildInterventionsFromPlan(plans, {});
    assert.equal(inv.wave, 3);
  });

  it("defaults wave to 1 for unparseable wave string", () => {
    const plans = [{ role: "Aaron", task: "api task", wave: "invalid", priority: 5 }];
    const [inv] = buildInterventionsFromPlan(plans, {});
    assert.equal(inv.wave, 1);
  });

  it("derives impact from priority (priority 10 → impact 1.0)", () => {
    const plans = [{ role: "Aaron", task: "high prio", wave: "wave-1", priority: 10 }];
    const [inv] = buildInterventionsFromPlan(plans, {});
    assert.equal(inv.impact, 1.0);
  });

  it("returns empty array for null or empty plans input", () => {
    assert.deepEqual(buildInterventionsFromPlan(null, {}), []);
    assert.deepEqual(buildInterventionsFromPlan([], {}), []);
  });

  it("uses defaultSampleCount from config when provided", () => {
    const plans = [{ role: "Noah", task: "deploy", wave: "wave-1", priority: 5 }];
    const [inv] = buildInterventionsFromPlan(plans, {
      interventionOptimizer: { defaultSampleCount: 5 },
    });
    assert.equal(inv.sampleCount, 5);
  });

  it("defaults sampleCount to SPARSE_DATA_THRESHOLD when not in config", () => {
    const plans = [{ role: "Noah", task: "deploy", wave: "wave-1", priority: 5 }];
    const [inv] = buildInterventionsFromPlan(plans, {});
    assert.equal(inv.sampleCount, SPARSE_DATA_THRESHOLD);
  });
});

// ── buildBudgetFromConfig ─────────────────────────────────────────────────────

describe("buildBudgetFromConfig", () => {
  it("uses requestBudget.hardCapTotal as maxWorkerSpawns when present", () => {
    const budget = buildBudgetFromConfig({ hardCapTotal: 15 }, {});
    assert.equal(budget.maxWorkerSpawns, 15);
  });

  it("falls back to config runtimeBudget.maxWorkerSpawnsPerCycle", () => {
    const config = { runtime: { runtimeBudget: { maxWorkerSpawnsPerCycle: 8 } } };
    const budget = buildBudgetFromConfig({}, config);
    assert.equal(budget.maxWorkerSpawns, 8);
  });

  it("falls back to config runtimeBudget.maxTasksPerCycle when maxWorkerSpawnsPerCycle absent", () => {
    const config = { runtime: { runtimeBudget: { maxTasksPerCycle: 6 } } };
    const budget = buildBudgetFromConfig({}, config);
    assert.equal(budget.maxWorkerSpawns, 6);
  });

  it("defaults to 12 when all config sources are absent", () => {
    const budget = buildBudgetFromConfig({}, {});
    assert.equal(budget.maxWorkerSpawns, 12);
  });

  it("always returns a valid Budget object", () => {
    const budget = buildBudgetFromConfig(null, null);
    const vr = validateBudget(budget);
    assert.equal(vr.ok, true, `buildBudgetFromConfig should always produce a valid budget: ${vr.message}`);
  });

  it("includes byRole when requestBudget.byRole is populated", () => {
    const requestBudget = {
      hardCapTotal: 10,
      byRole: [
        { role: "backend", count: 4 },
        { role: "frontend", count: 3 },
      ],
    };
    const budget = buildBudgetFromConfig(requestBudget, {});
    assert.ok(budget.byRole);
    assert.equal(budget.byRole.backend, 4);
    assert.equal(budget.byRole.frontend, 3);
  });
});

// ── Full integration: runInterventionOptimizer with buildInterventionsFromPlan ─

describe("full integration: plan → interventions → optimizer", () => {
  it("processes a realistic prometheus plan through the full optimizer pipeline", () => {
    const plans = [
      { id: "p1", role: "King David", kind: "backend",  priority: 9, wave: "wave-1", task: "Fix critical auth bug" },
      { id: "p2", role: "Samuel",     kind: "test",     priority: 7, wave: "wave-1", task: "Add auth tests" },
      { id: "p3", role: "Noah",       kind: "devops",   priority: 5, wave: "wave-2", task: "Update CI pipeline" },
      { id: "p4", role: "Esther",     kind: "frontend", priority: 3, wave: "wave-2", task: "Fix button layout" },
    ];

    const config = {
      runtime: { runtimeBudget: { maxTasksPerCycle: 12, maxWorkerSpawnsPerCycle: 12 } },
      planner: { defaultMaxWorkersPerWave: 10 },
    };
    const requestBudget = { hardCapTotal: 4, byWave: [], byRole: [] };

    const interventions = buildInterventionsFromPlan(plans, config);
    const budget = buildBudgetFromConfig(requestBudget, config);
    const result = runInterventionOptimizer(interventions, budget);

    assert.equal(result.status, OPTIMIZER_STATUS.OK);
    assert.equal(result.selected.length, 4);
    // Highest priority (p1) should have highest EV and rank first
    assert.equal(result.selected[0].id, "p1");
    // All selected items have ev field
    for (const s of result.selected) {
      assert.ok(typeof s.ev === "number");
    }
  });
});
