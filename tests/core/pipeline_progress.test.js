import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PIPELINE_STEPS } from "../../src/core/pipeline_progress.js";

const EXPECTED_STEP_IDS = [
  "idle",
  "jesus_awakening",
  "jesus_reading",
  "jesus_thinking",
  "jesus_decided",
  "trump_starting",
  "trump_reading_repo",
  "trump_analyzing",
  "trump_audit",
  "trump_done",
  "moses_awakening",
  "moses_planning",
  "moses_dispatching",
  "workers_running",
  "workers_finishing",
  "cycle_complete",
];

describe("PIPELINE_STEPS", () => {
  it("contains all expected step IDs in order", () => {
    const ids = PIPELINE_STEPS.map(s => s.id);
    assert.deepEqual(ids, EXPECTED_STEP_IDS);
  });

  it("starts at 0% and ends at 100%", () => {
    assert.equal(PIPELINE_STEPS[0].pct, 0);
    assert.equal(PIPELINE_STEPS[PIPELINE_STEPS.length - 1].pct, 100);
  });

  it("has strictly non-decreasing pct values", () => {
    for (let i = 1; i < PIPELINE_STEPS.length; i++) {
      assert.ok(
        PIPELINE_STEPS[i].pct >= PIPELINE_STEPS[i - 1].pct,
        `Step ${PIPELINE_STEPS[i].id} (${PIPELINE_STEPS[i].pct}) must be >= previous step (${PIPELINE_STEPS[i-1].pct})`
      );
    }
  });

  it("has only ASCII labels (no Turkish or other non-ASCII characters)", () => {
    for (const step of PIPELINE_STEPS) {
      // eslint-disable-next-line no-control-regex
      assert.ok(
        /^[\x00-\x7F]*$/.test(step.label),
        `Step '${step.id}' label '${step.label}' contains non-ASCII characters`
      );
    }
  });

  it("each step has id, label, and pct fields", () => {
    for (const step of PIPELINE_STEPS) {
      assert.ok(typeof step.id === "string" && step.id.length > 0, `step missing id`);
      assert.ok(typeof step.label === "string" && step.label.length > 0, `step ${step.id} missing label`);
      assert.ok(typeof step.pct === "number", `step ${step.id} missing pct`);
    }
  });
});
