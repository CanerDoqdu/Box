import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { evaluateRetune, applyRetune } from "../../src/core/strategy_retuner.js";

describe("strategy_retuner", () => {
  describe("evaluateRetune", () => {
    it("returns no actions for null delta", () => {
      const result = evaluateRetune({}, null);
      assert.equal(result.shouldRetune, false);
      assert.deepEqual(result.actions, []);
    });

    it("returns no actions when all trends are stable", () => {
      const delta = {
        trends: { parserConfidence: "stable", planCount: "stable", budgetUsed: "stable", workersDone: "stable" },
        overallScore: 50,
      };
      const result = evaluateRetune({}, delta);
      assert.equal(result.shouldRetune, false);
    });

    it("recommends tightening freshness when parser degrades", () => {
      const config = { runtime: { prometheusAnalysisFreshnessMinutes: 10 } };
      const delta = {
        trends: { parserConfidence: "degrading", planCount: "stable", budgetUsed: "stable", workersDone: "stable" },
        overallScore: 40,
      };
      const result = evaluateRetune(config, delta);
      assert.ok(result.shouldRetune);
      assert.ok(result.actions.some(a => a.parameter.includes("Freshness")));
    });

    it("recommends full re-eval for very low scores", () => {
      const delta = {
        trends: { parserConfidence: "degrading", planCount: "degrading", budgetUsed: "degrading", workersDone: "degrading" },
        overallScore: 10,
      };
      const result = evaluateRetune({}, delta);
      assert.ok(result.shouldRetune);
      assert.ok(result.actions.some(a => a.parameter === "strategy.fullReEval"));
    });

    it("detects budget efficiency concern", () => {
      const delta = {
        trends: { parserConfidence: "stable", planCount: "stable", budgetUsed: "improving", workersDone: "degrading" },
        overallScore: 35,
      };
      const result = evaluateRetune({}, delta);
      assert.ok(result.actions.some(a => a.parameter === "budget.awareness"));
    });

    it("recommends increasing maxTasks when planCount degrades", () => {
      const config = { planner: { maxTasks: 5 } };
      const delta = {
        trends: { parserConfidence: "stable", planCount: "degrading", budgetUsed: "stable", workersDone: "stable" },
        overallScore: 40,
      };
      const result = evaluateRetune(config, delta);
      assert.ok(result.actions.some(a => a.parameter === "planner.maxTasks"));
    });
  });

  describe("applyRetune", () => {
    it("returns unchanged config for empty actions", () => {
      const config = { runtime: { x: 1 } };
      const result = applyRetune(config, []);
      assert.deepEqual(result.config, config);
      assert.deepEqual(result.applied, []);
    });

    it("applies two-part parameter path", () => {
      const config = { runtime: { prometheusAnalysisFreshnessMinutes: 10 } };
      const actions = [
        { parameter: "runtime.prometheusAnalysisFreshnessMinutes", newValue: 8 },
      ];
      const result = applyRetune(config, actions);
      assert.equal(result.config.runtime.prometheusAnalysisFreshnessMinutes, 8);
      assert.deepEqual(result.applied, ["runtime.prometheusAnalysisFreshnessMinutes"]);
    });

    it("does not mutate original config", () => {
      const config = { runtime: { x: 1 } };
      const actions = [{ parameter: "runtime.x", newValue: 2 }];
      applyRetune(config, actions);
      assert.equal(config.runtime.x, 1);
    });
  });
});
