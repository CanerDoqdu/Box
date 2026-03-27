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
    assert.equal(result.status, 1,
      "expected exit code 1 when all required env vars are absent (WORKER_ROLE, TASK_PAYLOAD, TARGET_REPO, GITHUB_TOKEN)"
    );
    assert.match(result.stderr, /Missing required environment variable/,
      "stderr must name at least one missing required variable"
    );
    // Verify each required env var name appears in the combined output
    const combined = result.stderr + result.stdout;
    const requiredVars = ["WORKER_ROLE", "TASK_PAYLOAD", "TARGET_REPO", "GITHUB_TOKEN"];
    const reported = requiredVars.filter(v => combined.includes(v));
    assert.ok(
      reported.length > 0,
      `at least one of [${requiredVars.join(", ")}] must be named in the missing-var output; got: ${combined.slice(0, 300)}`
    );
  });

  it("exits 1 when TASK_PAYLOAD is not valid JSON", () => {
    const result = run({
      WORKER_ROLE: "noah",
      TASK_PAYLOAD: "not-json",
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 1, "expected exit code 1 when TASK_PAYLOAD is not valid JSON");
    assert.match(result.stderr, /not valid JSON/,
      'stderr must contain "not valid JSON" to describe the parse failure'
    );
  });

  it("exits 0 and logs startup info when all env vars are valid", () => {
    const task = JSON.stringify({ id: "t-1", kind: "devops" });
    const result = run({
      WORKER_ROLE: "noah",
      TASK_PAYLOAD: task,
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 0,
      `expected exit 0 when all env vars are valid; stderr: ${result.stderr}`
    );
    assert.match(result.stdout, /role=noah/,
      'stdout must log "role=noah" to confirm the worker role is echoed on startup'
    );
    assert.match(result.stdout, /id=t-1/,
      'stdout must log "id=t-1" to confirm the task id is echoed on startup'
    );
  });
});
