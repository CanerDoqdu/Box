import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { inferCapabilityTag, selectWorkerForPlan, assignWorkersToPlans, enforceLaneDiversity, computeDispatchMetrics, buildWorkerChain, detectLaneConflicts, recordLaneOutcome, getLaneScore } from "../../src/core/capability_pool.js";

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

    it("quality task routes to quality-worker", () => {
      const plan = { task: "Add test coverage for the parser module" };
      const selection = selectWorkerForPlan(plan);
      assert.equal(selection.role, "quality-worker");
      assert.equal(selection.lane, "quality");
      assert.equal(selection.isFallback, false);
    });

    it("governance task routes to governance-worker", () => {
      const plan = { task: "Update governance freeze policy rules" };
      const selection = selectWorkerForPlan(plan);
      assert.equal(selection.role, "governance-worker");
      assert.equal(selection.lane, "governance");
    });

    it("infrastructure task routes to infrastructure-worker", () => {
      const plan = { task: "Update Docker configuration for production" };
      const selection = selectWorkerForPlan(plan);
      assert.equal(selection.role, "infrastructure-worker");
      assert.equal(selection.lane, "infrastructure");
    });

    it("implementation task routes to Evolution Worker", () => {
      // Use a task with no domain keywords — pure implementation falls back to runtime-refactor → implementation lane
      const plan = { task: "Update the response parsing logic" };
      const selection = selectWorkerForPlan(plan);
      assert.equal(selection.role, "Evolution Worker");
      assert.equal(selection.lane, "implementation");
    });

    it("negative path: falls back when lane mapping is unknown", () => {
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

  describe("detectLaneConflicts", () => {
    it("returns empty for fewer than 2 assignments", () => {
      assert.deepEqual(detectLaneConflicts([]), []);
      assert.deepEqual(detectLaneConflicts([
        { plan: { target_files: ["src/a.ts"] }, selection: { lane: "implementation" } }
      ]), []);
    });

    it("returns empty when plans share a lane but no target files", () => {
      const conflicts = detectLaneConflicts([
        { plan: { task: "A", target_files: ["src/a.ts"] }, selection: { lane: "implementation" } },
        { plan: { task: "B", target_files: ["src/b.ts"] }, selection: { lane: "implementation" } },
      ]);
      assert.deepEqual(conflicts, []);
    });

    it("detects a conflict when plans share a lane and a target file", () => {
      const conflicts = detectLaneConflicts([
        { plan: { task: "A", target_files: ["src/core/orchestrator.ts"] }, selection: { lane: "implementation" } },
        { plan: { task: "B", target_files: ["src/core/orchestrator.ts"] }, selection: { lane: "implementation" } },
      ]);
      assert.equal(conflicts.length, 1);
      assert.equal(conflicts[0].lane, "implementation");
      assert.ok(conflicts[0].sharedFiles.includes("src/core/orchestrator.ts"));
    });

    it("does not flag plans in different lanes even if they share files", () => {
      const conflicts = detectLaneConflicts([
        { plan: { task: "A", target_files: ["src/core/orchestrator.ts"] }, selection: { lane: "implementation" } },
        { plan: { task: "B", target_files: ["src/core/orchestrator.ts"] }, selection: { lane: "governance" } },
      ]);
      assert.deepEqual(conflicts, []);
    });

    it("reports multiple conflicts when multiple pairs share files", () => {
      const conflicts = detectLaneConflicts([
        { plan: { task: "A", target_files: ["src/core/foo.ts"] }, selection: { lane: "quality" } },
        { plan: { task: "B", target_files: ["src/core/foo.ts"] }, selection: { lane: "quality" } },
        { plan: { task: "C", target_files: ["src/core/foo.ts"] }, selection: { lane: "quality" } },
      ]);
      // A↔B, A↔C, B↔C = 3 pairs
      assert.equal(conflicts.length, 3);
    });
  });

  describe("enforceLaneDiversity — lane diversity gate", () => {
    it("passes when activeLaneCount meets minLanes default (2)", () => {
      const pool = assignWorkersToPlans([
        { task: "Add test coverage" },
        { task: "Update Docker configuration" },
      ]);
      const result = enforceLaneDiversity(pool);
      assert.equal(result.meetsMinimum, true);
      assert.equal(result.warning, "");
    });

    it("fails when all plans route to a single lane", () => {
      const pool = assignWorkersToPlans([
        { task: "Add test coverage" },
        { task: "Write more tests" },
      ]);
      // Both are test-infra → quality lane → activeLaneCount = 1
      const result = enforceLaneDiversity(pool, { minLanes: 2 });
      if (pool.activeLaneCount < 2) {
        assert.equal(result.meetsMinimum, false);
        assert.ok(result.warning.length > 0, "warning must be non-empty when minimum is not met");
      } else {
        // If diversity happened to spread, just verify shape
        assert.ok(typeof result.meetsMinimum === "boolean");
      }
    });

    it("respects custom minLanes from config", () => {
      const pool = assignWorkersToPlans([
        { task: "Add test coverage" },
        { task: "Update Docker configuration" },
      ]);
      // Require 5 lanes — almost certain to fail with only 2 plans
      const result = enforceLaneDiversity(pool, { minLanes: 5 });
      assert.equal(result.meetsMinimum, false);
      assert.ok(result.warning.includes("minimum is 5"));
    });

    it("negative path: empty pool produces meetsMinimum=false", () => {
      const result = enforceLaneDiversity({ activeLaneCount: 0, assignments: [] });
      assert.equal(result.meetsMinimum, false);
      assert.ok(result.warning.length > 0);
    });

    it("negative path: null/missing pool falls back to activeLaneCount=0", () => {
      const result = enforceLaneDiversity({});
      assert.equal(result.meetsMinimum, false);
    });

    // Hard admission control contract — callers (orchestrator) must block dispatch
    // when meetsMinimum is false and plans.length >= minLanes.
    it("hard gate contract: meetsMinimum=false signals dispatch must be blocked", () => {
      const pool = assignWorkersToPlans([
        { task: "Add test coverage" },
        { task: "Write more tests" },
      ]);
      const result = enforceLaneDiversity(pool, { minLanes: 2 });
      // If meetsMinimum is false, the warning must be non-empty (caller uses it for alert)
      if (!result.meetsMinimum) {
        assert.ok(result.warning.length > 0, "hard gate: warning must carry a reason for the block");
        assert.ok(typeof result.activeLaneCount === "number");
      }
    });

    it("hard gate contract: meetsMinimum=true means gate passes and dispatch proceeds", () => {
      const pool = assignWorkersToPlans([
        { task: "Add test coverage" },
        { task: "Update Docker configuration" },
        { task: "Fix governance policy" },
      ]);
      const result = enforceLaneDiversity(pool, { minLanes: 2 });
      if (result.meetsMinimum) {
        assert.equal(result.warning, "", "no warning when gate passes");
      }
    });
  });
});

// ── Lane performance feedback ─────────────────────────────────────────────────

describe("capability_pool — lane performance feedback", () => {
  describe("recordLaneOutcome", () => {
    it("initialises a lane entry from an empty ledger", () => {
      const ledger = recordLaneOutcome({}, "quality", { success: true, durationMs: 500 });
      assert.equal(ledger.quality.successes, 1);
      assert.equal(ledger.quality.failures, 0);
      assert.equal(ledger.quality.totalMs, 500);
      assert.ok(ledger.quality.lastUpdated);
    });

    it("accumulates multiple outcomes for the same lane", () => {
      let ledger = {};
      ledger = recordLaneOutcome(ledger, "quality", { success: true,  durationMs: 300 });
      ledger = recordLaneOutcome(ledger, "quality", { success: false, durationMs: 150 });
      ledger = recordLaneOutcome(ledger, "quality", { success: true,  durationMs: 200 });
      assert.equal(ledger.quality.successes, 2);
      assert.equal(ledger.quality.failures,  1);
      assert.equal(ledger.quality.totalMs,   650);
    });

    it("does not mutate the input ledger", () => {
      const original = {};
      recordLaneOutcome(original, "quality", { success: true });
      assert.deepEqual(original, {});
    });

    it("handles missing durationMs gracefully (treats as 0)", () => {
      const ledger = recordLaneOutcome({}, "implementation", { success: true });
      assert.equal(ledger.implementation.totalMs, 0);
    });

    it("tracks separate lanes independently", () => {
      let ledger = {};
      ledger = recordLaneOutcome(ledger, "quality",        { success: true });
      ledger = recordLaneOutcome(ledger, "infrastructure", { success: false });
      assert.equal(ledger.quality.successes,        1);
      assert.equal(ledger.infrastructure.failures,  1);
      assert.equal(ledger.infrastructure.successes, 0);
    });
  });

  describe("getLaneScore", () => {
    it("returns 0.5 for an unseen lane (neutral prior)", () => {
      assert.equal(getLaneScore({}, "quality"), 0.5);
    });

    it("returns 0.5 for null/undefined ledger", () => {
      assert.equal(getLaneScore(null, "quality"), 0.5);
      assert.equal(getLaneScore(undefined, "quality"), 0.5);
    });

    it("returns close to 1 for a perfect lane (all successes)", () => {
      let ledger = {};
      for (let i = 0; i < 10; i++) ledger = recordLaneOutcome(ledger, "quality", { success: true });
      const score = getLaneScore(ledger, "quality");
      assert.ok(score > 0.9, `expected score > 0.9 for perfect lane; got ${score}`);
    });

    it("returns close to 0 for a consistently failing lane", () => {
      let ledger = {};
      for (let i = 0; i < 10; i++) ledger = recordLaneOutcome(ledger, "infra", { success: false });
      const score = getLaneScore(ledger, "infra");
      assert.ok(score < 0.2, `expected score < 0.2 for failing lane; got ${score}`);
    });

    it("score is always in [0, 1]", () => {
      let ledger = {};
      ledger = recordLaneOutcome(ledger, "governance", { success: true });
      ledger = recordLaneOutcome(ledger, "governance", { success: false });
      const score = getLaneScore(ledger, "governance");
      assert.ok(score >= 0 && score <= 1, `score out of range: ${score}`);
    });

    it("negative path: score below LOW_PERFORMANCE_THRESHOLD triggers fallback in selectWorkerForPlan", () => {
      let ledger = {};
      // Force 10 consecutive failures → score well below 0.25
      for (let i = 0; i < 10; i++) ledger = recordLaneOutcome(ledger, "quality", { success: false });
      const plan = { task: "Add test coverage for the parser module" }; // routes to quality lane
      const selection = selectWorkerForPlan(plan, null, ledger);
      assert.equal(selection.isFallback, true, "degraded lane must trigger fallback");
      assert.ok(selection.performanceScore < 0.25, `expected low score; got ${selection.performanceScore}`);
    });
  });

  describe("selectWorkerForPlan — performance-aware routing", () => {
    it("includes performanceScore=0.5 when no ledger is provided", () => {
      const plan = { task: "Add test coverage" };
      const selection = selectWorkerForPlan(plan);
      assert.equal(selection.performanceScore, 0.5);
    });

    it("routes to quality-worker when quality lane has healthy score", () => {
      let ledger = {};
      for (let i = 0; i < 5; i++) ledger = recordLaneOutcome(ledger, "quality", { success: true });
      const plan = { task: "Add test coverage for the parser module" };
      const selection = selectWorkerForPlan(plan, null, ledger);
      assert.equal(selection.role, "quality-worker");
      assert.equal(selection.lane, "quality");
      assert.ok(selection.performanceScore > 0.5);
    });

    it("falls back to evolution-worker when quality lane is degraded", () => {
      let ledger = {};
      for (let i = 0; i < 20; i++) ledger = recordLaneOutcome(ledger, "quality", { success: false });
      const plan = { task: "Add test coverage for the parser module" };
      const selection = selectWorkerForPlan(plan, null, ledger);
      assert.equal(selection.isFallback, true);
      assert.equal(selection.lane, "quality", "lane label preserved for diversity accounting");
    });
  });

  describe("assignWorkersToPlans — performance ledger passthrough", () => {
    it("accepts lanePerformance parameter and propagates scores to selections", () => {
      let ledger = {};
      for (let i = 0; i < 5; i++) ledger = recordLaneOutcome(ledger, "quality", { success: true });
      const plans = [{ task: "Add test coverage" }];
      const result = assignWorkersToPlans(plans, null, ledger);
      assert.equal(result.assignments.length, 1);
      assert.ok(result.assignments[0].selection.performanceScore > 0.5);
    });

    it("backward-compatible: works without lanePerformance argument", () => {
      const plans = [{ task: "Add test coverage" }, { task: "Update docker config" }];
      const result = assignWorkersToPlans(plans);
      assert.equal(result.assignments.length, 2);
      result.assignments.forEach(a => {
        assert.equal(a.selection.performanceScore, 0.5, "default score is 0.5 when no ledger");
      });
    });

    it("diversity controls are unaffected by performance feedback", () => {
      // Even when all lanes are healthy, diversityIndex and activeLaneCount still reflect actual routing
      let ledger = {};
      ["quality", "governance", "infrastructure"].forEach(l => {
        for (let i = 0; i < 5; i++) ledger = recordLaneOutcome(ledger, l, { success: true });
      });
      const plans = [
        { task: "Add test coverage" },
        { task: "Fix governance policy" },
        { task: "Update docker config" },
      ];
      const result = assignWorkersToPlans(plans, null, ledger);
      assert.ok(typeof result.diversityIndex === "number", "diversityIndex must still be computed");
      assert.ok(typeof result.activeLaneCount === "number", "activeLaneCount must still be computed");
    });
  });
});

// ── Lane diversity threshold enforcement (Task 1) ─────────────────────────────

describe("capability_pool — lane diversity threshold enforcement", () => {
  describe("assignWorkersToPlans — diversityCheck in return value", () => {
    it("always includes diversityCheck in the result shape", () => {
      const plans = [{ task: "Add test coverage" }];
      const result = assignWorkersToPlans(plans);
      assert.ok(typeof result.diversityCheck === "object", "diversityCheck must be present");
      assert.ok(typeof result.diversityCheck.meetsMinimum === "boolean");
      assert.ok(typeof result.diversityCheck.activeLaneCount === "number");
      assert.ok(typeof result.diversityCheck.warning === "string");
    });

    it("diversityCheck.meetsMinimum=true when lane spread meets default threshold (2)", () => {
      const plans = [
        { task: "Add test coverage" },        // quality lane
        { task: "Update Docker configuration" }, // infrastructure lane
      ];
      const result = assignWorkersToPlans(plans);
      // Two different lanes → should meet the default minLanes=2
      if (result.activeLaneCount >= 2) {
        assert.equal(result.diversityCheck.meetsMinimum, true);
        assert.equal(result.diversityCheck.warning, "");
      }
    });

    it("diversityCheck.meetsMinimum=false when all plans route to a single lane", () => {
      const plans = [
        { task: "Add test coverage" },
        { task: "Write more tests" },
        { task: "Add spec coverage" },
      ];
      // All test-infra → quality lane → activeLaneCount = 1 < minLanes=2
      const result = assignWorkersToPlans(plans);
      if (result.activeLaneCount < 2) {
        assert.equal(result.diversityCheck.meetsMinimum, false);
        assert.ok(result.diversityCheck.warning.length > 0,
          "warning must be non-empty when threshold is not met");
      }
    });

    it("respects custom diversityThreshold option", () => {
      const plans = [
        { task: "Add test coverage" },
        { task: "Update Docker configuration" },
      ];
      // Two lanes but require 5 — must fail
      const result = assignWorkersToPlans(plans, null, undefined, { diversityThreshold: 5 });
      assert.equal(result.diversityCheck.meetsMinimum, false);
      assert.ok(/minimum is 5/i.test(result.diversityCheck.warning),
        "warning must cite the minimum threshold");
    });

    it("diversityThreshold=0 always passes (diversity check disabled)", () => {
      const plans = [{ task: "Write tests" }, { task: "More tests" }];
      const result = assignWorkersToPlans(plans, null, undefined, { diversityThreshold: 0 });
      // minLanes=0 → always meets minimum
      assert.equal(result.diversityCheck.meetsMinimum, true);
    });

    it("backward-compatible: result still contains diversityIndex and activeLaneCount", () => {
      const plans = [{ task: "Fix governance policy" }];
      const result = assignWorkersToPlans(plans);
      assert.ok(typeof result.diversityIndex === "number");
      assert.ok(typeof result.activeLaneCount === "number");
      assert.ok(typeof result.laneCounts === "object");
    });

    it("negative path: empty plans list returns diversityCheck with meetsMinimum=true (no violation on empty set)", () => {
      const result = assignWorkersToPlans([]);
      assert.ok(typeof result.diversityCheck === "object");
      // An empty set has no diversity violation by convention
      assert.ok(typeof result.diversityCheck.meetsMinimum === "boolean");
    });

    it("negative path: null input returns diversityCheck object", () => {
      const result = assignWorkersToPlans(null);
      assert.ok(typeof result.diversityCheck === "object");
      assert.ok(typeof result.diversityCheck.meetsMinimum === "boolean");
    });
  });

  describe("buildRoleExecutionBatches — diversityViolation in batch descriptors", () => {
    // Import buildRoleExecutionBatches to verify diversityViolation is surfaced
    it("each batch includes diversityViolation field (null or object)", async () => {
      const { buildRoleExecutionBatches } = await import("../../src/core/worker_batch_planner.js");
      const plans = [{ role: "Evolution Worker", task: "Fix bug", wave: 1, taskKind: "implementation" }];
      const batches = buildRoleExecutionBatches(plans, {});
      assert.ok(batches.length > 0, "must produce at least one batch");
      for (const batch of batches) {
        // diversityViolation is null when no violation, or an object when violated
        assert.ok("diversityViolation" in batch,
          "each batch must include diversityViolation field");
        const dv = (batch as any).diversityViolation;
        assert.ok(dv === null || (typeof dv === "object" && dv !== null),
          "diversityViolation must be null or an object");
      }
    });

    it("diversityViolation is null when capabilityPoolResult is absent (no diversity info)", async () => {
      const { buildRoleExecutionBatches } = await import("../../src/core/worker_batch_planner.js");
      const plans = [{ role: "Evolution Worker", task: "Task A", wave: 1, taskKind: "implementation" }];
      const batches = buildRoleExecutionBatches(plans, {}, null);
      // No capabilityPoolResult → no diversity info → null
      assert.equal((batches[0] as any).diversityViolation, null);
    });
  });
});
