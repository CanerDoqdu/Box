/**
 * jesus_calibration.ts — Expected-vs-realized strategic calibration for Jesus directives.
 *
 * When Jesus issues a directive, he attaches an `expectedOutcome` forecast based on
 * the current state and commanded actions. On the next cycle, `computeCalibrationRecord`
 * compares those expectations against what actually happened.
 *
 * Calibration history is persisted to state/jesus_calibration_history.json.
 * Aggregated metrics are surfaced in evolution_metrics.json as `jesusCalibration`.
 *
 * This creates a closed-loop feedback signal for strategic decision quality.
 */

import path from "node:path";
import { readJson, writeJson } from "./fs_utils.js";

// ── Constants ─────────────────────────────────────────────────────────────────

export const JESUS_DECISION_TYPE = Object.freeze({
  WAIT: "wait",
  TACTICAL: "tactical",
  STRATEGIC: "strategic",
  EMERGENCY: "emergency",
} as const);

export const JESUS_FORECAST_CONFIDENCE = Object.freeze({
  HIGH: "high",
  MEDIUM: "medium",
  LOW: "low",
} as const);

export const JESUS_HEALTH_STATE = Object.freeze({
  GOOD: "good",
  DEGRADED: "degraded",
  CRITICAL: "critical",
  UNKNOWN: "unknown",
} as const);

/** Maximum calibration history entries to keep. */
const CALIBRATION_HISTORY_MAX = 50;

// ── Types ─────────────────────────────────────────────────────────────────────

export interface JesusExpectedOutcome {
  expectedSystemHealthAfter: string;
  expectedNextDecision: string;
  expectedAthenaActivated: boolean;
  expectedPrometheusRan: boolean;
  expectedWorkItemCount: number;
  forecastConfidence: string;
}

export interface JesusRealizedOutcome {
  systemHealth: string;
  decision: string;
  athenaActivated: boolean;
  prometheusRan: boolean;
  workItemCount: number;
}

export interface JesusCalibrationRecord {
  directiveIssuedAt: string;
  evaluatedAt: string;
  expected: JesusExpectedOutcome;
  realized: JesusRealizedOutcome;
  scores: {
    healthMatch: boolean;
    decisionMatch: boolean;
    athenaMatch: boolean;
    prometheusMatch: boolean;
    overall: number;
  };
}

export interface JesusCalibrationSummary {
  totalRecords: number;
  averageOverallScore: number | null;
  healthMatchRate: number | null;
  decisionMatchRate: number | null;
  athenaMatchRate: number | null;
  prometheusMatchRate: number | null;
  lastEvaluatedAt: string | null;
}

// ── Core Functions ────────────────────────────────────────────────────────────

/**
 * Derive `expectedOutcome` from a freshly-built Jesus directive.
 * This is a deterministic heuristic — not an AI call.
 *
 * @param directive - The Jesus directive object (after AI parse, before writing to disk).
 */
export function buildExpectedOutcome(directive: {
  decision?: string;
  systemHealth?: string;
  wakeAthena?: boolean;
  callPrometheus?: boolean;
  workItems?: unknown[];
  priorities?: unknown[];
}): JesusExpectedOutcome {
  const decision = directive.decision || JESUS_DECISION_TYPE.TACTICAL;
  const currentHealth = directive.systemHealth || JESUS_HEALTH_STATE.UNKNOWN;
  const wakeAthena = directive.wakeAthena === true;
  const callPrometheus = directive.callPrometheus === true;
  const workItemCount = Array.isArray(directive.workItems) ? directive.workItems.length : 0;

  // ── Predict system health AFTER this directive executes ───────────────────
  let expectedSystemHealthAfter: string;
  if (decision === JESUS_DECISION_TYPE.WAIT) {
    // No action → health stays the same
    expectedSystemHealthAfter = currentHealth;
  } else if (decision === JESUS_DECISION_TYPE.EMERGENCY) {
    // Emergency action expected to pull back from critical to degraded
    expectedSystemHealthAfter = JESUS_HEALTH_STATE.DEGRADED;
  } else if (decision === JESUS_DECISION_TYPE.STRATEGIC) {
    // Strategic planning expected to achieve good health
    expectedSystemHealthAfter = JESUS_HEALTH_STATE.GOOD;
  } else {
    // Tactical: improves one level (critical→degraded, degraded→good, good stays good)
    if (currentHealth === JESUS_HEALTH_STATE.CRITICAL) {
      expectedSystemHealthAfter = JESUS_HEALTH_STATE.DEGRADED;
    } else if (currentHealth === JESUS_HEALTH_STATE.DEGRADED) {
      expectedSystemHealthAfter = JESUS_HEALTH_STATE.GOOD;
    } else {
      expectedSystemHealthAfter = JESUS_HEALTH_STATE.GOOD;
    }
  }

  // ── Predict next-cycle decision ───────────────────────────────────────────
  let expectedNextDecision: string;
  if (decision === JESUS_DECISION_TYPE.WAIT) {
    expectedNextDecision = JESUS_DECISION_TYPE.WAIT;
  } else if (decision === JESUS_DECISION_TYPE.EMERGENCY) {
    // After emergency, expect tactical cleanup
    expectedNextDecision = JESUS_DECISION_TYPE.TACTICAL;
  } else if (workItemCount > 0 || wakeAthena) {
    // Ongoing work in progress → expect tactical continuation
    expectedNextDecision = JESUS_DECISION_TYPE.TACTICAL;
  } else {
    expectedNextDecision = JESUS_DECISION_TYPE.TACTICAL;
  }

  // ── Forecast confidence ───────────────────────────────────────────────────
  let forecastConfidence: string;
  if (decision === JESUS_DECISION_TYPE.EMERGENCY) {
    // Emergency state is highly deterministic — actions are forced
    forecastConfidence = JESUS_FORECAST_CONFIDENCE.HIGH;
  } else if (workItemCount > 0 && wakeAthena) {
    // Clear work queued + Athena activated → medium confidence
    forecastConfidence = JESUS_FORECAST_CONFIDENCE.MEDIUM;
  } else {
    forecastConfidence = JESUS_FORECAST_CONFIDENCE.LOW;
  }

  return {
    expectedSystemHealthAfter,
    expectedNextDecision,
    expectedAthenaActivated: wakeAthena,
    expectedPrometheusRan: callPrometheus,
    expectedWorkItemCount: workItemCount,
    forecastConfidence,
  };
}

/**
 * Compute calibration scores for a single expected-vs-realized pair.
 *
 * Scoring weights:
 *   - healthMatch:      35 pts
 *   - decisionMatch:    35 pts
 *   - athenaMatch:      15 pts
 *   - prometheusMatch:  15 pts
 */
export function scoreCalibration(
  expected: JesusExpectedOutcome,
  realized: JesusRealizedOutcome
): JesusCalibrationRecord["scores"] {
  const healthMatch = expected.expectedSystemHealthAfter === realized.systemHealth;
  const decisionMatch = expected.expectedNextDecision === realized.decision;
  const athenaMatch = expected.expectedAthenaActivated === realized.athenaActivated;
  const prometheusMatch = expected.expectedPrometheusRan === realized.prometheusRan;

  const overall =
    (healthMatch ? 35 : 0) +
    (decisionMatch ? 35 : 0) +
    (athenaMatch ? 15 : 0) +
    (prometheusMatch ? 15 : 0);

  return { healthMatch, decisionMatch, athenaMatch, prometheusMatch, overall };
}

/**
 * Build a complete calibration record by comparing a previous directive's
 * `expectedOutcome` against the realized current-cycle state.
 *
 * @param prevDirective - The previous directive that contains `expectedOutcome`.
 * @param realizedState - Observed state from the current Jesus cycle.
 */
export function computeCalibrationRecord(
  prevDirective: {
    decidedAt?: string;
    expectedOutcome?: JesusExpectedOutcome;
  },
  realizedState: {
    systemHealth: string;
    decision: string;
    athenaActivated: boolean;
    prometheusRan: boolean;
    workItemCount: number;
  }
): JesusCalibrationRecord | null {
  if (!prevDirective?.expectedOutcome || !prevDirective.decidedAt) {
    return null;
  }

  const realized: JesusRealizedOutcome = {
    systemHealth: realizedState.systemHealth || JESUS_HEALTH_STATE.UNKNOWN,
    decision: realizedState.decision || JESUS_DECISION_TYPE.TACTICAL,
    athenaActivated: realizedState.athenaActivated === true,
    prometheusRan: realizedState.prometheusRan === true,
    workItemCount: typeof realizedState.workItemCount === "number" ? realizedState.workItemCount : 0,
  };

  const scores = scoreCalibration(prevDirective.expectedOutcome, realized);

  return {
    directiveIssuedAt: prevDirective.decidedAt,
    evaluatedAt: new Date().toISOString(),
    expected: prevDirective.expectedOutcome,
    realized,
    scores,
  };
}

/**
 * Append a calibration record to state/jesus_calibration_history.json.
 * Keeps at most CALIBRATION_HISTORY_MAX records (rolling window).
 */
export async function appendCalibrationHistory(
  stateDir: string,
  record: JesusCalibrationRecord
): Promise<void> {
  const filePath = path.join(stateDir, "jesus_calibration_history.json");
  const history: JesusCalibrationRecord[] = await readJson(filePath, []);
  const updated = [...(Array.isArray(history) ? history : []), record];
  // Keep rolling window
  const trimmed = updated.slice(-CALIBRATION_HISTORY_MAX);
  await writeJson(filePath, trimmed);
}

/**
 * Read calibration history and compute aggregated summary metrics.
 *
 * @param stateDir - Path to state directory.
 * @param windowSize - Number of recent records to use (default: 20).
 */
export async function getCalibrationSummary(
  stateDir: string,
  windowSize = 20
): Promise<JesusCalibrationSummary> {
  const filePath = path.join(stateDir, "jesus_calibration_history.json");
  const history: JesusCalibrationRecord[] = await readJson(filePath, []);

  if (!Array.isArray(history) || history.length === 0) {
    return {
      totalRecords: 0,
      averageOverallScore: null,
      healthMatchRate: null,
      decisionMatchRate: null,
      athenaMatchRate: null,
      prometheusMatchRate: null,
      lastEvaluatedAt: null,
    };
  }

  const recent = history.slice(-windowSize);
  const n = recent.length;

  const sumOverall = recent.reduce((s, r) => s + (r.scores?.overall ?? 0), 0);
  const healthMatches = recent.filter(r => r.scores?.healthMatch === true).length;
  const decisionMatches = recent.filter(r => r.scores?.decisionMatch === true).length;
  const athenaMatches = recent.filter(r => r.scores?.athenaMatch === true).length;
  const prometheusMatches = recent.filter(r => r.scores?.prometheusMatch === true).length;

  const lastEvaluatedAt = recent[recent.length - 1]?.evaluatedAt ?? null;

  return {
    totalRecords: history.length,
    averageOverallScore: +(sumOverall / n).toFixed(1),
    healthMatchRate: +(healthMatches / n).toFixed(3),
    decisionMatchRate: +(decisionMatches / n).toFixed(3),
    athenaMatchRate: +(athenaMatches / n).toFixed(3),
    prometheusMatchRate: +(prometheusMatches / n).toFixed(3),
    lastEvaluatedAt,
  };
}
