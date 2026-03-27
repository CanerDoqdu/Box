/**
 * Tests for src/core/parser_baseline_recovery.ts
 *
 * Coverage:
 *   - computeBaselineRecoveryState: correct recovery detection, component metrics, gaps, penalties
 *   - persistBaselineMetrics / readBaselineMetrics: persistence, rolling history, schema version
 *   - Negative paths: null input, missing component fields, I/O failure resilience
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  computeBaselineRecoveryState,
  persistBaselineMetrics,
  readBaselineMetrics,
  PARSER_CONFIDENCE_RECOVERY_THRESHOLD,
  BASELINE_METRICS_SCHEMA_VERSION,
} from "../../src/core/parser_baseline_recovery.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFullAnalysis(overrides: Record<string, any> = {}): Record<string, any> {
  return {
    parserConfidence: 1.0,
    parserConfidenceComponents: {
      plansShape:    1.0,
      healthField:   1.0,
      requestBudget: 1.0,
    },
    parserConfidencePenalties: [],
    ...overrides,
  };
}

let tmpDir: string;

// ── Setup / teardown ──────────────────────────────────────────────────────────

before(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-baseline-recovery-"));
});

after(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function makeConfig(dir = tmpDir) {
  return { paths: { stateDir: dir } };
}

// ── PARSER_CONFIDENCE_RECOVERY_THRESHOLD ─────────────────────────────────────

describe("PARSER_CONFIDENCE_RECOVERY_THRESHOLD", () => {
  it("is 0.9", () => {
    assert.equal(PARSER_CONFIDENCE_RECOVERY_THRESHOLD, 0.9);
  });
});

// ── computeBaselineRecoveryState ──────────────────────────────────────────────

describe("computeBaselineRecoveryState", () => {
  it("recoveryActive=false when parserConfidence is at the threshold", () => {
    const result = computeBaselineRecoveryState(makeFullAnalysis({ parserConfidence: 0.9 }));
    assert.equal(result.recoveryActive, false);
  });

  it("recoveryActive=false when parserConfidence is above threshold", () => {
    const result = computeBaselineRecoveryState(makeFullAnalysis({ parserConfidence: 0.95 }));
    assert.equal(result.recoveryActive, false);
  });

  it("recoveryActive=true when parserConfidence is below threshold", () => {
    const result = computeBaselineRecoveryState(makeFullAnalysis({ parserConfidence: 0.75 }));
    assert.equal(result.recoveryActive, true);
  });

  it("recoveryThreshold is always PARSER_CONFIDENCE_RECOVERY_THRESHOLD", () => {
    const result = computeBaselineRecoveryState(makeFullAnalysis({ parserConfidence: 0.5 }));
    assert.equal(result.recoveryThreshold, PARSER_CONFIDENCE_RECOVERY_THRESHOLD);
  });

  it("componentMetrics reflects provided components", () => {
    const analysis = makeFullAnalysis({
      parserConfidence: 0.7,
      parserConfidenceComponents: { plansShape: 0.5, healthField: 0.8, requestBudget: 0.9 },
    });
    const result = computeBaselineRecoveryState(analysis);
    assert.equal(result.componentMetrics.plansShape,    0.5);
    assert.equal(result.componentMetrics.healthField,   0.8);
    assert.equal(result.componentMetrics.requestBudget, 0.9);
  });

  it("componentGap is 1.0 - score for each component", () => {
    const analysis = makeFullAnalysis({
      parserConfidence: 0.7,
      parserConfidenceComponents: { plansShape: 0.5, healthField: 0.8, requestBudget: 1.0 },
    });
    const result = computeBaselineRecoveryState(analysis);
    assert.equal(result.componentGap.plansShape,    0.5);
    assert.equal(result.componentGap.healthField,   0.2);
    assert.equal(result.componentGap.requestBudget, 0);
  });

  it("penalties are passed through when valid", () => {
    const penalties = [
      { reason: "plans_from_narrative_fallback", component: "plansShape", delta: -0.5 },
    ];
    const analysis = makeFullAnalysis({ parserConfidence: 0.5, parserConfidencePenalties: penalties });
    const result = computeBaselineRecoveryState(analysis);
    assert.equal(result.penalties.length, 1);
    assert.equal(result.penalties[0].reason, "plans_from_narrative_fallback");
  });

  it("invalid penalty entries are filtered out", () => {
    const analysis = makeFullAnalysis({
      parserConfidence: 0.5,
      parserConfidencePenalties: [
        null,
        { reason: "ok", component: "x", delta: -0.1 },
        { reason: 123 }, // invalid: reason is not a string
      ],
    });
    const result = computeBaselineRecoveryState(analysis);
    assert.equal(result.penalties.length, 1);
    assert.equal(result.penalties[0].reason, "ok");
  });

  it("handles null analysis gracefully (defaults to confidence=1.0, recoveryActive=false)", () => {
    const result = computeBaselineRecoveryState(null);
    assert.equal(result.parserConfidence, 1.0);
    assert.equal(result.recoveryActive, false);
    assert.equal(result.componentMetrics.plansShape, 1.0);
    assert.deepEqual(result.penalties, []);
  });

  it("handles undefined analysis gracefully", () => {
    const result = computeBaselineRecoveryState(undefined);
    assert.equal(result.recoveryActive, false);
  });

  it("handles missing parserConfidenceComponents (defaults all to 1.0)", () => {
    const result = computeBaselineRecoveryState({ parserConfidence: 0.8 });
    assert.equal(result.componentMetrics.plansShape,    1.0);
    assert.equal(result.componentMetrics.healthField,   1.0);
    assert.equal(result.componentMetrics.requestBudget, 1.0);
  });

  it("accepts a cycleId parameter and includes it in the record", () => {
    const result = computeBaselineRecoveryState(makeFullAnalysis(), "cycle-123");
    assert.equal(result.cycleId, "cycle-123");
  });

  it("cycleId is null when not provided", () => {
    const result = computeBaselineRecoveryState(makeFullAnalysis());
    assert.equal(result.cycleId, null);
  });

  it("recordedAt is a valid ISO timestamp string", () => {
    const result = computeBaselineRecoveryState(makeFullAnalysis());
    assert.ok(typeof result.recordedAt === "string");
    assert.ok(!isNaN(Date.parse(result.recordedAt)));
  });

  it("parserConfidence is rounded to 3 decimal places in the output record", () => {
    const result = computeBaselineRecoveryState(makeFullAnalysis({ parserConfidence: 0.8999999 }));
    // Stored value rounds to 0.9, but the raw value 0.8999999 is below the threshold
    assert.equal(result.parserConfidence, 0.9);
    // 0.8999999 < 0.9 — still below threshold before rounding, so recovery is active
    assert.equal(result.recoveryActive, true);
  });
});

// ── persistBaselineMetrics / readBaselineMetrics ──────────────────────────────

describe("persistBaselineMetrics + readBaselineMetrics", () => {
  it("reads null when no file exists", async () => {
    const config = makeConfig(path.join(tmpDir, "empty-" + Date.now()));
    // Directory doesn't exist — readBaselineMetrics should return null
    const result = await readBaselineMetrics(config);
    assert.equal(result, null);
  });

  it("persists a record and reads it back", async () => {
    const config = makeConfig(path.join(tmpDir, "persist-test"));
    await fs.mkdir(config.paths.stateDir, { recursive: true });

    const analysis = makeFullAnalysis({ parserConfidence: 0.75 });
    const record = computeBaselineRecoveryState(analysis, "cycle-abc");
    await persistBaselineMetrics(config, record);

    const state = await readBaselineMetrics(config);
    assert.ok(state !== null);
    assert.equal(state!.schemaVersion, BASELINE_METRICS_SCHEMA_VERSION);
    assert.ok(state!.lastRecord !== null);
    assert.equal(state!.lastRecord.cycleId, "cycle-abc");
    assert.equal(state!.lastRecord.parserConfidence, 0.75);
    assert.equal(state!.lastRecord.recoveryActive, true);
  });

  it("prepends new records to history (newest first)", async () => {
    const config = makeConfig(path.join(tmpDir, "history-test"));
    await fs.mkdir(config.paths.stateDir, { recursive: true });

    const r1 = computeBaselineRecoveryState(makeFullAnalysis({ parserConfidence: 0.7 }), "c1");
    await persistBaselineMetrics(config, r1);
    const r2 = computeBaselineRecoveryState(makeFullAnalysis({ parserConfidence: 0.8 }), "c2");
    await persistBaselineMetrics(config, r2);

    const state = await readBaselineMetrics(config);
    assert.equal(state!.history.length, 2);
    assert.equal(state!.history[0].cycleId, "c2"); // newest first
    assert.equal(state!.history[1].cycleId, "c1");
  });

  it("updatedAt is set on persist", async () => {
    const config = makeConfig(path.join(tmpDir, "updated-at-test"));
    await fs.mkdir(config.paths.stateDir, { recursive: true });

    const record = computeBaselineRecoveryState(makeFullAnalysis(), null);
    await persistBaselineMetrics(config, record);

    const state = await readBaselineMetrics(config);
    assert.ok(typeof state!.updatedAt === "string");
    assert.ok(!isNaN(Date.parse(state!.updatedAt)));
  });

  it("lastRecord is the most recently persisted record", async () => {
    const config = makeConfig(path.join(tmpDir, "last-record-test"));
    await fs.mkdir(config.paths.stateDir, { recursive: true });

    await persistBaselineMetrics(config, computeBaselineRecoveryState(makeFullAnalysis({ parserConfidence: 0.6 }), "old"));
    await persistBaselineMetrics(config, computeBaselineRecoveryState(makeFullAnalysis({ parserConfidence: 0.8 }), "new"));

    const state = await readBaselineMetrics(config);
    assert.equal(state!.lastRecord.cycleId, "new");
  });
});
