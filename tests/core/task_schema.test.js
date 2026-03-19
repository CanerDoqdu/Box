import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildSemanticKey,
  validateTaskContract,
  validateQueueTask,
} from "../../src/core/task_schema.js";

const validContract = {
  contractVersion: "1.0",
  domain: "quality",
  goal: "Improve test coverage",
  nonGoals: ["rewrite the app"],
  filesInScope: ["src/utils.js"],
  testsToAdd: ["tests/utils.test.js"],
  exitCriteria: ["all tests pass"],
  rollbackPlan: "revert commit",
  invariants: ["no regressions"],
  riskLevel: "low",
};

const validTask = {
  id: 1,
  semanticKey: "quality::abc123",
  title: "Fix lint errors",
  kind: "quality",
  priority: 2,
  status: "queued",
  source: "roadmap",
  attempt: 1,
  version: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  contract: validContract,
};

describe("buildSemanticKey", () => {
  it("returns a string in kind::hash format", () => {
    const key = buildSemanticKey("quality", "Fix lint errors");
    assert.match(key, /^quality::[a-f0-9]{16}$/);
  });

  it("is deterministic for the same inputs", () => {
    const a = buildSemanticKey("backend", "Add auth middleware");
    const b = buildSemanticKey("backend", "Add auth middleware");
    assert.equal(a, b);
  });

  it("produces different keys for different titles", () => {
    const a = buildSemanticKey("quality", "Fix lint");
    const b = buildSemanticKey("quality", "Add tests");
    assert.notEqual(a, b);
  });

  it("normalizes case and punctuation", () => {
    const a = buildSemanticKey("quality", "Fix lint errors!!!");
    const b = buildSemanticKey("quality", "fix lint errors");
    assert.equal(a, b);
  });
});

describe("validateTaskContract", () => {
  it("accepts a fully valid contract", () => {
    const result = validateTaskContract(validContract);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("rejects a non-object input", () => {
    const result = validateTaskContract(null);
    assert.equal(result.ok, false);
    assert.ok(result.errors.length > 0);
  });

  it("rejects wrong contractVersion", () => {
    const result = validateTaskContract({ ...validContract, contractVersion: "2.0" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("contractVersion")));
  });

  it("rejects invalid domain", () => {
    const result = validateTaskContract({ ...validContract, domain: "unknown" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("domain")));
  });

  it("rejects missing goal", () => {
    const result = validateTaskContract({ ...validContract, goal: "" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("goal")));
  });

  it("rejects empty exitCriteria", () => {
    const result = validateTaskContract({ ...validContract, exitCriteria: [] });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("exitCriteria")));
  });

  it("rejects invalid riskLevel", () => {
    const result = validateTaskContract({ ...validContract, riskLevel: "extreme" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("riskLevel")));
  });

  it("rejects unsafe filesInScope paths", () => {
    const result = validateTaskContract({ ...validContract, filesInScope: ["../secret.env"] });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("unsafe path")));
  });
});

describe("validateQueueTask", () => {
  it("accepts a fully valid task", () => {
    const result = validateQueueTask(validTask);
    assert.equal(result.ok, true);
    assert.equal(result.errors.length, 0);
  });

  it("rejects a non-object input", () => {
    const result = validateQueueTask("not a task");
    assert.equal(result.ok, false);
  });

  it("rejects non-positive id", () => {
    const result = validateQueueTask({ ...validTask, id: 0 });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("id")));
  });

  it("rejects invalid kind", () => {
    const result = validateQueueTask({ ...validTask, kind: "magic" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("kind")));
  });

  it("rejects out-of-range priority", () => {
    const result = validateQueueTask({ ...validTask, priority: 6 });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("priority")));
  });

  it("rejects invalid status", () => {
    const result = validateQueueTask({ ...validTask, status: "unknown" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("status")));
  });

  it("rejects missing semanticKey", () => {
    const result = validateQueueTask({ ...validTask, semanticKey: "" });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("semanticKey")));
  });

  it("validates nested contract errors", () => {
    const result = validateQueueTask({ ...validTask, contract: { ...validContract, riskLevel: "extreme" } });
    assert.equal(result.ok, false);
    assert.ok(result.errors.some(e => e.includes("contract")));
  });
});
