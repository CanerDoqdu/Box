import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeAthenaReviewPayload,
  MANDATORY_ACTIONABLE_PACKET_FIELDS,
  PREMORTEM_RISK_LEVEL,
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

