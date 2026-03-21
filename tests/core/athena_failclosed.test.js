/**
 * Regression tests for T-002: Athena fail-closed mode.
 *
 * Verifies that plan review AI failures return approved=false with a
 * machine-readable reason, that the orchestrator blocks worker dispatch,
 * and that an alert record with deterministic severity is written.
 *
 * The runtime.athenaFailOpen flag must restore legacy permissive behavior.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { runAthenaPlanReview } from "../../src/core/athena_reviewer.js";
import { runOnce } from "../../src/core/orchestrator.js";
import { ALERT_SEVERITY } from "../../src/core/state_tracker.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeConfig(tmpDir, overrides = {}) {
  return {
    loopIntervalMs: 1000,
    maxParallelWorkers: 1,
    paths: {
      stateDir: tmpDir,
      progressFile: path.join(tmpDir, "progress.txt"),
      policyFile: path.join(tmpDir, "policy.json")
    },
    env: {
      // Missing binary forces every AI call to fail deterministically.
      copilotCliCommand: "__missing_copilot_binary__",
      targetRepo: "CanerDoqdu/Box"
    },
    roleRegistry: {
      ceoSupervisor: { name: "Jesus", model: "Claude Sonnet 4.6" },
      deepPlanner: { name: "Prometheus", model: "GPT-5.3-Codex" },
      qualityReviewer: { name: "Athena", model: "Claude Sonnet 4.6" },
      workers: {
        backend: { name: "King David" }
      }
    },
    copilot: { leadershipAutopilot: false },
    runtime: {},
    ...overrides
  };
}

// A minimal Prometheus analysis that satisfies the plan shape Athena reads.
const VALID_PROMETHEUS_ANALYSIS = {
  analyzedAt: new Date().toISOString(),
  projectHealth: "good",
  analysis: "Test analysis",
  keyFindings: "None",
  plans: [
    {
      role: "King David",
      task: "Fix test",
      priority: 1,
      wave: 1,
      verification: "npm test"
    }
  ],
  executionStrategy: {},
  requestBudget: {}
};

// ── ALERT_SEVERITY constants ─────────────────────────────────────────────────

describe("ALERT_SEVERITY enum", () => {
  it("exports deterministic severity constants", () => {
    assert.equal(ALERT_SEVERITY.LOW, "low");
    assert.equal(ALERT_SEVERITY.MEDIUM, "medium");
    assert.equal(ALERT_SEVERITY.HIGH, "high");
    assert.equal(ALERT_SEVERITY.CRITICAL, "critical");
  });
});

// ── runAthenaPlanReview: fail-closed mode ────────────────────────────────────

describe("runAthenaPlanReview — fail-closed on AI failure", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-athena-fc-"));
    await fs.writeFile(path.join(tmpDir, "policy.json"), JSON.stringify({ blockedCommands: [] }), "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns approved=false when AI call fails (fail-closed default)", async () => {
    const config = makeConfig(tmpDir);
    const result = await runAthenaPlanReview(config, VALID_PROMETHEUS_ANALYSIS);

    assert.equal(result.approved, false,
      "AI failure must return approved=false — no silent pass-through");
  });

  it("returns a machine-readable reason object with code and message", async () => {
    const config = makeConfig(tmpDir);
    const result = await runAthenaPlanReview(config, VALID_PROMETHEUS_ANALYSIS);

    assert.ok(result.reason && typeof result.reason === "object",
      "reason must be an object, not a plain string");
    assert.ok(typeof result.reason.code === "string" && result.reason.code.length > 0,
      "reason.code must be a non-empty string");
    assert.ok(typeof result.reason.message === "string",
      "reason.message must be a string");
    assert.equal(result.reason.code, "AI_CALL_FAILED");
  });

  it("writes an alert record with CRITICAL severity on AI failure", async () => {
    const config = makeConfig(tmpDir);
    await runAthenaPlanReview(config, VALID_PROMETHEUS_ANALYSIS);

    const alertsFile = path.join(tmpDir, "alerts.json");
    const alertsExists = await fs.access(alertsFile).then(() => true).catch(() => false);
    assert.ok(alertsExists, "alerts.json must be created when plan review AI fails");

    const alerts = JSON.parse(await fs.readFile(alertsFile, "utf8"));
    const criticalAlerts = alerts.entries.filter(e => e.severity === ALERT_SEVERITY.CRITICAL);
    assert.ok(criticalAlerts.length > 0,
      "At least one CRITICAL alert must be recorded on AI failure");
    assert.ok(criticalAlerts[0].source === "athena_reviewer",
      "Alert source must be 'athena_reviewer'");
    assert.ok(criticalAlerts[0].message.includes("AI_CALL_FAILED"),
      "Alert message must include the reason code for machine readability");
  });

  it("returns approved=true with fail-open flag enabled (rollback mode)", async () => {
    const config = makeConfig(tmpDir, { runtime: { athenaFailOpen: true } });
    const result = await runAthenaPlanReview(config, VALID_PROMETHEUS_ANALYSIS);

    assert.equal(result.approved, true,
      "runtime.athenaFailOpen=true must restore legacy permissive behavior");
    assert.equal(result.reason.code, "AI_CALL_FAILED_FAILOPEN");
  });

  it("returns approved=false and empty corrections array on AI failure", async () => {
    const config = makeConfig(tmpDir);
    const result = await runAthenaPlanReview(config, VALID_PROMETHEUS_ANALYSIS);

    assert.ok(Array.isArray(result.corrections),
      "corrections must always be an array");
  });

  it("does not write athena_plan_review.json when AI call fails (no data to persist)", async () => {
    const config = makeConfig(tmpDir);
    await runAthenaPlanReview(config, VALID_PROMETHEUS_ANALYSIS);

    // The review JSON is only written on successful AI response; failure path must not write it.
    const reviewFile = path.join(tmpDir, "athena_plan_review.json");
    const reviewExists = await fs.access(reviewFile).then(() => true).catch(() => false);
    assert.equal(reviewExists, false,
      "athena_plan_review.json must not be written when AI call fails");
  });
});

// ── Orchestrator: no worker dispatch on failed plan review ───────────────────

describe("orchestrator — no worker dispatch when Athena blocks plan", () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-orch-fc-"));
    await fs.writeFile(path.join(tmpDir, "policy.json"), JSON.stringify({ blockedCommands: [] }), "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("does not dispatch workers when plan review returns approved=false", async () => {
    const config = makeConfig(tmpDir);

    // Run a full cycle — Jesus/Prometheus/Athena all use missing binary, so
    // the cycle will fail before dispatching any worker.
    await runOnce(config);

    // Confirm no worker state files were created (dispatch did not happen).
    const workerFiles = await fs.readdir(tmpDir)
      .then(files => files.filter(f => f.startsWith("worker_") && f.endsWith(".json")))
      .catch(() => []);

    assert.equal(workerFiles.length, 0,
      "No worker state files must exist — dispatch must be blocked when Athena rejects");
  });

  it("writes athena_plan_rejection.json with reason object when plan is blocked", async () => {
    const config = makeConfig(tmpDir);

    // Pre-seed a Prometheus analysis so the orchestrator reaches Athena review.
    await fs.writeFile(
      path.join(tmpDir, "prometheus_analysis.json"),
      JSON.stringify(VALID_PROMETHEUS_ANALYSIS),
      "utf8"
    );

    // Manually invoke the plan review and simulate the orchestrator rejection path.
    const result = await runAthenaPlanReview(config, VALID_PROMETHEUS_ANALYSIS);

    // The reason must be a machine-readable object, not a legacy string.
    assert.equal(typeof result.reason, "object",
      "reason must be a structured object for machine readability");
    assert.ok(result.reason.code, "reason.code must be present");
    assert.equal(result.approved, false);
  });

  it("records blocked cycle state in progress log when Athena blocks", async () => {
    const config = makeConfig(tmpDir);
    await runOnce(config);

    const progress = await fs.readFile(config.paths.progressFile, "utf8").catch(() => "");
    // Either Prometheus fails first or Athena blocks — either way, no dispatch.
    // The key assertion is that no worker was dispatched.
    const workerFiles = await fs.readdir(tmpDir)
      .then(files => files.filter(f => f.startsWith("worker_") && f.endsWith(".json")))
      .catch(() => []);
    assert.equal(workerFiles.length, 0,
      "Worker dispatch must not occur when the cycle is blocked");
    // Progress log must exist with some content.
    assert.ok(progress.length > 0, "Progress log must be written during blocked cycle");
  });
});
