import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { critiquePlan, runCriticPass, CRITIC_DIMENSION, CRITIC_PASS_THRESHOLD, evaluateACRichness, repairPlan, dualPassCriticRepair, AC_RICHNESS_THRESHOLD } from "../../src/core/plan_critic.js";

describe("plan_critic", () => {
  describe("critiquePlan", () => {
    it("returns failed for null plan", () => {
      const result = critiquePlan(null);
      assert.equal(result.passed, false);
      assert.equal(result.score, 0);
    });

    it("passes a well-formed plan", () => {
      const plan = {
        task: "Add validation to src/core/config.js",
        verification: "npm test passes; npm run lint passes",
        context: "src/core/config.js needs input validation",
        dependencies: ["setup-tests"],
        riskLevel: "low",
      };
      const result = critiquePlan(plan);
      assert.equal(result.passed, true);
      assert.ok(result.score >= CRITIC_PASS_THRESHOLD);
      assert.ok(result.issues.length === 0 || result.score > 0);
    });

    it("flags vague task", () => {
      const plan = { task: "Improve things", verification: "" };
      const result = critiquePlan(plan);
      assert.ok(result.issues.some(i => /vague/i.test(i)));
      assert.equal(result.dimensions[CRITIC_DIMENSION.NO_VAGUE_TASK], 0);
    });

    it("flags missing verification", () => {
      const plan = { task: "Add feature to src/core/foo.js", verification: "" };
      const result = critiquePlan(plan);
      assert.equal(result.dimensions[CRITIC_DIMENSION.HAS_VERIFICATION], 0);
    });

    it("scores partial credit for text-only verification", () => {
      const plan = {
        task: "Update src/core/logger.js formatting",
        verification: "Manually verify that logs are properly formatted after the change",
      };
      const result = critiquePlan(plan);
      assert.equal(result.dimensions[CRITIC_DIMENSION.HAS_VERIFICATION], 0.5);
    });

    it("detects scope from file extensions", () => {
      const plan = { task: "Update schema_registry.js exports" };
      const result = critiquePlan(plan);
      assert.equal(result.dimensions[CRITIC_DIMENSION.HAS_CLEAR_SCOPE], 1.0);
    });
  });

  describe("runCriticPass", () => {
    it("returns empty for non-array input", () => {
      const result = runCriticPass(null);
      assert.deepEqual(result, { approved: [], rejected: [], results: [] });
    });

    it("separates approved and rejected plans", () => {
      const plans = [
        { task: "Add test for src/core/foo.js", verification: "npm test passes", riskLevel: "low", dependencies: ["a"] },
        { task: "Improve", verification: "" },
      ];
      const result = runCriticPass(plans);
      assert.equal(result.approved.length + result.rejected.length, 2);
      assert.equal(result.results.length, 2);
    });

    it("uses custom threshold", () => {
      const plans = [{ task: "Update src/core/foo.js", verification: "short" }];
      const result = runCriticPass(plans, { threshold: 0.01 });
      assert.equal(result.approved.length, 1);
    });
  });

  describe("evaluateACRichness (Packet 9)", () => {
    it("returns score 0 for plan with no AC", () => {
      const result = evaluateACRichness({ task: "Something" });
      assert.equal(result.score, 0);
      assert.equal(result.passed, false);
    });

    it("returns score 0 for empty AC array", () => {
      const result = evaluateACRichness({ acceptance_criteria: [] });
      assert.equal(result.score, 0);
      assert.equal(result.passed, false);
    });

    it("returns positive score for rich AC", () => {
      const result = evaluateACRichness({
        acceptance_criteria: ["npm test passes with 0 failures", "Build completes without errors"],
        verification: "npm test",
      });
      assert.ok(result.score > 0);
    });

    it("scores higher for measurable AC", () => {
      const richResult = evaluateACRichness({
        acceptance_criteria: ["npm test passes with 0 failures", "Coverage > 80%"],
        verification: "npm test && npm run coverage",
      });
      const poorResult = evaluateACRichness({
        acceptance_criteria: ["looks good"],
      });
      assert.ok(richResult.score > poorResult.score);
    });
  });

  describe("repairPlan (Packet 7)", () => {
    it("returns repaired plan object", () => {
      const plan = { task: "Fix src/core/foo.js error handling" };
      const criticResult = critiquePlan(plan);
      const result = repairPlan(plan, criticResult);
      assert.ok(result.plan);
      assert.ok(typeof result.repaired === "boolean");
      assert.ok(Array.isArray(result.repairs));
    });

    it("does not overwrite existing AC when they pass", () => {
      const plan = { task: "Fix something in src/core/foo.js", acceptance_criteria: ["All tests pass"], verification: "npm test" };
      const criticResult = critiquePlan(plan);
      const result = repairPlan(plan, criticResult);
      assert.ok(result.plan.acceptance_criteria.includes("All tests pass"));
    });

    it("adds verification when missing", () => {
      const plan = { task: "Fix src/core/foo.js logic" };
      const criticResult = critiquePlan(plan);
      const result = repairPlan(plan, criticResult);
      assert.ok(result.plan.verification);
    });
  });

  describe("dualPassCriticRepair (Packet 7)", () => {
    it("returns repaired plans array", () => {
      const plans = [
        { task: "Valid plan with detail here", verification: "npm test", acceptance_criteria: ["pass"] },
        { task: "Vague plan without any details" },
      ];
      const result = dualPassCriticRepair(plans);
      assert.ok(Array.isArray(result.plans));
      assert.equal(result.plans.length, 2);
    });

    it("attaches critic scores", () => {
      const plans = [{ task: "Add feature to src/core/foo.js", verification: "npm test", acceptance_criteria: ["ok"] }];
      const result = dualPassCriticRepair(plans);
      assert.ok(typeof result.plans[0]._criticScore === "number");
    });
  });

  describe("AC_RICHNESS_THRESHOLD", () => {
    it("is a positive number", () => {
      assert.ok(AC_RICHNESS_THRESHOLD > 0);
      assert.ok(AC_RICHNESS_THRESHOLD <= 1);
    });
  });
});
