import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { canUseClaude, chargeBudget, loadBudget } from "../../src/core/budget_controller.js";

describe("budget_controller", () => {
  let tmpDir: string;
  let budgetFile: string;
  let config: any;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-budget-"));
    budgetFile = path.join(tmpDir, "budget.json");
    config = { paths: { budgetFile }, env: { budgetUsd: 5 } };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("loads default budget when file does not exist", async () => {
    const budget = await loadBudget(config);
    assert.equal(budget.initialUsd, 5);
    assert.equal(budget.remainingUsd, 5);
    assert.equal(budget.claudeCalls, 0);
    assert.equal(budget.workerRuns, 0);
  });

  it("charges budget and clamps remainingUsd at zero", async () => {
    const budget = await chargeBudget(config, { usd: 9.99, claudeCalls: 2, workerRuns: 1 });
    assert.equal(budget.remainingUsd, 0);
    assert.equal(budget.claudeCalls, 2);
    assert.equal(budget.workerRuns, 1);
  });

  it("negative path: blocks claude usage when remaining budget is too low", () => {
    assert.equal(canUseClaude({ remainingUsd: 0.2 }), false);
    assert.equal(canUseClaude({ remainingUsd: 0.1 }), false);
  });
});

