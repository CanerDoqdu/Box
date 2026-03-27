import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getRoleRegistry, LANE_WORKER_NAMES } from "../../src/core/role_registry.js";

describe("role_registry", () => {
  it("returns fallback registry when config is missing", () => {
    const registry = getRoleRegistry(undefined);
    assert.equal(registry.ceoSupervisor.name, "Jesus");
    assert.equal(registry.planner.name, "Prometheus");
    assert.equal(registry.workers.evolution.name, "Evolution Worker");
  });

  it("negative path: merges custom workers without dropping fallback evolution worker", () => {
    const registry = getRoleRegistry({
      roleRegistry: {
        workers: { backend: { id: "worker-backend", name: "Backend Worker", model: "x" } }
      }
    });
    assert.equal(registry.workers.backend.name, "Backend Worker");
    assert.equal(registry.workers.evolution.name, "Evolution Worker");
  });

  it("all six lane workers are registered", () => {
    const registry = getRoleRegistry(undefined);
    const lanes = ["implementation", "quality", "governance", "infrastructure", "integration", "observation"];
    const registeredLanes = Object.values(registry.workers).map((w: any) => w.lane);
    for (const lane of lanes) {
      assert.ok(registeredLanes.includes(lane), `Missing lane worker for: ${lane}`);
    }
  });

  it("LANE_WORKER_NAMES covers all six lanes", () => {
    const expected = ["implementation", "quality", "governance", "infrastructure", "integration", "observation"];
    for (const lane of expected) {
      assert.ok(LANE_WORKER_NAMES[lane], `LANE_WORKER_NAMES missing entry for lane: ${lane}`);
    }
  });

  it("implementation lane maps to Evolution Worker", () => {
    assert.equal(LANE_WORKER_NAMES["implementation"], "Evolution Worker");
  });

  it("non-implementation lanes map to hyphenated worker names", () => {
    assert.equal(LANE_WORKER_NAMES["quality"], "quality-worker");
    assert.equal(LANE_WORKER_NAMES["governance"], "governance-worker");
    assert.equal(LANE_WORKER_NAMES["infrastructure"], "infrastructure-worker");
    assert.equal(LANE_WORKER_NAMES["integration"], "integration-worker");
    assert.equal(LANE_WORKER_NAMES["observation"], "observation-worker");
  });
});


