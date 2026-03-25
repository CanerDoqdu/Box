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
});
