/**
 * Tests for src/workers/run_task.js entry-point validation logic.
 *
 * We exercise the env-var validation path by spawning the module as a
 * child process and inspecting exit code + stderr output, which keeps
 * the test isolated and deterministic.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.resolve(__dirname, "../../src/workers/run_task.ts");

function run(env = {}) {
  return spawnSync(process.execPath, ["--import", "tsx", ENTRY], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}

describe("run_task.js — containerised worker entry point", () => {
  it("exits 1 and reports missing vars when all required env vars are absent", () => {
    const result = run({
      WORKER_ROLE: "",
      TASK_PAYLOAD: "",
      TARGET_REPO: "",
      GITHUB_TOKEN: "",
    });
    assert.equal(result.status, 1, "expected exit code 1");
    assert.match(result.stderr, /Missing required environment variable/);
  });

  it("exits 1 when TASK_PAYLOAD is not valid JSON", () => {
    const result = run({
      WORKER_ROLE: "noah",
      TASK_PAYLOAD: "not-json",
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 1, "expected exit code 1 for bad JSON");
    assert.match(result.stderr, /not valid JSON/);
  });

  it("exits 0 and logs startup info when all env vars are valid", () => {
    const task = JSON.stringify({ id: "t-1", kind: "devops" });
    const result = run({
      WORKER_ROLE: "noah",
      TASK_PAYLOAD: task,
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 0, `expected exit 0, got stderr: ${result.stderr}`);
    assert.match(result.stdout, /role=noah/);
    assert.match(result.stdout, /id=t-1/);
  });
});
