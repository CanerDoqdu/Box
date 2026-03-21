/**
 * Tests for T-013: Deprecate stale Moses references in learning loop.
 *
 * Covers:
 *   AC1:  Outcome collector no longer relies on absent Moses artifacts.
 *   AC2:  Metrics derive from active orchestration state files
 *         (prometheus_analysis.json, evolution_progress.json, worker_sessions.json).
 *   AC3:  No null/empty learning cycles due to missing moses_coordination.json.
 *   AC5:  Tests cover no-Moses runtime (criterion 5 from task).
 *   AC7:  Negative path — missing ALL state files → degraded=true with reason code.
 *   AC8:  Newly returned JSON fields (metricsSource, degraded, degradedReason) are present.
 *   AC9:  Missing input (ENOENT) vs invalid input (parse error) produce distinct reason codes.
 *   AC10: No silent fallback — degraded state sets explicit status and reason.
 *
 * Scenarios:
 *   1. No-Moses runtime: prometheus + evolution files present, no moses_coordination.json
 *      → metrics derived from active state files, degraded=false
 *   2. Only evolution_progress present, prometheus absent (ENOENT)
 *      → degraded=true, degradedReason=PROMETHEUS_ABSENT
 *   3. prometheus_analysis present but invalid JSON
 *      → degraded=true, degradedReason=PROMETHEUS_INVALID
 *   4. Legacy adapter: moses_coordination.json present alongside active files
 *      → completedTasks merges both sources; metricsSource includes "moses_coordination(legacy)"
 *   5. No state files at all
 *      → degraded=true, totalPlans=0, completedCount=0
 *   6. evolution_progress invalid JSON (distinct from missing)
 *      → degradedReason=EVOLUTION_INVALID (not EVOLUTION_ABSENT)
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  collectCycleOutcomes,
  OUTCOME_DEGRADED_REASON,
  computeWeightedDecisionScore,
  DECISION_QUALITY_WEIGHTS
} from "../../src/core/self_improvement.js";
import { DECISION_QUALITY_LABEL } from "../../src/core/athena_reviewer.js";

// ── Test helpers ──────────────────────────────────────────────────────────────

/** Write JSON to a file, creating parent dirs. */
async function writeTestJson(dir, filename, data) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), JSON.stringify(data, null, 2), "utf8");
}

/** Write raw text to a file (for corrupt JSON tests). */
async function writeRaw(dir, filename, text) {
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, filename), text, "utf8");
}

/** Build a minimal config pointing at a temp stateDir. */
function makeConfig(stateDir) {
  return {
    selfImprovement: { enabled: true },
    paths: { stateDir }
  };
}

/** Minimal valid prometheus_analysis.json. */
const PROMETHEUS_ANALYSIS = {
  schemaVersion: 1,
  projectHealth: "good",
  plans: [
    { id: "T-001", worker: "evolution-worker", context: "fix tests" },
    { id: "T-002", worker: "evolution-worker", context: "add lint" }
  ],
  executionStrategy: {
    waves: [
      { id: "wave-1", workers: ["evolution-worker"], gate: "none", estimatedRequests: 2 }
    ]
  },
  requestBudget: { estimatedPremiumRequestsTotal: 2, hardCapTotal: 10, errorMarginPercent: 20, confidenceLevel: "medium" }
};

/** Minimal valid evolution_progress.json with two completed tasks. */
const EVOLUTION_PROGRESS = {
  cycle_id: "SE-test-001",
  started_at: new Date().toISOString(),
  current_task_index: 2,
  tasks: {
    "T-001": { status: "completed", attempts: 1 },
    "T-002": { status: "in_progress", attempts: 1 },
    "T-003": { status: "pending", attempts: 0 }
  }
};

/** Minimal worker_sessions.json. */
const WORKER_SESSIONS = {
  schemaVersion: 1,
  "evolution-worker": { status: "idle", startedAt: new Date().toISOString() }
};

// ── OUTCOME_DEGRADED_REASON enum ──────────────────────────────────────────────

describe("OUTCOME_DEGRADED_REASON", () => {
  it("is a frozen object with all required reason codes", () => {
    assert.ok(Object.isFrozen(OUTCOME_DEGRADED_REASON), "must be frozen");
    assert.equal(OUTCOME_DEGRADED_REASON.PROMETHEUS_ABSENT,  "PROMETHEUS_ABSENT");
    assert.equal(OUTCOME_DEGRADED_REASON.PROMETHEUS_INVALID, "PROMETHEUS_INVALID");
    assert.equal(OUTCOME_DEGRADED_REASON.EVOLUTION_ABSENT,   "EVOLUTION_ABSENT");
    assert.equal(OUTCOME_DEGRADED_REASON.EVOLUTION_INVALID,  "EVOLUTION_INVALID");
    assert.equal(OUTCOME_DEGRADED_REASON.NO_ACTIVE_DATA,     "NO_ACTIVE_DATA");
  });
});

// ── Scenario 1: No-Moses runtime (AC1, AC2, AC3, AC5) ────────────────────────

describe("collectCycleOutcomes — no-Moses runtime", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t013-noses-"));
    await writeTestJson(tmpDir, "prometheus_analysis.json", PROMETHEUS_ANALYSIS);
    await writeTestJson(tmpDir, "evolution_progress.json", EVOLUTION_PROGRESS);
    await writeTestJson(tmpDir, "worker_sessions.json", WORKER_SESSIONS);
    // Intentionally NO moses_coordination.json
    result = await collectCycleOutcomes(makeConfig(tmpDir));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns totalPlans from prometheus_analysis.plans", () => {
    assert.equal(result.totalPlans, 2, "totalPlans must match prometheus plans count");
  });

  it("returns completedCount from evolution_progress completed tasks", () => {
    assert.equal(result.completedCount, 1, "only T-001 has status=completed");
  });

  it("returns projectHealth from prometheus_analysis", () => {
    assert.equal(result.projectHealth, "good");
  });

  it("degraded=false when all primary sources are present", () => {
    assert.equal(result.degraded, false, "should not be degraded with all active files present");
    assert.equal(result.degradedReason, null);
  });

  it("metricsSource includes prometheus_analysis and evolution_progress", () => {
    assert.ok(result.metricsSource.includes("prometheus_analysis"), "must credit prometheus_analysis");
    assert.ok(result.metricsSource.includes("evolution_progress"), "must credit evolution_progress");
    assert.ok(!result.metricsSource.includes("moses_coordination"), "must not include Moses source");
  });

  it("dispatches does not rely on moses dispatchLog", () => {
    // With no Moses file and no worker activity files, dispatches is empty (not null).
    assert.ok(Array.isArray(result.dispatches), "dispatches must be an array");
  });

  it("waves derived from prometheus_analysis executionStrategy", () => {
    assert.equal(result.waves.length, 1);
    assert.equal(result.waves[0].id, "wave-1");
  });

  it("result includes required schema fields", () => {
    for (const field of ["totalPlans", "completedCount", "projectHealth", "workerOutcomes",
      "waves", "dispatches", "requestBudget", "decisionQuality", "timestamp",
      "metricsSource", "degraded", "degradedReason"]) {
      assert.ok(field in result, `result must include field: ${field}`);
    }
  });
});

// ── Scenario 2: prometheus_analysis absent (AC9, AC10) ───────────────────────

describe("collectCycleOutcomes — prometheus_analysis missing (ENOENT)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t013-nopr-"));
    await writeTestJson(tmpDir, "evolution_progress.json", EVOLUTION_PROGRESS);
    await writeTestJson(tmpDir, "worker_sessions.json", WORKER_SESSIONS);
    // No prometheus_analysis.json
    result = await collectCycleOutcomes(makeConfig(tmpDir));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("degraded=true when prometheus_analysis is missing", () => {
    assert.equal(result.degraded, true);
  });

  it("degradedReason=PROMETHEUS_ABSENT (not INVALID) for ENOENT", () => {
    assert.equal(result.degradedReason, OUTCOME_DEGRADED_REASON.PROMETHEUS_ABSENT,
      "must use ABSENT reason code for missing file, not INVALID");
  });

  it("totalPlans=0 when prometheus_analysis is absent", () => {
    assert.equal(result.totalPlans, 0);
  });
});

// ── Scenario 3: prometheus_analysis invalid JSON (AC9) ───────────────────────

describe("collectCycleOutcomes — prometheus_analysis invalid JSON", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t013-invpr-"));
    await writeRaw(tmpDir, "prometheus_analysis.json", "{ this is not valid json }}}");
    await writeTestJson(tmpDir, "evolution_progress.json", EVOLUTION_PROGRESS);
    await writeTestJson(tmpDir, "worker_sessions.json", WORKER_SESSIONS);
    result = await collectCycleOutcomes(makeConfig(tmpDir));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("degraded=true when prometheus_analysis is invalid JSON", () => {
    assert.equal(result.degraded, true);
  });

  it("degradedReason=PROMETHEUS_INVALID (not ABSENT) for corrupt file", () => {
    assert.equal(result.degradedReason, OUTCOME_DEGRADED_REASON.PROMETHEUS_INVALID,
      "must use INVALID reason code for corrupt file, not ABSENT");
  });
});

// ── Scenario 4: prometheus_analysis has wrong structure (AC9) ─────────────────

describe("collectCycleOutcomes — prometheus_analysis missing plans array", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t013-badpr-"));
    // Valid JSON but missing the required `plans` array field
    await writeTestJson(tmpDir, "prometheus_analysis.json", { projectHealth: "good" });
    await writeTestJson(tmpDir, "evolution_progress.json", EVOLUTION_PROGRESS);
    await writeTestJson(tmpDir, "worker_sessions.json", WORKER_SESSIONS);
    result = await collectCycleOutcomes(makeConfig(tmpDir));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("degraded=true when prometheus_analysis lacks plans array", () => {
    assert.equal(result.degraded, true);
  });

  it("degradedReason=PROMETHEUS_INVALID for bad structure", () => {
    assert.equal(result.degradedReason, OUTCOME_DEGRADED_REASON.PROMETHEUS_INVALID);
  });
});

// ── Scenario 5: Legacy adapter — moses_coordination.json present (AC1 rollback) ─

describe("collectCycleOutcomes — legacy adapter (moses_coordination.json present)", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t013-legacy-"));
    await writeTestJson(tmpDir, "prometheus_analysis.json", PROMETHEUS_ANALYSIS);
    await writeTestJson(tmpDir, "evolution_progress.json", EVOLUTION_PROGRESS);
    await writeTestJson(tmpDir, "worker_sessions.json", WORKER_SESSIONS);
    // Legacy Moses file still present on disk
    await writeTestJson(tmpDir, "moses_coordination.json", {
      completedTasks: ["T-001", "T-LEGACY-001"],
      dispatchLog: [{ role: "old-worker", task: "T-LEGACY-001", status: "done" }]
    });
    result = await collectCycleOutcomes(makeConfig(tmpDir));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("merges legacy completedTasks with evolution-derived completed tasks", () => {
    // evolution has T-001 completed; legacy adds T-LEGACY-001
    assert.ok(result.completedCount >= 2, "must include both evolution and legacy completed tasks");
  });

  it("metricsSource includes moses_coordination(legacy)", () => {
    assert.ok(result.metricsSource.includes("moses_coordination(legacy)"),
      "must tag legacy source in metricsSource");
  });

  it("degraded=false — primary sources are present, Moses is additive", () => {
    assert.equal(result.degraded, false);
  });
});

// ── Scenario 6: All state files absent (AC7 negative path) ───────────────────

describe("collectCycleOutcomes — all state files absent", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t013-empty-"));
    // Create directory but write NO state files
    result = await collectCycleOutcomes(makeConfig(tmpDir));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("degraded=true when no state files exist", () => {
    assert.equal(result.degraded, true);
  });

  it("degradedReason is a valid OUTCOME_DEGRADED_REASON code (not null)", () => {
    assert.ok(result.degradedReason !== null, "degradedReason must not be null when degraded");
    assert.ok(
      Object.values(OUTCOME_DEGRADED_REASON).includes(result.degradedReason),
      `degradedReason must be a known code, got: ${result.degradedReason}`
    );
  });

  it("totalPlans=0 and completedCount=0", () => {
    assert.equal(result.totalPlans, 0);
    assert.equal(result.completedCount, 0);
  });

  it("result is an object (not null/undefined) — no silent failure", () => {
    assert.ok(result !== null && typeof result === "object",
      "must return a result object, not null");
  });
});

// ── Scenario 7: evolution_progress invalid JSON (AC9 distinct reason code) ────

describe("collectCycleOutcomes — evolution_progress invalid JSON", () => {
  let tmpDir;
  let result;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-t013-invevo-"));
    await writeTestJson(tmpDir, "prometheus_analysis.json", PROMETHEUS_ANALYSIS);
    await writeRaw(tmpDir, "evolution_progress.json", "BROKEN{{{");
    await writeTestJson(tmpDir, "worker_sessions.json", WORKER_SESSIONS);
    result = await collectCycleOutcomes(makeConfig(tmpDir));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("degraded=true when evolution_progress is corrupt", () => {
    assert.equal(result.degraded, true);
  });

  it("degradedReason=EVOLUTION_INVALID (not EVOLUTION_ABSENT)", () => {
    assert.equal(result.degradedReason, OUTCOME_DEGRADED_REASON.EVOLUTION_INVALID,
      "corrupt file must produce INVALID, not ABSENT");
  });

  it("totalPlans still returns plan count from prometheus (other source still valid)", () => {
    // prometheus_analysis was valid, so plans should be populated
    assert.equal(result.totalPlans, 2,
      "totalPlans should still be populated from prometheus when evolution is the only degraded source");
  });
});
