import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  normalizeAthenaReviewPayload,
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
});