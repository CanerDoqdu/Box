/**
 * BOX Cycle-level SLO Checker
 *
 * Computes, evaluates, and persists Service Level Objective (SLO) metrics
 * for each completed orchestration cycle.
 *
 * cycle_id contract (Athena missing item resolved):
 *   pipeline_progress.startedAt is the canonical cycle identifier.
 *   It is an ISO 8601 timestamp written when the first non-idle stage begins.
 *
 * SLO input field contract (Athena missing item resolved):
 *   All latency timestamps are read from pipeline_progress.json.stageTimestamps.
 *   - Decision latency:          jesus_awakening → jesus_decided
 *   - Dispatch latency:          athena_approved → workers_dispatching
 *   - Verification completion:   workers_dispatching → cycle_complete
 *   Timestamps from jesus_directive.json are NOT used — stageTimestamps is
 *   the single authoritative source to eliminate field ambiguity.
 *
 * slo_metrics.json schema (Athena missing item resolved — see SLO_METRICS_SCHEMA):
 *   Required fields, enums, and cycle key are fully specified below.
 *
 * Dashboard degraded path (Athena missing item resolved):
 *   A breach writes orchestratorStatus=degraded via writeOrchestratorHealth (orchestrator.js),
 *   NOT via appendAlert alone. The orchestrator calls writeOrchestratorHealth explicitly.
 */

import path from "node:path";
import { readJson, writeJson } from "./fs_utils.js";

// ── Enums ─────────────────────────────────────────────────────────────────────

/** SLO metric identifiers. */
export const SLO_METRIC = Object.freeze({
  DECISION_LATENCY: "decisionLatencyMs",
  DISPATCH_LATENCY: "dispatchLatencyMs",
  VERIFICATION_COMPLETION: "verificationCompletionMs",
});

/** SLO health status written to slo_metrics.json. */
export const SLO_STATUS = Object.freeze({
  OK: "ok",
  DEGRADED: "degraded",
});

/**
 * Machine-readable statusReason codes.
 * Never use free-form strings for SLO status reasons.
 */
export const SLO_REASON = Object.freeze({
  OK: "OK",
  BREACH_DETECTED: "BREACH_DETECTED",
  MISSING_TIMESTAMPS: "MISSING_TIMESTAMPS",
});

/**
 * Reason codes for individual missing timestamp cases.
 * Distinguishes missing-input from invalid-input (AC9).
 */
export const SLO_MISSING_REASON = Object.freeze({
  MISSING_TIMESTAMP_DECISION: "MISSING_TIMESTAMP_DECISION",
  MISSING_TIMESTAMP_DISPATCH: "MISSING_TIMESTAMP_DISPATCH",
  MISSING_TIMESTAMP_VERIFICATION: "MISSING_TIMESTAMP_VERIFICATION",
});

/**
 * Reason codes for threshold validation errors (AC1, AC9, AC10).
 * THRESHOLD_MISSING: key absent from the configured slo.thresholds object.
 * THRESHOLD_INVALID: key present but value is not a positive finite number.
 * Neither case is a silent fallback — both are recorded in thresholdValidationErrors.
 */
export const SLO_THRESHOLD_REASON = Object.freeze({
  THRESHOLD_MISSING: "THRESHOLD_MISSING",
  THRESHOLD_INVALID: "THRESHOLD_INVALID",
});

/** Breach alert severity levels. Aligns with ALERT_SEVERITY in state_tracker.js. */
export const SLO_BREACH_SEVERITY = Object.freeze({
  HIGH: "high",
  CRITICAL: "critical",
});

// ── Field contract ────────────────────────────────────────────────────────────

/**
 * Defines which stageTimestamps fields are required for each SLO metric.
 * Source for all timestamps: pipeline_progress.json.stageTimestamps.
 * This is the authoritative field contract (Athena AC12 resolved).
 */
export const SLO_TIMESTAMP_CONTRACT = Object.freeze({
  [SLO_METRIC.DECISION_LATENCY]: Object.freeze({
    start: "jesus_awakening",
    end: "jesus_decided",
    missingReason: SLO_MISSING_REASON.MISSING_TIMESTAMP_DECISION,
  }),
  [SLO_METRIC.DISPATCH_LATENCY]: Object.freeze({
    start: "athena_approved",
    end: "workers_dispatching",
    missingReason: SLO_MISSING_REASON.MISSING_TIMESTAMP_DISPATCH,
  }),
  [SLO_METRIC.VERIFICATION_COMPLETION]: Object.freeze({
    start: "workers_dispatching",
    end: "cycle_complete",
    missingReason: SLO_MISSING_REASON.MISSING_TIMESTAMP_VERIFICATION,
  }),
});

// ── Schema ────────────────────────────────────────────────────────────────────

/**
 * Canonical schema for slo_metrics.json (Athena AC13 resolved).
 * Required fields, enums, and cycle key are fully specified.
 *
 * cycleId = pipeline_progress.startedAt (ISO 8601 string).
 */
export const SLO_METRICS_SCHEMA = Object.freeze({
  schemaVersion: 1,
  required: ["schemaVersion", "lastCycle", "history", "updatedAt"],
  cycleRecord: Object.freeze({
    required: [
      "cycleId",
      "startedAt",
      "completedAt",
      "metrics",
      "missingTimestamps",
      "thresholdValidationErrors",
      "sloBreaches",
      "status",
      "statusReason",
    ],
    /** cycleId is pipeline_progress.startedAt — the canonical cycle identifier. */
    cycleIdSource: "pipeline_progress.startedAt",
    statusEnum: Object.freeze([...Object.values(SLO_STATUS)]),
    statusReasonEnum: Object.freeze([...Object.values(SLO_REASON)]),
    metricNames: Object.freeze([...Object.values(SLO_METRIC)]),
    breachSeverityEnum: Object.freeze([...Object.values(SLO_BREACH_SEVERITY)]),
    missingReasonEnum: Object.freeze([...Object.values(SLO_MISSING_REASON)]),
    thresholdReasonEnum: Object.freeze([...Object.values(SLO_THRESHOLD_REASON)]),
  }),
  maxHistoryEntries: 100,
});

// ── Default thresholds ────────────────────────────────────────────────────────

const DEFAULT_THRESHOLDS = Object.freeze({
  [SLO_METRIC.DECISION_LATENCY]: 120000,       // 2 min
  [SLO_METRIC.DISPATCH_LATENCY]: 30000,         // 30 s
  [SLO_METRIC.VERIFICATION_COMPLETION]: 3600000, // 1 hr
});

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Validate config-driven thresholds and return explicit validation errors (AC1, AC9, AC10).
 *
 * Rules:
 *   - If config.slo.thresholds is absent/null → use all defaults, no errors (expected first-run).
 *   - If config.slo.thresholds is an object and a key is absent → THRESHOLD_MISSING (explicit).
 *   - If a value is present but not a positive finite number → THRESHOLD_INVALID (explicit).
 * Neither case is silent: validation errors are returned and persisted in the cycle record.
 *
 * @param {object} config
 * @returns {{ thresholds: object, validationErrors: Array }}
 */
function resolveThresholds(config) {
  const configured = config?.slo?.thresholds;
  const validationErrors = [];
  const thresholds: Record<string, any> = {};

  for (const metric of Object.values(SLO_METRIC)) {
    const fallback = DEFAULT_THRESHOLDS[metric];

    if (!configured || typeof configured !== "object") {
      // No thresholds object configured — use defaults without emitting errors (first-run expected).
      thresholds[metric] = fallback;
      continue;
    }

    if (!(metric in configured)) {
      // Key absent from an explicitly provided thresholds object — record explicitly (AC10).
      validationErrors.push({
        metric,
        reason: SLO_THRESHOLD_REASON.THRESHOLD_MISSING,
        configured: undefined,
        fallback,
      });
      thresholds[metric] = fallback;
      continue;
    }

    const raw = configured[metric];
    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      // Value present but invalid — never silently coerce; record reason (AC9, AC10).
      validationErrors.push({
        metric,
        reason: SLO_THRESHOLD_REASON.THRESHOLD_INVALID,
        configured: raw,
        fallback,
      });
      thresholds[metric] = fallback;
    } else {
      thresholds[metric] = value;
    }
  }

  return { thresholds, validationErrors };
}

function resolveBreachSeverity(config, metric, actual, threshold) {
  const configured = String(config?.slo?.breachSeverity?.[metric] || "").toLowerCase();
  if (configured === SLO_BREACH_SEVERITY.CRITICAL) return SLO_BREACH_SEVERITY.CRITICAL;
  if (configured === SLO_BREACH_SEVERITY.HIGH) return SLO_BREACH_SEVERITY.HIGH;
  // Auto-escalate to critical when actual exceeds 2× threshold
  return actual > threshold * 2 ? SLO_BREACH_SEVERITY.CRITICAL : SLO_BREACH_SEVERITY.HIGH;
}

/**
 * Validate and parse a raw timestamp string.
 * Distinguishes missing input from invalid input (AC9).
 *
 * @param {any} raw
 * @returns {{ ms: number, valid: true } | { valid: false, reason: "missing"|"invalid" }}
 */
function parseTimestamp(raw) {
  if (raw === null || raw === undefined || String(raw).trim() === "") {
    return { valid: false, reason: "missing" };
  }
  const ms = Date.parse(String(raw));
  if (!Number.isFinite(ms)) {
    return { valid: false, reason: "invalid" };
  }
  return { valid: true, ms };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Compute SLO metrics for a completed cycle.
 *
 * This is a pure function — it reads no files and performs no I/O.
 * Call this after `cycle_complete` to evaluate latencies against thresholds.
 *
 * @param {object} config         - BOX config (used for slo.thresholds, slo.enabled)
 * @param {object} stageTimestamps - pipeline_progress.json.stageTimestamps
 * @param {string|null} startedAt  - pipeline_progress.json.startedAt (= cycleId)
 * @param {string|null} completedAt - pipeline_progress.json.completedAt
 * @returns {object} cycleRecord conforming to SLO_METRICS_SCHEMA.cycleRecord
 */
export function computeCycleSLOs(config, stageTimestamps, startedAt, completedAt) {
  const sloEnabled = config?.slo?.enabled !== false;
  const timestamps = stageTimestamps && typeof stageTimestamps === "object" ? stageTimestamps : {};
  const { thresholds, validationErrors: thresholdValidationErrors } = resolveThresholds(config);

  const metrics = {
    [SLO_METRIC.DECISION_LATENCY]: null,
    [SLO_METRIC.DISPATCH_LATENCY]: null,
    [SLO_METRIC.VERIFICATION_COMPLETION]: null,
  };
  const missingTimestamps = [];
  const sloBreaches = [];

  if (sloEnabled) {
    for (const [metric, contract] of Object.entries(SLO_TIMESTAMP_CONTRACT)) {
      const startResult = parseTimestamp(timestamps[contract.start]);
      const endResult = parseTimestamp(timestamps[contract.end]);

      if (!startResult.valid || !endResult.valid) {
        missingTimestamps.push(contract.missingReason);
        // No SLO calculation on missing mandatory timestamps (AC5)
        continue;
      }

      const latencyMs = endResult.ms - startResult.ms;
      // Clamp to 0 — negative latency (clock skew) is treated as 0
      metrics[metric] = Math.max(0, latencyMs);

      const threshold = thresholds[metric];
      if (metrics[metric] > threshold) {
        sloBreaches.push({
          metric,
          threshold,
          actual: metrics[metric],
          severity: resolveBreachSeverity(config, metric, metrics[metric], threshold),
          reason: `${metric.toUpperCase().replace(/MS$/, "")}_BREACH`,
        });
      }
    }
  }

  const hasBreach = sloBreaches.length > 0;
  const hasMissing = missingTimestamps.length > 0;

  let status, statusReason;
  if (hasBreach && config?.slo?.degradedOnBreach !== false) {
    status = SLO_STATUS.DEGRADED;
    statusReason = SLO_REASON.BREACH_DETECTED;
  } else if (!sloEnabled || (!hasBreach && !hasMissing)) {
    status = SLO_STATUS.OK;
    statusReason = SLO_REASON.OK;
  } else if (hasMissing && !hasBreach) {
    status = SLO_STATUS.OK;
    statusReason = SLO_REASON.MISSING_TIMESTAMPS;
  } else {
    status = SLO_STATUS.OK;
    statusReason = SLO_REASON.OK;
  }

  return {
    cycleId: startedAt || null,
    startedAt: startedAt || null,
    completedAt: completedAt || null,
    metrics,
    missingTimestamps,
    thresholdValidationErrors,
    sloBreaches,
    status,
    statusReason,
  };
}

function sloMetricsPath(config) {
  const stateDir = config?.paths?.stateDir || "state";
  return path.join(stateDir, "slo_metrics.json");
}

/**
 * Persist a computed cycle SLO record to slo_metrics.json.
 * Maintains a rolling history of up to SLO_METRICS_SCHEMA.maxHistoryEntries cycles.
 *
 * @param {object} config
 * @param {object} cycleRecord - output of computeCycleSLOs()
 */
export async function persistSloMetrics(config, cycleRecord) {
  const filePath = sloMetricsPath(config);
  const existing = await readJson(filePath, {
    schemaVersion: SLO_METRICS_SCHEMA.schemaVersion,
    lastCycle: null,
    history: [],
    updatedAt: null,
  });

  const history = Array.isArray(existing.history) ? existing.history : [];
  history.unshift(cycleRecord);
  if (history.length > SLO_METRICS_SCHEMA.maxHistoryEntries) {
    history.length = SLO_METRICS_SCHEMA.maxHistoryEntries;
  }

  await writeJson(filePath, {
    schemaVersion: SLO_METRICS_SCHEMA.schemaVersion,
    lastCycle: cycleRecord,
    history,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Read the most recent SLO metrics from slo_metrics.json.
 * Returns null for lastCycle and empty history if the file does not exist.
 *
 * @param {object} config
 * @returns {object}
 */
export async function readSloMetrics(config) {
  return readJson(sloMetricsPath(config), {
    schemaVersion: SLO_METRICS_SCHEMA.schemaVersion,
    lastCycle: null,
    history: [],
    updatedAt: null,
  });
}
