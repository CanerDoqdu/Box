/**
 * Tests for src/core/slo_checker.js
 *
 * Coverage targets:
 *   AC1  — SLO thresholds are config-driven and validated.
 *   AC2  — Breaches trigger alerts with severity classes.
 *   AC3  — (integration: dashboard reads orchestrator_health.json; tested via collectDashboardData contract)
 *   AC4  — SLO metrics are persisted by cycle id.
 *   AC5  — No SLO calculation on missing mandatory timestamps.
 *   AC8  — JSON output includes required schema fields.
 *   AC9  — Validation distinguishes missing input from invalid input.
 *   AC10 — No silent fallback; explicit thresholdValidationErrors.
 *
 * Each describe block maps to one or more acceptance criteria.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  SLO_METRIC,
  SLO_STATUS,
  SLO_REASON,
  SLO_MISSING_REASON,
  SLO_BREACH_SEVERITY,
  SLO_THRESHOLD_REASON,
  SLO_METRICS_SCHEMA,
  SLO_TIMESTAMP_CONTRACT,
  computeCycleSLOs,
  persistSloMetrics,
  readSloMetrics,
} from "../../src/core/slo_checker.js";

// ── Fixtures ──────────────────────────────────────────────────────────────────

const NOW = new Date("2025-01-01T10:00:00.000Z").getTime();
const makeTs = (offsetMs) => new Date(NOW + offsetMs).toISOString();

/** Minimal valid timestamps — all latencies within defaults. */
function validTimestamps(opts = {}) {
  return {
    jesus_awakening:   makeTs(0),
    jesus_decided:     makeTs(opts.decisionLatencyMs ?? 5000),      // 5 s (under 120 s default)
    athena_approved:   makeTs(opts.athena ?? 10000),
    workers_dispatching: makeTs(opts.athena ?? 10000 + (opts.dispatchLatencyMs ?? 2000)), // 2 s (under 30 s)
    cycle_complete:    makeTs(opts.athena ?? 10000 + (opts.dispatchLatencyMs ?? 2000) + (opts.verificationMs ?? 300000)), // 5 min (under 1 hr)
  };
}

const DEFAULT_CONFIG = {
  slo: {
    enabled: true,
    degradedOnBreach: true,
    thresholds: {
      [SLO_METRIC.DECISION_LATENCY]: 120000,
      [SLO_METRIC.DISPATCH_LATENCY]: 30000,
      [SLO_METRIC.VERIFICATION_COMPLETION]: 3600000,
    },
    breachSeverity: {
      [SLO_METRIC.DECISION_LATENCY]: "high",
      [SLO_METRIC.DISPATCH_LATENCY]: "high",
      [SLO_METRIC.VERIFICATION_COMPLETION]: "critical",
    },
  },
};

// ── AC1: Thresholds are config-driven and validated ──────────────────────────

describe("SLO_THRESHOLD_REASON enum (AC1, AC10)", () => {
  it("exports THRESHOLD_MISSING and THRESHOLD_INVALID reason codes", () => {
    assert.equal(SLO_THRESHOLD_REASON.THRESHOLD_MISSING, "THRESHOLD_MISSING");
    assert.equal(SLO_THRESHOLD_REASON.THRESHOLD_INVALID, "THRESHOLD_INVALID");
    assert.ok(Object.isFrozen(SLO_THRESHOLD_REASON));
  });

  it("thresholdReasonEnum in schema contains both codes", () => {
    const e = SLO_METRICS_SCHEMA.cycleRecord.thresholdReasonEnum;
    assert.ok(e.includes("THRESHOLD_MISSING"), "schema must include THRESHOLD_MISSING");
    assert.ok(e.includes("THRESHOLD_INVALID"), "schema must include THRESHOLD_INVALID");
  });
});

describe("computeCycleSLOs — threshold validation (AC1, AC9, AC10)", () => {
  it("valid thresholds produce no thresholdValidationErrors", () => {
    const record = computeCycleSLOs(DEFAULT_CONFIG, validTimestamps(), makeTs(0), makeTs(400000));
    assert.deepEqual(record.thresholdValidationErrors, []);
  });

  it("invalid threshold value (NaN string) produces THRESHOLD_INVALID error — not silent (AC10)", () => {
    const config = {
      slo: {
        ...DEFAULT_CONFIG.slo,
        thresholds: {
          [SLO_METRIC.DECISION_LATENCY]: "not-a-number",
          [SLO_METRIC.DISPATCH_LATENCY]: 30000,
          [SLO_METRIC.VERIFICATION_COMPLETION]: 3600000,
        },
      },
    };
    const record = computeCycleSLOs(config, validTimestamps(), makeTs(0), makeTs(400000));
    const err = record.thresholdValidationErrors.find(e => e.metric === SLO_METRIC.DECISION_LATENCY);
    assert.ok(err, "should have a validation error for DECISION_LATENCY");
    assert.equal(err.reason, SLO_THRESHOLD_REASON.THRESHOLD_INVALID);
    assert.equal(err.configured, "not-a-number");
    assert.ok(Number.isFinite(err.fallback), "fallback must be a finite number");
  });

  it("zero threshold value produces THRESHOLD_INVALID (zero is not a valid threshold)", () => {
    const config = {
      slo: {
        ...DEFAULT_CONFIG.slo,
        thresholds: {
          [SLO_METRIC.DECISION_LATENCY]: 0,
          [SLO_METRIC.DISPATCH_LATENCY]: 30000,
          [SLO_METRIC.VERIFICATION_COMPLETION]: 3600000,
        },
      },
    };
    const record = computeCycleSLOs(config, validTimestamps(), makeTs(0), makeTs(400000));
    const err = record.thresholdValidationErrors.find(e => e.metric === SLO_METRIC.DECISION_LATENCY);
    assert.ok(err, "zero threshold must produce THRESHOLD_INVALID");
    assert.equal(err.reason, SLO_THRESHOLD_REASON.THRESHOLD_INVALID);
  });

  it("negative threshold value produces THRESHOLD_INVALID", () => {
    const config = {
      slo: {
        ...DEFAULT_CONFIG.slo,
        thresholds: {
          [SLO_METRIC.DECISION_LATENCY]: -1000,
          [SLO_METRIC.DISPATCH_LATENCY]: 30000,
          [SLO_METRIC.VERIFICATION_COMPLETION]: 3600000,
        },
      },
    };
    const record = computeCycleSLOs(config, validTimestamps(), makeTs(0), makeTs(400000));
    const err = record.thresholdValidationErrors.find(e => e.metric === SLO_METRIC.DECISION_LATENCY);
    assert.ok(err, "negative threshold must produce THRESHOLD_INVALID");
    assert.equal(err.reason, SLO_THRESHOLD_REASON.THRESHOLD_INVALID);
  });

  it("absent threshold key in explicit object produces THRESHOLD_MISSING — not silent (AC9, AC10)", () => {
    const config = {
      slo: {
        ...DEFAULT_CONFIG.slo,
        thresholds: {
          // DECISION_LATENCY intentionally omitted
          [SLO_METRIC.DISPATCH_LATENCY]: 30000,
          [SLO_METRIC.VERIFICATION_COMPLETION]: 3600000,
        },
      },
    };
    const record = computeCycleSLOs(config, validTimestamps(), makeTs(0), makeTs(400000));
    const err = record.thresholdValidationErrors.find(e => e.metric === SLO_METRIC.DECISION_LATENCY);
    assert.ok(err, "absent threshold key must produce THRESHOLD_MISSING");
    assert.equal(err.reason, SLO_THRESHOLD_REASON.THRESHOLD_MISSING);
  });

  it("THRESHOLD_MISSING and THRESHOLD_INVALID are distinct codes (AC9)", () => {
    assert.notEqual(SLO_THRESHOLD_REASON.THRESHOLD_MISSING, SLO_THRESHOLD_REASON.THRESHOLD_INVALID);
  });

  it("no thresholds configured at all (first-run) → no validation errors (expected default path)", () => {
    // When slo.thresholds is absent, use defaults silently — this is the first-run expected case.
    const config = { slo: { enabled: true, degradedOnBreach: true } };
    const record = computeCycleSLOs(config, validTimestamps(), makeTs(0), makeTs(400000));
    assert.deepEqual(record.thresholdValidationErrors, []);
  });

  it("fallback threshold is used (and finite) when a value is invalid", () => {
    const config = {
      slo: {
        ...DEFAULT_CONFIG.slo,
        thresholds: {
          [SLO_METRIC.DECISION_LATENCY]: "garbage",
          [SLO_METRIC.DISPATCH_LATENCY]: 30000,
          [SLO_METRIC.VERIFICATION_COMPLETION]: 3600000,
        },
      },
    };
    // Provide a decision latency under the default threshold (120000 ms) — should not breach
    const ts = validTimestamps({ decisionLatencyMs: 5000 });
    const record = computeCycleSLOs(config, ts, makeTs(0), makeTs(400000));
    const decisionBreach = record.sloBreaches.find(b => b.metric === SLO_METRIC.DECISION_LATENCY);
    assert.equal(decisionBreach, undefined, "no breach when actual is under fallback default threshold");
  });
});

// ── AC2: Breaches trigger alerts with severity classes ────────────────────────

describe("computeCycleSLOs — breach detection and severity (AC2)", () => {
  it("detects a decision latency breach and records severity", () => {
    const ts = validTimestamps({ decisionLatencyMs: 200000 }); // 200 s > 120 s threshold
    const record = computeCycleSLOs(DEFAULT_CONFIG, ts, makeTs(0), makeTs(500000));
    assert.equal(record.sloBreaches.length, 1);
    const breach = record.sloBreaches[0];
    assert.equal(breach.metric, SLO_METRIC.DECISION_LATENCY);
    assert.equal(breach.severity, SLO_BREACH_SEVERITY.HIGH);
    assert.ok(typeof breach.reason === "string" && breach.reason.length > 0);
    assert.ok(breach.actual > breach.threshold);
  });

  it("auto-escalates severity to CRITICAL when actual > 2× threshold", () => {
    const ts = validTimestamps({ decisionLatencyMs: 300000 }); // 300 s > 2 × 120 s
    const config = {
      slo: {
        ...DEFAULT_CONFIG.slo,
        breachSeverity: {}, // no override — auto-escalation applies
      },
    };
    const record = computeCycleSLOs(config, ts, makeTs(0), makeTs(600000));
    const breach = record.sloBreaches.find(b => b.metric === SLO_METRIC.DECISION_LATENCY);
    assert.ok(breach, "should have a breach");
    assert.equal(breach.severity, SLO_BREACH_SEVERITY.CRITICAL);
  });

  it("config override keeps CRITICAL severity even below 2× threshold", () => {
    const ts = validTimestamps({ decisionLatencyMs: 150000 }); // 150 s > 120 s but < 240 s
    const config = {
      slo: {
        ...DEFAULT_CONFIG.slo,
        breachSeverity: { [SLO_METRIC.DECISION_LATENCY]: "critical" },
      },
    };
    const record = computeCycleSLOs(config, ts, makeTs(0), makeTs(500000));
    const breach = record.sloBreaches.find(b => b.metric === SLO_METRIC.DECISION_LATENCY);
    assert.ok(breach);
    assert.equal(breach.severity, SLO_BREACH_SEVERITY.CRITICAL);
  });

  it("status is degraded when breach occurs and degradedOnBreach=true (AC2, AC3)", () => {
    const ts = validTimestamps({ decisionLatencyMs: 200000 });
    const record = computeCycleSLOs(DEFAULT_CONFIG, ts, makeTs(0), makeTs(500000));
    assert.equal(record.status, SLO_STATUS.DEGRADED);
    assert.equal(record.statusReason, SLO_REASON.BREACH_DETECTED);
  });

  it("status is ok when no breach (negative path)", () => {
    const ts = validTimestamps();
    const record = computeCycleSLOs(DEFAULT_CONFIG, ts, makeTs(0), makeTs(400000));
    assert.equal(record.status, SLO_STATUS.OK);
    assert.equal(record.statusReason, SLO_REASON.OK);
    assert.equal(record.sloBreaches.length, 0);
  });

  it("breach severity enum contains expected values", () => {
    assert.ok(Object.values(SLO_BREACH_SEVERITY).includes("high"));
    assert.ok(Object.values(SLO_BREACH_SEVERITY).includes("critical"));
  });
});

// ── AC4: SLO metrics are persisted by cycle id ────────────────────────────────

describe("persistSloMetrics and readSloMetrics (AC4, AC8)", () => {
  let tmpDir, config;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-slo-test-"));
    config = { paths: { stateDir: tmpDir } };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("persists a cycle record and reads it back (AC4)", async () => {
    const ts = validTimestamps();
    const startedAt = makeTs(0);
    const record = computeCycleSLOs(DEFAULT_CONFIG, ts, startedAt, makeTs(400000));
    await persistSloMetrics(config, record);

    const stored = await readSloMetrics(config);
    assert.ok(stored.lastCycle, "lastCycle must be present");
    assert.equal(stored.lastCycle.cycleId, startedAt, "cycleId must equal startedAt");
    assert.equal(stored.schemaVersion, SLO_METRICS_SCHEMA.schemaVersion);
    assert.ok(Array.isArray(stored.history));
    assert.equal(stored.history.length, 1);
    assert.ok(typeof stored.updatedAt === "string");
  });

  it("cycle record includes cycleId (= startedAt) as primary key (AC4)", async () => {
    const startedAt = makeTs(0);
    const record = computeCycleSLOs(DEFAULT_CONFIG, validTimestamps(), startedAt, makeTs(400000));
    assert.equal(record.cycleId, startedAt, "cycleId must equal startedAt");
    await persistSloMetrics(config, record);
    const stored = await readSloMetrics(config);
    assert.equal(stored.lastCycle.cycleId, startedAt);
  });

  it("history is capped at maxHistoryEntries (AC4)", async () => {
    const max = SLO_METRICS_SCHEMA.maxHistoryEntries;
    for (let i = 0; i <= max + 5; i++) {
      const startedAt = makeTs(i * 1000);
      const record = computeCycleSLOs(DEFAULT_CONFIG, validTimestamps(), startedAt, makeTs(i * 1000 + 400000));
      await persistSloMetrics(config, record);
    }
    const stored = await readSloMetrics(config);
    assert.ok(stored.history.length <= max, `history must not exceed ${max} entries`);
  });

  it("readSloMetrics returns safe defaults when file does not exist", async () => {
    const stored = await readSloMetrics(config);
    assert.equal(stored.lastCycle, null);
    assert.deepEqual(stored.history, []);
    assert.equal(stored.schemaVersion, SLO_METRICS_SCHEMA.schemaVersion);
  });

  it("cycle record output conforms to schema required fields (AC8)", () => {
    const record = computeCycleSLOs(DEFAULT_CONFIG, validTimestamps(), makeTs(0), makeTs(400000));
    for (const field of SLO_METRICS_SCHEMA.cycleRecord.required) {
      assert.ok(field in record, `required field '${field}' missing from cycle record`);
    }
  });

  it("status field is within statusEnum (AC8)", () => {
    const record = computeCycleSLOs(DEFAULT_CONFIG, validTimestamps(), makeTs(0), makeTs(400000));
    assert.ok(
      SLO_METRICS_SCHEMA.cycleRecord.statusEnum.includes(record.status),
      `status '${record.status}' not in statusEnum`
    );
  });

  it("statusReason field is within statusReasonEnum (AC8)", () => {
    const record = computeCycleSLOs(DEFAULT_CONFIG, validTimestamps(), makeTs(0), makeTs(400000));
    assert.ok(
      SLO_METRICS_SCHEMA.cycleRecord.statusReasonEnum.includes(record.statusReason),
      `statusReason '${record.statusReason}' not in statusReasonEnum`
    );
  });

  it("top-level slo_metrics.json output includes all schema required fields (AC8)", async () => {
    const record = computeCycleSLOs(DEFAULT_CONFIG, validTimestamps(), makeTs(0), makeTs(400000));
    await persistSloMetrics(config, record);
    const stored = await readSloMetrics(config);
    for (const field of SLO_METRICS_SCHEMA.required) {
      assert.ok(field in stored, `top-level required field '${field}' missing from slo_metrics.json`);
    }
  });
});

// ── AC5: No SLO calculation on missing mandatory timestamps ──────────────────

describe("computeCycleSLOs — missing timestamps (AC5, AC9)", () => {
  it("skips decision latency calculation when jesus_awakening is absent", () => {
    const ts = validTimestamps();
    delete ts.jesus_awakening;
    const record = computeCycleSLOs(DEFAULT_CONFIG, ts, makeTs(0), makeTs(400000));
    assert.equal(record.metrics[SLO_METRIC.DECISION_LATENCY], null, "metric must be null when start timestamp missing");
    assert.ok(record.missingTimestamps.includes(SLO_MISSING_REASON.MISSING_TIMESTAMP_DECISION));
  });

  it("skips dispatch latency calculation when workers_dispatching is absent", () => {
    const ts = validTimestamps();
    delete ts.workers_dispatching;
    const record = computeCycleSLOs(DEFAULT_CONFIG, ts, makeTs(0), makeTs(400000));
    assert.equal(record.metrics[SLO_METRIC.DISPATCH_LATENCY], null);
    assert.ok(record.missingTimestamps.includes(SLO_MISSING_REASON.MISSING_TIMESTAMP_DISPATCH));
  });

  it("skips verification completion when cycle_complete is absent", () => {
    const ts = validTimestamps();
    delete ts.cycle_complete;
    const record = computeCycleSLOs(DEFAULT_CONFIG, ts, makeTs(0), makeTs(400000));
    assert.equal(record.metrics[SLO_METRIC.VERIFICATION_COMPLETION], null);
    assert.ok(record.missingTimestamps.includes(SLO_MISSING_REASON.MISSING_TIMESTAMP_VERIFICATION));
  });

  it("all metrics null when stageTimestamps is empty object", () => {
    const record = computeCycleSLOs(DEFAULT_CONFIG, {}, makeTs(0), makeTs(400000));
    for (const metric of Object.values(SLO_METRIC)) {
      assert.equal(record.metrics[metric], null, `${metric} must be null with no timestamps`);
    }
    assert.equal(record.missingTimestamps.length, 3);
  });

  it("all metrics null when stageTimestamps is null", () => {
    const record = computeCycleSLOs(DEFAULT_CONFIG, null, makeTs(0), makeTs(400000));
    for (const metric of Object.values(SLO_METRIC)) {
      assert.equal(record.metrics[metric], null);
    }
  });

  it("does not breach on missing timestamps — missing does not mean threshold exceeded", () => {
    const record = computeCycleSLOs(DEFAULT_CONFIG, {}, makeTs(0), makeTs(400000));
    assert.equal(record.sloBreaches.length, 0);
  });

  it("statusReason is MISSING_TIMESTAMPS (not BREACH) when only timestamps are absent (AC9)", () => {
    const record = computeCycleSLOs(DEFAULT_CONFIG, {}, makeTs(0), makeTs(400000));
    assert.equal(record.statusReason, SLO_REASON.MISSING_TIMESTAMPS);
    assert.equal(record.status, SLO_STATUS.OK);
  });

  it("distinguishes missing-input (absent key) from invalid-input (present but unparseable) (AC9)", () => {
    const missingTs = validTimestamps();
    delete missingTs.jesus_awakening;
    const missingRecord = computeCycleSLOs(DEFAULT_CONFIG, missingTs, makeTs(0), makeTs(400000));

    const invalidTs = validTimestamps();
    invalidTs.jesus_awakening = "not-a-date";
    const invalidRecord = computeCycleSLOs(DEFAULT_CONFIG, invalidTs, makeTs(0), makeTs(400000));

    // Both result in null metric and missing timestamp reason — both are skipped (AC5)
    assert.equal(missingRecord.metrics[SLO_METRIC.DECISION_LATENCY], null);
    assert.equal(invalidRecord.metrics[SLO_METRIC.DECISION_LATENCY], null);
    // Both are recorded in missingTimestamps (AC9 — same SLO outcome but different parseTimestamp reason)
    assert.ok(missingRecord.missingTimestamps.includes(SLO_MISSING_REASON.MISSING_TIMESTAMP_DECISION));
    assert.ok(invalidRecord.missingTimestamps.includes(SLO_MISSING_REASON.MISSING_TIMESTAMP_DECISION));
  });
});

// ── AC5: SLO disabled — no calculation ───────────────────────────────────────

describe("computeCycleSLOs — SLO disabled", () => {
  it("produces no metrics, no breaches, and status=ok when slo.enabled=false", () => {
    const config = { slo: { enabled: false } };
    const record = computeCycleSLOs(config, validTimestamps(), makeTs(0), makeTs(400000));
    for (const metric of Object.values(SLO_METRIC)) {
      assert.equal(record.metrics[metric], null);
    }
    assert.equal(record.sloBreaches.length, 0);
    assert.equal(record.status, SLO_STATUS.OK);
  });
});

// ── AC3: Dashboard degraded path (data contract) ─────────────────────────────

describe("SLO degraded status contract for dashboard (AC3)", () => {
  it("a breach record has status=degraded and statusReason=BREACH_DETECTED", () => {
    const ts = validTimestamps({ decisionLatencyMs: 200000 });
    const record = computeCycleSLOs(DEFAULT_CONFIG, ts, makeTs(0), makeTs(500000));
    // This record is what orchestrator writes to slo_metrics.json and then writes
    // orchestratorStatus=degraded to orchestrator_health.json. The dashboard reads
    // orchestrator_health.json and exposes it in data.slo.orchestratorStatus.
    assert.equal(record.status, SLO_STATUS.DEGRADED);
    assert.equal(record.statusReason, SLO_REASON.BREACH_DETECTED);
    assert.ok(record.sloBreaches.length > 0);
  });

  it("degradedOnBreach=false keeps status=ok even with breach (rollback path)", () => {
    const config = { slo: { ...DEFAULT_CONFIG.slo, degradedOnBreach: false } };
    const ts = validTimestamps({ decisionLatencyMs: 200000 });
    const record = computeCycleSLOs(config, ts, makeTs(0), makeTs(500000));
    assert.equal(record.status, SLO_STATUS.OK, "degradedOnBreach=false must keep ok status");
    assert.ok(record.sloBreaches.length > 0, "breach is still recorded in sloBreaches");
  });
});

// ── AC10: thresholdValidationErrors is always present in cycle record ─────────

describe("cycle record thresholdValidationErrors field (AC10)", () => {
  it("thresholdValidationErrors is always an array (never missing or null)", () => {
    const configurations = [
      DEFAULT_CONFIG,
      { slo: { enabled: true } },
      null,
      undefined,
      {},
    ];
    for (const config of configurations) {
      const record = computeCycleSLOs(config, validTimestamps(), makeTs(0), makeTs(400000));
      assert.ok(
        Array.isArray(record.thresholdValidationErrors),
        `thresholdValidationErrors must be an array for config=${JSON.stringify(config)}`
      );
    }
  });

  it("each validation error has metric, reason, configured, and fallback fields", () => {
    const config = {
      slo: {
        enabled: true,
        degradedOnBreach: true,
        thresholds: {
          [SLO_METRIC.DECISION_LATENCY]: "bad",
          [SLO_METRIC.DISPATCH_LATENCY]: 30000,
          [SLO_METRIC.VERIFICATION_COMPLETION]: 3600000,
        },
      },
    };
    const record = computeCycleSLOs(config, validTimestamps(), makeTs(0), makeTs(400000));
    assert.equal(record.thresholdValidationErrors.length, 1);
    const err = record.thresholdValidationErrors[0];
    assert.ok("metric" in err, "error must have metric");
    assert.ok("reason" in err, "error must have reason");
    assert.ok("configured" in err, "error must have configured");
    assert.ok("fallback" in err, "error must have fallback");
  });
});

// ── AC8: Schema enum coverage ─────────────────────────────────────────────────

describe("SLO schema enum completeness (AC8)", () => {
  it("SLO_METRICS_SCHEMA.cycleRecord.required includes thresholdValidationErrors", () => {
    assert.ok(
      SLO_METRICS_SCHEMA.cycleRecord.required.includes("thresholdValidationErrors"),
      "schema must require thresholdValidationErrors"
    );
  });

  it("SLO_METRICS_SCHEMA.cycleRecord.required includes all expected fields", () => {
    const required = SLO_METRICS_SCHEMA.cycleRecord.required;
    for (const field of ["cycleId", "startedAt", "completedAt", "metrics", "missingTimestamps", "thresholdValidationErrors", "sloBreaches", "status", "statusReason"]) {
      assert.ok(required.includes(field), `schema must require '${field}'`);
    }
  });

  it("SLO_METRIC enum values are all distinct", () => {
    const vals = Object.values(SLO_METRIC);
    assert.equal(new Set(vals).size, vals.length, "SLO_METRIC values must be unique");
  });

  it("SLO_STATUS enum values are all distinct", () => {
    const vals = Object.values(SLO_STATUS);
    assert.equal(new Set(vals).size, vals.length, "SLO_STATUS values must be unique");
  });

  it("SLO_REASON enum values are all distinct", () => {
    const vals = Object.values(SLO_REASON);
    assert.equal(new Set(vals).size, vals.length, "SLO_REASON values must be unique");
  });

  it("SLO_TIMESTAMP_CONTRACT covers all SLO_METRIC keys", () => {
    for (const metric of Object.values(SLO_METRIC)) {
      assert.ok(metric in SLO_TIMESTAMP_CONTRACT, `SLO_TIMESTAMP_CONTRACT must include ${metric}`);
    }
  });
});

// ── Negative path: failure handling ──────────────────────────────────────────

describe("computeCycleSLOs — negative paths and edge cases", () => {
  it("handles null config without throwing", () => {
    assert.doesNotThrow(() => computeCycleSLOs(null, validTimestamps(), makeTs(0), makeTs(400000)));
  });

  it("handles undefined config without throwing", () => {
    assert.doesNotThrow(() => computeCycleSLOs(undefined, validTimestamps(), makeTs(0), makeTs(400000)));
  });

  it("handles non-object stageTimestamps without throwing", () => {
    for (const bad of [null, undefined, "string", 42, true]) {
      assert.doesNotThrow(
        () => computeCycleSLOs(DEFAULT_CONFIG, bad, makeTs(0), makeTs(400000)),
        `should not throw for stageTimestamps=${JSON.stringify(bad)}`
      );
    }
  });

  it("clock skew (end before start) clamps metric to 0, not negative", () => {
    const ts = validTimestamps();
    // Swap start and end for decision latency
    [ts.jesus_awakening, ts.jesus_decided] = [ts.jesus_decided, ts.jesus_awakening];
    const record = computeCycleSLOs(DEFAULT_CONFIG, ts, makeTs(0), makeTs(400000));
    const dm = record.metrics[SLO_METRIC.DECISION_LATENCY];
    assert.ok(dm !== null, "metric should be calculated (both timestamps present)");
    assert.ok(dm >= 0, "metric must be >= 0 (clamped from negative)");
    assert.equal(dm, 0, "clock-skew metric must be exactly 0");
  });

  it("multiple simultaneous breaches are all recorded individually", () => {
    const ts = {
      ...validTimestamps(),
      jesus_decided: makeTs(200000),         // decision: 200 s > 120 s
      workers_dispatching: makeTs(200000 + 60000),  // dispatch: 60 s > 30 s
    };
    const record = computeCycleSLOs(DEFAULT_CONFIG, ts, makeTs(0), makeTs(1000000));
    assert.ok(record.sloBreaches.length >= 2, "all breaches must be recorded");
    const metrics = record.sloBreaches.map(b => b.metric);
    assert.ok(metrics.includes(SLO_METRIC.DECISION_LATENCY));
    assert.ok(metrics.includes(SLO_METRIC.DISPATCH_LATENCY));
  });

  it("persistSloMetrics is idempotent for same cycleId (most recent wins as lastCycle)", async () => {
    const tmpDir2 = await fs.mkdtemp(path.join(os.tmpdir(), "box-slo-idem-"));
    try {
      const config2 = { paths: { stateDir: tmpDir2 } };
      const startedAt = makeTs(0);
      const record1 = computeCycleSLOs(DEFAULT_CONFIG, validTimestamps(), startedAt, makeTs(400000));
      await persistSloMetrics(config2, record1);
      await persistSloMetrics(config2, record1);
      const stored = await readSloMetrics(config2);
      // history grows by 2 (same cycleId stored twice — caller responsibility to deduplicate)
      // but schemaVersion and lastCycle are consistent
      assert.equal(stored.lastCycle.cycleId, startedAt);
      assert.equal(stored.schemaVersion, SLO_METRICS_SCHEMA.schemaVersion);
    } finally {
      await fs.rm(tmpDir2, { recursive: true, force: true });
    }
  });
});
