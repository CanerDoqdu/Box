import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRoleExecutionBatches } from "../../src/core/worker_batch_planner.js";

function buildPlan(index) {
  return {
    role: "Evolution Worker",
    task: `Task ${index + 1} ${"x".repeat(80)}`,
    context: `Context ${index + 1}`,
    verification: `Verify ${index + 1}`,
    wave: 1,
    priority: index,
    taskKind: "implementation"
  };
}

describe("worker_batch_planner", () => {
  it("selects the model that minimizes batches and assigns GitHub closure to the final batch", () => {
    const config = {
      copilot: {
        defaultModel: "GPT-5.3-Codex",
        preferredModelsByTaskKind: {
          implementation: ["Claude Sonnet 4.6", "GPT-5.3-Codex"]
        },
        preferredModelsByRole: {
          "Evolution Worker": ["Claude Sonnet 4.6", "GPT-5.3-Codex"]
        },
        modelContextWindows: {
          "Claude Sonnet 4.6": 1700,
          "GPT-5.3-Codex": 1100
        },
        modelContextReserveTokens: 0
      },
      runtime: {
        workerContextTokenLimit: 1100
      },
      roleRegistry: {
        workers: {
          evolution: {
            name: "Evolution Worker",
            model: "GPT-5.3-Codex"
          }
        }
      }
    };

    const plans = Array.from({ length: 9 }, (_, index) => buildPlan(index));
    const batches = buildRoleExecutionBatches(plans, config);

    assert.equal(batches.length, 2);
    assert.equal(batches[0].model, "Claude Sonnet 4.6");
    assert.equal(batches[1].model, "Claude Sonnet 4.6");
    assert.equal(batches[0].plans.length, 5);
    assert.equal(batches[1].plans.length, 4);
    assert.equal(batches[0].githubFinalizer, false);
    assert.equal(batches[1].githubFinalizer, true);
    assert.equal(batches[0].roleBatchIndex, 1);
    assert.equal(batches[1].roleBatchIndex, 2);
    assert.equal(batches[0].roleBatchTotal, 2);
    assert.equal(batches[1].roleBatchTotal, 2);
    assert.equal(batches[0].sharedBranch, batches[1].sharedBranch);
  });
});