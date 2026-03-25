/**
 * Tests for T-012: Decision Quality Labels on Postmortems.
 *
 * Covers:
 *   AC1:  Every postmortem includes one decision-quality label.
 *   AC2:  Labels map deterministically from measurable outcomes via LABEL_OUTCOME_MAP.
 *   AC3:  getDecisionQualityTrend() returns trendData with shape {timestamp, label, count}.
 *   AC4:  computeWeightedDecisionScore uses explicit weights as signals.
 *   AC5:  Legacy entries (no decisionQualityLabel) default to "inconclusive" (backward-compat).
 *   AC8:  DECISION_QUALITY_LABEL and LABEL_OUTCOME_MAP are frozen enums with defined values.
 *   AC9:  Missing vs invalid input produce distinct reason codes.
 *   AC10: No silent fallback — degraded state carries explicit status and reason fields.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import {
  DECISION_QUALITY_LABEL,
  DECISION_QUALITY_REASON,
  LABEL_OUTCOME_MAP,
  computeDecisionQualityLabel,
  normalizeDecisionQualityLabel
} from "../../src/core/athena_reviewer.js";

import {
  DECISION_QUALITY_WEIGHTS,
  computeWeightedDecisionScore
} from "../../src/core/self_improvement.js";

import { getDecisionQualityTrend } from "../../src/dashboard/live_dashboard.ts";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

// ── DECISION_QUALITY_LABEL enum ───────────────────────────────────────────────

describe("DECISION_QUALITY_LABEL enum", () => {
  it("exports four frozen label constants", () => {
    assert.equal(DECISION_QUALITY_LABEL.CORRECT, "correct");
    assert.equal(DECISION_QUALITY_LABEL.DELAYED_CORRECT, "delayed-correct");
    assert.equal(DECISION_QUALITY_LABEL.INCORRECT, "incorrect");
    assert.equal(DECISION_QUALITY_LABEL.INCONCLUSIVE, "inconclusive");
    assert.ok(Object.isFrozen(DECISION_QUALITY_LABEL), "DECISION_QUALITY_LABEL must be frozen");
  });
});

// ── LABEL_OUTCOME_MAP ─────────────────────────────────────────────────────────

describe("LABEL_OUTCOME_MAP", () => {
  it("maps merged → correct", () => {
    assert.equal(LABEL_OUTCOME_MAP.merged, DECISION_QUALITY_LABEL.CORRECT);
  });

  it("maps reopen → delayed-correct", () => {
    assert.equal(LABEL_OUTCOME_MAP.reopen, DECISION_QUALITY_LABEL.DELAYED_CORRECT);
  });

  it("maps rollback → incorrect", () => {
    assert.equal(LABEL_OUTCOME_MAP.rollback, DECISION_QUALITY_LABEL.INCORRECT);
  });

  it("maps timeout → inconclusive", () => {
    assert.equal(LABEL_OUTCOME_MAP.timeout, DECISION_QUALITY_LABEL.INCONCLUSIVE);
  });

  it("is frozen", () => {
    assert.ok(Object.isFrozen(LABEL_OUTCOME_MAP), "LABEL_OUTCOME_MAP must be frozen");
  });
});

// ── computeDecisionQualityLabel — positive paths ──────────────────────────────

describe("computeDecisionQualityLabel — positive paths", () => {
  it("returns correct for outcome=merged", () => {
    const r = computeDecisionQualityLabel("merged");
    assert.equal(r.label, "correct");
    assert.equal(r.reason, DECISION_QUALITY_REASON.OK);
    assert.equal(r.status, "ok");
  });

  it("returns delayed-correct for outcome=reopen", () => {
    const r = computeDecisionQualityLabel("reopen");
    assert.equal(r.label, "delayed-correct");
    assert.equal(r.reason, DECISION_QUALITY_REASON.OK);
    assert.equal(r.status, "ok");
  });

  it("returns incorrect for outcome=rollback", () => {
    const r = computeDecisionQualityLabel("rollback");
    assert.equal(r.label, "incorrect");
    assert.equal(r.reason, DECISION_QUALITY_REASON.OK);
    assert.equal(r.status, "ok");
  });

  it("returns inconclusive for outcome=timeout", () => {
    const r = computeDecisionQualityLabel("timeout");
    assert.equal(r.label, "inconclusive");
    assert.equal(r.reason, DECISION_QUALITY_REASON.OK);
    assert.equal(r.status, "ok");
  });
});

// ── computeDecisionQualityLabel — negative paths ─────────────────────────────

describe("computeDecisionQualityLabel — negative paths (AC9, AC10)", () => {
  it("distinguishes missing input (null) from invalid input — returns MISSING_INPUT reason", () => {
    const r = computeDecisionQualityLabel(null);
    assert.equal(r.label, "inconclusive",
      "missing input must default label to inconclusive");
    assert.equal(r.reason, DECISION_QUALITY_REASON.MISSING_INPUT,
      "reason must be MISSING_INPUT, not INVALID_INPUT");
    assert.equal(r.status, "degraded",
      "missing input must set status=degraded — no silent fallback");
  });

  it("distinguishes missing input (undefined) — returns MISSING_INPUT reason", () => {
    const r = computeDecisionQualityLabel(undefined);
    assert.equal(r.reason, DECISION_QUALITY_REASON.MISSING_INPUT);
    assert.equal(r.status, "degraded");
  });

  it("distinguishes missing input (empty string) — returns MISSING_INPUT reason", () => {
    const r = computeDecisionQualityLabel("");
    assert.equal(r.reason, DECISION_QUALITY_REASON.MISSING_INPUT);
  });

  it("returns INVALID_INPUT for unknown outcome values — degraded, not silent", () => {
    const r = computeDecisionQualityLabel("some-unknown-outcome");
    assert.equal(r.label, "inconclusive",
      "unknown outcome must default to inconclusive");
    assert.equal(r.reason, DECISION_QUALITY_REASON.INVALID_INPUT,
      "reason must be INVALID_INPUT — not MISSING_INPUT and not OK");
    assert.equal(r.status, "degraded",
      "invalid input must set status=degraded — no silent fallback");
  });

  it("returns INVALID_INPUT for numeric outcome", () => {
    const r = computeDecisionQualityLabel(42);
    assert.equal(r.reason, DECISION_QUALITY_REASON.INVALID_INPUT);
    assert.equal(r.status, "degraded");
  });
});

// ── normalizeDecisionQualityLabel — backward compat ──────────────────────────

describe("normalizeDecisionQualityLabel — legacy backward-compat (AC5, AC14)", () => {
  it("returns inconclusive for legacy entry without decisionQualityLabel", () => {
    const legacyPm = {
      workerName: "evolution-worker",
      recommendation: "proceed",
      reviewedAt: "2025-06-01T10:00:00.000Z"
    };
    assert.equal(normalizeDecisionQualityLabel(legacyPm), "inconclusive",
      "legacy entries without decisionQualityLabel must default to inconclusive");
  });

  it("returns the existing label for new entries", () => {
    const newPm = {
      workerName: "worker",
      decisionQualityLabel: "correct",
      reviewedAt: "2026-01-01T00:00:00.000Z"
    };
    assert.equal(normalizeDecisionQualityLabel(newPm), "correct");
  });

  it("returns inconclusive for entries with an unknown label value", () => {
    const badPm = { decisionQualityLabel: "some-future-label" };
    assert.equal(normalizeDecisionQualityLabel(badPm), "inconclusive");
  });

  it("returns inconclusive for null input", () => {
    assert.equal(normalizeDecisionQualityLabel(null), "inconclusive");
  });
});

describe("postmortem_legacy.json fixture — backward-compat read (AC5, AC14)", () => {
  it("all legacy entries parse and default to inconclusive label", async () => {
    const raw = JSON.parse(
      await fs.readFile(path.join(FIXTURES_DIR, "postmortem_legacy.json"), "utf8")
    );
    assert.ok(Array.isArray(raw), "legacy fixture must be a plain array (v0 format)");
    assert.ok(raw.length >= 1, "fixture must have at least one entry");
    for (const pm of raw) {
      assert.ok(!("decisionQualityLabel" in pm),
        "legacy entries must not have decisionQualityLabel field");
      assert.equal(normalizeDecisionQualityLabel(pm), "inconclusive",
        "legacy entry without decisionQualityLabel must normalize to inconclusive");
    }
  });
});

// ── DECISION_QUALITY_WEIGHTS ──────────────────────────────────────────────────

describe("DECISION_QUALITY_WEIGHTS (AC4, AC13)", () => {
  it("defines explicit weights for all four labels", () => {
    assert.equal(DECISION_QUALITY_WEIGHTS["correct"], 1.0);
    assert.equal(DECISION_QUALITY_WEIGHTS["delayed-correct"], 0.6);
    assert.equal(DECISION_QUALITY_WEIGHTS["incorrect"], 0.0);
    assert.equal(DECISION_QUALITY_WEIGHTS["inconclusive"], 0.3);
    assert.ok(Object.isFrozen(DECISION_QUALITY_WEIGHTS), "weights must be frozen");
  });

  it("correct > delayed-correct > inconclusive > incorrect ordering", () => {
    assert.ok(DECISION_QUALITY_WEIGHTS["correct"] > DECISION_QUALITY_WEIGHTS["delayed-correct"]);
    assert.ok(DECISION_QUALITY_WEIGHTS["delayed-correct"] > DECISION_QUALITY_WEIGHTS["inconclusive"]);
    assert.ok(DECISION_QUALITY_WEIGHTS["inconclusive"] > DECISION_QUALITY_WEIGHTS["incorrect"]);
  });
});

// ── computeWeightedDecisionScore ──────────────────────────────────────────────

describe("computeWeightedDecisionScore (AC4, AC13)", () => {
  it("returns score=1.0 for all-correct postmortems", () => {
    const pms = [
      { decisionQualityLabel: "correct" },
      { decisionQualityLabel: "correct" }
    ];
    const r = computeWeightedDecisionScore(pms);
    assert.equal(r.score, 1.0);
    assert.equal(r.total, 2);
    assert.equal(r.labelCounts.correct, 2);
  });

  it("returns score=0.0 for all-incorrect postmortems", () => {
    const pms = [
      { decisionQualityLabel: "incorrect" },
      { decisionQualityLabel: "incorrect" }
    ];
    const r = computeWeightedDecisionScore(pms);
    assert.equal(r.score, 0.0);
  });

  it("computes mixed score deterministically", () => {
    const pms = [
      { decisionQualityLabel: "correct" },    // 1.0
      { decisionQualityLabel: "incorrect" }   // 0.0
    ];
    const r = computeWeightedDecisionScore(pms);
    assert.equal(r.score, 0.5, "mixed correct+incorrect should average to 0.5");
  });

  it("legacy entries (no label) count as inconclusive (weight=0.3)", () => {
    const pms = [
      { workerName: "legacy", recommendation: "proceed" }  // no decisionQualityLabel
    ];
    const r = computeWeightedDecisionScore(pms);
    assert.equal(r.score, 0.3, "missing label must use inconclusive weight=0.3");
    assert.equal(r.labelCounts.inconclusive, 1);
  });

  it("returns null score for empty input", () => {
    const r = computeWeightedDecisionScore([]);
    assert.equal(r.score, null);
    assert.equal(r.total, 0);
  });

  it("returns null score for non-array input (negative path)", () => {
    const r = computeWeightedDecisionScore(null);
    assert.equal(r.score, null);
  });
});

// ── getDecisionQualityTrend — data-contract check (AC3, AC12) ────────────────

describe("getDecisionQualityTrend — data-contract (AC3, AC12)", () => {
  let tmpDir;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-dqt-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns trendData=[] and total=0 when no postmortems file exists", async () => {
    const result = await getDecisionQualityTrend(tmpDir);
    assert.ok(Array.isArray(result.trendData), "trendData must be an array");
    assert.equal(result.trendData.length, 0);
    assert.equal(result.total, 0);
  });

  it("returns trendData with shape {timestamp, label, count} for v1 postmortems", async () => {
    const pmFile = path.join(tmpDir, "athena_postmortems.json");
    await fs.writeFile(pmFile, JSON.stringify({
      schemaVersion: 1,
      entries: [
        { decisionQualityLabel: "correct", reviewedAt: "2026-03-01T10:00:00.000Z" },
        { decisionQualityLabel: "correct", reviewedAt: "2026-03-01T12:00:00.000Z" },
        { decisionQualityLabel: "incorrect", reviewedAt: "2026-03-01T14:00:00.000Z" },
        { decisionQualityLabel: "inconclusive", reviewedAt: "2026-03-02T08:00:00.000Z" }
      ]
    }), "utf8");

    const result = await getDecisionQualityTrend(tmpDir);
    assert.ok(Array.isArray(result.trendData), "trendData must be an array");
    assert.equal(result.total, 4, "total must count all entries");

    // Validate shape of each element
    for (const item of result.trendData) {
      assert.ok(typeof item.timestamp === "string", "timestamp must be a string");
      assert.ok(typeof item.label === "string", "label must be a string");
      assert.ok(typeof item.count === "number", "count must be a number");
      assert.ok(item.count > 0, "count must be positive");
    }

    // Day 2026-03-01 should have two buckets: correct(2) and incorrect(1)
    const march1correct = result.trendData.find(
      d => d.timestamp === "2026-03-01" && d.label === "correct"
    );
    assert.ok(march1correct, "should have a correct bucket for 2026-03-01");
    assert.equal(march1correct.count, 2);

    const march1incorrect = result.trendData.find(
      d => d.timestamp === "2026-03-01" && d.label === "incorrect"
    );
    assert.ok(march1incorrect, "should have an incorrect bucket for 2026-03-01");
    assert.equal(march1incorrect.count, 1);
  });

  it("handles v0 (plain array) postmortems format", async () => {
    const pmFile = path.join(tmpDir, "athena_postmortems.json");
    await fs.writeFile(pmFile, JSON.stringify([
      { decisionQualityLabel: "delayed-correct", reviewedAt: "2026-03-05T09:00:00.000Z" }
    ]), "utf8");

    const result = await getDecisionQualityTrend(tmpDir);
    assert.equal(result.total, 1);
    assert.equal(result.trendData.length, 1);
    assert.equal(result.trendData[0].label, "delayed-correct");
    assert.equal(result.trendData[0].count, 1);
  });

  it("legacy entries without decisionQualityLabel count as inconclusive (AC5)", async () => {
    const pmFile = path.join(tmpDir, "athena_postmortems.json");
    await fs.writeFile(pmFile, JSON.stringify([
      { workerName: "old-worker", recommendation: "proceed", reviewedAt: "2026-02-01T10:00:00.000Z" }
    ]), "utf8");

    const result = await getDecisionQualityTrend(tmpDir);
    assert.equal(result.total, 1);
    const bucket = result.trendData[0];
    assert.equal(bucket.label, "inconclusive",
      "legacy entries without label must be bucketed as inconclusive");
    assert.equal(bucket.count, 1);
  });

  it("returns empty trend for corrupt/empty postmortems file (negative path)", async () => {
    const pmFile = path.join(tmpDir, "athena_postmortems.json");
    await fs.writeFile(pmFile, "not valid json", "utf8");

    const result = await getDecisionQualityTrend(tmpDir);
    assert.ok(Array.isArray(result.trendData));
    assert.equal(result.trendData.length, 0);
    assert.equal(result.total, 0);
  });
});
