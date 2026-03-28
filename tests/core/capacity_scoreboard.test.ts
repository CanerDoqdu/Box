import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeCapacityIndex, appendCapacityEntry, getRecentCapacity, computeTrend } from "../../src/core/capacity_scoreboard.js";

describe("capacity_scoreboard", () => {
  describe("existing exports", () => {
    it("appendCapacityEntry is a function", () => {
      assert.equal(typeof appendCapacityEntry, "function");
    });

    it("getRecentCapacity is a function", () => {
      assert.equal(typeof getRecentCapacity, "function");
    });

    it("computeTrend is a function", () => {
      assert.equal(typeof computeTrend, "function");
    });
  });

  describe("computeCapacityIndex (Packet 17)", () => {
    it("returns 10 dimensions", () => {
      const result = computeCapacityIndex({});
      assert.equal(Object.keys(result.dimensions).length, 10);
    });

    it("returns composite as mean of dimensions", () => {
      const result = computeCapacityIndex({
        parserConfidence: 1,
        planContractPassRate: 1,
        testPassRate: 1,
        workerDoneRate: 1,
        diversityIndex: 1,
        recurrenceClosureRate: 1,
        premiumEfficiency: 1,
        securityScore: 1,
        cycleDurationMinutes: 10,
        targetDurationMinutes: 10,
      });
      assert.ok(result.composite >= 0.9);
      assert.ok(result.composite <= 1.0);
    });

    it("all dimensions are between 0 and 1", () => {
      const result = computeCapacityIndex({
        parserConfidence: 2, // out of range — should clamp
        testPassRate: -1,    // out of range — should clamp
      });
      for (const [key, val] of Object.entries(result.dimensions)) {
        assert.ok(val >= 0, `${key} should be >= 0`);
        assert.ok(val <= 1, `${key} should be <= 1`);
      }
    });

    it("computes deltas from previous index", () => {
      const prev = computeCapacityIndex({ parserConfidence: 0.5 });
      const curr = computeCapacityIndex({ parserConfidence: 0.8 }, prev);
      assert.ok(curr.deltas !== null);
      assert.ok(curr.deltas.parserQuality > 0);
    });

    it("deltas are null when no previous index", () => {
      const result = computeCapacityIndex({});
      assert.equal(result.deltas, null);
    });

    it("composite is a number between 0 and 1", () => {
      const result = computeCapacityIndex({});
      assert.ok(typeof result.composite === "number");
      assert.ok(result.composite >= 0);
      assert.ok(result.composite <= 1);
    });

    it("speed dimension uses duration ratio", () => {
      const fast = computeCapacityIndex({ cycleDurationMinutes: 5, targetDurationMinutes: 10 });
      const slow = computeCapacityIndex({ cycleDurationMinutes: 20, targetDurationMinutes: 10 });
      assert.ok(fast.dimensions.speed >= slow.dimensions.speed);
    });
  });

  describe("parser trend tracking — independent from contextual penalties", () => {
    it("parserQuality uses parserCoreConfidence when provided", () => {
      // Core confidence is high (good structural parsing), but aggregate is lower due to context penalties
      const result = computeCapacityIndex({
        parserCoreConfidence: 0.95,
        parserConfidence: 0.6,  // aggregate after context penalties
      });
      assert.ok(
        result.dimensions.parserQuality >= 0.9,
        `parserQuality should reflect core confidence (0.95), got ${result.dimensions.parserQuality}`
      );
    });

    it("parserQuality falls back to parserConfidence when parserCoreConfidence is absent", () => {
      const result = computeCapacityIndex({ parserConfidence: 0.7 });
      assert.ok(
        Math.abs(result.dimensions.parserQuality - 0.7) < 0.01,
        `parserQuality should fall back to parserConfidence (0.7), got ${result.dimensions.parserQuality}`
      );
    });

    it("promptQuality uses aggregate parserConfidence regardless of parserCoreConfidence", () => {
      const result = computeCapacityIndex({
        parserCoreConfidence: 0.95,
        parserConfidence: 0.6,
      });
      assert.ok(
        Math.abs(result.dimensions.promptQuality - 0.6) < 0.01,
        `promptQuality should use aggregate parserConfidence (0.6), got ${result.dimensions.promptQuality}`
      );
    });

    it("parserQuality and promptQuality diverge when context penalties are present", () => {
      const result = computeCapacityIndex({
        parserCoreConfidence: 0.9,
        parserConfidence: 0.5,  // heavily penalized by contextual signals
      });
      assert.ok(
        result.dimensions.parserQuality > result.dimensions.promptQuality,
        "parserQuality (core) should exceed promptQuality (penalized aggregate) when context penalties are applied"
      );
    });

    it("parserQuality equals promptQuality when no parserCoreConfidence and no penalties", () => {
      // When only parserConfidence is provided (legacy path), both dimensions use the same value
      const result = computeCapacityIndex({ parserConfidence: 0.75 });
      assert.ok(
        Math.abs(result.dimensions.parserQuality - result.dimensions.promptQuality) < 0.01,
        "without parserCoreConfidence, parserQuality and promptQuality should be equal"
      );
    });

    it("computeTrend on parserCoreConfidence tracks parser quality independently", () => {
      // Build a series where core confidence improves but aggregate stays penalized
      const entries = [
        { parserCoreConfidence: 0.6, parserConfidence: 0.3 },
        { parserCoreConfidence: 0.65, parserConfidence: 0.3 },
        { parserCoreConfidence: 0.68, parserConfidence: 0.3 },
        { parserCoreConfidence: 0.72, parserConfidence: 0.3 },
        { parserCoreConfidence: 0.78, parserConfidence: 0.3 },
        { parserCoreConfidence: 0.85, parserConfidence: 0.3 },
      ];
      const coreTrend = computeTrend(entries, "parserCoreConfidence");
      const aggregateTrend = computeTrend(entries, "parserConfidence");
      assert.equal(coreTrend, "improving", "parser core trend should be improving");
      assert.equal(aggregateTrend, "stable", "aggregate trend should be stable (contextual penalties unchanged)");
    });
  });
});
