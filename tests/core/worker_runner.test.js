import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseWorkerResponse } from "../../src/core/worker_runner.js";
import { isProcessAlive } from "../../src/core/daemon_control.js";

// ── parseWorkerResponse ──────────────────────────────────────────────────────

describe("parseWorkerResponse", () => {
  it("parses done status when BOX_STATUS=done", () => {
    const result = parseWorkerResponse("BOX_STATUS=done\nSome output", "");
    assert.equal(result.status, "done");
  });

  it("defaults to done when no BOX_STATUS marker is present", () => {
    const result = parseWorkerResponse("Worker completed the task successfully.", "");
    assert.equal(result.status, "done");
  });

  it("parses blocked status", () => {
    const result = parseWorkerResponse("BOX_STATUS=blocked\nCannot access repo", "");
    assert.equal(result.status, "blocked");
  });

  it("parses partial status", () => {
    const result = parseWorkerResponse("BOX_STATUS=partial", "");
    assert.equal(result.status, "partial");
  });

  it("parses error status", () => {
    const result = parseWorkerResponse("", "fatal: not a git repository\nBOX_STATUS=error");
    assert.equal(result.status, "error");
  });

  it("normalizes unknown status values to done", () => {
    const result = parseWorkerResponse("BOX_STATUS=complete", "");
    assert.equal(result.status, "done");
  });

  it("extracts BOX_PR_URL", () => {
    const result = parseWorkerResponse("BOX_PR_URL=https://github.com/org/repo/pull/42", "");
    assert.equal(result.prUrl, "https://github.com/org/repo/pull/42");
  });

  it("returns null prUrl when marker is absent", () => {
    const result = parseWorkerResponse("No PR in this output", "");
    assert.equal(result.prUrl, null);
  });

  it("extracts BOX_BRANCH", () => {
    const result = parseWorkerResponse("BOX_BRANCH=box/feature-auth", "");
    assert.equal(result.currentBranch, "box/feature-auth");
  });

  it("extracts BOX_FILES_TOUCHED as array", () => {
    const result = parseWorkerResponse("BOX_FILES_TOUCHED=src/a.js,src/b.js, src/c.js", "");
    assert.deepEqual(result.filesTouched, ["src/a.js", "src/b.js", "src/c.js"]);
  });

  it("returns empty filesTouched when marker is absent", () => {
    const result = parseWorkerResponse("No files mentioned", "");
    assert.deepEqual(result.filesTouched, []);
  });

  // BOX_ACCESS blocked guardrail — access-blocked output must force status=blocked
  // even if the worker self-reports BOX_STATUS=done. This prevents silent swallowing
  // of blocked access states.
  it("forces status=blocked when BOX_ACCESS reports blocked fields", () => {
    const stdout = [
      "BOX_STATUS=done",
      "BOX_ACCESS=repo:blocked;files:ok;tools:ok;api:ok",
      "I completed the task"
    ].join("\n");
    const result = parseWorkerResponse(stdout, "");
    assert.equal(result.status, "blocked",
      "Worker self-reporting done must be overridden when access is blocked");
  });

  it("does not override status when BOX_ACCESS reports all ok", () => {
    const stdout = [
      "BOX_STATUS=done",
      "BOX_ACCESS=repo:ok;files:ok;tools:ok;api:ok"
    ].join("\n");
    const result = parseWorkerResponse(stdout, "");
    assert.equal(result.status, "done");
  });

  it("does not override status=blocked when BOX_ACCESS also blocked", () => {
    const stdout = "BOX_STATUS=blocked\nBOX_ACCESS=repo:blocked;files:ok;tools:ok;api:ok";
    const result = parseWorkerResponse(stdout, "");
    assert.equal(result.status, "blocked");
  });

  it("includes VERIFICATION_REPORT in verificationReport field", () => {
    const stdout = "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; RESPONSIVE=n/a; API=n/a; EDGE_CASES=pass; SECURITY=pass";
    const result = parseWorkerResponse(stdout, "");
    assert.ok(result.verificationReport, "verificationReport should be populated");
    assert.equal(result.verificationReport.build, "pass");
    assert.equal(result.verificationReport.tests, "pass");
  });

  it("sets verificationReport to null when no VERIFICATION_REPORT marker is present", () => {
    const result = parseWorkerResponse("Task complete. No report.", "");
    assert.equal(result.verificationReport, null);
  });

  it("returns non-empty summary from stdout", () => {
    const result = parseWorkerResponse("I fixed the bug in src/auth.js", "");
    assert.ok(result.summary.length > 0);
  });

  it("returns fullOutput equal to raw stdout", () => {
    const raw = "BOX_STATUS=done\nSome text";
    const result = parseWorkerResponse(raw, "");
    assert.equal(result.fullOutput, raw);
  });
});

// ── daemon-control: isProcessAlive ──────────────────────────────────────────

describe("isProcessAlive", () => {
  it("returns true for the current process pid", () => {
    assert.equal(isProcessAlive(process.pid), true);
  });

  it("returns false for pid 0", () => {
    assert.equal(isProcessAlive(0), false);
  });

  it("returns false for a negative pid", () => {
    assert.equal(isProcessAlive(-1), false);
  });

  it("returns false for a non-numeric value", () => {
    assert.equal(isProcessAlive("not-a-pid"), false);
  });

  it("returns false for a pid that does not exist (very high number)", () => {
    // PID 9999999 is astronomically unlikely to be a real process
    assert.equal(isProcessAlive(9999999), false);
  });
});
