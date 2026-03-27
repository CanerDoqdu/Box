import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeNextWaves, computeFrontier, microBatch, computeCriticalPathLength, computeWaveParallelismBound, conflictAwareMicroBatch } from "../../src/core/dag_scheduler.js";

describe("dag_scheduler", () => {
  describe("computeNextWaves", () => {
    it("returns all_done for empty plans", () => {
      const result = computeNextWaves([]);
      assert.equal(result.status, "all_done");
      assert.equal(result.readyWaves.length, 0);
    });

    it("produces waves for independent plans", () => {
      const plans = [
        { task: "A", role: "wA", dependencies: [] },
        { task: "B", role: "wB", dependencies: [] },
      ];
      const result = computeNextWaves(plans);
      assert.equal(result.status, "ok");
      assert.ok(result.readyWaves.length >= 1);
      // Both independent tasks should be in wave 1
      const allTasks = result.readyWaves.flat().map(p => p.task);
      assert.ok(allTasks.includes("A"));
      assert.ok(allTasks.includes("B"));
    });

    it("excludes completed tasks", () => {
      const plans = [
        { task: "A", role: "wA", dependencies: [] },
        { task: "B", role: "wB", dependencies: [] },
      ];
      const result = computeNextWaves(plans, new Set(["A"]));
      assert.equal(result.status, "ok");
      const allTasks = result.readyWaves.flat().map(p => p.task);
      assert.ok(!allTasks.includes("A"));
      assert.ok(allTasks.includes("B"));
    });

    it("returns all_done when all tasks completed", () => {
      const plans = [{ task: "A", role: "wA", dependencies: [] }];
      const result = computeNextWaves(plans, new Set(["A"]));
      assert.equal(result.status, "all_done");
    });

    it("blocks plans with failed dependencies", () => {
      const plans = [
        { task: "A", role: "wA", dependencies: [] },
        { task: "B", role: "wB", dependencies: ["A"] },
      ];
      const result = computeNextWaves(plans, new Set(), new Set(["A"]));
      assert.ok(result.blocked.length > 0);
      assert.ok(result.blocked.some(p => p.task === "B"));
    });

    it("produces sequential waves for chained dependencies", () => {
      const plans = [
        { task: "A", role: "wA", dependencies: [] },
        { task: "B", role: "wB", dependencies: ["A"] },
      ];
      const result = computeNextWaves(plans);
      assert.equal(result.status, "ok");
      // A should be in wave 1, B should be in wave 2 (or only A in wave 1)
      const wave1Tasks = result.readyWaves[0]?.map(p => p.task) || [];
      assert.ok(wave1Tasks.includes("A"));
    });

    it("returns deadlocked when no tasks are schedulable", () => {
      const plans = [
        { task: "B", role: "wB", dependencies: ["A"] }, // A doesn't exist in plans
      ];
      const result = computeNextWaves(plans, new Set(), new Set(["A"]));
      // B depends on failed A → blocked
      assert.ok(result.blocked.length > 0 || result.status === "deadlocked");
    });
  });

  describe("computeFrontier (Packet 6)", () => {
    it("returns all independent tasks as frontier", () => {
      const plans = [
        { task: "A", dependencies: [] },
        { task: "B", dependencies: [] },
        { task: "C", dependencies: ["A"] },
      ];
      const result = computeFrontier(plans, new Set(), new Set(), new Set());
      const tasks = result.frontier.map(p => p.task);
      assert.ok(tasks.includes("A"));
      assert.ok(tasks.includes("B"));
      assert.ok(!tasks.includes("C"));
    });

    it("promotes task once dependencies completed", () => {
      const plans = [
        { task: "A", dependencies: [] },
        { task: "B", dependencies: ["A"] },
      ];
      const result = computeFrontier(plans, new Set(["A"]), new Set(), new Set());
      assert.ok(result.frontier.some(p => p.task === "B"));
    });

    it("excludes in-progress tasks", () => {
      const plans = [
        { task: "A", dependencies: [] },
        { task: "B", dependencies: [] },
      ];
      const result = computeFrontier(plans, new Set(), new Set(), new Set(["A"]));
      assert.ok(!result.frontier.some(p => p.task === "A"));
      assert.ok(result.frontier.some(p => p.task === "B"));
    });

    it("returns empty if all completed", () => {
      const plans = [{ task: "A", dependencies: [] }];
      const result = computeFrontier(plans, new Set(["A"]), new Set(), new Set());
      assert.equal(result.frontier.length, 0);
      assert.equal(result.status, "all_done");
    });
  });

  describe("microBatch (Packet 6)", () => {
    it("splits frontier into bounded batches", () => {
      const items = [{ task: "A" }, { task: "B" }, { task: "C" }, { task: "D" }, { task: "E" }];
      const batches = microBatch(items, { maxConcurrent: 2 });
      assert.equal(batches.length, 3);
      assert.equal(batches[0].length, 2);
      assert.equal(batches[2].length, 1);
    });

    it("returns single batch when under limit", () => {
      const items = [{ task: "A" }];
      const batches = microBatch(items, { maxConcurrent: 5 });
      assert.equal(batches.length, 1);
    });

    it("uses default maxConcurrent of 3 when no graph info provided", () => {
      const items = Array.from({ length: 7 }, (_, i) => ({ task: `T${i}` }));
      const batches = microBatch(items);
      assert.equal(batches[0].length, 3);
    });

    it("derives concurrency from criticalPathLength when provided", () => {
      // 6 tasks, critical path length 3 → bound = ceil(6/3) = 2
      const items = Array.from({ length: 6 }, (_, i) => ({ task: `T${i}` }));
      const batches = microBatch(items, { criticalPathLength: 3 });
      assert.equal(batches[0].length, 2);
      assert.equal(batches.length, 3);
    });

    it("explicit maxConcurrent takes precedence over criticalPathLength", () => {
      const items = Array.from({ length: 6 }, (_, i) => ({ task: `T${i}` }));
      // criticalPathLength would give 2, but maxConcurrent=4 wins
      const batches = microBatch(items, { maxConcurrent: 4, criticalPathLength: 3 });
      assert.equal(batches[0].length, 4);
    });
  });
});

describe("dag_scheduler — critical path utilities", () => {
  it("computeCriticalPathLength returns 1 for empty graph", () => {
    assert.equal(computeCriticalPathLength({}), 1);
    assert.equal(computeCriticalPathLength({ waves: [] }), 1);
  });

  it("computeCriticalPathLength returns max wave number", () => {
    const graph = { waves: [{ wave: 1, taskIds: ["A"] }, { wave: 2, taskIds: ["B"] }, { wave: 3, taskIds: ["C"] }] };
    assert.equal(computeCriticalPathLength(graph), 3);
  });

  it("computeWaveParallelismBound distributes tasks evenly across stages", () => {
    // 9 tasks, critical path 3 → ceil(9/3) = 3
    assert.equal(computeWaveParallelismBound(9, 3), 3);
    // 10 tasks, critical path 1 → ceil(10/1) = 10 → clamped to max 8
    assert.equal(computeWaveParallelismBound(10, 1), 8);
    // 1 task → bound = 1
    assert.equal(computeWaveParallelismBound(1, 5), 1);
  });

  it("computeWaveParallelismBound respects min/max opts", () => {
    assert.equal(computeWaveParallelismBound(2, 10, { min: 1, max: 4 }), 1);
    assert.equal(computeWaveParallelismBound(100, 1, { min: 1, max: 4 }), 4);
  });

  it("computeWaveParallelismBound returns min for invalid inputs", () => {
    assert.equal(computeWaveParallelismBound(0, 3), 1);
    assert.equal(computeWaveParallelismBound(5, 0), 1);
  });
});

// ── conflictAwareMicroBatch ───────────────────────────────────────────────────

describe("dag_scheduler — conflictAwareMicroBatch", () => {
  it("returns empty array for empty frontier", () => {
    const result = conflictAwareMicroBatch([], []);
    assert.deepEqual(result, []);
  });

  it("behaves like microBatch when no conflict pairs are provided", () => {
    const tasks = Array.from({ length: 6 }, (_, i) => ({ task: `T${i}` }));
    const plain = microBatch(tasks, { maxConcurrent: 2 });
    const aware = conflictAwareMicroBatch(tasks, [], { maxConcurrent: 2 });
    assert.equal(aware.length, plain.length);
    for (let i = 0; i < plain.length; i++) {
      assert.equal(aware[i].length, plain[i].length);
    }
  });

  it("places two conflicting tasks into different batches", () => {
    const taskA = { task: "task-a" };
    const taskB = { task: "task-b" };
    const taskC = { task: "task-c" };
    const batches = conflictAwareMicroBatch(
      [taskA, taskB, taskC],
      [["task-a", "task-b"]],
      { maxConcurrent: 3 }
    );
    // taskA and taskB conflict — they must not share a batch
    const coexist = batches.some(b => b.includes(taskA) && b.includes(taskB));
    assert.equal(coexist, false, "conflicting tasks must not appear in the same batch");
  });

  it("non-conflicting task is packed into the same batch as a conflicting task", () => {
    const taskA = { task: "task-a" };
    const taskB = { task: "task-b" };
    const taskC = { task: "task-c" };
    const batches = conflictAwareMicroBatch(
      [taskA, taskB, taskC],
      [["task-a", "task-b"]],
      { maxConcurrent: 3 }
    );
    // taskC conflicts with neither — it should be packed alongside taskA or taskB
    const cWithA = batches.some(b => b.includes(taskA) && b.includes(taskC));
    const cWithB = batches.some(b => b.includes(taskB) && b.includes(taskC));
    assert.ok(cWithA || cWithB, "non-conflicting task must be co-batched with one of the conflicting tasks");
  });

  it("respects maxConcurrent even when there are no conflicts", () => {
    const tasks = Array.from({ length: 5 }, (_, i) => ({ task: `T${i}` }));
    const batches = conflictAwareMicroBatch(tasks, [], { maxConcurrent: 2 });
    for (const batch of batches) {
      assert.ok(batch.length <= 2, `batch size must not exceed maxConcurrent=2; got ${batch.length}`);
    }
    assert.equal(batches.length, 3); // ceil(5/2) = 3
  });

  it("all tasks appear in exactly one batch (no loss, no duplication)", () => {
    const tasks = Array.from({ length: 7 }, (_, i) => ({ task: `T${i}` }));
    const conflicts: Array<[string, string]> = [["T0", "T1"], ["T2", "T3"], ["T0", "T4"]];
    const batches = conflictAwareMicroBatch(tasks, conflicts, { maxConcurrent: 4 });
    const all = batches.flat();
    assert.equal(all.length, tasks.length, "total task count across all batches must equal frontier length");
    for (const task of tasks) {
      const count = all.filter(t => t === task).length;
      assert.equal(count, 1, `each task must appear in exactly one batch; ${(task as any).task} appeared ${count} times`);
    }
  });

  it("uses criticalPathLength to derive maxConcurrent when explicit value is absent", () => {
    // 6 tasks, critical path 3 → bound = ceil(6/3) = 2
    const tasks = Array.from({ length: 6 }, (_, i) => ({ task: `T${i}` }));
    const batches = conflictAwareMicroBatch(tasks, [], { criticalPathLength: 3 });
    assert.equal(batches[0].length, 2, "first batch must contain 2 tasks when criticalPathLength=3 and 6 tasks");
  });

  it("explicit maxConcurrent takes precedence over criticalPathLength", () => {
    const tasks = Array.from({ length: 6 }, (_, i) => ({ task: `T${i}` }));
    // criticalPathLength gives bound=2, but maxConcurrent=4 wins
    const batches = conflictAwareMicroBatch(tasks, [], { maxConcurrent: 4, criticalPathLength: 3 });
    assert.equal(batches[0].length, 4);
  });

  it("negative: fully conflicting chain forces one task per batch", () => {
    // Every pair conflicts — each task must be in its own batch
    const tasks = [{ task: "X" }, { task: "Y" }, { task: "Z" }];
    const conflicts: Array<[string, string]> = [["X", "Y"], ["Y", "Z"], ["X", "Z"]];
    const batches = conflictAwareMicroBatch(tasks, conflicts, { maxConcurrent: 10 });
    assert.equal(batches.length, 3, "fully-conflicting tasks must each be in a separate batch");
    for (const batch of batches) {
      assert.equal(batch.length, 1, "each batch must contain exactly one task in the fully-conflicting case");
    }
  });

  it("wave invariant: frontier tasks are all wave-ready; conflict separation does not reorder them", () => {
    // Simulate a frontier of wave-2 tasks (dependencies satisfied)
    const w2a = { task: "w2-a", wave: 2 };
    const w2b = { task: "w2-b", wave: 2 };
    const w2c = { task: "w2-c", wave: 2 };
    const batches = conflictAwareMicroBatch(
      [w2a, w2b, w2c],
      [["w2-a", "w2-b"]],
      { maxConcurrent: 3 }
    );
    // All tasks must appear; no task from a different wave should be injected
    const all = batches.flat() as typeof w2a[];
    assert.equal(all.length, 3);
    for (const task of all) {
      assert.equal(task.wave, 2, "all batched tasks must remain in wave 2");
    }
    // w2a and w2b must still be in separate batches
    const conflictCoexist = batches.some(b => b.includes(w2a) && b.includes(w2b));
    assert.equal(conflictCoexist, false, "conflicting wave-2 tasks must not share a batch");
  });

  it("uses default maxConcurrent of 3 when no opts provided", () => {
    const tasks = Array.from({ length: 7 }, (_, i) => ({ task: `T${i}` }));
    const batches = conflictAwareMicroBatch(tasks);
    assert.equal(batches[0].length, 3, "default maxConcurrent must be 3 when no opts given");
  });
});
