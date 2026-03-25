import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { compileLessonsToPolicies, validatePlanAgainstPolicies, COMPILABLE_PATTERNS, hardGateRecurrenceToPolicies, checkCarryForwardGate } from "../../src/core/learning_policy_compiler.js";

describe("learning_policy_compiler", () => {
  describe("compileLessonsToPolicies", () => {
    it("returns empty for null input", () => {
      assert.deepEqual(compileLessonsToPolicies(null), []);
    });

    it("returns empty for postmortems with no lessons", () => {
      const pms = [{ lessonLearned: "" }, { lessonLearned: "short" }];
      assert.deepEqual(compileLessonsToPolicies(pms), []);
    });

    it("compiles glob-related lesson to policy", () => {
      const pms = [
        { lessonLearned: "The node --test tests/**/*.test.ts glob pattern fails on Windows due to path expansion issues" }
      ];
      const policies = compileLessonsToPolicies(pms);
      assert.ok(policies.length > 0);
      assert.ok(policies.some(p => p.id === "glob-false-fail"));
    });

    it("compiles test-related lesson", () => {
      const pms = [
        { lessonLearned: "The module was shipped without any test coverage, causing a regression that went undetected" }
      ];
      const policies = compileLessonsToPolicies(pms);
      assert.ok(policies.some(p => p.id === "missing-test"));
    });

    it("compiles lint-related lesson", () => {
      const pms = [
        { lessonLearned: "ESLint flagged an unused import that should have been caught before merge" }
      ];
      const policies = compileLessonsToPolicies(pms);
      assert.ok(policies.some(p => p.id === "lint-failure"));
    });

    it("deduplicates policies from multiple matching lessons", () => {
      const pms = [
        { lessonLearned: "The glob pattern expansion failed again on Windows systems" },
        { lessonLearned: "Another glob wildcard issue in test command" },
      ];
      const policies = compileLessonsToPolicies(pms);
      const globPolicies = policies.filter(p => p.id === "glob-false-fail");
      assert.equal(globPolicies.length, 1);
    });

    it("excludes existing policies", () => {
      const pms = [
        { lessonLearned: "The glob pattern failed on Windows" }
      ];
      const policies = compileLessonsToPolicies(pms, { existingPolicies: ["glob-false-fail"] });
      assert.equal(policies.filter(p => p.id === "glob-false-fail").length, 0);
    });

    it("sets severity and source lesson", () => {
      const pms = [
        { lessonLearned: "Syntax error in new code was pushed without checking", reviewedAt: "2026-01-01T00:00:00Z" }
      ];
      const policies = compileLessonsToPolicies(pms);
      const policy = policies.find(p => p.id === "syntax-error");
      assert.ok(policy);
      assert.equal(policy.severity, "critical");
      assert.ok(policy.sourceLesson.length > 0);
      assert.equal(policy.detectedAt, "2026-01-01T00:00:00Z");
    });
  });

  describe("validatePlanAgainstPolicies", () => {
    it("returns ok for null inputs", () => {
      assert.deepEqual(validatePlanAgainstPolicies(null, []), { ok: true, violations: [] });
    });

    it("detects glob false-fail violation", () => {
      const plan = { task: "Run tests", verification: "node --test tests/**/*.test.ts" };
      const policies = [{ id: "glob-false-fail", assertion: "Use npm test", severity: "critical" }];
      const result = validatePlanAgainstPolicies(plan, policies);
      assert.equal(result.ok, false);
      assert.ok(result.violations.length > 0);
    });

    it("passes clean plan", () => {
      const plan = { task: "Review config", verification: "npm test" };
      const policies = [{ id: "glob-false-fail", assertion: "Use npm test", severity: "critical" }];
      const result = validatePlanAgainstPolicies(plan, policies);
      assert.equal(result.ok, true);
    });
  });

  describe("COMPILABLE_PATTERNS", () => {
    it("has unique IDs", () => {
      const ids = COMPILABLE_PATTERNS.map(p => p.id);
      assert.equal(ids.length, new Set(ids).size);
    });

    it("all patterns have required fields", () => {
      for (const p of COMPILABLE_PATTERNS) {
        assert.ok(p.id, "pattern must have id");
        assert.ok(p.pattern instanceof RegExp, "pattern must have regex");
        assert.ok(p.assertion, "pattern must have assertion");
        assert.ok(["critical", "warning"].includes(p.severity), "severity must be critical or warning");
      }
    });
  });

  describe("hardGateRecurrenceToPolicies (Packet 15)", () => {
    it("returns empty for no postmortems", () => {
      const result = hardGateRecurrenceToPolicies([], []);
      assert.deepEqual(result.newPolicies, []);
      assert.deepEqual(result.escalations, []);
    });

    it("auto-compiles recurring unresolved lesson into policy", () => {
      const pms = [
        { lessonLearned: "The glob pattern fails on Windows due to path expansion", followUpNeeded: true },
        { lessonLearned: "The glob pattern fails on Windows due to path expansion", followUpNeeded: true },
        { lessonLearned: "The glob pattern fails on Windows due to path expansion", followUpNeeded: true },
      ];
      const result = hardGateRecurrenceToPolicies(pms, [], { maxRecurrences: 2 });
      assert.ok(result.newPolicies.length > 0);
      assert.ok(result.newPolicies[0].severity === "critical" || result.newPolicies[0].severity === "warning");
    });

    it("excludes already existing policy IDs", () => {
      const pms = [
        { lessonLearned: "Same issue repeated enough to be compiled", followUpNeeded: true },
        { lessonLearned: "Same issue repeated enough to be compiled", followUpNeeded: true },
        { lessonLearned: "Same issue repeated enough to be compiled", followUpNeeded: true },
      ];
      const first = hardGateRecurrenceToPolicies(pms, [], { maxRecurrences: 2 });
      if (first.newPolicies.length > 0) {
        const firstId = first.newPolicies[0].id;
        const second = hardGateRecurrenceToPolicies(pms, [firstId], { maxRecurrences: 2 });
        assert.ok(!second.newPolicies.some(p => p.id === firstId));
      }
    });
  });

  describe("checkCarryForwardGate (Packet 16)", () => {
    it("detects unresolved lessons across cycles", () => {
      const pms = [
        { followUpNeeded: true, followUpTask: "Fix the critical thing", lessonLearned: "a" },
        { followUpNeeded: true, followUpTask: "Fix the critical thing", lessonLearned: "b" },
        { followUpNeeded: true, followUpTask: "Fix the critical thing", lessonLearned: "c" },
      ];
      const result = checkCarryForwardGate(pms, [], { maxUnresolvedCycles: 2 });
      assert.ok(result.unresolvedLessons.length > 0);
    });

    it("returns empty unresolvedLessons when count below threshold", () => {
      const pms = [{ followUpNeeded: true, followUpTask: "One-off issue", lessonLearned: "minor" }];
      const result = checkCarryForwardGate(pms, []);
      assert.equal(result.unresolvedLessons.length, 0);
    });

    it("validates mandatoryCarryForward items against current plans", () => {
      const pms = [];
      const plans = [{ task: "Must do X exactly" }];
      const result = checkCarryForwardGate(pms, plans, { mandatoryCarryForward: ["Must do X exactly", "Must do Y"] });
      assert.ok(Array.isArray(result.missingMandatory));
      assert.ok(result.missingMandatory.includes("Must do Y"));
    });

    it("returns empty missingMandatory when all mandatory items in plans", () => {
      const pms = [];
      const plans = [{ task: "Must do X" }, { task: "Must do Y" }];
      const result = checkCarryForwardGate(pms, plans, { mandatoryCarryForward: ["Must do X", "Must do Y"] });
      assert.equal(result.missingMandatory.length, 0);
    });
  });
});
