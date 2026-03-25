import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeNextWaves, computeFrontier, microBatch } from "../../src/core/dag_scheduler.js";

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

    it("uses default maxConcurrent of 3", () => {
      const items = Array.from({ length: 7 }, (_, i) => ({ task: `T${i}` }));
      const batches = microBatch(items);
      assert.equal(batches[0].length, 3);
    });
  });
});
