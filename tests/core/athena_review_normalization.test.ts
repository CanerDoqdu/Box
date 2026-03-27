import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeAthenaReviewPayload,
  MANDATORY_ACTIONABLE_PACKET_FIELDS,
  PREMORTEM_RISK_LEVEL,
  validatePatchedPlan,
  normalizePatchedPlansForDispatch,
} from "../../src/core/athena_reviewer.js";

const BASE_PLANS = [
  {
    role: "evolution-worker",
    task: "Add deterministic dispatch verification coverage",
    verification: "npm test",
    target_files: ["src/core/orchestrator.js", "tests/core/orchestrator.test.ts"],
    acceptance_criteria: ["dispatch path is covered"],
    riskLevel: "low",
  },
  {
    role: "evolution-worker",
    task: "Strengthen scheduler contract validation",
    verification: "node --test tests/core/scheduler.test.ts",
    target_files: ["src/core/scheduler.js"],
    acceptance_criteria: ["invalid contract blocks execution"],
    riskLevel: PREMORTEM_RISK_LEVEL.HIGH,
    premortem: {
      riskLevel: "high",
      scenario: "Scheduler contract refactor could silently accept malformed work packets during dispatch.",
      failurePaths: ["Invalid packets bypass validation"],
      mitigations: ["Keep validator checks explicit"],
      detectionSignals: ["Contract tests begin failing"],
      guardrails: ["Reject malformed packets before dispatch"],
      rollbackPlan: "Revert scheduler validation changes"
    }
  }
];

describe("normalizeAthenaReviewPayload", () => {
  it("synthesizes reviewer contract fields when Athena omits them", () => {
    const normalized = normalizeAthenaReviewPayload({
      summary: "Approved. Plan is measurable and ready for execution."
    }, BASE_PLANS);

    assert.equal(normalized.payload.approved, true);
    assert.deepEqual(normalized.payload.corrections, []);
    assert.equal(normalized.payload.planReviews.length, BASE_PLANS.length);
    assert.ok(normalized.synthesizedFields.includes("approved"));
    assert.ok(normalized.synthesizedFields.includes("corrections"));
    assert.ok(normalized.synthesizedFields.includes("planReviews"));
  });

  it("derives corrections from plan review issues and stays fail-closed", () => {
    const normalized = normalizeAthenaReviewPayload({
      planReviews: [
        {
          planIndex: 0,
          role: "evolution-worker",
          measurable: false,
          successCriteriaClear: true,
          verificationConcrete: true,
          scopeDefined: true,
          preMortemComplete: true,
          issues: ["task is still vague"],
          suggestion: "name the exact contract"
        }
      ],
      summary: "Plan still needs work."
    }, BASE_PLANS);

    assert.equal(normalized.payload.approved, false);
    assert.equal(normalized.payload.corrections.length, 1);
    assert.match(normalized.payload.corrections[0], /task is still vague/i);
    assert.ok(normalized.synthesizedFields.includes("approved"));
    assert.ok(normalized.synthesizedFields.includes("corrections"));
  });

  it("accepts nested decision payloads and normalizes alias fields", () => {
    const normalized = normalizeAthenaReviewPayload({
      decision: {
        status: "approved",
        plan_reviews: [
          {
            role: "evolution-worker",
            issues: []
          }
        ],
        reason: "All critical gates passed."
      }
    }, BASE_PLANS);

    assert.equal(normalized.payload.approved, true);
    assert.equal(normalized.payload.planReviews.length, 1);
    assert.equal(normalized.payload.summary, "All critical gates passed.");
    assert.ok(normalized.synthesizedFields.includes("approved"));
    assert.ok(normalized.synthesizedFields.includes("corrections"));
    assert.ok(normalized.synthesizedFields.includes("planReviews"));
  });

  it("fails closed when reviewer status is blocked, even if summary text sounds positive", () => {
    const normalized = normalizeAthenaReviewPayload({
      status: "blocked",
      planReviews: [
        {
          planIndex: 0,
          role: "evolution-worker",
          measurable: true,
          issues: []
        }
      ],
      summary: "Looks good overall."
    }, BASE_PLANS);

    assert.equal(normalized.payload.approved, false);
    assert.deepEqual(normalized.payload.corrections, []);
  });

  // ── MANDATORY_ACTIONABLE_PACKET_FIELDS ────────────────────────────────────

  it("exports MANDATORY_ACTIONABLE_PACKET_FIELDS as a frozen array with approved and planReviews", () => {
    assert.ok(Object.isFrozen(MANDATORY_ACTIONABLE_PACKET_FIELDS), "must be frozen");
    assert.ok(MANDATORY_ACTIONABLE_PACKET_FIELDS.includes("approved"));
    assert.ok(MANDATORY_ACTIONABLE_PACKET_FIELDS.includes("planReviews"));
  });

  // ── missingFields tracking ────────────────────────────────────────────────

  it("populates missingFields when both approved and planReviews are absent from the AI response", () => {
    const normalized = normalizeAthenaReviewPayload({
      summary: "Everything looks good."
    }, BASE_PLANS);

    assert.ok(Array.isArray(normalized.missingFields), "missingFields must be an array");
    assert.ok(normalized.missingFields.includes("approved"), "approved must be in missingFields when only summary is present");
    assert.ok(normalized.missingFields.includes("planReviews"), "planReviews must be in missingFields when absent");
  });

  it("does NOT populate missingFields when an explicit boolean approved is provided", () => {
    const normalized = normalizeAthenaReviewPayload({
      approved: true,
      planReviews: [{ planIndex: 0, role: "evolution-worker", issues: [] }]
    }, BASE_PLANS);

    assert.ok(!normalized.missingFields.includes("approved"), "approved must NOT be in missingFields when explicit boolean is given");
    assert.ok(!normalized.missingFields.includes("planReviews"), "planReviews must NOT be in missingFields when array is provided");
  });

  it("does NOT add approved to missingFields when an unambiguous status alias is used", () => {
    const normalized = normalizeAthenaReviewPayload({
      status: "approved",
      planReviews: [{ planIndex: 0, role: "evolution-worker", issues: [] }]
    }, BASE_PLANS);

    assert.ok(!normalized.missingFields.includes("approved"),
      "approved must NOT be in missingFields when status='approved' alias is provided");
  });

  it("does NOT add approved to missingFields when status is a rejection alias", () => {
    const normalized = normalizeAthenaReviewPayload({
      status: "rejected",
      planReviews: [{ planIndex: 0, role: "evolution-worker", issues: [] }]
    }, BASE_PLANS);

    assert.ok(!normalized.missingFields.includes("approved"),
      "approved must NOT be in missingFields when status='rejected' alias is provided");
  });

  it("does NOT add planReviews to missingFields when plan_reviews alias is used", () => {
    const normalized = normalizeAthenaReviewPayload({
      approved: false,
      plan_reviews: [{ planIndex: 0, role: "evolution-worker", issues: ["vague task"] }]
    }, BASE_PLANS);

    assert.ok(!normalized.missingFields.includes("planReviews"),
      "planReviews must NOT be in missingFields when plan_reviews alias is present");
  });

  it("only adds to missingFields the fields that are genuinely absent — not those aliased", () => {
    // planReviews provided as alias (plan_reviews) but approved truly missing (only in summary text)
    const normalized = normalizeAthenaReviewPayload({
      plan_reviews: [{ planIndex: 0, role: "evolution-worker", issues: [] }],
      summary: "Looks good — approved."
    }, BASE_PLANS);

    assert.ok(normalized.missingFields.includes("approved"),
      "approved must be in missingFields when only inferred from summary text");
    assert.ok(!normalized.missingFields.includes("planReviews"),
      "planReviews must NOT be in missingFields when plan_reviews alias is present");
  });
});

// ── Task 3: Patched-plan validation gate ──────────────────────────────────────

describe("validatePatchedPlan (Task 3)", () => {
  it("passes a well-formed patched plan", () => {
    const result = validatePatchedPlan({
      target_files: ["src/core/orchestrator.ts"],
      scope: "src/core/",
      acceptance_criteria: ["CI passes", "Tests green"],
    });
    assert.equal(result.valid, true);
    assert.equal(result.issues.length, 0);
  });

  it("fails when target_files is missing", () => {
    const result = validatePatchedPlan({ scope: "src/core/", acceptance_criteria: ["test passes"] });
    assert.equal(result.valid, false);
    assert.ok(result.issues.some(i => /target_files/i.test(i)));
  });

  it("fails when target_files is an empty array", () => {
    const result = validatePatchedPlan({ target_files: [], scope: "src/", acceptance_criteria: ["test passes"] });
    assert.equal(result.valid, false);
    assert.ok(result.issues.some(i => /target_files/i.test(i)));
  });

  it("fails when target_files contains '...' placeholder", () => {
    const result = validatePatchedPlan({
      target_files: ["src/core/foo.ts", "..."],
      scope: "src/core/",
      acceptance_criteria: ["test passes"],
    });
    assert.equal(result.valid, false);
    assert.ok(result.issues.some(i => /placeholder/i.test(i)));
  });

  it("fails when target_files contains '<placeholder>' style", () => {
    const result = validatePatchedPlan({
      target_files: ["<path/to/file.ts>"],
      scope: "src/",
      acceptance_criteria: ["test passes"],
    });
    assert.equal(result.valid, false);
    assert.ok(result.issues.some(i => /placeholder/i.test(i)));
  });

  it("fails when target_files contains 'path/to/' generic prefix", () => {
    const result = validatePatchedPlan({
      target_files: ["path/to/module.ts"],
      scope: "src/",
      acceptance_criteria: ["passes"],
    });
    assert.equal(result.valid, false);
    assert.ok(result.issues.some(i => /placeholder/i.test(i)));
  });

  it("fails when scope is missing", () => {
    const result = validatePatchedPlan({ target_files: ["src/core/foo.ts"], acceptance_criteria: ["test"] });
    assert.equal(result.valid, false);
    assert.ok(result.issues.some(i => /scope/i.test(i)));
  });

  it("fails when acceptance_criteria is empty", () => {
    const result = validatePatchedPlan({ target_files: ["src/core/foo.ts"], scope: "src/core/", acceptance_criteria: [] });
    assert.equal(result.valid, false);
    assert.ok(result.issues.some(i => /acceptance_criteria/i.test(i)));
  });

  it("negative path: non-object plan is invalid", () => {
    const result = validatePatchedPlan("not an object");
    assert.equal(result.valid, false);
    assert.ok(result.issues.length > 0);
  });

  it("accepts targetFiles alias for target_files", () => {
    const result = validatePatchedPlan({
      targetFiles: ["src/core/foo.ts"],
      scope: "src/core/",
      acceptance_criteria: ["passes"],
    });
    assert.equal(result.valid, true);
  });
});

// ── Task 2: normalizePatchedPlansForDispatch — handoff normalization ───────────

describe("normalizePatchedPlansForDispatch", () => {
  it("returns empty array for non-array input", () => {
    assert.deepEqual(normalizePatchedPlansForDispatch(null as any), []);
    assert.deepEqual(normalizePatchedPlansForDispatch(undefined as any), []);
  });

  it("ensures dependencies is an array when missing", () => {
    const result = normalizePatchedPlansForDispatch([
      { task: "do something", role: "evolution-worker", wave: 1, target_files: ["src/x.ts"], scope: "src/", acceptance_criteria: ["test passes"] }
    ]);
    assert.ok(Array.isArray(result[0].dependencies), "dependencies must be an array");
    assert.deepEqual(result[0].dependencies, []);
  });

  it("preserves existing dependencies array without modification", () => {
    const result = normalizePatchedPlansForDispatch([
      { task: "do something", role: "evolution-worker", wave: 1, dependencies: ["T-001"], target_files: ["src/x.ts"], scope: "src/", acceptance_criteria: ["test passes"] }
    ]);
    assert.deepEqual(result[0].dependencies, ["T-001"]);
  });

  it("sets role to evolution-worker when missing or empty", () => {
    const missing = normalizePatchedPlansForDispatch([
      { task: "x", wave: 1, target_files: ["src/x.ts"], scope: "src/", acceptance_criteria: ["done"] }
    ]);
    assert.equal(missing[0].role, "evolution-worker");

    const empty = normalizePatchedPlansForDispatch([
      { task: "x", role: "", wave: 1, target_files: ["src/x.ts"], scope: "src/", acceptance_criteria: ["done"] }
    ]);
    assert.equal(empty[0].role, "evolution-worker");
  });

  it("preserves explicit role when provided", () => {
    const result = normalizePatchedPlansForDispatch([
      { task: "x", role: "athena", wave: 1, target_files: ["src/x.ts"], scope: "src/", acceptance_criteria: ["done"] }
    ]);
    assert.equal(result[0].role, "athena");
  });

  it("normalizes wave to 1 when invalid or missing", () => {
    const noWave = normalizePatchedPlansForDispatch([
      { task: "x", role: "evolution-worker", target_files: ["src/x.ts"], scope: "src/", acceptance_criteria: ["done"] }
    ]);
    assert.equal(noWave[0].wave, 1);

    const zeroWave = normalizePatchedPlansForDispatch([
      { task: "x", role: "evolution-worker", wave: 0, target_files: ["src/x.ts"], scope: "src/", acceptance_criteria: ["done"] }
    ]);
    assert.equal(zeroWave[0].wave, 1);
  });

  it("preserves valid wave value", () => {
    const result = normalizePatchedPlansForDispatch([
      { task: "x", role: "evolution-worker", wave: 3, target_files: ["src/x.ts"], scope: "src/", acceptance_criteria: ["done"] }
    ]);
    assert.equal(result[0].wave, 3);
  });

  it("normalises targetFiles alias to target_files", () => {
    const result = normalizePatchedPlansForDispatch([
      { task: "x", role: "evolution-worker", wave: 1, targetFiles: ["src/y.ts"], scope: "src/", acceptance_criteria: ["done"] }
    ]);
    assert.deepEqual(result[0].target_files, ["src/y.ts"]);
  });

  it("is idempotent — applying twice produces the same result", () => {
    const input = [
      { task: "fix", role: "evolution-worker", wave: 2, target_files: ["src/a.ts"], scope: "src/", acceptance_criteria: ["done"], dependencies: ["T-1"] }
    ];
    const once = normalizePatchedPlansForDispatch(input);
    const twice = normalizePatchedPlansForDispatch(once);
    assert.deepEqual(once[0].dependencies, twice[0].dependencies);
    assert.equal(once[0].role, twice[0].role);
    assert.equal(once[0].wave, twice[0].wave);
  });

  it("negative path: non-object entries are passed through without throwing", () => {
    assert.doesNotThrow(() => {
      const result = normalizePatchedPlansForDispatch([null, undefined, "string"] as any[]);
      assert.ok(Array.isArray(result));
    });
  });
});

