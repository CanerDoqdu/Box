/**
 * capacity_scoreboard.js — Persists capacity KPIs across cycles.
 *
 * Tracks key metrics over time so Prometheus and Jesus can observe trends
 * rather than point-in-time snapshots.
 *
 * Stored in: state/capacity_scoreboard.json
 */

import path from "node:path";
import { readJson, writeJson } from "./fs_utils.js";

/** Maximum entries to keep in the scoreboard. */
const MAX_ENTRIES = 100;

/**
 * @typedef {object} CapacityEntry
 * @property {string} recordedAt — ISO timestamp
 * @property {number} parserConfidence — 0-1
 * @property {number} planCount — plans in last Prometheus run
 * @property {string} projectHealth — healthy|warning|critical
 * @property {string} optimizerStatus — ok|budget_exceeded|etc
 * @property {number} budgetUsed
 * @property {number} budgetLimit
 * @property {number} workersDone — workers completed in last cycle
 */

/**
 * Append a new entry to the capacity scoreboard.
 *
 * @param {object} config — BOX config with paths.stateDir
 * @param {CapacityEntry} entry
 */
export async function appendCapacityEntry(config, entry) {
  const stateDir = config?.paths?.stateDir || "state";
  const filePath = path.join(stateDir, "capacity_scoreboard.json");
  const data = await readJson(filePath, []);
  const entries = Array.isArray(data) ? data : [];
  entries.push({
    ...entry,
    recordedAt: entry.recordedAt || new Date().toISOString()
  });
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  await writeJson(filePath, entries);
}

/**
 * Read the latest N entries from the scoreboard.
 *
 * @param {object} config
 * @param {number} [n=10]
 * @returns {Promise<CapacityEntry[]>}
 */
export async function getRecentCapacity(config, n = 10) {
  const stateDir = config?.paths?.stateDir || "state";
  const filePath = path.join(stateDir, "capacity_scoreboard.json");
  const data = await readJson(filePath, []);
  const entries = Array.isArray(data) ? data : [];
  return entries.slice(-n);
}

/**
 * Compute trend direction from recent entries.
 *
 * @param {CapacityEntry[]} entries
 * @param {string} field — field name to trend
 * @returns {"improving"|"stable"|"degrading"|"insufficient_data"}
 */
export function computeTrend(entries, field) {
  if (!Array.isArray(entries) || entries.length < 3) return "insufficient_data";

  const values = entries.map(e => Number(e[field])).filter(v => Number.isFinite(v));
  if (values.length < 3) return "insufficient_data";

  const recent = values.slice(-3);
  const earlier = values.slice(-6, -3);
  if (earlier.length === 0) return "insufficient_data";

  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const earlierAvg = earlier.reduce((a, b) => a + b, 0) / earlier.length;

  const delta = recentAvg - earlierAvg;
  const threshold = 0.05;

  if (delta > threshold) return "improving";
  if (delta < -threshold) return "degrading";
  return "stable";
}

/**
 * Capacity Index Decomposition — 10-Dimension Balanced Score (Packet 17).
 *
 * Each dimension is scored 0-1. The composite index is the mean of all dimensions.
 * This gives Prometheus and Jesus a multi-dimensional view of system capacity.
 *
 * @typedef {object} CapacityIndex
 * @property {number} architecture — system modularity, data flow quality
 * @property {number} speed — cycle throughput, latency
 * @property {number} taskQuality — correctness, depth, completeness
 * @property {number} promptQuality — instruction clarity, model utilization
 * @property {number} parserQuality — output parsing, confidence
 * @property {number} workerSpecialization — role diversity, capability matching
 * @property {number} modelTaskFit — routing accuracy, token efficiency
 * @property {number} learningLoop — postmortem-to-policy closure rate
 * @property {number} costEfficiency — premium requests per useful outcome
 * @property {number} security — vulnerability prevention, governance compliance
 */

/**
 * Compute the 10-dimension capacity index from cycle data.
 *
 * @param {object} cycleData
 * @param {number} [cycleData.parserConfidence] — 0-1
 * @param {number} [cycleData.planContractPassRate] — 0-1
 * @param {number} [cycleData.testPassRate] — 0-1
 * @param {number} [cycleData.workerDoneRate] — 0-1
 * @param {number} [cycleData.diversityIndex] — 0-1
 * @param {number} [cycleData.recurrenceClosureRate] — 0-1
 * @param {number} [cycleData.premiumEfficiency] — 0-1
 * @param {number} [cycleData.securityScore] — 0-1
 * @param {number} [cycleData.cycleDurationMinutes] — actual duration
 * @param {number} [cycleData.targetDurationMinutes] — target duration
 * @returns {{ dimensions: CapacityIndex, composite: number, deltas: Record<string, number>|null }}
 */
export function computeCapacityIndex(cycleData: any = {}, previousIndex = null) {
  const d = {
    architecture: clamp(cycleData.planContractPassRate ?? 0.5),
    speed: clamp(cycleData.targetDurationMinutes
      ? Math.min(1, cycleData.targetDurationMinutes / Math.max(1, cycleData.cycleDurationMinutes || cycleData.targetDurationMinutes))
      : 0.5),
    taskQuality: clamp(cycleData.testPassRate ?? 0.5),
    promptQuality: clamp(cycleData.parserConfidence ?? 0.5),
    parserQuality: clamp(cycleData.parserConfidence ?? 0.5),
    workerSpecialization: clamp(cycleData.diversityIndex ?? 0),
    modelTaskFit: clamp(cycleData.premiumEfficiency ?? 0.5),
    learningLoop: clamp(cycleData.recurrenceClosureRate ?? 0),
    costEfficiency: clamp(cycleData.premiumEfficiency ?? 0.5),
    security: clamp(cycleData.securityScore ?? 0.7),
  };

  const values = Object.values(d);
  const composite = Math.round((values.reduce((a, b) => a + b, 0) / values.length) * 100) / 100;

  // Compute deltas from previous index
  let deltas = null;
  if (previousIndex && previousIndex.dimensions) {
    deltas = {};
    for (const [key, val] of Object.entries(d)) {
      const prev = previousIndex.dimensions[key] ?? val;
      deltas[key] = Math.round((val - prev) * 1000) / 1000;
    }
  }

  return { dimensions: d, composite, deltas };
}

function clamp(v) {
  return Math.max(0, Math.min(1, Number(v) || 0));
}
