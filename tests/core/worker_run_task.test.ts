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
import { parseContractHealth, isContractHealthy, formatContractHealth, parseStartupContractAnchor, formatStartupContractAnchor, STARTUP_CONTRACT_ANCHOR_KEY } from "../../src/workers/contract_health.js";

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

// ── Carry-forward env/startup contract gap tests ──────────────────────────────

describe("run_task.js — startup ordering and env/startup contract gaps", () => {
  it("env_vars check runs before payload check: env failure reported when both ROLE and PAYLOAD are absent", () => {
    // When WORKER_ROLE is empty and TASK_PAYLOAD is also empty,
    // env_vars:fail must be emitted — not payload:fail — because env check runs first.
    const result = run({
      WORKER_ROLE: "",
      TASK_PAYLOAD: "",
      TARGET_REPO: "",
      GITHUB_TOKEN: "",
    });
    assert.equal(result.status, 1, "must exit 1 when all required vars are absent");
    const health = parseContractHealth(result.stderr);
    assert.ok(health !== null, "WORKER_CONTRACT_HEALTH must appear in stderr");
    assert.equal(health!.env_vars, "fail",
      "env_vars slot must be 'fail' when env vars are absent — env check is first"
    );
    assert.equal(health!.payload, "n/a",
      "payload slot must be 'n/a' when env_vars fails (payload check not reached)"
    );
    assert.equal(health!.role, "n/a",
      "role slot must be 'n/a' when env_vars fails (role check not reached)"
    );
  });

  it("single missing env var triggers env_vars:fail (partial env_vars failure)", () => {
    // Only TARGET_REPO is missing — still an env_vars failure
    const result = run({
      WORKER_ROLE: "evolution-worker",
      TASK_PAYLOAD: JSON.stringify({ id: "t-99", kind: "implementation" }),
      TARGET_REPO: "",            // single missing required var
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 1, "must exit 1 when a single required env var is absent");
    const health = parseContractHealth(result.stderr);
    assert.ok(health !== null, "WORKER_CONTRACT_HEALTH must appear in stderr for single-missing-var failure");
    assert.equal(health!.env_vars, "fail",
      "env_vars must be 'fail' even for a single missing variable"
    );
  });

  it("startup log line appears in stdout before the contract health line on success", () => {
    const task = JSON.stringify({ id: "t-88", kind: "devops" });
    const result = run({
      WORKER_ROLE: "noah",
      TASK_PAYLOAD: task,
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 0, "must exit 0 when all env vars are valid");

    const lines = result.stdout.split("\n").filter(l => l.trim().length > 0);
    const startupIdx = lines.findIndex(l => l.includes("[run_task] Worker container started"));
    const healthIdx  = lines.findIndex(l => l.includes("WORKER_CONTRACT_HEALTH="));

    assert.ok(startupIdx >= 0, "'Worker container started' line must appear in stdout");
    assert.ok(healthIdx >= 0,  "WORKER_CONTRACT_HEALTH line must appear in stdout on success");
    assert.ok(startupIdx < healthIdx,
      "startup log line must appear BEFORE the contract health line (startup ordering contract)"
    );
  });

  it("contract health line appears before 'Worker ready' message on success (health gate is pre-ready)", () => {
    const task = JSON.stringify({ id: "t-77", kind: "infrastructure" });
    const result = run({
      WORKER_ROLE: "evolution-worker",
      TASK_PAYLOAD: task,
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 0);

    const lines = result.stdout.split("\n").filter(l => l.trim().length > 0);
    const healthIdx = lines.findIndex(l => l.includes("WORKER_CONTRACT_HEALTH="));
    const readyIdx  = lines.findIndex(l => l.includes("Worker ready"));

    assert.ok(healthIdx >= 0, "WORKER_CONTRACT_HEALTH line must appear in stdout");
    assert.ok(readyIdx >= 0,  "'Worker ready' message must appear in stdout");
    assert.ok(healthIdx < readyIdx,
      "contract health line must appear BEFORE 'Worker ready' (health gate precedes task dispatch)"
    );
  });

  it("WORKER_ROLE value is echoed in the startup log line for every successful start", () => {
    for (const role of ["noah", "evolution-worker", "quality-worker"]) {
      const task = JSON.stringify({ id: `t-${role}`, kind: "test" });
      const result = run({
        WORKER_ROLE: role,
        TASK_PAYLOAD: task,
        TARGET_REPO: "owner/repo",
        GITHUB_TOKEN: "ghp_fake",
      });
      assert.equal(result.status, 0, `must exit 0 for role=${role}`);
      assert.match(
        result.stdout,
        new RegExp(`role=${role}`),
        `stdout must echo role=${role} in the startup log line`
      );
    }
  });

  it("negative: WORKER_ROLE is NOT echoed to stdout when env_vars check fails", () => {
    const result = run({
      WORKER_ROLE: "",
      TASK_PAYLOAD: "",
      TARGET_REPO: "",
      GITHUB_TOKEN: "",
    });
    assert.equal(result.status, 1);
    // The startup log line that echoes role= must not appear when env check fails
    // (it is written only after env validation passes)
    assert.ok(
      !result.stdout.includes("Worker container started"),
      "startup log must NOT appear in stdout when env_vars check fails — fail-fast before echoing role"
    );
  });
});

// ── Per-variable named env contract tests ────────────────────────────────────

/**
 * These tests verify the exact required env var contract for run_task.ts.
 * Each required variable is tested in isolation so that future renames or
 * additions are caught immediately by a named, scoped failure.
 *
 * Required env vars (authoritative set): WORKER_ROLE, TASK_PAYLOAD, TARGET_REPO, GITHUB_TOKEN
 */
describe("run_task.js — exact named required-env-var contract", () => {
  it("documents the exact required env var set: WORKER_ROLE, TASK_PAYLOAD, TARGET_REPO, GITHUB_TOKEN", () => {
    // This test pins the authoritative required-variable names.
    // If any variable is added or renamed in run_task.ts, this test must be
    // updated to reflect the new contract — preventing silent terminology drift.
    const REQUIRED_ENV_VARS = ["WORKER_ROLE", "TASK_PAYLOAD", "TARGET_REPO", "GITHUB_TOKEN"];

    // Run with all vars absent and confirm each name appears in the error output
    const result = run(
      Object.fromEntries(REQUIRED_ENV_VARS.map(v => [v, ""]))
    );
    assert.equal(result.status, 1, "must exit 1 when all required vars are absent");

    const combined = result.stderr + result.stdout;
    for (const varName of REQUIRED_ENV_VARS) {
      assert.ok(
        combined.includes(varName),
        `required env var '${varName}' must be named in the error output; combined output: ${combined.slice(0, 400)}`
      );
    }
  });

  it("WORKER_ROLE alone missing → env_vars:fail with WORKER_ROLE named in stderr", () => {
    const result = run({
      WORKER_ROLE: "",
      TASK_PAYLOAD: JSON.stringify({ id: "t-wrmissing", kind: "devops" }),
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 1, "must exit 1 when WORKER_ROLE is absent");
    assert.match(result.stderr, /WORKER_ROLE/,
      "stderr must name WORKER_ROLE as the missing variable");
    const health = parseContractHealth(result.stderr);
    assert.ok(health !== null, "WORKER_CONTRACT_HEALTH must be emitted to stderr");
    assert.equal(health!.env_vars, "fail",
      "env_vars must be 'fail' when WORKER_ROLE is missing");
    assert.equal(health!.payload, "n/a",
      "payload must be 'n/a' when env_vars check fails (not reached)");
    assert.equal(health!.role, "n/a",
      "role must be 'n/a' when env_vars check fails (not reached)");
  });

  it("GITHUB_TOKEN alone missing → env_vars:fail with GITHUB_TOKEN named in stderr", () => {
    const result = run({
      WORKER_ROLE: "noah",
      TASK_PAYLOAD: JSON.stringify({ id: "t-ghtoken", kind: "devops" }),
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "",
    });
    assert.equal(result.status, 1, "must exit 1 when GITHUB_TOKEN is absent");
    assert.match(result.stderr, /GITHUB_TOKEN/,
      "stderr must name GITHUB_TOKEN as the missing variable");
    const health = parseContractHealth(result.stderr);
    assert.ok(health !== null, "WORKER_CONTRACT_HEALTH must be emitted to stderr");
    assert.equal(health!.env_vars, "fail",
      "env_vars must be 'fail' when GITHUB_TOKEN is missing");
    assert.equal(health!.payload, "n/a");
    assert.equal(health!.role, "n/a");
  });

  it("TASK_PAYLOAD alone missing → env_vars:fail with TASK_PAYLOAD named in stderr", () => {
    const result = run({
      WORKER_ROLE: "noah",
      TASK_PAYLOAD: "",
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 1, "must exit 1 when TASK_PAYLOAD is absent");
    assert.match(result.stderr, /TASK_PAYLOAD/,
      "stderr must name TASK_PAYLOAD as the missing variable");
    const health = parseContractHealth(result.stderr);
    assert.ok(health !== null, "WORKER_CONTRACT_HEALTH must be emitted to stderr");
    assert.equal(health!.env_vars, "fail",
      "env_vars must be 'fail' when TASK_PAYLOAD is missing (treated as absent by the env check)");
  });

  it("all four required vars present → exits 0 with full-pass contract health on stdout", () => {
    const task = JSON.stringify({ id: "t-allpresent", kind: "implementation" });
    const result = run({
      WORKER_ROLE: "evolution-worker",
      TASK_PAYLOAD: task,
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 0, "must exit 0 when all four required vars are present");
    const health = parseContractHealth(result.stdout);
    assert.ok(health !== null,
      "WORKER_CONTRACT_HEALTH must appear in stdout on success");
    assert.equal(health!.env_vars, "pass");
    assert.equal(health!.payload, "pass");
    assert.equal(health!.role, "pass");
  });
});

// ── Named startup-contract verification anchor ────────────────────────────────

/**
 * STARTUP_CONTRACT_ANCHOR — explicit named verification anchor.
 *
 * These tests pin the named anchor (WORKER_STARTUP_CONTRACT_ANCHOR=verified)
 * that closes carry-forward ambiguity: downstream gates use this line to
 * distinguish a freshly-verified contract from a stale health line carried
 * forward in logs from a previous startup cycle.
 */
describe("run_task.js — STARTUP_CONTRACT_ANCHOR named verification anchor", () => {
  it("STARTUP_CONTRACT_ANCHOR: emits WORKER_STARTUP_CONTRACT_ANCHOR=verified on successful startup", () => {
    const task = JSON.stringify({ id: "t-anchor", kind: "infrastructure" });
    const result = run({
      WORKER_ROLE: "evolution-worker",
      TASK_PAYLOAD: task,
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 0, "must exit 0 for a valid startup");
    assert.ok(
      result.stdout.includes(`${STARTUP_CONTRACT_ANCHOR_KEY}=verified`),
      `stdout must contain '${STARTUP_CONTRACT_ANCHOR_KEY}=verified' to confirm startup-contract verification completed`
    );
  });

  it("STARTUP_CONTRACT_ANCHOR: parseStartupContractAnchor returns true for the anchor line", () => {
    const anchorLine = formatStartupContractAnchor();
    assert.equal(anchorLine, `${STARTUP_CONTRACT_ANCHOR_KEY}=verified`);
    assert.equal(parseStartupContractAnchor(anchorLine), true);
  });

  it("STARTUP_CONTRACT_ANCHOR: parseStartupContractAnchor returns false for unrelated lines", () => {
    assert.equal(parseStartupContractAnchor(""), false);
    assert.equal(parseStartupContractAnchor("WORKER_CONTRACT_HEALTH=env_vars:pass;payload:pass;role:pass"), false);
    assert.equal(parseStartupContractAnchor("BOX_STATUS=done"), false);
    assert.equal(parseStartupContractAnchor("[run_task] Worker ready."), false);
  });

  it("STARTUP_CONTRACT_ANCHOR: anchor appears after contract health line in stdout (post-gate ordering)", () => {
    const task = JSON.stringify({ id: "t-ordering", kind: "devops" });
    const result = run({
      WORKER_ROLE: "noah",
      TASK_PAYLOAD: task,
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 0);

    const lines = result.stdout.split("\n").filter(l => l.trim().length > 0);
    const healthIdx = lines.findIndex(l => l.includes("WORKER_CONTRACT_HEALTH="));
    const anchorIdx = lines.findIndex(l => l.includes(`${STARTUP_CONTRACT_ANCHOR_KEY}=verified`));

    assert.ok(healthIdx >= 0, "WORKER_CONTRACT_HEALTH line must appear in stdout");
    assert.ok(anchorIdx >= 0, `${STARTUP_CONTRACT_ANCHOR_KEY}=verified line must appear in stdout`);
    assert.ok(healthIdx < anchorIdx,
      "contract health line must appear BEFORE the anchor (health gate precedes anchor emission)"
    );
  });

  it("negative: STARTUP_CONTRACT_ANCHOR is NOT emitted when env_vars check fails", () => {
    const result = run({
      WORKER_ROLE: "",
      TASK_PAYLOAD: "",
      TARGET_REPO: "",
      GITHUB_TOKEN: "",
    });
    assert.equal(result.status, 1);
    const combined = result.stdout + result.stderr;
    assert.ok(
      !combined.includes(`${STARTUP_CONTRACT_ANCHOR_KEY}=verified`),
      "startup-contract anchor must NOT appear when env_vars check fails — it is only emitted after all slots pass"
    );
  });

  it("negative: STARTUP_CONTRACT_ANCHOR is NOT emitted when TASK_PAYLOAD is invalid JSON", () => {
    const result = run({
      WORKER_ROLE: "noah",
      TASK_PAYLOAD: "{broken",
      TARGET_REPO: "owner/repo",
      GITHUB_TOKEN: "ghp_fake",
    });
    assert.equal(result.status, 1);
    const combined = result.stdout + result.stderr;
    assert.ok(
      !combined.includes(`${STARTUP_CONTRACT_ANCHOR_KEY}=verified`),
      "startup-contract anchor must NOT appear when payload check fails"
    );
  });
});
