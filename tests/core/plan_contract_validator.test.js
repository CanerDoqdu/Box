import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validatePlanContract,
  validateAllPlans,
  PLAN_VIOLATION_SEVERITY,
} from "../../src/core/plan_contract_validator.js";

describe("plan_contract_validator", () => {
  describe("validatePlanContract", () => {
    it("accepts a fully valid plan", () => {
      const plan = {
        task: "Implement user authentication module",
        role: "evolution-worker",
        wave: 1,
        verification: "npm test",
        dependencies: [],
        acceptance_criteria: ["All tests pass"],
      };
      const result = validatePlanContract(plan);
      assert.equal(result.valid, true);
      assert.equal(result.violations.length, 0);
    });

    it("rejects null plan", () => {
      const result = validatePlanContract(null);
      assert.equal(result.valid, false);
      assert.ok(result.violations.some(v => v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL));
    });

    it("rejects plan with short task", () => {
      const result = validatePlanContract({ task: "Fix", role: "worker", wave: 1, verification: "npm test" });
      assert.equal(result.valid, false);
      assert.ok(result.violations.some(v => v.field === "task"));
    });

    it("rejects plan with missing role", () => {
      const result = validatePlanContract({ task: "Implement something long enough", role: "", wave: 1, verification: "npm test" });
      assert.equal(result.valid, false);
      assert.ok(result.violations.some(v => v.field === "role"));
    });

    it("warns on missing wave", () => {
      const plan = { task: "Implement something long enough", role: "worker", verification: "npm test", dependencies: [], acceptance_criteria: ["pass"] };
      const result = validatePlanContract(plan);
      // wave warning is non-critical
      assert.ok(result.violations.some(v => v.field === "wave"));
    });

    it("warns on missing verification", () => {
      const plan = { task: "Implement something long enough", role: "worker", wave: 1, dependencies: [], acceptance_criteria: ["pass"] };
      const result = validatePlanContract(plan);
      assert.ok(result.violations.some(v => v.field === "verification"));
    });

    it("warns on missing dependencies", () => {
      const plan = { task: "Implement something long enough", role: "worker", wave: 1, verification: "npm test", acceptance_criteria: ["pass"] };
      const result = validatePlanContract(plan);
      assert.ok(result.violations.some(v => v.field === "dependencies"));
    });

    it("detects forbidden glob pattern", () => {
      const plan = {
        task: "Implement something long enough",
        role: "worker",
        wave: 1,
        verification: "node --test tests/**/*.test.js",
        dependencies: [],
        acceptance_criteria: ["pass"],
      };
      const result = validatePlanContract(plan);
      assert.equal(result.valid, false);
      assert.ok(result.violations.some(v => v.field === "verification" && v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL));
    });

    it("allows npm test as verification", () => {
      const plan = {
        task: "Implement something long enough",
        role: "worker",
        wave: 1,
        verification: "npm test",
        dependencies: [],
        acceptance_criteria: ["pass"],
      };
      const result = validatePlanContract(plan);
      assert.equal(result.valid, true);
    });

    it("rejects empty acceptance_criteria as CRITICAL (Packet 8)", () => {
      const plan = {
        task: "Implement something reasonably long",
        role: "worker",
        wave: 1,
        verification: "npm test",
        dependencies: [],
        acceptance_criteria: [],
      };
      const result = validatePlanContract(plan);
      assert.equal(result.valid, false);
      assert.ok(result.violations.some(v => v.field === "acceptance_criteria" && v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL));
    });

    it("detects forbidden command via centralized check (Packet 5)", () => {
      const plan = {
        task: "Implement something long enough here",
        role: "worker",
        wave: 1,
        verification: "node --test src/**/*.test.js",
        dependencies: [],
        acceptance_criteria: ["pass"],
      };
      const result = validatePlanContract(plan);
      assert.equal(result.valid, false);
      assert.ok(result.violations.some(v => v.field === "verification" && v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL));
    });
  });

  describe("validateAllPlans", () => {
    it("returns passRate 1.0 for empty array", () => {
      const result = validateAllPlans([]);
      assert.equal(result.passRate, 1.0);
      assert.equal(result.totalPlans, 0);
    });

    it("computes correct pass rate for mixed plans", () => {
      const plans = [
        { task: "Valid plan with enough chars", role: "worker", wave: 1, verification: "npm test", dependencies: [], acceptance_criteria: ["ok"] },
        { task: "X", role: "", wave: -1, verification: "" }, // invalid
      ];
      const result = validateAllPlans(plans);
      assert.equal(result.totalPlans, 2);
      assert.equal(result.validCount, 1);
      assert.equal(result.invalidCount, 1);
      assert.equal(result.passRate, 0.5);
    });

    it("returns all valid when all plans pass", () => {
      const plans = [
        { task: "First valid plan task here", role: "w1", wave: 1, verification: "npm test", dependencies: [], acceptance_criteria: ["ok"] },
        { task: "Second valid plan task here", role: "w2", wave: 2, verification: "npm test", dependencies: [], acceptance_criteria: ["ok"] },
      ];
      const result = validateAllPlans(plans);
      assert.equal(result.passRate, 1);
      assert.equal(result.invalidCount, 0);
    });
  });
});
