import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getRoleRegistry } from "../../src/core/role_registry.js";

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
});

