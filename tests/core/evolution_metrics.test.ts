import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { collectEvolutionMetrics } from "../../src/core/evolution_metrics.js";

describe("evolution_metrics", () => {
  let stateDir: string;

  beforeEach(async () => {
    stateDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-evolution-metrics-"));
  });

  afterEach(async () => {
    await fs.rm(stateDir, { recursive: true, force: true });
  });

  it("collects and persists metrics", async () => {
    const now = new Date().toISOString();
    await fs.writeFile(path.join(stateDir, "athena_postmortems.json"), JSON.stringify([{ model: "deterministic" }]), "utf8");
    await fs.writeFile(path.join(stateDir, "progress.txt"), `[${now}] [JESUS] awakening\n`, "utf8");
    await fs.writeFile(path.join(stateDir, "premium_usage_log.json"), JSON.stringify([{ timestamp: now }]), "utf8");
    await fs.writeFile(path.join(stateDir, "slo_metrics_history.json"), JSON.stringify([{ totalCycleDurationMs: 20 }, { totalCycleDurationMs: 10 }]), "utf8");
    await fs.writeFile(path.join(stateDir, "jesus_directive.json"), JSON.stringify({ prometheusAnalysis: { projectHealth: "green" } }), "utf8");

    const metrics = await collectEvolutionMetrics({ paths: { stateDir } });
    assert.equal(metrics.deterministicPostmortem.totalCount, 1);
    assert.equal(metrics.jesusAiCallsPerDay, 1);
    assert.equal(metrics.premiumRequestsPerDay, 1);
    assert.equal(metrics.cycleWallClockP50Ms, 15);
    const saved = JSON.parse(await fs.readFile(path.join(stateDir, "evolution_metrics.json"), "utf8"));
    assert.equal(saved.jesusContextCorrect, true);
  });

  it("negative path: handles missing input files deterministically", async () => {
    const metrics = await collectEvolutionMetrics({ paths: { stateDir } });
    assert.equal(metrics.deterministicPostmortem.totalCount, 0);
    assert.equal(metrics.premiumRequestsPerDay, 0);
    assert.equal(metrics.jesusContextCorrect, false);
  });
});

