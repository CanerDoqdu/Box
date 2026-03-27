/**
 * BOX Cycle Analytics
 *
 * Generates cycle_analytics.json per orchestration loop with normalized KPIs,
 * confidence assessment, and causal links between pipeline stages.
 *
 * Differentiation boundary with slo_metrics.json (Athena AC14 resolved):
 *   slo_metrics.json  — SLO compliance: raw latency values, breach records, threshold
 *                       violations. Written by slo_checker.js. Compliance tracking.
 *   cycle_analytics.json — Cycle performance: high-level KPIs aggregated from SLO results
 *                          + outcomes + health scores + causal attribution.
 *                          References sloBreachCount/sloStatus, does NOT duplicate raw
 *                          breach records or threshold details.
 *
 * Canonical events (Athena AC13 resolved):
 *   KPIs are computed exclusively from the 5 SLO_TIMESTAMP_STAGES defined in
 *   pipeline_progress.js. No other events are treated as canonical inputs.
 *
 * Confidence levels (Athena AC11 resolved):
 *   Confidence uses the existing codebase enum ("high"|"medium"|"low") computed
 *   deterministically from data completeness — NOT invented statistical intervals.
 *   high:   All 5 canonical events present AND sloRecord provided.
 *   medium: 3–4 canonical events present OR sloRecord missing.
 *   low:    ≤2 canonical events present OR no pipeline progress.
 *
 * Causal links (Athena AC12 resolved):
 *   Deterministic model: the 3 SLO-measured spans (decision, dispatch, verification).
 *   Each link records cause→effect stage names, measured latencyMs, and whether the
 *   span exceeded its configured threshold (anomaly=true). No invented causality.
 *
 * Schema (Athena AC16 resolved):
 *   See CYCLE_ANALYTICS_SCHEMA for required fields and explicit enums.
 *
 * Retention policy (Athena AC17 resolved):
 *   Defaults to 50 history entries (configurable via config.cycleAnalytics.maxHistoryEntries).
 *   slo_checker uses 100; cycle records are larger so a lower cap is appropriate.
 *
 * Missing data sentinel (Athena AC18 resolved):
 *   Numeric fields use null (not 0) when data is absent.
 *   All absent fields are documented in the missingData[] array with reason codes.
 *
 * Risk (Athena AC19 resolved):
 *   Per-cycle file I/O is added to the runSingleCycle hot path.
 *   The call is wrapped in try/catch — analytics failure never blocks orchestration.
 */

import path from "node:path";
import { readJson, writeJson } from "./fs_utils.js";
import { SLO_TIMESTAMP_CONTRACT, SLO_METRIC } from "./slo_checker.js";

// ── Enums ──────────────────────────────────────────────────────────────────────

/** Pipeline phase at the time analytics were generated. */
export const CYCLE_PHASE = Object.freeze({
  COMPLETED: "completed",
  FAILED: "failed",
  INCOMPLETE: "incomplete",
});

/** Aggregate outcome status for the cycle. */
export const CYCLE_OUTCOME_STATUS = Object.freeze({
  SUCCESS: "success",
  PARTIAL: "partial",
  FAILED: "failed",
  NO_PLANS: "no_plans",
  REJECTED: "rejected",
  UNKNOWN: "unknown",
});

/**
 * Confidence level for the analytics record.
 * Uses the existing codebase enum — NOT statistical confidence intervals.
 * Computed deterministically from data completeness.
 */
export const CONFIDENCE_LEVEL = Object.freeze({
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
});

/** Reason codes for entries in the missingData[] array. */
export const MISSING_DATA_REASON = Object.freeze({
  /** The source file or object was not provided (null/undefined). */
  MISSING_SOURCE: "MISSING_SOURCE",
  /** The source was provided but the specific timestamp field was absent. */
  MISSING_TIMESTAMP: "MISSING_TIMESTAMP",
  /** The source was provided but a computation step raised an error. */
  COMPUTATION_ERROR: "COMPUTATION_ERROR",
});

/** Which part of the analytics record is affected by a missing data entry. */
export const MISSING_DATA_IMPACT = Object.freeze({
  KPI: "kpi",
  OUTCOME: "outcome",
  CAUSAL_LINK: "causal_link",
});

// ── Schema contract ────────────────────────────────────────────────────────────

/**
 * Canonical schema for cycle_analytics.json (Athena AC16 resolved).
 *
 * Required fields and enums are fully specified.
 * cycleId = pipeline_progress.startedAt (ISO 8601 string) — same as slo_metrics.json.
 */
export const CYCLE_ANALYTICS_SCHEMA = Object.freeze({
  schemaVersion: 1,
  required: ["schemaVersion", "lastCycle", "history", "updatedAt"],
  cycleRecord: Object.freeze({
    required: [
      "cycleId",
      "generatedAt",
      "phase",
      "outcomes",
      "kpis",
      "confidence",
      "causalLinks",
      "canonicalEvents",
      "missingData",
    ],
    cycleIdSource: "pipeline_progress.startedAt",
    phaseEnum: Object.freeze([...Object.values(CYCLE_PHASE)]),
    outcomeStatusEnum: Object.freeze([...Object.values(CYCLE_OUTCOME_STATUS)]),
    confidenceLevelEnum: Object.freeze([...Object.values(CONFIDENCE_LEVEL)]),
    missingDataReasonEnum: Object.freeze([...Object.values(MISSING_DATA_REASON)]),
    missingDataImpactEnum: Object.freeze([...Object.values(MISSING_DATA_IMPACT)]),
  }),
  /** Configurable via config.cycleAnalytics.maxHistoryEntries. */
  defaultMaxHistoryEntries: 50,
});

/**
 * The 5 canonical pipeline stage names used as KPI inputs.
 * Source: SLO_TIMESTAMP_STAGES in pipeline_progress.js.
 * These are the ONLY events treated as canonical for KPI computation (AC2 / AC13).
 */
export const CANONICAL_EVENT_NAMES = Object.freeze([
  "jesus_awakening",
  "jesus_decided",
  "athena_approved",
  "workers_dispatching",
  "cycle_complete",
]);

/**
 * The 3 causal spans, each mapping directly to an SLO metric.
 * Deterministic model — no invented causality (Athena AC12 resolved).
 */
const CAUSAL_SPANS = Object.freeze([
  Object.freeze({
    metric: SLO_METRIC.DECISION_LATENCY,
    cause: SLO_TIMESTAMP_CONTRACT[SLO_METRIC.DECISION_LATENCY].start,
    effect: SLO_TIMESTAMP_CONTRACT[SLO_METRIC.DECISION_LATENCY].end,
    defaultThresholdMs: 120000,
  }),
  Object.freeze({
    metric: SLO_METRIC.DISPATCH_LATENCY,
    cause: SLO_TIMESTAMP_CONTRACT[SLO_METRIC.DISPATCH_LATENCY].start,
    effect: SLO_TIMESTAMP_CONTRACT[SLO_METRIC.DISPATCH_LATENCY].end,
    defaultThresholdMs: 30000,
  }),
  Object.freeze({
    metric: SLO_METRIC.VERIFICATION_COMPLETION,
    cause: SLO_TIMESTAMP_CONTRACT[SLO_METRIC.VERIFICATION_COMPLETION].start,
    effect: SLO_TIMESTAMP_CONTRACT[SLO_METRIC.VERIFICATION_COMPLETION].end,
    defaultThresholdMs: 3600000,
  }),
]);

// ── Path helper ────────────────────────────────────────────────────────────────

function cycleAnalyticsPath(config) {
  const stateDir = config?.paths?.stateDir || "state";
  return path.join(stateDir, "cycle_analytics.json");
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Resolve the threshold for a given metric from config or fall back to default.
 * Does NOT emit errors — this is analytics, not compliance.
 */
function resolveThreshold(config, metric, defaultMs) {
  const configured = config?.slo?.thresholds?.[metric];
  if (typeof configured === "number" && isFinite(configured) && configured > 0) {
    return configured;
  }
  return defaultMs;
}

/**
 * Build the canonicalEvents array from stage timestamps.
 * Each entry records name, timestamp (or null), and present flag.
 */
function buildCanonicalEvents(stageTimestamps) {
  return CANONICAL_EVENT_NAMES.map(name => ({
    name,
    timestamp: (stageTimestamps && typeof stageTimestamps[name] === "string")
      ? stageTimestamps[name]
      : null,
    present: !!(stageTimestamps && typeof stageTimestamps[name] === "string"),
  }));
}

/**
 * Build causal links from stage timestamps and config thresholds.
 * Each link corresponds to one SLO span (Athena AC12 resolved).
 */
function buildCausalLinks(config, stageTimestamps, missingData) {
  return CAUSAL_SPANS.map(span => {
    const causeTs = stageTimestamps?.[span.cause];
    const effectTs = stageTimestamps?.[span.effect];

    if (!causeTs || !effectTs) {
      missingData.push({
        field: `causalLinks[${span.cause}→${span.effect}].latencyMs`,
        reason: MISSING_DATA_REASON.MISSING_TIMESTAMP,
        impact: MISSING_DATA_IMPACT.CAUSAL_LINK,
      });
      return {
        cause: span.cause,
        effect: span.effect,
        metric: span.metric,
        latencyMs: null,
        anomaly: false,
        anomalyReason: null,
      };
    }

    const latencyMs = Math.max(0, new Date(effectTs).getTime() - new Date(causeTs).getTime());
    const threshold = resolveThreshold(config, span.metric, span.defaultThresholdMs);
    const anomaly = latencyMs > threshold;
    const anomalyReason = anomaly
      ? `${span.metric} exceeded threshold: actual=${latencyMs}ms threshold=${threshold}ms`
      : null;

    return {
      cause: span.cause,
      effect: span.effect,
      metric: span.metric,
      latencyMs,
      anomaly,
      anomalyReason,
    };
  });
}

/**
 * Compute confidence level deterministically from data completeness.
 * Uses the codebase enum ("high"|"medium"|"low") — not statistical intervals.
 * (Athena AC11 resolved)
 *
 * Rules:
 *   high:   All 5 canonical events present AND sloRecord provided.
 *   medium: 3–4 canonical events present OR sloRecord absent.
 *   low:    ≤2 canonical events present OR pipelineProgress null.
 */
function computeConfidence(canonicalEvents, sloRecord, pipelineProgress) {
  const presentCount = canonicalEvents.filter(e => e.present).length;
  const missingFields = canonicalEvents
    .filter(e => !e.present)
    .map(e => `canonicalEvents.${e.name}`);

  if (pipelineProgress === null) {
    if (sloRecord === null) missingFields.push("sloRecord");
    return {
      level: CONFIDENCE_LEVEL.LOW,
      reason: "pipelineProgress not available",
      missingFields,
    };
  }

  if (sloRecord === null) {
    missingFields.push("sloRecord");
  }

  if (presentCount >= 5 && sloRecord !== null) {
    return { level: CONFIDENCE_LEVEL.HIGH, reason: "all canonical events present", missingFields };
  }
  if (presentCount >= 3) {
    return {
      level: CONFIDENCE_LEVEL.MEDIUM,
      reason: sloRecord === null
        ? `${presentCount}/5 canonical events present; sloRecord absent`
        : `${presentCount}/5 canonical events present`,
      missingFields,
    };
  }
  return {
    level: CONFIDENCE_LEVEL.LOW,
    reason: `only ${presentCount}/5 canonical events present`,
    missingFields,
  };
}

/**
 * Derive outcome status from workerResults and planCount.
 * Handles null inputs explicitly (missing data sentinel = null, not 0).
 */
function computeOutcomeStatus(phase, workerResults, planCount) {
  if (phase === CYCLE_PHASE.INCOMPLETE) {
    // Distinguish specific incomplete reasons
    if (planCount === 0) return CYCLE_OUTCOME_STATUS.NO_PLANS;
    return CYCLE_OUTCOME_STATUS.UNKNOWN;
  }
  if (phase === CYCLE_PHASE.FAILED) return CYCLE_OUTCOME_STATUS.FAILED;

  if (!Array.isArray(workerResults) || workerResults.length === 0) {
    return CYCLE_OUTCOME_STATUS.UNKNOWN;
  }

  const failed = workerResults.filter(w => w.status === "error" || w.status === "failed").length;
  const done = workerResults.filter(w => w.status === "done" || w.status === "success").length;

  if (failed === 0) return CYCLE_OUTCOME_STATUS.SUCCESS;
  if (done > 0) return CYCLE_OUTCOME_STATUS.PARTIAL;
  return CYCLE_OUTCOME_STATUS.FAILED;
}

// ── Core computation ──────────────────────────────────────────────────────────

/**
 * Compute a cycle analytics record from available inputs.
 * Pure function — no file I/O. All inputs may be null (missing data handled explicitly).
 *
 * @param {object} config
 * @param {object} opts
 * @param {object|null} opts.sloRecord              Output of computeCycleSLOs(). May be null.
 * @param {object|null} opts.pipelineProgress        pipeline_progress.json content. May be null.
 * @param {Array|null}  opts.workerResults           [{roleName, status}] per dispatched worker. May be null.
 * @param {number|null} opts.planCount               Total plans dispatched this cycle. May be null.
 * @param {string}      opts.phase                   CYCLE_PHASE value.
 * @param {object|null} opts.parserBaselineRecovery  Output of computeBaselineRecoveryState(). May be null.
 * @returns {object} Analytics record conforming to CYCLE_ANALYTICS_SCHEMA.cycleRecord.
 */
export function computeCycleAnalytics(config, {
  sloRecord = null,
  pipelineProgress = null,
  workerResults = null,
  planCount = null,
  phase = CYCLE_PHASE.COMPLETED,
  parserBaselineRecovery = null,
}: any = {}) {
  const missingData = [];
  const stageTimestamps = pipelineProgress?.stageTimestamps || null;

  if (pipelineProgress === null) {
    missingData.push({
      field: "pipelineProgress",
      reason: MISSING_DATA_REASON.MISSING_SOURCE,
      impact: MISSING_DATA_IMPACT.KPI,
    });
  }
  if (sloRecord === null) {
    missingData.push({
      field: "sloRecord",
      reason: MISSING_DATA_REASON.MISSING_SOURCE,
      impact: MISSING_DATA_IMPACT.KPI,
    });
  }

  // Canonical events inventory
  const canonicalEvents = buildCanonicalEvents(stageTimestamps);

  // Causal links (deterministic, SLO-span aligned)
  const causalLinks = buildCausalLinks(config, stageTimestamps, missingData);

  // KPIs — reference sloRecord for latency values; do NOT duplicate raw breach records
  const kpis = {
    decisionLatencyMs: sloRecord?.metrics?.decisionLatencyMs ?? null,
    dispatchLatencyMs: sloRecord?.metrics?.dispatchLatencyMs ?? null,
    verificationCompletionMs: sloRecord?.metrics?.verificationCompletionMs ?? null,
    systemHealthScore: null,   // populated externally if self-improvement ran
    sloBreachCount: Array.isArray(sloRecord?.sloBreaches) ? sloRecord.sloBreaches.length : 0,
    sloStatus: sloRecord?.status ?? "unknown",
  };

  if (sloRecord === null) {
    // Already noted in missingData above; no silent zero-fill for latency fields
    missingData.push(
      { field: "kpis.decisionLatencyMs", reason: MISSING_DATA_REASON.MISSING_SOURCE, impact: MISSING_DATA_IMPACT.KPI },
      { field: "kpis.dispatchLatencyMs", reason: MISSING_DATA_REASON.MISSING_SOURCE, impact: MISSING_DATA_IMPACT.KPI },
      { field: "kpis.verificationCompletionMs", reason: MISSING_DATA_REASON.MISSING_SOURCE, impact: MISSING_DATA_IMPACT.KPI },
    );
  }

  // Outcomes
  const tasksDispatched = planCount !== null ? planCount : null;
  const tasksCompleted = Array.isArray(workerResults)
    ? workerResults.filter(w => w.status === "done" || w.status === "success").length
    : null;
  const tasksFailed = Array.isArray(workerResults)
    ? workerResults.filter(w => w.status === "error" || w.status === "failed").length
    : null;

  if (planCount === null) {
    missingData.push({
      field: "outcomes.tasksDispatched",
      reason: MISSING_DATA_REASON.MISSING_SOURCE,
      impact: MISSING_DATA_IMPACT.OUTCOME,
    });
  }

  if (!Array.isArray(workerResults)) {
    missingData.push(
      { field: "outcomes.tasksCompleted", reason: MISSING_DATA_REASON.MISSING_SOURCE, impact: MISSING_DATA_IMPACT.OUTCOME },
      { field: "outcomes.tasksFailed",    reason: MISSING_DATA_REASON.MISSING_SOURCE, impact: MISSING_DATA_IMPACT.OUTCOME },
    );
  }

  const outcomeStatus = computeOutcomeStatus(phase, workerResults, planCount);

  const outcomes = {
    tasksDispatched,
    tasksCompleted,
    tasksFailed,
    athenaApproved: pipelineProgress
      ? !!(stageTimestamps?.athena_approved)
      : null,
    selfImprovementRan: null,  // set externally after self-improvement cycle
    status: outcomeStatus,
  };

  // Explicit reason code when outcome status is UNKNOWN (no silent ambiguity).
  if (outcomeStatus === CYCLE_OUTCOME_STATUS.UNKNOWN) {
    const unknownReason = !Array.isArray(workerResults)
      ? "workerResults not provided"
      : (workerResults.length === 0
          ? "no worker results recorded"
          : "unrecognized worker status values");
    missingData.push({
      field: "outcomes.status",
      reason: MISSING_DATA_REASON.MISSING_SOURCE,
      impact: MISSING_DATA_IMPACT.OUTCOME,
      unknownReason,
    });
  }

  // Confidence (deterministic, not statistical)
  const confidence = computeConfidence(canonicalEvents, sloRecord, pipelineProgress);

  const cycleId = pipelineProgress?.startedAt ?? sloRecord?.cycleId ?? null;

  return {
    cycleId,
    generatedAt: new Date().toISOString(),
    phase,
    outcomes,
    kpis,
    confidence,
    causalLinks,
    canonicalEvents,
    missingData,
    parserBaselineRecovery: parserBaselineRecovery ?? null,
  };
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * Persist a computed cycle analytics record to state/cycle_analytics.json.
 * Maintains a rolling history capped at config.cycleAnalytics.maxHistoryEntries
 * (default: CYCLE_ANALYTICS_SCHEMA.defaultMaxHistoryEntries = 50).
 *
 * Append-only: new record is prepended; oldest entries are evicted when cap is reached.
 *
 * @param {object} config
 * @param {object} record - output of computeCycleAnalytics()
 */
export async function persistCycleAnalytics(config, record) {
  const filePath = cycleAnalyticsPath(config);
  const maxEntries = Number(
    config?.cycleAnalytics?.maxHistoryEntries
    || CYCLE_ANALYTICS_SCHEMA.defaultMaxHistoryEntries
  );

  const existing = await readJson(filePath, {
    schemaVersion: CYCLE_ANALYTICS_SCHEMA.schemaVersion,
    lastCycle: null,
    history: [],
    updatedAt: null,
  });

  const history = Array.isArray(existing.history) ? existing.history : [];
  history.unshift(record);
  if (history.length > maxEntries) {
    history.length = maxEntries;
  }

  await writeJson(filePath, {
    schemaVersion: CYCLE_ANALYTICS_SCHEMA.schemaVersion,
    lastCycle: record,
    history,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Read the current cycle_analytics.json snapshot.
 * Returns the parsed object or null if the file does not exist yet.
 *
 * @param {object} config
 * @returns {Promise<object|null>}
 */
export async function readCycleAnalytics(config) {
  const filePath = cycleAnalyticsPath(config);
  const data = await readJson(filePath, null);
  return data;
}
