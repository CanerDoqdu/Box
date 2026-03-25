import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runOnce } from "../../src/core/orchestrator.js";

describe("orchestrator startup chain fallback", () => {
  let tmpDir;
  let config;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-startup-chain-"));

    config = {
      loopIntervalMs: 1000,
      maxParallelWorkers: 3,
      paths: {
        stateDir: tmpDir,
        progressFile: path.join(tmpDir, "progress.txt"),
        policyFile: path.join(tmpDir, "policy.json")
      },
      env: {
        // Force all Copilot agent calls (Jesus/Prometheus/Athena) into deterministic fallback paths.
        copilotCliCommand: "__missing_copilot_binary__",
        targetRepo: "CanerDoqdu/Box"
      },
      roleRegistry: {
        ceoSupervisor: { name: "Jesus", model: "Claude Sonnet 4.6" },
        deepPlanner: { name: "Prometheus", model: "GPT-5.3-Codex" },
        leadWorker: { name: "Athena", model: "Claude Sonnet 4.6" },
        workers: {
          backend: { name: "King David" },
          test: { name: "Samuel" }
        }
      },
      copilot: {
        leadershipAutopilot: false
      }
    };

    await fs.writeFile(config.paths.policyFile, JSON.stringify({ blockedCommands: [] }, null, 2), "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("returns early and logs failure when leadership CLI is unavailable", async () => {
    await runOnce(config);

    // In the new architecture (Jesus → Prometheus → Athena → Workers),
    // when the CLI binary is missing, Jesus falls back to a deterministic decision
    // and then Prometheus also fails — no athena plan review file is created.
    const reviewPath = path.join(tmpDir, "athena_plan_review.json");
    const reviewExists = await fs.access(reviewPath).then(() => true).catch(() => false);
    assert.equal(reviewExists, false);

    const progress = await fs.readFile(config.paths.progressFile, "utf8");
    // Jesus AI call fails but returns deterministic fallback, then Prometheus fails
    assert.ok(progress.includes("[JESUS]"));
    assert.ok(progress.includes("[CYCLE]"));
  });
});
