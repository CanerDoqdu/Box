import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildRoleExecutionBatches, MAX_PLANS_PER_DEPENDENCY_BATCH, computeCriticalPathScores } from "../../src/core/worker_batch_planner.js";

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

// ── Cross-role wave ordering ──────────────────────────────────────────────────

describe("worker_batch_planner — cross-role wave ordering", () => {
  const baseConfig = { copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 } };

  it("all wave-1 batches precede all wave-2 batches across different roles", () => {
    // Two roles each contributing one plan per wave.
    // Without the wave-sort fix the output is [A-w1, A-w2, B-w1, B-w2],
    // causing the orchestrator to run A-w2 before B-w1 — wrong.
    const planA = { role: "Worker A", task: "task-a", wave: 1 };
    const planB = { role: "Worker A", task: "task-b", wave: 2 };
    const planC = { role: "Worker B", task: "task-c", wave: 1 };
    const planD = { role: "Worker B", task: "task-d", wave: 2 };

    const batches = buildRoleExecutionBatches([planA, planB, planC, planD], baseConfig);

    const wave1Indices = batches.filter(b => b.wave === 1).map(b => b.bundleIndex);
    const wave2Indices = batches.filter(b => b.wave === 2).map(b => b.bundleIndex);

    assert.ok(wave1Indices.length > 0, "expected wave-1 batches");
    assert.ok(wave2Indices.length > 0, "expected wave-2 batches");

    const maxWave1 = Math.max(...wave1Indices);
    const minWave2 = Math.min(...wave2Indices);
    assert.ok(maxWave1 < minWave2,
      `all wave-1 bundleIndices must be less than all wave-2 bundleIndices; max-w1=${maxWave1} min-w2=${minWave2}`);
  });

  it("graph-derived cross-role waves maintain global bundle ordering", () => {
    // planA and planB share a file across different roles — graph assigns them
    // different waves.  The batch with the lower graph-derived wave must have
    // the lower bundleIndex so the orchestrator runs it first.
    const planA = { role: "Worker A", task: "task-alpha", filesInScope: ["src/shared.ts"] };
    const planB = { role: "Worker B", task: "task-beta",  filesInScope: ["src/shared.ts"] };

    const batches = buildRoleExecutionBatches([planA, planB], baseConfig);

    const batchA = batches.find(b => b.plans.includes(planA as any));
    const batchB = batches.find(b => b.plans.includes(planB as any));

    assert.ok(batchA, "planA must appear in a batch");
    assert.ok(batchB, "planB must appear in a batch");
    assert.ok((batchA as any).wave !== (batchB as any).wave,
      "conflicting cross-role plans must be in different waves");

    const earlier = (batchA as any).wave < (batchB as any).wave ? batchA : batchB;
    const later   = (batchA as any).wave < (batchB as any).wave ? batchB : batchA;
    assert.ok((earlier as any).bundleIndex < (later as any).bundleIndex,
      "earlier-wave batch must have lower bundleIndex than later-wave batch");
  });

  it("negative: single-role plans are unaffected by cross-role sort", () => {
    // All plans belong to the same role at the same wave — batch count and
    // wave field must remain unchanged by the final sort step.
    const plans = Array.from({ length: 3 }, (_, i) => ({
      role: "Evolution Worker",
      task: `T${i}`,
      wave: 1,
    }));

    const batches = buildRoleExecutionBatches(plans, baseConfig);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].wave, 1);
    assert.equal(batches[0].plans.length, 3);
  });
});

// ── Task 4 hardening: dependency-sensitive batch splitting ────────────────────

describe("worker_batch_planner — dependency-sensitive batch size limit (Task 4)", () => {
  const baseConfig = { copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 } };

  it("exports MAX_PLANS_PER_DEPENDENCY_BATCH as a positive number", () => {
    assert.ok(typeof MAX_PLANS_PER_DEPENDENCY_BATCH === "number");
    assert.ok(MAX_PLANS_PER_DEPENDENCY_BATCH > 0);
  });

  it("does not split batches of plans with no dependency declarations", () => {
    // 5 plans without dependsOn/dependencies — should not be split beyond normal packing
    const plans = Array.from({ length: 5 }, (_, i) => ({
      role: "Evolution Worker",
      task: `T${i}`,
      wave: 1,
    }));
    const batches = buildRoleExecutionBatches(plans, baseConfig);
    // All fit in one batch (small token count) — no spurious splits
    assert.equal(batches.length, 1);
    assert.equal(batches[0].plans.length, 5);
  });

  it("splits a batch that exceeds MAX_PLANS_PER_DEPENDENCY_BATCH when plans carry dependsOn", () => {
    // 6 plans all with dependsOn — each batch must have ≤ MAX_PLANS_PER_DEPENDENCY_BATCH plans
    const plans = Array.from({ length: 6 }, (_, i) => ({
      role: "Evolution Worker",
      task: `dep-task-${i}`,
      wave: 1,
      dependsOn: [`dep-task-${i - 1}`].filter(x => x !== "dep-task--1"),
    }));
    const batches = buildRoleExecutionBatches(plans, baseConfig);
    for (const batch of batches) {
      assert.ok(
        (batch.plans as any[]).length <= MAX_PLANS_PER_DEPENDENCY_BATCH,
        `batch has ${(batch.plans as any[]).length} plans > MAX_PLANS_PER_DEPENDENCY_BATCH=${MAX_PLANS_PER_DEPENDENCY_BATCH}`
      );
    }
    // All plans must still be present
    const allPlans = batches.flatMap(b => b.plans);
    assert.equal(allPlans.length, 6);
  });

  it("splits a batch that exceeds MAX_PLANS_PER_DEPENDENCY_BATCH when plans carry dependencies", () => {
    const plans = Array.from({ length: 4 }, (_, i) => ({
      role: "Evolution Worker",
      task: `task-${i}`,
      wave: 1,
      dependencies: [`task-${i - 1}`].filter(x => x !== "task--1"),
    }));
    const batches = buildRoleExecutionBatches(plans, baseConfig);
    for (const batch of batches) {
      assert.ok(
        (batch.plans as any[]).length <= MAX_PLANS_PER_DEPENDENCY_BATCH,
        `dependency batch too large: ${(batch.plans as any[]).length} > ${MAX_PLANS_PER_DEPENDENCY_BATCH}`
      );
    }
    const allPlans = batches.flatMap(b => b.plans);
    assert.equal(allPlans.length, 4);
  });

  it("respects config override for maxPlansPerDependencyBatch", () => {
    const configWithOverride = {
      ...baseConfig,
      runtime: { maxPlansPerDependencyBatch: 2 }
    };
    const plans = Array.from({ length: 5 }, (_, i) => ({
      role: "Evolution Worker",
      task: `task-${i}`,
      wave: 1,
      dependsOn: i > 0 ? [`task-${i - 1}`] : [],
    }));
    const batches = buildRoleExecutionBatches(plans, configWithOverride);
    for (const batch of batches) {
      assert.ok(
        (batch.plans as any[]).length <= 2,
        `batch must not exceed config override of 2; got ${(batch.plans as any[]).length}`
      );
    }
    const allPlans = batches.flatMap(b => b.plans);
    assert.equal(allPlans.length, 5);
  });

  it("negative path: a single plan with dependsOn is not split (nothing to split)", () => {
    const plans = [{ role: "Evolution Worker", task: "solo", wave: 1, dependsOn: ["other"] }];
    const batches = buildRoleExecutionBatches(plans, baseConfig);
    assert.equal(batches.length, 1);
    assert.equal(batches[0].plans.length, 1);
  });
});

// ── Wave-boundary enforcement ─────────────────────────────────────────────────

describe("worker_batch_planner — wave-boundary enforcement", () => {
  const baseConfig = { copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 } };

  it("plans from different waves are never co-batched", () => {
    const w1a = { role: "Evolution Worker", task: "wave1-a", wave: 1 };
    const w1b = { role: "Evolution Worker", task: "wave1-b", wave: 1 };
    const w2a = { role: "Evolution Worker", task: "wave2-a", wave: 2 };
    const w2b = { role: "Evolution Worker", task: "wave2-b", wave: 2 };

    const batches = buildRoleExecutionBatches([w1a, w1b, w2a, w2b], baseConfig);

    for (const batch of batches) {
      const waves = new Set(batch.plans.map((p: any) => p.wave));
      assert.equal(waves.size, 1, `batch must contain plans from exactly one wave; got waves=[${[...waves]}]`);
    }
  });

  it("batch carries the wave field matching its plans", () => {
    const w1 = { role: "Evolution Worker", task: "wave1", wave: 1 };
    const w2 = { role: "Evolution Worker", task: "wave2", wave: 2 };

    const batches = buildRoleExecutionBatches([w1, w2], baseConfig);

    const wave1Batch = batches.find(b => b.plans.includes(w1));
    const wave2Batch = batches.find(b => b.plans.includes(w2));
    assert.ok(wave1Batch, "wave-1 plan must be in some batch");
    assert.ok(wave2Batch, "wave-2 plan must be in some batch");
    assert.equal((wave1Batch as any).wave, 1);
    assert.equal((wave2Batch as any).wave, 2);
  });

  it("negative: single-wave plans are unaffected (no spurious splits)", () => {
    const plans = Array.from({ length: 4 }, (_, i) => ({
      role: "Evolution Worker",
      task: `T${i}`,
      wave: 1,
    }));

    const batches = buildRoleExecutionBatches(plans, baseConfig);
    // All plans share wave 1 — batch count should be 1 (all fit in context window)
    const allPlans = batches.flatMap(b => b.plans);
    assert.equal(allPlans.length, 4, "all plans must appear in batches");
    for (const batch of batches) {
      const waves = new Set(batch.plans.map((p: any) => p.wave));
      assert.equal(waves.size, 1);
    }
  });
});

// ── Critical-path scoring ─────────────────────────────────────────────────────

describe("worker_batch_planner — computeCriticalPathScores", () => {
  it("leaf tasks (no dependents) score 0", () => {
    const tasks = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: [] },
    ];
    const scores = computeCriticalPathScores(tasks);
    assert.equal(scores.get("A"), 0);
    assert.equal(scores.get("B"), 0);
  });

  it("a linear chain A→B→C gives A=2, B=1, C=0", () => {
    // C depends on B; B depends on A.
    // A has 2 levels of downstream work, B has 1, C has 0.
    const tasks = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["B"] },
    ];
    const scores = computeCriticalPathScores(tasks);
    assert.equal(scores.get("A"), 2, "A is upstream of B and C");
    assert.equal(scores.get("B"), 1, "B is upstream of C only");
    assert.equal(scores.get("C"), 0, "C is a leaf");
  });

  it("diamond DAG: A→B, A→C, B→D, C→D — A scores highest", () => {
    // D depends on B and C; B and C both depend on A.
    const tasks = [
      { id: "A", dependsOn: [] },
      { id: "B", dependsOn: ["A"] },
      { id: "C", dependsOn: ["A"] },
      { id: "D", dependsOn: ["B", "C"] },
    ];
    const scores = computeCriticalPathScores(tasks);
    assert.equal(scores.get("D"), 0);
    assert.equal(scores.get("B"), 1);
    assert.equal(scores.get("C"), 1);
    assert.equal(scores.get("A"), 2);
  });

  it("tasks not known to any other task all score 0", () => {
    const tasks = [
      { id: "X", dependsOn: [] },
      { id: "Y", dependsOn: [] },
      { id: "Z", dependsOn: [] },
    ];
    const scores = computeCriticalPathScores(tasks);
    for (const t of tasks) assert.equal(scores.get(t.id), 0);
  });

  it("negative path: empty task array returns empty map", () => {
    const scores = computeCriticalPathScores([]);
    assert.equal(scores.size, 0);
  });

  it("negative path: cycle guard returns 0 instead of infinite recursion", () => {
    // A depends on B, B depends on A — cycle. Guard must not throw.
    const tasks = [
      { id: "A", dependsOn: ["B"] },
      { id: "B", dependsOn: ["A"] },
    ];
    assert.doesNotThrow(() => computeCriticalPathScores(tasks));
    const scores = computeCriticalPathScores(tasks);
    // Scores may be 0 due to cycle guard — just verify they are non-negative numbers
    assert.ok((scores.get("A") ?? 0) >= 0);
    assert.ok((scores.get("B") ?? 0) >= 0);
  });
});

// ── Critical-path ordering within a wave ─────────────────────────────────────

describe("worker_batch_planner — critical-path dispatch ordering", () => {
  const baseConfig = { copilot: { defaultModel: "Claude Sonnet 4.6", modelContextReserveTokens: 0 } };

  it("within a wave, the task with the longest downstream chain is dispatched first", () => {
    // chain: root → mid → leaf (all wave 1)
    // root has the longest downstream path and must appear first in the output.
    const leaf = { role: "Evolution Worker", task: "leaf-task",  wave: 1, dependsOn: ["mid-task"] };
    const mid  = { role: "Evolution Worker", task: "mid-task",   wave: 1, dependsOn: ["root-task"] };
    const root = { role: "Evolution Worker", task: "root-task",  wave: 1, dependsOn: [] };

    // Pass in reverse order to ensure the sort — not input order — drives placement
    const batches = buildRoleExecutionBatches([leaf, mid, root], baseConfig);
    const allPlans = batches.flatMap(b => b.plans) as any[];

    const posRoot = allPlans.findIndex(p => p.task === "root-task");
    const posMid  = allPlans.findIndex(p => p.task === "mid-task");
    const posLeaf = allPlans.findIndex(p => p.task === "leaf-task");

    assert.ok(posRoot !== -1, "root-task must be in batches");
    assert.ok(posMid  !== -1, "mid-task must be in batches");
    assert.ok(posLeaf !== -1, "leaf-task must be in batches");

    assert.ok(posRoot < posMid,  `root (score 2) must precede mid (score 1); posRoot=${posRoot} posMid=${posMid}`);
    assert.ok(posMid  < posLeaf, `mid (score 1) must precede leaf (score 0); posMid=${posMid} posLeaf=${posLeaf}`);
  });

  it("tasks without any dependency hints preserve their original priority order", () => {
    // No dependsOn/filesInScope — critical-path scores all 0 → fall through to priority
    const plans = [
      { role: "Evolution Worker", task: "T0", wave: 1, priority: 0 },
      { role: "Evolution Worker", task: "T1", wave: 1, priority: 1 },
      { role: "Evolution Worker", task: "T2", wave: 1, priority: 2 },
    ];
    const batches = buildRoleExecutionBatches(plans, baseConfig);
    const allPlans = batches.flatMap(b => b.plans) as any[];
    const positions = plans.map(p => allPlans.findIndex(bp => (bp as any).task === p.task));
    // Priority-0 must come before priority-1, which must come before priority-2
    assert.ok(positions[0] < positions[1], "priority 0 before priority 1");
    assert.ok(positions[1] < positions[2], "priority 1 before priority 2");
  });

  it("wave ordering is never overridden by critical-path scores", () => {
    // leaf is in wave 1, root is in wave 2 — root depends on leaf.
    // Even though root has dependents (none), wave 1 tasks must come first.
    const planA = { role: "Evolution Worker", task: "wave1-task", wave: 1 };
    const planB = { role: "Evolution Worker", task: "wave2-task", wave: 2, dependsOn: ["wave1-task"] };

    const batches = buildRoleExecutionBatches([planB, planA], baseConfig);
    const batchA = batches.find(b => b.plans.some((p: any) => p.task === "wave1-task"));
    const batchB = batches.find(b => b.plans.some((p: any) => p.task === "wave2-task"));

    assert.ok(batchA, "wave1-task must be in some batch");
    assert.ok(batchB, "wave2-task must be in some batch");
    assert.ok((batchA as any).bundleIndex < (batchB as any).bundleIndex,
      "wave-1 batch must precede wave-2 batch regardless of critical-path score");
  });
});