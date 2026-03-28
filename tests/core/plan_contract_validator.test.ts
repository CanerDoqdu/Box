import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  validatePlanContract,
  validateAllPlans,
  PLAN_VIOLATION_SEVERITY,
  PACKET_VIOLATION_CODE,
  isNonSpecificVerification,
} from "../../src/core/plan_contract_validator.js";

describe("plan_contract_validator", () => {
  describe("isNonSpecificVerification", () => {
    it("identifies bare npm test as non-specific", () => {
      assert.equal(isNonSpecificVerification("npm test"), true);
      assert.equal(isNonSpecificVerification("npm run test"), true);
      assert.equal(isNonSpecificVerification("npm run tests"), true);
      assert.equal(isNonSpecificVerification("node --test"), true);
      assert.equal(isNonSpecificVerification("run tests"), true);
    });

    it("identifies test file references as specific", () => {
      assert.equal(isNonSpecificVerification("tests/core/foo.test.ts — test: should return X"), false);
      assert.equal(isNonSpecificVerification("node --test tests/core/foo.test.ts"), false);
      assert.equal(isNonSpecificVerification("src/core/bar.spec.js"), false);
    });

    it("identifies description separators as specific", () => {
      assert.equal(isNonSpecificVerification("tests/core/auth.test.ts — test: login works"), false);
    });

    it("treats empty string as non-specific", () => {
      assert.equal(isNonSpecificVerification(""), true);
      assert.equal(isNonSpecificVerification("   "), true);
    });

    it("treats non-CLI descriptive text as specific (benefit of doubt)", () => {
      // Descriptive assertion text is not a bare CLI command
      assert.equal(isNonSpecificVerification("All integration tests pass when auth module is loaded"), false);
    });
  });

  describe("validatePlanContract", () => {
    it("accepts a fully valid plan with specific verification", () => {
      const plan = {
        task: "Implement user authentication module",
        role: "evolution-worker",
        wave: 1,
        verification: "tests/core/auth.test.ts — test: should authenticate user",
        dependencies: [],
        acceptance_criteria: ["All tests pass"],
        capacityDelta: 0.1,
        requestROI: 2.0,
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
      const plan = { task: "Implement something long enough", role: "worker", verification: "tests/core/foo.test.ts — test: passes", dependencies: [], acceptance_criteria: ["pass"], capacityDelta: 0.1, requestROI: 1.5 };
      const result = validatePlanContract(plan);
      // wave warning is non-critical
      assert.ok(result.violations.some(v => v.field === "wave"));
    });

    it("warns on missing verification", () => {
      const plan = { task: "Implement something long enough", role: "worker", wave: 1, dependencies: [], acceptance_criteria: ["pass"], capacityDelta: 0.1, requestROI: 1.5 };
      const result = validatePlanContract(plan);
      assert.ok(result.violations.some(v => v.field === "verification"));
    });

    it("warns on missing dependencies", () => {
      const plan = { task: "Implement something long enough", role: "worker", wave: 1, verification: "tests/core/foo.test.ts — test: passes", acceptance_criteria: ["pass"], capacityDelta: 0.1, requestROI: 1.5 };
      const result = validatePlanContract(plan);
      assert.ok(result.violations.some(v => v.field === "dependencies"));
    });

    it("detects forbidden glob pattern", () => {
      const plan = {
        task: "Implement something long enough",
        role: "worker",
        wave: 1,
        verification: "node --test tests/**/*.test.ts",
        dependencies: [],
        acceptance_criteria: ["pass"],
        capacityDelta: 0.1,
        requestROI: 1.5,
      };
      const result = validatePlanContract(plan);
      assert.equal(result.valid, false);
      assert.ok(result.violations.some(v => v.field === "verification" && v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL));
    });

    it("rejects non-specific verification (npm test alone) as CRITICAL", () => {
      const plan = {
        task: "Implement something long enough",
        role: "worker",
        wave: 1,
        verification: "npm test",
        dependencies: [],
        acceptance_criteria: ["pass"],
        capacityDelta: 0.1,
        requestROI: 1.5,
      };
      const result = validatePlanContract(plan);
      assert.equal(result.valid, false, "plan with non-specific verification must be invalid");
      assert.ok(
        result.violations.some(v => v.field === "verification" && v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL),
        "must have a CRITICAL violation on the verification field"
      );
    });

    it("accepts specific verification with test file path", () => {
      const plan = {
        task: "Implement something long enough",
        role: "worker",
        wave: 1,
        verification: "tests/core/foo.test.ts — test: should pass validation",
        dependencies: [],
        acceptance_criteria: ["pass"],
        capacityDelta: 0.1,
        requestROI: 1.5,
      };
      const result = validatePlanContract(plan);
      assert.ok(!result.violations.some(v => v.field === "verification" && v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL),
        "specific verification should not produce a CRITICAL violation");
    });

    it("accepts node --test with a specific test file as verification", () => {
      const plan = {
        task: "Implement something long enough here",
        role: "worker",
        wave: 1,
        verification: "node --test tests/core/foo.test.ts",
        dependencies: [],
        acceptance_criteria: ["pass"],
        capacityDelta: 0.1,
        requestROI: 1.5,
      };
      const result = validatePlanContract(plan);
      assert.ok(!result.violations.some(v => v.field === "verification" && v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL),
        "node --test with specific file should not be CRITICAL");
    });

    it("rejects empty acceptance_criteria as CRITICAL (Packet 8)", () => {
      const plan = {
        task: "Implement something reasonably long",
        role: "worker",
        wave: 1,
        verification: "npm test",
        dependencies: [],
        acceptance_criteria: [],
        capacityDelta: 0.1,
        requestROI: 1.5,
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
        verification: "node --test src/**/*.test.ts",
        dependencies: [],
        acceptance_criteria: ["pass"],
        capacityDelta: 0.1,
        requestROI: 1.5,
      };
      const result = validatePlanContract(plan);
      assert.equal(result.valid, false);
      assert.ok(result.violations.some(v => v.field === "verification" && v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL));
    });

    it("detects forbidden command in verification_commands array", () => {
      const plan = {
        task: "Implement something long enough here",
        role: "worker",
        wave: 1,
        verification: "npm test",
        verification_commands: ["npm test", "node --test tests/**/*.test.ts"],
        dependencies: [],
        acceptance_criteria: ["pass"],
        capacityDelta: 0.1,
        requestROI: 1.5,
      };
      const result = validatePlanContract(plan);
      assert.equal(result.valid, false);
      assert.ok(result.violations.some(v => v.field === "verification_commands[1]" && v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL));
    });

    it("passes when all verification_commands are safe", () => {
      const plan = {
        task: "Implement something long enough here",
        role: "worker",
        wave: 1,
        verification: "tests/core/foo.test.ts — test: should pass with safe commands",
        verification_commands: ["npm test", "npm run lint"],
        dependencies: [],
        acceptance_criteria: ["pass"],
        capacityDelta: 0.1,
        requestROI: 1.5,
      };
      const result = validatePlanContract(plan);
      assert.equal(result.valid, true);
    });

    it("detects forbidden command only in verification_commands when verification is clean", () => {
      const plan = {
        task: "Implement something long enough here",
        role: "worker",
        wave: 1,
        verification: "npm test",
        verification_commands: ["node --test src/**/*.test.ts"],
        dependencies: [],
        acceptance_criteria: ["pass"],
        capacityDelta: 0.1,
        requestROI: 1.5,
      };
      const result = validatePlanContract(plan);
      assert.equal(result.valid, false);
      assert.ok(result.violations.some(v => v.field === "verification_commands[0]" && v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL));
    });
  });

  describe("validatePlanContract — capacityDelta and requestROI (measurable packet scoring)", () => {
    it("rejects when capacityDelta is missing (CRITICAL)", () => {
      const plan = {
        task: "Implement something long enough",
        role: "worker",
        wave: 1,
        verification: "npm test",
        dependencies: [],
        acceptance_criteria: ["pass"],
        requestROI: 1.5,
      };
      const result = validatePlanContract(plan);
      assert.equal(result.valid, false, "plan must be invalid without capacityDelta");
      assert.ok(result.violations.some(v => v.field === "capacityDelta" && v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL));
    });

    it("rejects when requestROI is missing (CRITICAL)", () => {
      const plan = {
        task: "Implement something long enough",
        role: "worker",
        wave: 1,
        verification: "npm test",
        dependencies: [],
        acceptance_criteria: ["pass"],
        capacityDelta: 0.1,
      };
      const result = validatePlanContract(plan);
      assert.equal(result.valid, false, "plan must be invalid without requestROI");
      assert.ok(result.violations.some(v => v.field === "requestROI" && v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL));
    });

    it("accepts valid capacityDelta at boundaries", () => {
      for (const delta of [-1.0, 0, 0.5, 1.0]) {
        const plan = {
          task: "Implement something long enough",
          role: "worker",
          wave: 1,
          verification: "npm test",
          dependencies: [],
          acceptance_criteria: ["pass"],
          capacityDelta: delta,
          requestROI: 2.0,
        };
        const result = validatePlanContract(plan);
        assert.ok(
          !result.violations.some(v => v.field === "capacityDelta"),
          `capacityDelta=${delta} should be accepted`
        );
      }
    });

    it("rejects when capacityDelta is out of range (CRITICAL)", () => {
      const plan = {
        task: "Implement something long enough",
        role: "worker",
        wave: 1,
        verification: "npm test",
        dependencies: [],
        acceptance_criteria: ["pass"],
        capacityDelta: 1.5,
        requestROI: 1.0,
      };
      const result = validatePlanContract(plan);
      assert.equal(result.valid, false, "plan must be invalid with out-of-range capacityDelta");
      assert.ok(result.violations.some(v => v.field === "capacityDelta" && v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL));
    });

    it("rejects when requestROI is zero or negative (CRITICAL)", () => {
      for (const roi of [0, -0.5, -1]) {
        const plan = {
          task: "Implement something long enough",
          role: "worker",
          wave: 1,
          verification: "npm test",
          dependencies: [],
          acceptance_criteria: ["pass"],
          capacityDelta: 0.1,
          requestROI: roi,
        };
        const result = validatePlanContract(plan);
        assert.equal(result.valid, false, `plan must be invalid with requestROI=${roi}`);
        assert.ok(
          result.violations.some(v => v.field === "requestROI" && v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL),
          `requestROI=${roi} should produce a CRITICAL violation`
        );
      }
    });

    it("does not produce capacityDelta or requestROI warnings for fully-specified packets", () => {
      const plan = {
        task: "Implement something long enough",
        role: "worker",
        wave: 1,
        verification: "npm test",
        dependencies: [],
        acceptance_criteria: ["pass"],
        capacityDelta: 0.2,
        requestROI: 3.0,
      };
      const result = validatePlanContract(plan);
      assert.ok(!result.violations.some(v => v.field === "capacityDelta"), "no capacityDelta warning expected");
      assert.ok(!result.violations.some(v => v.field === "requestROI"), "no requestROI warning expected");
    });

    it("missing capacityDelta/requestROI makes an otherwise-valid plan invalid (CRITICAL violations)", () => {
      const plan = {
        task: "Implement something long enough",
        role: "worker",
        wave: 1,
        verification: "npm test",
        dependencies: [],
        acceptance_criteria: ["pass"],
        // no capacityDelta or requestROI
      };
      const result = validatePlanContract(plan);
      assert.equal(result.valid, false, "plan must be invalid — capacityDelta and requestROI are required");
      assert.ok(result.violations.some(v => v.field === "capacityDelta" && v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL));
      assert.ok(result.violations.some(v => v.field === "requestROI" && v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL));
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
        { task: "Valid plan with enough chars", role: "worker", wave: 1, verification: "tests/core/foo.test.ts — test: ok", dependencies: [], acceptance_criteria: ["ok"], capacityDelta: 0.1, requestROI: 1.5 },
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
        { task: "First valid plan task here", role: "w1", wave: 1, verification: "tests/core/foo.test.ts — test: first", dependencies: [], acceptance_criteria: ["ok"], capacityDelta: 0.1, requestROI: 2.0 },
        { task: "Second valid plan task here", role: "w2", wave: 2, verification: "tests/core/bar.test.ts — test: second", dependencies: [], acceptance_criteria: ["ok"], capacityDelta: 0.2, requestROI: 1.5 },
      ];
      const result = validateAllPlans(plans);
      assert.equal(result.passRate, 1);
      assert.equal(result.invalidCount, 0);
    });

    it("planIndex correctly identifies critical-violation plans for removal", () => {
      const plans = [
        { task: "Valid plan with enough chars", role: "worker", wave: 1, verification: "tests/core/foo.test.ts — test: passes", dependencies: [], acceptance_criteria: ["ok"], capacityDelta: 0.1, requestROI: 1.5 },
        { task: "X", role: "", wave: -1, verification: "" }, // critical violations
        { task: "Another valid plan here", role: "worker", wave: 2, verification: "tests/core/bar.test.ts — test: ok", dependencies: [], acceptance_criteria: ["ok"], capacityDelta: 0.2, requestROI: 2.0 },
      ];
      const result = validateAllPlans(plans);

      // Collect indices with critical violations (as orchestrator does)
      const toRemove = result.results
        .filter(r => !r.valid && r.violations.some(v => v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL))
        .map(r => r.planIndex)
        .sort((a, b) => b - a);

      assert.deepEqual(toRemove, [1], "only index 1 should be flagged for removal");

      // Simulate splice in reverse order (as orchestrator does)
      const filtered = [...plans];
      for (const idx of toRemove) {
        filtered.splice(idx, 1);
      }
      assert.equal(filtered.length, 2, "critical-violation plan should be removed");
      assert.equal(filtered[0].task, "Valid plan with enough chars");
      assert.equal(filtered[1].task, "Another valid plan here");
    });
  });
});

describe("PACKET_VIOLATION_CODE — deterministic violation taxonomy", () => {
  it("exports all expected codes as frozen string constants", () => {
    const expectedCodes = [
      "NO_TASK_IDENTITY", "TASK_TOO_SHORT", "MISSING_ROLE",
      "INVALID_WAVE",
      "MISSING_VERIFICATION", "NON_SPECIFIC_VERIFICATION", "FORBIDDEN_COMMAND", "MISSING_VERIFICATION_COUPLING",
      "MISSING_ACCEPTANCE_CRITERIA", "MISSING_DEPENDENCIES",
      "MISSING_CAPACITY_DELTA", "INVALID_CAPACITY_DELTA",
      "MISSING_REQUEST_ROI", "INVALID_REQUEST_ROI",
    ];
    for (const key of expectedCodes) {
      assert.equal(typeof PACKET_VIOLATION_CODE[key], "string", `${key} must be a string`);
      assert.ok(PACKET_VIOLATION_CODE[key].length > 0, `${key} must be non-empty`);
    }
  });

  it("is frozen — mutation throws in strict mode", () => {
    assert.throws(
      () => { (PACKET_VIOLATION_CODE as any).NEW_KEY = "x"; },
      /Cannot add property/,
      "PACKET_VIOLATION_CODE must be frozen"
    );
  });

  it("scoring codes match UNRECOVERABLE_PACKET_REASONS string values for cross-gate consistency", async () => {
    // Import UNRECOVERABLE_PACKET_REASONS from prometheus to verify alignment.
    // Both gates must emit identical string codes for the same violation.
    const { UNRECOVERABLE_PACKET_REASONS } = await import("../../src/core/prometheus.js");
    assert.equal(UNRECOVERABLE_PACKET_REASONS.NO_TASK_IDENTITY,       PACKET_VIOLATION_CODE.NO_TASK_IDENTITY);
    assert.equal(UNRECOVERABLE_PACKET_REASONS.MISSING_CAPACITY_DELTA, PACKET_VIOLATION_CODE.MISSING_CAPACITY_DELTA);
    assert.equal(UNRECOVERABLE_PACKET_REASONS.INVALID_CAPACITY_DELTA, PACKET_VIOLATION_CODE.INVALID_CAPACITY_DELTA);
    assert.equal(UNRECOVERABLE_PACKET_REASONS.MISSING_REQUEST_ROI,    PACKET_VIOLATION_CODE.MISSING_REQUEST_ROI);
    assert.equal(UNRECOVERABLE_PACKET_REASONS.INVALID_REQUEST_ROI,    PACKET_VIOLATION_CODE.INVALID_REQUEST_ROI);
    assert.equal(UNRECOVERABLE_PACKET_REASONS.MISSING_VERIFICATION_COUPLING, PACKET_VIOLATION_CODE.MISSING_VERIFICATION_COUPLING);
  });

  describe("validatePlanContract violations include deterministic code field", () => {
    const baseValidPlan = () => ({
      task: "Implement something long enough",
      role: "evolution-worker",
      wave: 1,
      verification: "tests/core/foo.test.ts — test: should pass",
      dependencies: [],
      acceptance_criteria: ["All tests pass"],
      capacityDelta: 0.1,
      requestROI: 2.0,
    });

    it("every violation object has a non-empty string code", () => {
      // Generate a maximally-invalid plan to collect many violations
      const result = validatePlanContract({
        task: "X",  // too short → TASK_TOO_SHORT
        role: "",   // missing → MISSING_ROLE
        wave: -1,   // invalid → INVALID_WAVE
        verification: "npm test", // non-specific → NON_SPECIFIC_VERIFICATION
        // no dependencies, no acceptance_criteria, no capacityDelta, no requestROI
      });
      assert.equal(result.valid, false);
      for (const v of result.violations) {
        assert.equal(typeof v.code, "string", `violation on field "${v.field}" must have a string code`);
        assert.ok(v.code.length > 0, `violation code on field "${v.field}" must be non-empty`);
      }
    });

    it("TASK_TOO_SHORT code on short task", () => {
      const result = validatePlanContract({ ...baseValidPlan(), task: "Fix" });
      const v = result.violations.find(x => x.field === "task");
      assert.ok(v, "must have task violation");
      assert.equal(v!.code, PACKET_VIOLATION_CODE.TASK_TOO_SHORT);
    });

    it("MISSING_ROLE code on empty role", () => {
      const result = validatePlanContract({ ...baseValidPlan(), role: "" });
      const v = result.violations.find(x => x.field === "role");
      assert.ok(v, "must have role violation");
      assert.equal(v!.code, PACKET_VIOLATION_CODE.MISSING_ROLE);
    });

    it("INVALID_WAVE code on missing wave", () => {
      const plan = { ...baseValidPlan() };
      delete (plan as any).wave;
      const result = validatePlanContract(plan);
      const v = result.violations.find(x => x.field === "wave");
      assert.ok(v, "must have wave violation");
      assert.equal(v!.code, PACKET_VIOLATION_CODE.INVALID_WAVE);
    });

    it("NON_SPECIFIC_VERIFICATION code on bare npm test", () => {
      const result = validatePlanContract({ ...baseValidPlan(), verification: "npm test" });
      const v = result.violations.find(x => x.field === "verification" && x.severity === PLAN_VIOLATION_SEVERITY.CRITICAL);
      assert.ok(v, "must have verification violation");
      assert.equal(v!.code, PACKET_VIOLATION_CODE.NON_SPECIFIC_VERIFICATION);
    });

    it("MISSING_VERIFICATION code on absent verification", () => {
      const plan = { ...baseValidPlan() };
      delete (plan as any).verification;
      const result = validatePlanContract(plan);
      const v = result.violations.find(x => x.field === "verification");
      assert.ok(v, "must have verification violation");
      assert.equal(v!.code, PACKET_VIOLATION_CODE.MISSING_VERIFICATION);
    });

    it("MISSING_ACCEPTANCE_CRITERIA code on empty array", () => {
      const result = validatePlanContract({ ...baseValidPlan(), acceptance_criteria: [] });
      const v = result.violations.find(x => x.field === "acceptance_criteria");
      assert.ok(v, "must have acceptance_criteria violation");
      assert.equal(v!.code, PACKET_VIOLATION_CODE.MISSING_ACCEPTANCE_CRITERIA);
    });

    it("MISSING_DEPENDENCIES code on absent dependencies", () => {
      const plan = { ...baseValidPlan() };
      delete (plan as any).dependencies;
      const result = validatePlanContract(plan);
      const v = result.violations.find(x => x.field === "dependencies");
      assert.ok(v, "must have dependencies violation");
      assert.equal(v!.code, PACKET_VIOLATION_CODE.MISSING_DEPENDENCIES);
    });

    it("MISSING_CAPACITY_DELTA code on absent capacityDelta", () => {
      const plan = { ...baseValidPlan() };
      delete (plan as any).capacityDelta;
      const result = validatePlanContract(plan);
      const v = result.violations.find(x => x.field === "capacityDelta");
      assert.ok(v, "must have capacityDelta violation");
      assert.equal(v!.code, PACKET_VIOLATION_CODE.MISSING_CAPACITY_DELTA);
    });

    it("INVALID_CAPACITY_DELTA code on out-of-range capacityDelta", () => {
      const result = validatePlanContract({ ...baseValidPlan(), capacityDelta: 2.0 });
      const v = result.violations.find(x => x.field === "capacityDelta");
      assert.ok(v, "must have capacityDelta violation");
      assert.equal(v!.code, PACKET_VIOLATION_CODE.INVALID_CAPACITY_DELTA);
    });

    it("MISSING_REQUEST_ROI code on absent requestROI", () => {
      const plan = { ...baseValidPlan() };
      delete (plan as any).requestROI;
      const result = validatePlanContract(plan);
      const v = result.violations.find(x => x.field === "requestROI");
      assert.ok(v, "must have requestROI violation");
      assert.equal(v!.code, PACKET_VIOLATION_CODE.MISSING_REQUEST_ROI);
    });

    it("INVALID_REQUEST_ROI code on zero requestROI", () => {
      const result = validatePlanContract({ ...baseValidPlan(), requestROI: 0 });
      const v = result.violations.find(x => x.field === "requestROI");
      assert.ok(v, "must have requestROI violation");
      assert.equal(v!.code, PACKET_VIOLATION_CODE.INVALID_REQUEST_ROI);
    });

    it("FORBIDDEN_COMMAND code on glob pattern in verification", () => {
      const result = validatePlanContract({ ...baseValidPlan(), verification: "node --test tests/**/*.test.ts" });
      const v = result.violations.find(x => x.field === "verification" && x.severity === PLAN_VIOLATION_SEVERITY.CRITICAL);
      assert.ok(v, "must have verification violation");
      assert.equal(v!.code, PACKET_VIOLATION_CODE.FORBIDDEN_COMMAND);
    });

    it("FORBIDDEN_COMMAND code on glob in verification_commands array", () => {
      const result = validatePlanContract({
        ...baseValidPlan(),
        verification_commands: ["node --test src/**/*.test.ts"],
      });
      const v = result.violations.find(x => x.field === "verification_commands[0]");
      assert.ok(v, "must have verification_commands violation");
      assert.equal(v!.code, PACKET_VIOLATION_CODE.FORBIDDEN_COMMAND);
    });

    it("NO_TASK_IDENTITY code when plan is null", () => {
      const result = validatePlanContract(null);
      assert.equal(result.violations[0].code, PACKET_VIOLATION_CODE.NO_TASK_IDENTITY);
    });

    it("secondary safety net can filter by code — code-based filter matches field-based filter", () => {
      const SCORING_CODES = new Set([
        PACKET_VIOLATION_CODE.MISSING_CAPACITY_DELTA,
        PACKET_VIOLATION_CODE.INVALID_CAPACITY_DELTA,
        PACKET_VIOLATION_CODE.MISSING_REQUEST_ROI,
        PACKET_VIOLATION_CODE.INVALID_REQUEST_ROI,
      ]);
      const plans = [
        { task: "First valid plan here", role: "w1", wave: 1, verification: "tests/core/foo.test.ts — test: first", dependencies: [], acceptance_criteria: ["ok"], capacityDelta: 0.1, requestROI: 2.0 },
        { task: "Missing scoring fields", role: "w2", wave: 2, verification: "tests/core/bar.test.ts — test: bar", dependencies: [], acceptance_criteria: ["ok"] },
      ];
      const result = validateAllPlans(plans);
      const byCode = result.results
        .filter(r => !r.valid && r.violations.some(v =>
          SCORING_CODES.has(v.code) && v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL
        ))
        .map(r => r.planIndex);
      const byField = result.results
        .filter(r => !r.valid && r.violations.some(v =>
          (v.field === "capacityDelta" || v.field === "requestROI") && v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL
        ))
        .map(r => r.planIndex);
      assert.deepEqual(byCode, byField, "code-based and field-based filters must identify the same plans");
    });
  });
});

// ── Task 3: Harden forbidden command checks — plan contract level ─────────────

describe("plan_contract_validator — forbidden command checks (Task 3 hardening)", () => {
  it("detects forbidden bash in verification field with leading whitespace (trimming fix)", () => {
    const plan = {
      task: "Implement something long enough here",
      role: "worker",
      wave: 1,
      verification: "  bash scripts/run_tests.sh",
      dependencies: [],
      acceptance_criteria: ["tests pass"],
      capacityDelta: 0.1,
      requestROI: 1.5,
    };
    const result = validatePlanContract(plan);
    assert.equal(result.valid, false,
      "leading-whitespace bash in verification must be detected as forbidden");
    assert.ok(
      result.violations.some(v => v.field === "verification" && v.code === PACKET_VIOLATION_CODE.FORBIDDEN_COMMAND),
      `expected FORBIDDEN_COMMAND violation on verification; got: [${JSON.stringify(result.violations)}]`
    );
  });

  it("detects forbidden node --test glob in verification_commands with leading whitespace", () => {
    const plan = {
      task: "Implement something long enough here",
      role: "worker",
      wave: 1,
      verification: "tests/core/foo.test.ts — test: should pass",
      verification_commands: ["  node --test tests/**/*.test.ts"],
      dependencies: [],
      acceptance_criteria: ["tests pass"],
      capacityDelta: 0.1,
      requestROI: 1.5,
    };
    const result = validatePlanContract(plan);
    assert.equal(result.valid, false,
      "leading-whitespace node --test glob in verification_commands must be detected as forbidden");
    assert.ok(
      result.violations.some(v =>
        v.field === "verification_commands[0]" && v.code === PACKET_VIOLATION_CODE.FORBIDDEN_COMMAND
      ),
      `expected FORBIDDEN_COMMAND on verification_commands[0]; got: [${JSON.stringify(result.violations)}]`
    );
  });

  it("negative path: clean commands with leading whitespace are NOT flagged as forbidden", () => {
    const plan = {
      task: "Implement something long enough here",
      role: "worker",
      wave: 1,
      verification: "tests/core/foo.test.ts — test: should pass",
      verification_commands: ["  npm test", "  npm run lint"],
      dependencies: [],
      acceptance_criteria: ["tests pass"],
      capacityDelta: 0.1,
      requestROI: 1.5,
    };
    const result = validatePlanContract(plan);
    const forbiddenViolations = result.violations.filter(
      v => v.code === PACKET_VIOLATION_CODE.FORBIDDEN_COMMAND
    );
    assert.equal(forbiddenViolations.length, 0,
      `canonical commands with leading whitespace must not be flagged; got: [${JSON.stringify(forbiddenViolations)}]`
    );
  });
});
