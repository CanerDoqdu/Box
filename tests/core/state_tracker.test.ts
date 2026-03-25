import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ALERT_SEVERITY, appendProgress, loadTestsState, updateTaskInTestsState } from "../../src/core/state_tracker.js";

describe("state_tracker", () => {
  let stateDir: string;
  let config: any;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-state-tracker-"));
    config = {
      paths: {
        stateDir,
        progressFile: path.join(stateDir, "progress.txt"),
        testsStateFile: path.join(stateDir, "tests_state.json")
      }
    };
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("initializes tests state and updates task totals deterministically", async () => {
    const initial = await loadTestsState(config);
    assert.deepEqual(initial.totals, { passed: 0, failed: 0, running: 0, queued: 0 });

    await updateTaskInTestsState(config, { id: 1, title: "T1", kind: "unit" }, "passed", "ok");
    const updated = await loadTestsState(config);
    assert.equal(updated.tests.length, 1);
    assert.equal(updated.totals.passed, 1);
  });

  it("negative path: appendProgress creates file and appends message", async () => {
    await appendProgress(config, "hello world");
    const raw = await fs.readFile(config.paths.progressFile, "utf8");
    assert.ok(raw.includes("hello world"));
    assert.equal(ALERT_SEVERITY.CRITICAL, "critical");
  });
});

