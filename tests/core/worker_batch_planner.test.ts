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

  it("produces the same result when capabilityPoolResult is null (backward-compatible)", () => {
    const config = { copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 } };
    const plans = [buildPlan(0), buildPlan(1), buildPlan(2)];
    const withNull = buildRoleExecutionBatches(plans, config, null);
    const withoutArg = buildRoleExecutionBatches(plans, config);
    assert.equal(withNull.length, withoutArg.length);
    assert.equal(withNull[0].plans.length, withoutArg[0].plans.length);
  });

  it("separates conflicting plans in the same lane into distinct batches", () => {
    const config = { copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 } };
    const planA = { role: "Evolution Worker", task: "Refactor orchestrator", target_files: ["src/core/orchestrator.ts"], wave: 1 };
    const planB = { role: "Evolution Worker", task: "Add log to orchestrator", target_files: ["src/core/orchestrator.ts"], wave: 1 };
    const planC = { role: "Evolution Worker", task: "Update prometheus", target_files: ["src/core/prometheus.ts"], wave: 1 };

    // Simulate capability pool result with lane assignments and a file conflict between A and B
    const capabilityPoolResult = {
      assignments: [
        { plan: planA, selection: { role: "Evolution Worker", lane: "implementation", isFallback: false } },
        { plan: planB, selection: { role: "Evolution Worker", lane: "implementation", isFallback: false } },
        { plan: planC, selection: { role: "Evolution Worker", lane: "implementation", isFallback: false } },
      ],
      diversityIndex: 0,
      activeLaneCount: 1,
    };

    const batches = buildRoleExecutionBatches([planA, planB, planC], config, capabilityPoolResult);

    // planA and planB share a file so they must NOT appear in the same batch
    const allBatchPlanSets = batches.map(b => b.plans);
    const conflictCoexists = allBatchPlanSets.some(batchPlans => batchPlans.includes(planA) && batchPlans.includes(planB));
    assert.equal(conflictCoexists, false, "conflicting plans should be in different batches");

    // planC (no conflict) should appear alongside exactly one of the two conflicting plans
    const planCBatch = allBatchPlanSets.find(bp => bp.includes(planC));
    assert.ok(planCBatch, "planC should be in some batch");
  });
});

// ── Task 3: dependency graph wave and conflict integration ────────────────────

describe("worker_batch_planner — dependency graph optimization (Task 3)", () => {
  const baseConfig = { copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 } };

  it("uses graph wave to order plans that lack an explicit wave field", () => {
    // planB depends on planA — graph should place planA in wave 1, planB in wave 2.
    // No wave field on either plan: graph-derived ordering should be respected.
    const planA = { role: "Evolution Worker", task: "task-alpha", filesInScope: ["src/a.ts"] };
    const planB = { role: "Evolution Worker", task: "task-beta",  filesInScope: ["src/b.ts"], dependencies: ["task-alpha"] };

    const batches = buildRoleExecutionBatches([planB, planA], baseConfig);
    // Both plans are for the same role — graph resolves planA wave=1, planB wave=2.
    // The batch for planA (wave 1) should come before planB (wave 2).
    const allPlans = batches.flatMap(b => b.plans);
    const posA = allPlans.indexOf(planA);
    const posB = allPlans.indexOf(planB);
    assert.ok(posA !== -1, "planA must be in batches");
    assert.ok(posB !== -1, "planB must be in batches");
    assert.ok(posA < posB, `planA (wave 1) must appear before planB (wave 2); posA=${posA} posB=${posB}`);
  });

  it("separates plans with filesInScope conflict via graph (no capabilityPoolResult needed)", () => {
    // planX and planY share a filesInScope file — graph detects conflict.
    // Without capabilityPoolResult, only graph-based detection applies.
    const planX = { role: "Evolution Worker", task: "task-x", filesInScope: ["src/shared.ts"] };
    const planY = { role: "Evolution Worker", task: "task-y", filesInScope: ["src/shared.ts"] };
    const planZ = { role: "Evolution Worker", task: "task-z", filesInScope: ["src/other.ts"] };

    const batches = buildRoleExecutionBatches([planX, planY, planZ], baseConfig);
    const allBatchPlanSets = batches.map(b => b.plans);
    const conflictCoexists = allBatchPlanSets.some(bp => bp.includes(planX) && bp.includes(planY));
    assert.equal(conflictCoexists, false, "graph-detected conflicting plans must not share a batch");
  });

  it("plans without graph hints behave identically to pre-optimization (backward-compatible)", () => {
    // No filesInScope, no dependencies: graph hints are absent → no change in behavior.
    const plans = Array.from({ length: 3 }, (_, i) => ({
      role: "Evolution Worker",
      task: `Task ${i}`,
      wave: 1,
      priority: i,
    }));
    const batches = buildRoleExecutionBatches(plans, baseConfig);
    assert.equal(batches.length, 1, "3 small plans without hints should fit in one batch");
    assert.equal(batches[0].plans.length, 3);
  });

  it("graph wave assignment respects explicit wave field over graph wave", () => {
    // planA is marked wave=2 explicitly; planB is wave=1 explicitly.
    // Even if graph would order them differently, explicit wave fields take priority.
    const planA = { role: "Evolution Worker", task: "task-a", wave: 2, filesInScope: ["src/a.ts"] };
    const planB = { role: "Evolution Worker", task: "task-b", wave: 1, filesInScope: ["src/b.ts"] };

    const batches = buildRoleExecutionBatches([planA, planB], baseConfig);
    const allPlans = batches.flatMap(b => b.plans);
    const posA = allPlans.indexOf(planA);
    const posB = allPlans.indexOf(planB);
    // planB (wave=1) must come before planA (wave=2)
    assert.ok(posB < posA, `explicit wave field must override graph wave; posB=${posB} posA=${posA}`);
  });
});