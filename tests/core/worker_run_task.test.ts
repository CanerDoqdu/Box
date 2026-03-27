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
import { parseContractHealth, isContractHealthy, formatContractHealth } from "../../src/workers/contract_health.js";

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

// ── Contract health gate ──────────────────────────────────────────────────────

describe("run_task.js — WORKER_CONTRACT_HEALTH runtime gate", () => {
  it("emits WORKER_CONTRACT_HEALTH=env_vars:pass;payload:pass;role:pass on success", () => {
    const task = JSON.stringify({ id: "t-42", kind: "implementation" });
    const result = run({
      WORKER_ROLE: "evolution-worker",
      TASK_PAYLOAD: task,
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 0);
    assert.match(
      result.stdout,
      /WORKER_CONTRACT_HEALTH=env_vars:pass;payload:pass;role:pass/,
      "stdout must contain the full-pass contract health line"
    );
  });

  it("emits WORKER_CONTRACT_HEALTH=env_vars:fail on missing env vars (written to stderr)", () => {
    const result = run({
      WORKER_ROLE: "",
      TASK_PAYLOAD: "",
      TARGET_REPO: "",
      GITHUB_TOKEN: "",
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /WORKER_CONTRACT_HEALTH=env_vars:fail/,
      "stderr must contain env_vars:fail when required env vars are missing"
    );
    assert.match(result.stderr, /payload:n\/a/, "payload must be n/a when env_vars fail");
    assert.match(result.stderr, /role:n\/a/, "role must be n/a when env_vars fail");
  });

  it("emits WORKER_CONTRACT_HEALTH=env_vars:pass;payload:fail on invalid JSON (written to stderr)", () => {
    const result = run({
      WORKER_ROLE: "noah",
      TASK_PAYLOAD: "{broken json",
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      /WORKER_CONTRACT_HEALTH=env_vars:pass;payload:fail/,
      "stderr must show env_vars:pass and payload:fail when JSON is invalid"
    );
    assert.match(result.stderr, /role:n\/a/, "role must be n/a when payload fails to parse");
  });

  it("parseContractHealth correctly parses a full-pass health line", () => {
    const line = "WORKER_CONTRACT_HEALTH=env_vars:pass;payload:pass;role:pass";
    const health = parseContractHealth(line);
    assert.ok(health !== null, "parseContractHealth must return a non-null object for a valid line");
    assert.equal(health!.env_vars, "pass");
    assert.equal(health!.payload, "pass");
    assert.equal(health!.role, "pass");
  });

  it("parseContractHealth correctly parses an env_vars:fail line", () => {
    const line = "WORKER_CONTRACT_HEALTH=env_vars:fail;payload:n/a;role:n/a";
    const health = parseContractHealth(line);
    assert.ok(health !== null);
    assert.equal(health!.env_vars, "fail");
    assert.equal(health!.payload, "n/a");
    assert.equal(health!.role, "n/a");
  });

  it("parseContractHealth returns null for lines without the health marker", () => {
    assert.equal(parseContractHealth(""), null);
    assert.equal(parseContractHealth("[run_task] Worker ready."), null);
    assert.equal(parseContractHealth("BOX_STATUS=done"), null);
  });

  it("isContractHealthy returns true only when all three slots are pass", () => {
    assert.equal(isContractHealthy({ env_vars: "pass", payload: "pass", role: "pass" }), true);
    assert.equal(isContractHealthy({ env_vars: "fail", payload: "pass", role: "pass" }), false);
    assert.equal(isContractHealthy({ env_vars: "pass", payload: "n/a", role: "pass" }), false);
    assert.equal(isContractHealthy({ env_vars: "pass", payload: "pass", role: "fail" }), false);
  });

  it("formatContractHealth produces a deterministic, machine-parseable line", () => {
    const health = { env_vars: "pass" as const, payload: "pass" as const, role: "pass" as const };
    const line = formatContractHealth(health);
    assert.equal(line, "WORKER_CONTRACT_HEALTH=env_vars:pass;payload:pass;role:pass");
    const parsed = parseContractHealth(line);
    assert.deepEqual(parsed, health);
  });

  it("negative: contract health gate is unhealthy when env_vars fail", () => {
    const result = run({
      WORKER_ROLE: "",
      TASK_PAYLOAD: JSON.stringify({ id: "t-1" }),
      TARGET_REPO: "",
      GITHUB_TOKEN: "",
    });
    assert.equal(result.status, 1);
    const combinedOutput = result.stderr + result.stdout;
    const healthLine = combinedOutput.split("\n").find(l => l.includes("WORKER_CONTRACT_HEALTH="));
    assert.ok(healthLine, "WORKER_CONTRACT_HEALTH line must appear in combined output");
    const health = parseContractHealth(healthLine!);
    assert.ok(health !== null);
    assert.equal(isContractHealthy(health!), false,
      "startup contract must not be healthy when required env vars are missing"
    );
  });
});
