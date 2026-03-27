/**
 * Tests for src/core/cycle_analytics.js
 *
 * Coverage:
 *   AC1  — artifact includes cycle id, phase, outcomes, confidence values
 *   AC2  — KPIs computed from canonical events only
 *   AC3  — missing data represented explicitly (not zero-filled)
 *   AC4  — append-only with retention policy
 *   AC6  — each criterion maps to explicit verification
 *   AC7  — negative paths including failure handling
 *   AC8  — schema with required fields and explicit enums
 *   AC9  — distinguishes missing input from invalid input
 *   AC10 — no silent fallback for critical state
 */

import assert from "node:assert/strict";
import { describe, it, before, after, beforeEach } from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  computeCycleAnalytics,
  persistCycleAnalytics,
  readCycleAnalytics,
  CYCLE_PHASE,
  CYCLE_OUTCOME_STATUS,
  CONFIDENCE_LEVEL,
  MISSING_DATA_REASON,
  MISSING_DATA_IMPACT,
  CYCLE_ANALYTICS_SCHEMA,
  CANONICAL_EVENT_NAMES,
} from "../../src/core/cycle_analytics.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = new Date("2025-01-01T10:00:00.000Z").getTime();
const makeTs = (offsetMs) => new Date(NOW + offsetMs).toISOString();

function validTimestamps() {
  return {
    jesus_awakening: makeTs(0),
    jesus_decided:   makeTs(5_000),      // 5s decision — within 120s threshold
    athena_approved: makeTs(10_000),
    workers_dispatching: makeTs(15_000), // 5s dispatch — within 30s threshold
    cycle_complete:  makeTs(600_000),    // 10min verification — within 1hr threshold
  };
}

function makeSloRecord(overrides = {}) {
  return {
    cycleId: makeTs(0),
    startedAt: makeTs(0),
    completedAt: makeTs(600_000),
    metrics: {
      decisionLatencyMs: 5000,
      dispatchLatencyMs: 5000,
      verificationCompletionMs: 585000,
    },
    sloBreaches: [],
    status: "ok",
    statusReason: "OK",
    ...overrides,
  };
}

function makePipelineProgress(overrides = {}) {
  return {
    startedAt: makeTs(0),
    completedAt: makeTs(600_000),
    stage: "cycle_complete",
    stageTimestamps: validTimestamps(),
    ...overrides,
  };
}

function makeConfig(stateDir) {
  return {
    paths: { stateDir },
    slo: {
      enabled: true,
      thresholds: {
        decisionLatencyMs: 120_000,
        dispatchLatencyMs: 30_000,
        verificationCompletionMs: 3_600_000,
      },
    },
  };
}

// ── Schema compliance ─────────────────────────────────────────────────────────

describe("CYCLE_ANALYTICS_SCHEMA (AC8)", () => {
  it("exports schemaVersion 1", () => {
    assert.equal(CYCLE_ANALYTICS_SCHEMA.schemaVersion, 1);
  });

  it("required fields list is complete", () => {
    const req = CYCLE_ANALYTICS_SCHEMA.cycleRecord.required;
    for (const f of ["cycleId", "generatedAt", "phase", "outcomes", "kpis", "confidence", "causalLinks", "canonicalEvents", "missingData"]) {
      assert.ok(req.includes(f), `required field missing: ${f}`);
    }
  });

  it("phaseEnum contains all CYCLE_PHASE values", () => {
    for (const v of Object.values(CYCLE_PHASE)) {
      assert.ok(CYCLE_ANALYTICS_SCHEMA.cycleRecord.phaseEnum.includes(v), `phaseEnum missing: ${v}`);
    }
  });

  it("confidenceLevelEnum contains all CONFIDENCE_LEVEL values", () => {
    for (const v of Object.values(CONFIDENCE_LEVEL)) {
      assert.ok(CYCLE_ANALYTICS_SCHEMA.cycleRecord.confidenceLevelEnum.includes(v), `confidenceLevelEnum missing: ${v}`);
    }
  });

  it("defaultMaxHistoryEntries is 50", () => {
    assert.equal(CYCLE_ANALYTICS_SCHEMA.defaultMaxHistoryEntries, 50);
  });

  it("cycleIdSource is pipeline_progress.startedAt", () => {
    assert.equal(CYCLE_ANALYTICS_SCHEMA.cycleRecord.cycleIdSource, "pipeline_progress.startedAt");
  });
});

// ── CANONICAL_EVENT_NAMES ─────────────────────────────────────────────────────

describe("CANONICAL_EVENT_NAMES (AC2, AC13)", () => {
  it("contains exactly the 5 SLO timestamp stages", () => {
    const expected = ["jesus_awakening", "jesus_decided", "athena_approved", "workers_dispatching", "cycle_complete"];
    assert.deepEqual([...CANONICAL_EVENT_NAMES], expected);
  });
});

// ── computeCycleAnalytics — required fields (AC1) ─────────────────────────────

describe("computeCycleAnalytics — required fields (AC1)", () => {
  it("returns all required fields on full input", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      sloRecord: makeSloRecord(),
      pipelineProgress: makePipelineProgress(),
      workerResults: [{ roleName: "coder", status: "done" }],
      planCount: 1,
      phase: CYCLE_PHASE.COMPLETED,
    });
    for (const f of CYCLE_ANALYTICS_SCHEMA.cycleRecord.required) {
      assert.ok(f in record, `missing required field: ${f}`);
    }
  });

  it("cycleId equals pipelineProgress.startedAt", () => {
    const config = makeConfig("state");
    const progress = makePipelineProgress();
    const record = computeCycleAnalytics(config, { sloRecord: makeSloRecord(), pipelineProgress: progress });
    assert.equal(record.cycleId, progress.startedAt);
  });

  it("phase is included", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { phase: CYCLE_PHASE.INCOMPLETE });
    assert.equal(record.phase, CYCLE_PHASE.INCOMPLETE);
  });

  it("generatedAt is a valid ISO string", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config);
    assert.ok(!isNaN(new Date(record.generatedAt).getTime()), "generatedAt must be valid ISO");
  });
});

// ── computeCycleAnalytics — KPIs from canonical events only (AC2) ─────────────

describe("computeCycleAnalytics — KPIs (AC2)", () => {
  it("kpis.decisionLatencyMs comes from sloRecord.metrics", () => {
    const config = makeConfig("state");
    const sloRecord = makeSloRecord({ metrics: { decisionLatencyMs: 4200, dispatchLatencyMs: 3000, verificationCompletionMs: 300000 } });
    const record = computeCycleAnalytics(config, { sloRecord, pipelineProgress: makePipelineProgress() });
    assert.equal(record.kpis.decisionLatencyMs, 4200);
  });

  it("kpis.sloBreachCount is zero when no breaches", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { sloRecord: makeSloRecord(), pipelineProgress: makePipelineProgress() });
    assert.equal(record.kpis.sloBreachCount, 0);
  });

  it("kpis.sloBreachCount counts breach entries", () => {
    const config = makeConfig("state");
    const sloRecord = makeSloRecord({ sloBreaches: [{ metric: "decisionLatencyMs" }] });
    const record = computeCycleAnalytics(config, { sloRecord });
    assert.equal(record.kpis.sloBreachCount, 1);
  });

  it("kpis.sloStatus reflects sloRecord.status", () => {
    const config = makeConfig("state");
    const sloRecord = makeSloRecord({ status: "degraded" });
    const record = computeCycleAnalytics(config, { sloRecord });
    assert.equal(record.kpis.sloStatus, "degraded");
  });

  it("kpis.sloStatus is 'unknown' when sloRecord is null (AC10)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { sloRecord: null });
    assert.equal(record.kpis.sloStatus, "unknown");
  });
});

// ── computeCycleAnalytics — canonicalEvents inventory (AC2) ──────────────────

describe("computeCycleAnalytics — canonicalEvents (AC2)", () => {
  it("lists all 5 canonical events", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress() });
    assert.equal(record.canonicalEvents.length, CANONICAL_EVENT_NAMES.length);
  });

  it("marks present=true for existing timestamps", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress() });
    for (const e of record.canonicalEvents) {
      assert.ok(e.present === true, `expected ${e.name} to be present`);
    }
  });

  it("marks present=false and timestamp=null for missing events", () => {
    const config = makeConfig("state");
    const ts = validTimestamps();
    delete ts.jesus_decided;
    delete ts.cycle_complete;
    const progress = makePipelineProgress({ stageTimestamps: ts });
    const record = computeCycleAnalytics(config, { pipelineProgress: progress });
    const missing = record.canonicalEvents.filter(e => !e.present);
    assert.equal(missing.length, 2);
    for (const e of missing) {
      assert.equal(e.timestamp, null);
    }
  });
});

// ── computeCycleAnalytics — missing data explicit (AC3, AC9, AC10) ────────────

describe("computeCycleAnalytics — missing data handling (AC3, AC9, AC10)", () => {
  it("null sloRecord adds MISSING_SOURCE entries for kpi fields", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { sloRecord: null });
    const reasons = record.missingData.map(m => m.reason);
    assert.ok(reasons.includes(MISSING_DATA_REASON.MISSING_SOURCE));
  });

  it("null pipelineProgress adds MISSING_SOURCE entry", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { pipelineProgress: null });
    const fields = record.missingData.map(m => m.field);
    assert.ok(fields.includes("pipelineProgress"), "pipelineProgress missing data not recorded");
  });

  it("latency fields are null (not 0) when sloRecord absent (AC3)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { sloRecord: null });
    assert.equal(record.kpis.decisionLatencyMs, null);
    assert.equal(record.kpis.dispatchLatencyMs, null);
    assert.equal(record.kpis.verificationCompletionMs, null);
  });

  it("causal link latencyMs is null when timestamps missing (AC3)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { pipelineProgress: null });
    for (const link of record.causalLinks) {
      assert.equal(link.latencyMs, null);
    }
  });

  it("causal link missing timestamp adds MISSING_TIMESTAMP entry to missingData (AC9)", () => {
    const config = makeConfig("state");
    const ts = validTimestamps();
    delete ts.jesus_decided;
    const progress = makePipelineProgress({ stageTimestamps: ts });
    const record = computeCycleAnalytics(config, { pipelineProgress: progress });
    const entry = record.missingData.find(m => m.field.includes("jesus_awakening→jesus_decided"));
    assert.ok(entry, "missing timestamp entry not found in missingData");
    assert.equal(entry.reason, MISSING_DATA_REASON.MISSING_TIMESTAMP);
    assert.equal(entry.impact, MISSING_DATA_IMPACT.CAUSAL_LINK);
  });

  it("missingData entries include impact field (AC10)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { sloRecord: null, pipelineProgress: null });
    for (const m of record.missingData) {
      assert.ok(Object.values(MISSING_DATA_IMPACT).includes(m.impact), `invalid impact: ${m.impact}`);
      assert.ok(Object.values(MISSING_DATA_REASON).includes(m.reason), `invalid reason: ${m.reason}`);
    }
  });
});

// ── computeCycleAnalytics — confidence (AC1, AC11) ────────────────────────────

describe("computeCycleAnalytics — confidence levels (AC1, AC11)", () => {
  it("high when all 5 events present and sloRecord provided", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      sloRecord: makeSloRecord(),
      pipelineProgress: makePipelineProgress(),
    });
    assert.equal(record.confidence.level, CONFIDENCE_LEVEL.HIGH);
  });

  it("medium when 4 events present (one missing)", () => {
    const config = makeConfig("state");
    const ts = validTimestamps();
    delete ts.cycle_complete;
    const record = computeCycleAnalytics(config, {
      sloRecord: makeSloRecord(),
      pipelineProgress: makePipelineProgress({ stageTimestamps: ts }),
    });
    assert.equal(record.confidence.level, CONFIDENCE_LEVEL.MEDIUM);
  });

  it("medium when all events present but sloRecord absent", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      sloRecord: null,
      pipelineProgress: makePipelineProgress(),
    });
    assert.equal(record.confidence.level, CONFIDENCE_LEVEL.MEDIUM);
  });

  it("low when ≤2 events present", () => {
    const config = makeConfig("state");
    const ts = { jesus_awakening: makeTs(0), jesus_decided: makeTs(5000) };
    const record = computeCycleAnalytics(config, {
      pipelineProgress: makePipelineProgress({ stageTimestamps: ts }),
    });
    assert.equal(record.confidence.level, CONFIDENCE_LEVEL.LOW);
  });

  it("low when pipelineProgress is null", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { pipelineProgress: null });
    assert.equal(record.confidence.level, CONFIDENCE_LEVEL.LOW);
  });

  it("confidence.level is always a valid enum value (AC8)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {});
    assert.ok(Object.values(CONFIDENCE_LEVEL).includes(record.confidence.level));
  });

  it("confidence.missingFields is an array", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config);
    assert.ok(Array.isArray(record.confidence.missingFields));
  });
});

// ── computeCycleAnalytics — causal links (AC12) ───────────────────────────────

describe("computeCycleAnalytics — causal links (AC12)", () => {
  it("produces 3 causal links", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress() });
    assert.equal(record.causalLinks.length, 3);
  });

  it("each link has cause, effect, metric, latencyMs, anomaly, anomalyReason", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress() });
    for (const link of record.causalLinks) {
      assert.ok("cause" in link);
      assert.ok("effect" in link);
      assert.ok("metric" in link);
      assert.ok("latencyMs" in link);
      assert.ok("anomaly" in link);
      assert.ok("anomalyReason" in link);
    }
  });

  it("anomaly=false when latency within threshold", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress() });
    for (const link of record.causalLinks) {
      assert.equal(link.anomaly, false, `unexpected anomaly on ${link.cause}→${link.effect}`);
    }
  });

  it("anomaly=true and anomalyReason set when threshold exceeded (negative path)", () => {
    const config = makeConfig("state");
    const ts = validTimestamps();
    // Push jesus_decided beyond the 120s threshold
    ts.jesus_decided = makeTs(200_000);
    const record = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress({ stageTimestamps: ts }) });
    const decisionLink = record.causalLinks.find(l => l.cause === "jesus_awakening");
    assert.ok(decisionLink, "decision causal link not found");
    assert.equal(decisionLink.anomaly, true);
    assert.ok(typeof decisionLink.anomalyReason === "string" && decisionLink.anomalyReason.length > 0);
  });

  it("latencyMs is clamped to ≥0 (clock skew safety)", () => {
    const config = makeConfig("state");
    const ts = validTimestamps();
    // Reverse jesus_awakening and jesus_decided to simulate clock skew
    ts.jesus_awakening = makeTs(10_000);
    ts.jesus_decided = makeTs(0);  // earlier than awakening
    const record = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress({ stageTimestamps: ts }) });
    const decisionLink = record.causalLinks.find(l => l.cause === "jesus_awakening");
    assert.ok(decisionLink.latencyMs >= 0, "latencyMs must be non-negative");
  });
});

// ── computeCycleAnalytics — outcomes (AC1) ────────────────────────────────────

describe("computeCycleAnalytics — outcomes (AC1)", () => {
  it("outcomes.status is SUCCESS when all workers done", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      pipelineProgress: makePipelineProgress(),
      workerResults: [{ roleName: "coder", status: "done" }],
      planCount: 1,
      phase: CYCLE_PHASE.COMPLETED,
    });
    assert.equal(record.outcomes.status, CYCLE_OUTCOME_STATUS.SUCCESS);
  });

  it("outcomes.status is PARTIAL when some workers failed", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      workerResults: [
        { roleName: "coder", status: "done" },
        { roleName: "qa", status: "error" },
      ],
      planCount: 2,
      phase: CYCLE_PHASE.COMPLETED,
    });
    assert.equal(record.outcomes.status, CYCLE_OUTCOME_STATUS.PARTIAL);
  });

  it("outcomes.status is NO_PLANS when planCount=0 and phase=INCOMPLETE", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { planCount: 0, phase: CYCLE_PHASE.INCOMPLETE });
    assert.equal(record.outcomes.status, CYCLE_OUTCOME_STATUS.NO_PLANS);
  });

  it("outcomes.status is FAILED for CYCLE_PHASE.FAILED", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { phase: CYCLE_PHASE.FAILED });
    assert.equal(record.outcomes.status, CYCLE_OUTCOME_STATUS.FAILED);
  });

  it("outcomes.tasksDispatched is null when planCount not provided (AC3)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { planCount: null });
    assert.equal(record.outcomes.tasksDispatched, null);
  });

  it("outcomes.status enum value is valid (AC8)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config);
    assert.ok(Object.values(CYCLE_OUTCOME_STATUS).includes(record.outcomes.status));
  });
});

// ── persistCycleAnalytics + readCycleAnalytics (AC4, retention policy) ────────

describe("persistCycleAnalytics and readCycleAnalytics (AC4)", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-analytics-test-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("creates file with correct schema on first write", async () => {
    const config = makeConfig(tmpDir);
    const record = computeCycleAnalytics(config, { sloRecord: makeSloRecord(), pipelineProgress: makePipelineProgress() });
    await persistCycleAnalytics(config, record);

    const data = await readCycleAnalytics(config);
    assert.ok(data !== null);
    assert.equal(data.schemaVersion, CYCLE_ANALYTICS_SCHEMA.schemaVersion);
    assert.ok("lastCycle" in data);
    assert.ok(Array.isArray(data.history));
    assert.ok("updatedAt" in data);
  });

  it("append-only: second write prepends to history", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-analytics-append-"));
    try {
      const config = makeConfig(dir);
      const r1 = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress({ startedAt: makeTs(0) }) });
      await persistCycleAnalytics(config, r1);
      const r2 = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress({ startedAt: makeTs(1000) }) });
      await persistCycleAnalytics(config, r2);

      const data = await readCycleAnalytics(config);
      assert.equal(data.history.length, 2);
      // Most recent is first (prepend)
      assert.equal(data.lastCycle.cycleId, r2.cycleId);
      assert.equal(data.history[0].cycleId, r2.cycleId);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("retention policy: caps history at maxHistoryEntries (AC17)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-analytics-cap-"));
    try {
      const config = { ...makeConfig(dir), cycleAnalytics: { maxHistoryEntries: 3 } };
      for (let i = 0; i < 5; i++) {
        const r = computeCycleAnalytics(config, { pipelineProgress: makePipelineProgress({ startedAt: makeTs(i * 1000) }) });
        await persistCycleAnalytics(config, r);
      }
      const data = await readCycleAnalytics(config);
      assert.ok(data.history.length <= 3, `history should be capped at 3, got ${data.history.length}`);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it("readCycleAnalytics returns null when file does not exist (AC3, AC18)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "box-analytics-empty-"));
    try {
      const config = makeConfig(dir);
      const data = await readCycleAnalytics(config);
      assert.equal(data, null);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});

// ── Negative paths (AC7) ──────────────────────────────────────────────────────

describe("Negative paths (AC7)", () => {
  it("computeCycleAnalytics with all-null inputs returns valid record (no throw)", () => {
    const config = makeConfig("state");
    assert.doesNotThrow(() => {
      const record = computeCycleAnalytics(config, {
        sloRecord: null,
        pipelineProgress: null,
        workerResults: null,
        planCount: null,
        phase: CYCLE_PHASE.INCOMPLETE,
      });
      // Must still have required fields
      for (const f of CYCLE_ANALYTICS_SCHEMA.cycleRecord.required) {
        assert.ok(f in record, `missing field: ${f}`);
      }
    });
  });

  it("computeCycleAnalytics with empty config does not throw", () => {
    assert.doesNotThrow(() => computeCycleAnalytics({}));
  });

  it("computeCycleAnalytics with no arguments does not throw", () => {
    assert.doesNotThrow(() => computeCycleAnalytics());
  });

  it("missingData is populated (not empty) when inputs are null (AC10 — no silent fallback)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { sloRecord: null, pipelineProgress: null });
    assert.ok(record.missingData.length > 0, "missingData must be non-empty when inputs are absent");
  });

  it("invalid workerResults (non-array) treated as null — no throw, outcomes.tasksCompleted=null (AC9)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { workerResults: "not-an-array" });
    assert.equal(record.outcomes.tasksCompleted, null);
    assert.equal(record.outcomes.tasksFailed, null);
  });

  it("persistCycleAnalytics with invalid state dir throws (I/O error surfaced, not swallowed) (AC10)", async () => {
    // Create a regular file at the state dir path so ensureParent (mkdir) fails.
    // This forces a genuine I/O error that must surface rather than be swallowed.
    const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), "box-analytics-ioerr-"));
    const blockerFile = path.join(tmpBase, "state-as-file");
    await fs.writeFile(blockerFile, "not-a-dir");
    // The state dir is a path that requires treating blockerFile as a directory
    const config = makeConfig(path.join(blockerFile, "subdir"));
    const record = computeCycleAnalytics(config);
    await assert.rejects(
      () => persistCycleAnalytics(config, record),
      (err) => {
        assert.ok(err instanceof Error, "must throw an Error");
        return true;
      }
    );
    await fs.rm(tmpBase, { recursive: true, force: true });
  });

  it("phase enum is preserved for FAILED cycle", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { phase: CYCLE_PHASE.FAILED });
    assert.equal(record.phase, CYCLE_PHASE.FAILED);
    assert.equal(record.outcomes.status, CYCLE_OUTCOME_STATUS.FAILED);
  });

  it("null workerResults adds missingData entries for tasksCompleted and tasksFailed", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { workerResults: null });
    const fields = record.missingData.map((m: any) => m.field);
    assert.ok(fields.includes("outcomes.tasksCompleted"), "missingData must include outcomes.tasksCompleted");
    assert.ok(fields.includes("outcomes.tasksFailed"),    "missingData must include outcomes.tasksFailed");
  });

  it("UNKNOWN outcome status produces explicit missingData entry with unknownReason", () => {
    const config = makeConfig("state");
    // workerResults: null with COMPLETED phase → UNKNOWN status
    const record = computeCycleAnalytics(config, { workerResults: null, phase: CYCLE_PHASE.COMPLETED });
    assert.equal(record.outcomes.status, CYCLE_OUTCOME_STATUS.UNKNOWN);
    const entry = record.missingData.find((m: any) => m.field === "outcomes.status");
    assert.ok(entry, "missingData must include an entry for outcomes.status when UNKNOWN");
    assert.equal(entry.reason, MISSING_DATA_REASON.MISSING_SOURCE);
    assert.equal(entry.impact, MISSING_DATA_IMPACT.OUTCOME);
    assert.ok(typeof entry.unknownReason === "string" && entry.unknownReason.length > 0,
      "unknownReason must be a non-empty string explaining why status is UNKNOWN");
  });

  it("UNKNOWN outcome status from empty workerResults array also sets unknownReason (negative path)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, { workerResults: [], phase: CYCLE_PHASE.COMPLETED });
    assert.equal(record.outcomes.status, CYCLE_OUTCOME_STATUS.UNKNOWN);
    const entry = record.missingData.find((m: any) => m.field === "outcomes.status");
    assert.ok(entry, "missingData must include outcomes.status entry for empty workerResults");
    assert.ok(typeof entry.unknownReason === "string" && entry.unknownReason.length > 0);
  });
});

// ── Funnel counts and ratios ───────────────────────────────────────────────────

describe("computeCycleAnalytics — funnel (Task 1)", () => {
  it("schema requires funnel field", () => {
    assert.ok(CYCLE_ANALYTICS_SCHEMA.cycleRecord.required.includes("funnel"),
      "schema.cycleRecord.required must list 'funnel'");
  });

  it("funnel field is present on every record regardless of funnelCounts input", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {});
    assert.ok("funnel" in record, "funnel must be present");
  });

  it("funnel contains all six expected keys", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      funnelCounts: { generated: 10, approved: 8, dispatched: 7, completed: 5 },
    });
    for (const k of ["generated", "approved", "dispatched", "completed", "approvalRate", "dispatchRate", "completionRate"]) {
      assert.ok(k in record.funnel, `funnel missing key: ${k}`);
    }
  });

  it("funnel stores provided counts verbatim", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      funnelCounts: { generated: 10, approved: 8, dispatched: 6, completed: 4 },
    });
    assert.equal(record.funnel.generated,  10);
    assert.equal(record.funnel.approved,    8);
    assert.equal(record.funnel.dispatched,  6);
    assert.equal(record.funnel.completed,   4);
  });

  it("funnel computes approvalRate = approved / generated", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      funnelCounts: { generated: 10, approved: 8, dispatched: 8, completed: 8 },
    });
    assert.equal(record.funnel.approvalRate, 0.8);
  });

  it("funnel computes dispatchRate = dispatched / approved", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      funnelCounts: { generated: 10, approved: 8, dispatched: 4, completed: 4 },
    });
    assert.equal(record.funnel.dispatchRate, 0.5);
  });

  it("funnel computes completionRate = completed / dispatched", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      funnelCounts: { generated: 10, approved: 10, dispatched: 10, completed: 3 },
    });
    assert.equal(record.funnel.completionRate, 0.3);
  });

  it("funnel rates are null when denominator stage is absent (no silent zero-fill)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      funnelCounts: { generated: null, approved: null, dispatched: null, completed: null },
    });
    assert.equal(record.funnel.approvalRate,   null, "approvalRate must be null when generated is null");
    assert.equal(record.funnel.dispatchRate,   null, "dispatchRate must be null when approved is null");
    assert.equal(record.funnel.completionRate, null, "completionRate must be null when dispatched is null");
  });

  it("funnel rates are null when funnelCounts is absent", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {});
    assert.equal(record.funnel.generated,      null);
    assert.equal(record.funnel.approvalRate,   null);
    assert.equal(record.funnel.dispatchRate,   null);
    assert.equal(record.funnel.completionRate, null);
  });

  it("funnel rate is null when denominator is zero (no division by zero)", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      funnelCounts: { generated: 0, approved: 0, dispatched: 0, completed: 0 },
    });
    assert.equal(record.funnel.approvalRate,   null, "approvalRate must be null when generated=0");
    assert.equal(record.funnel.dispatchRate,   null, "dispatchRate must be null when approved=0");
    assert.equal(record.funnel.completionRate, null, "completionRate must be null when dispatched=0");
  });

  it("100% funnel (all plans complete) produces ratios of 1", () => {
    const config = makeConfig("state");
    const record = computeCycleAnalytics(config, {
      funnelCounts: { generated: 5, approved: 5, dispatched: 5, completed: 5 },
    });
    assert.equal(record.funnel.approvalRate,   1);
    assert.equal(record.funnel.dispatchRate,   1);
    assert.equal(record.funnel.completionRate, 1);
  });
});
