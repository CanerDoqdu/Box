import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferCapabilityTag, selectWorkerForPlan, assignWorkersToPlans, computeDispatchMetrics, buildWorkerChain } from "../../src/core/capability_pool.js";

describe("capability_pool", () => {
  describe("inferCapabilityTag", () => {
    it("returns default for null", () => {
      assert.equal(inferCapabilityTag(null), "runtime-refactor");
    });

    it("detects governance role", () => {
      assert.equal(inferCapabilityTag({ role: "governance-worker" }), "state-governance");
    });

    it("detects test task", () => {
      assert.equal(inferCapabilityTag({ task: "Add test coverage for parser" }), "test-infra");
    });

    it("detects prometheus task", () => {
      assert.equal(inferCapabilityTag({ task: "Plan new hypothesis" }), "planner-improvement");
    });

    it("detects infrastructure task", () => {
      assert.equal(inferCapabilityTag({ task: "Update Docker configuration" }), "infrastructure");
    });

    it("detects dashboard task", () => {
      assert.equal(inferCapabilityTag({ task: "Fix dashboard metrics display" }), "observation");
    });

    it("falls back to runtime-refactor for generic tasks", () => {
      assert.equal(inferCapabilityTag({ task: "Update code logic" }), "runtime-refactor");
    });
  });

  describe("selectWorkerForPlan", () => {
    it("selects a worker from the lane", () => {
      const plan = { task: "Add test for foo", role: "evolution-worker" };
      const selection = selectWorkerForPlan(plan);
      assert.ok(selection.role);
      assert.ok(selection.lane);
      assert.ok(selection.reason);
    });

    it("falls back when no lane workers found", () => {
      const plan = { task: "Generic task", role: "nonexistent-role" };
      const selection = selectWorkerForPlan(plan);
      assert.ok(selection.role);
    });
  });

  describe("assignWorkersToPlans", () => {
    it("returns empty for non-array", () => {
      const result = assignWorkersToPlans(null);
      assert.deepEqual(result.assignments, []);
      assert.equal(result.diversityIndex, 0);
    });

    it("assigns workers to all plans", () => {
      const plans = [
        { task: "Add tests", role: "evolution-worker" },
        { task: "Fix governance policy", role: "evolution-worker" },
        { task: "Update docker config", role: "evolution-worker" },
      ];
      const result = assignWorkersToPlans(plans);
      assert.equal(result.assignments.length, 3);
      assert.ok(result.diversityIndex >= 0 && result.diversityIndex <= 1);
    });

    it("computes diversity index", () => {
      const plans = [
        { task: "A" },
        { task: "B" },
      ];
      const result = assignWorkersToPlans(plans);
      assert.ok(typeof result.diversityIndex === "number");
    });
  });

  describe("computeDispatchMetrics (Packet 12)", () => {
    it("returns metrics for empty pool", () => {
      const metrics = computeDispatchMetrics({ assignments: [] });
      assert.ok(typeof metrics.concentrationRatio === "number");
      assert.ok(typeof metrics.diversityScore === "number");
    });

    it("returns role and lane distribution", () => {
      const pool = {
        assignments: [
          { selection: { role: "evolution-worker", lane: "implementation" } },
          { selection: { role: "evolution-worker", lane: "implementation" } },
          { selection: { role: "governance-worker", lane: "governance" } },
        ],
      };
      const metrics = computeDispatchMetrics(pool);
      assert.ok(metrics.roleDistribution["evolution-worker"] >= 2);
      assert.ok(metrics.laneDistribution["implementation"] >= 2);
    });

    it("computes concentration ratio", () => {
      const pool = {
        assignments: [
          { selection: { role: "a", lane: "x" } },
          { selection: { role: "a", lane: "x" } },
          { selection: { role: "b", lane: "y" } },
        ],
      };
      const metrics = computeDispatchMetrics(pool);
      assert.ok(metrics.concentrationRatio > 0);
      assert.ok(metrics.concentrationRatio <= 1);
    });
  });

  describe("buildWorkerChain (Packet 13)", () => {
    it("returns 3-stage chain for complex tasks", () => {
      const plan = { task: "Complex multi-file refactoring", complexity: "critical" };
      const result = buildWorkerChain(plan, { complexity: "critical" });
      assert.equal(result.isChained, true);
      assert.ok(result.chain.length === 3);
    });

    it("returns empty chain for simple tasks", () => {
      const plan = { task: "Fix typo" };
      const result = buildWorkerChain(plan, { complexity: "low" });
      assert.equal(result.isChained, false);
      assert.equal(result.chain.length, 0);
    });

    it("each stage has stage and lane", () => {
      const result = buildWorkerChain({ task: "Refactor auth" }, { complexity: "high" });
      assert.equal(result.isChained, true);
      for (const stage of result.chain) {
        assert.ok(stage.stage);
        assert.ok(stage.lane);
        assert.ok(stage.task);
      }
    });
  });
});
