/**
 * evolution_metrics.js — Collects Prometheus proof-of-improvement metrics
 * and persists them to state/evolution_metrics.json.
 *
 * Called at cycle end by the orchestrator.
 */
import path from "node:path";
import fs from "node:fs/promises";
import { readJson, writeJson } from "./fs_utils.js";
import { getCalibrationSummary } from "./jesus_calibration.js";

const WINDOW_24H = 24 * 60 * 60_000;

/**
 * Count lines matching a pattern in progress.txt within a time window.
 * Uses simple substring matching on the raw text.
 */
async function countProgressEntries(stateDir, pattern, windowMs = WINDOW_24H) {
  try {
    const raw = await fs.readFile(path.join(stateDir, "progress.txt"), "utf8");
    const cutoff = Date.now() - windowMs;
    let count = 0;
    for (const line of raw.split("\n")) {
      if (!line.includes(pattern)) continue;
      // Try to extract timestamp from ISO prefix (lines often start with [2026-03-22T...])
      const tsMatch = line.match(/\[(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]/);
      if (tsMatch) {
        const ts = new Date(tsMatch[1]).getTime();
        if (ts < cutoff) continue;
      }
      count += 1;
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Compute deterministic postmortem bypass rate from athena_postmortems.json.
 */
async function computeDeterministicRate(stateDir) {
  const postmortems = await readJson(path.join(stateDir, "athena_postmortems.json"), []);
  if (!Array.isArray(postmortems) || postmortems.length === 0) {
    return { deterministicCount: 0, totalCount: 0, rate: null };
  }
  // Look at last 20 postmortems
  const recent = postmortems.slice(-20);
  const deterministicCount = recent.filter(p => p.model === "deterministic").length;
  return {
    deterministicCount,
    totalCount: recent.length,
    rate: recent.length > 0 ? +(deterministicCount / recent.length).toFixed(3) : null
  };
}

/**
 * Compute cycle wall-clock time p50 from recent pipeline progress records.
 * Reads the current pipeline_progress.json and any historical cycle data.
 */
async function computeCycleTimeP50(stateDir) {
  const sloHistory = await readJson(path.join(stateDir, "slo_metrics_history.json"), []);
  if (!Array.isArray(sloHistory) || sloHistory.length === 0) return null;
  const durations = sloHistory
    .filter(r => r.totalCycleDurationMs > 0)
    .map(r => r.totalCycleDurationMs)
    .sort((a, b) => a - b);
  if (durations.length === 0) return null;
  const mid = Math.floor(durations.length / 2);
  return durations.length % 2 === 0
    ? (durations[mid - 1] + durations[mid]) / 2
    : durations[mid];
}

/**
 * Collect all proof metrics and persist to state/evolution_metrics.json.
 */
export async function collectEvolutionMetrics(config) {
  const stateDir = config.paths?.stateDir || "state";

  const [
    deterministicPostmortem,
    jesusCallsLast24h,
    trustBoundaryViolations24h,
    selfImprovementCalls24h,
    premiumRequests24h,
    cycleTimeP50,
    jesusDirective,
    jesusCalibration
  ] = await Promise.all([
    computeDeterministicRate(stateDir),
    countProgressEntries(stateDir, "[JESUS] awakening"),
    countProgressEntries(stateDir, "[TRUST_BOUNDARY]"),
    countProgressEntries(stateDir, "[SELF_IMPROVEMENT]"),
    readJson(path.join(stateDir, "premium_usage_log.json"), []).then(log => {
      if (!Array.isArray(log)) return 0;
      const cutoff = Date.now() - WINDOW_24H;
      return log.filter(e => new Date(e.timestamp || e.ts || 0).getTime() > cutoff).length;
    }),
    computeCycleTimeP50(stateDir),
    readJson(path.join(stateDir, "jesus_directive.json"), null),
    getCalibrationSummary(stateDir)
  ]);

  const jesusContextCorrect = !!(jesusDirective?.prometheusAnalysis?.projectHealth);

  const metrics = {
    collectedAt: new Date().toISOString(),
    deterministicPostmortem,
    jesusAiCallsPerDay: jesusCallsLast24h,
    cycleWallClockP50Ms: cycleTimeP50,
    trustBoundaryViolations24h,
    selfImprovementCallsPerDay: selfImprovementCalls24h,
    jesusContextCorrect,
    premiumRequestsPerDay: premiumRequests24h,
    jesusCalibration
  };

  await writeJson(path.join(stateDir, "evolution_metrics.json"), metrics);
  return metrics;
}
