/**
 * retry_strategy.js — Adaptive retry strategy router for BOX.
 *
 * Replaces uniform retry behavior with per-failure-class policies that route
 * blocked/failed tasks to the correct remediation path: cooldown, rework,
 * role reassignment, task split, or escalation.
 *
 * ── Feature flag (rollback strategy) ─────────────────────────────────────────
 *   config.runtime.retryStrategy = "adaptive" | "uniform"
 *   Setting "uniform" restores legacy flat-retry behavior.
 *   Default: "adaptive"
 *
 * ── Failure class taxonomy ────────────────────────────────────────────────────
 *   Defined in failure_classifier.js as FAILURE_CLASS enum:
 *     environment   — OS/filesystem/network/infra failures
 *     policy        — Policy gate rejections, access violations
 *     verification  — Verification gate failures, rework exhausted
 *     model         — AI model errors, rate limits, quota exceeded
 *     external_api  — GitHub/external API failures
 *     logic_defect  — Code bugs, logic errors, unexpected behaviour
 *
 * ── RETRY_ACTION enum ─────────────────────────────────────────────────────────
 *   retry          — immediate retry (uniform path or low-attempt cases)
 *   cooldown_retry — wait cooldownMs, then retry (environment/model/external_api)
 *   rework         — re-dispatch with verification-backed rework instruction (logic_defect/verification)
 *   reassign       — route to a different worker role (policy, < reassignBeforeAttempt)
 *   split          — split task into sub-tasks (policy, >= splitAfterAttempt)
 *   escalate       — escalate to escalationTarget (any class when attempts exhausted)
 *
 * ── Default policy values (AC#12 / Athena missing item #2) ───────────────────
 *   environment:  cooldownMs=30min, maxRetries=3, escalationTarget="daemon_queue"
 *   logic_defect: maxReworkAttempts=2, reworkQueue="rework_queue", verificationStep="verification_gate"
 *   policy:       reassignBeforeAttempt=2, splitAfterAttempt=2, escalateAfter=3
 *   verification: maxReworkAttempts=2, reworkQueue="rework_queue", verificationStep="verification_gate"
 *   model:        cooldownMs=15min, maxRetries=3, escalationTarget="daemon_queue"
 *   external_api: cooldownMs=10min, maxRetries=3, escalationTarget="daemon_queue"
 *
 * ── Decision predicate for policy violations (AC#14 / Athena missing item #4) ─
 *   attempts < policy.reassignBeforeAttempt  → REASSIGN
 *   attempts < policy.escalateAfter          → SPLIT
 *   attempts >= policy.escalateAfter         → ESCALATE
 *
 * ── Retry state schema (AC#8 / AC#18 / Athena missing item #8) ───────────────
 *   RETRY_STATE_SCHEMA  — required fields for a persisted retry state record
 *   RETRY_METRIC_SCHEMA — required fields for a retry outcome metric record
 *
 * ── Metrics schema (AC#5 / AC#15 / Athena missing item #5) ──────────────────
 *   Named fields: schemaVersion, taskId, failureClass, retryAction, attempts,
 *   strategyUsed, cooldownMs, escalationTarget, decidedAt
 *
 * ── Validation (AC#9) ────────────────────────────────────────────────────────
 *   resolveRetryAction distinguishes missing/invalid failureClass from missing
 *   attempts with explicit RETRY_RESOLVE_REASON codes.
 *
 * ── No silent fallback (AC#10) ───────────────────────────────────────────────
 *   Invalid/unknown failureClass → ok=false with code=UNKNOWN_FAILURE_CLASS.
 *   Missing required parameters  → ok=false with code=MISSING_PARAM.
 *
 * Risk: MEDIUM — integrates into worker_runner.js (hot path). All resolveRetryAction
 *   calls are non-fatal in worker_runner — failure returns a safe RETRY decision.
 */

import { FAILURE_CLASS } from "./failure_classifier.js";

// ── Schema version ────────────────────────────────────────────────────────────

/** Integer schema version for retry state and metric records. Bump on incompatible schema change. */
export const RETRY_STRATEGY_SCHEMA_VERSION = 1;

// ── Feature flag enum ─────────────────────────────────────────────────────────

/**
 * Strategy modes for the retry router.
 *
 * adaptive — class-specific policies (new behavior, default)
 * uniform  — legacy flat retry with no class routing (rollback path)
 *
 * Rollback: set config.runtime.retryStrategy = "uniform" to restore legacy behavior.
 */
export const RETRY_STRATEGY = Object.freeze({
  ADAPTIVE: "adaptive",
  UNIFORM:  "uniform",
});

// ── Retry action enum ─────────────────────────────────────────────────────────

/**
 * Exhaustive set of retry actions returned by resolveRetryAction.
 * Every resolved retry decision receives exactly one action value from this enum.
 *
 *   retry          — immediate retry (uniform path or minimal attempt cases)
 *   cooldown_retry — wait cooldownMs before retrying (environment/model/external_api blockers)
 *   rework         — re-dispatch with verification-backed rework (logic_defect/verification)
 *   reassign       — route to a different worker role (policy violations, early attempts)
 *   split          — split task into sub-tasks (policy violations, mid-range attempts)
 *   escalate       — escalate to human or daemon queue (any class when attempts exhausted)
 */
export const RETRY_ACTION = Object.freeze({
  RETRY:          "retry",
  COOLDOWN_RETRY: "cooldown_retry",
  REWORK:         "rework",
  REASSIGN:       "reassign",
  SPLIT:          "split",
  ESCALATE:       "escalate",
});

// ── Validation reason codes ───────────────────────────────────────────────────

/**
 * Machine-readable reason codes for resolveRetryAction validation failures.
 *
 * AC#9 (Athena missing item #8): distinguishes missing from invalid input.
 */
export const RETRY_RESOLVE_REASON = Object.freeze({
  /** Required parameter is null/undefined/absent. */
  MISSING_PARAM:         "MISSING_PARAM",
  /** failureClass value is not a member of FAILURE_CLASS enum. */
  UNKNOWN_FAILURE_CLASS: "UNKNOWN_FAILURE_CLASS",
  /** attempts is not a non-negative integer. */
  INVALID_ATTEMPTS:      "INVALID_ATTEMPTS",
});

// ── Default retry policies per failure class (AC#12) ─────────────────────────

/**
 * Default per-failure-class retry policies with concrete numeric thresholds.
 *
 * AC#12 / Athena missing item #2: All values are explicit and machine-checkable.
 *
 * cooldownMinutes  — minutes to wait before retrying (cooldown_retry actions)
 * maxRetries       — maximum retry attempts before escalating (cooldown classes)
 * maxReworkAttempts — maximum rework attempts before escalating (rework classes)
 * reassignBeforeAttempt — attempt index below which REASSIGN is chosen over SPLIT
 * splitAfterAttempt     — attempt index at/above which SPLIT is chosen over REASSIGN
 * escalateAfter    — attempt index at/above which ESCALATE is chosen
 * escalationTarget — named target for escalation (machine-readable)
 * reworkQueue      — named queue for rework dispatch (AC#13 / Athena missing item #3)
 * verificationStep — named verification step that backs rework dispatch (AC#13)
 */
export const DEFAULT_RETRY_POLICIES = Object.freeze({
  [FAILURE_CLASS.ENVIRONMENT]: Object.freeze({
    action:            RETRY_ACTION.COOLDOWN_RETRY,
    cooldownMinutes:   30,
    maxRetries:        3,
    escalateAfter:     3,
    escalationTarget:  "daemon_queue",
  }),
  [FAILURE_CLASS.LOGIC_DEFECT]: Object.freeze({
    action:            RETRY_ACTION.REWORK,
    maxReworkAttempts: 2,
    escalateAfter:     2,
    reworkQueue:       "rework_queue",
    verificationStep:  "verification_gate",
    escalationTarget:  "daemon_queue",
  }),
  [FAILURE_CLASS.POLICY]: Object.freeze({
    action:                RETRY_ACTION.REASSIGN,
    reassignBeforeAttempt: 2,
    splitAfterAttempt:     2,
    escalateAfter:         3,
    escalationTarget:      "daemon_queue",
  }),
  [FAILURE_CLASS.VERIFICATION]: Object.freeze({
    action:            RETRY_ACTION.REWORK,
    maxReworkAttempts: 2,
    escalateAfter:     2,
    reworkQueue:       "rework_queue",
    verificationStep:  "verification_gate",
    escalationTarget:  "daemon_queue",
  }),
  [FAILURE_CLASS.MODEL]: Object.freeze({
    action:           RETRY_ACTION.COOLDOWN_RETRY,
    cooldownMinutes:  15,
    maxRetries:       3,
    escalateAfter:    3,
    escalationTarget: "daemon_queue",
  }),
  [FAILURE_CLASS.EXTERNAL_API]: Object.freeze({
    action:           RETRY_ACTION.COOLDOWN_RETRY,
    cooldownMinutes:  10,
    maxRetries:       3,
    escalateAfter:    3,
    escalationTarget: "daemon_queue",
  }),
});

// ── Retry state schema (AC#8 / AC#18) ────────────────────────────────────────

/**
 * Canonical schema for a persisted retry state record.
 *
 * AC#8 / AC#18 / Athena missing item #8: required fields and explicit enums defined here.
 *
 * Required fields:
 *   schemaVersion    {number}       = RETRY_STRATEGY_SCHEMA_VERSION (1)
 *   taskId           {string|null}
 *   failureClass     {string}       — one of FAILURE_CLASS values
 *   attempts         {number}       — zero-based attempt index
 *   retryAction      {string}       — one of RETRY_ACTION values
 *   cooldownUntilMs  {number|null}  — epoch ms for cooldown expiry, or null
 *   escalationTarget {string|null}  — named escalation target, or null
 *   reworkQueue      {string|null}  — named rework queue, or null
 *   verificationStep {string|null}  — named verification step, or null
 *   strategyUsed     {string}       — one of RETRY_STRATEGY values
 *   reason           {string}       — human-readable decision rationale
 *   decidedAt        {string}       — ISO 8601 timestamp
 */
export const RETRY_STATE_SCHEMA = Object.freeze({
  schemaVersion: RETRY_STRATEGY_SCHEMA_VERSION,
  required: Object.freeze([
    "schemaVersion",
    "taskId",
    "failureClass",
    "attempts",
    "retryAction",
    "cooldownUntilMs",
    "escalationTarget",
    "reworkQueue",
    "verificationStep",
    "strategyUsed",
    "reason",
    "decidedAt",
  ]),
  retryActionEnum:    Object.freeze(Object.values(RETRY_ACTION)),
  failureClassEnum:   Object.freeze(Object.values(FAILURE_CLASS)),
  retryStrategyEnum:  Object.freeze(Object.values(RETRY_STRATEGY)),
});

// ── Retry metric schema (AC#5 / AC#15) ───────────────────────────────────────

/**
 * Canonical schema for a retry outcome metric record.
 *
 * AC#5 / AC#15 / Athena missing item #5: named fields and output artifact defined here.
 * These records are appended to state/retry_metrics.jsonl (one JSON object per line).
 *
 * Required fields:
 *   schemaVersion    {number}       = RETRY_STRATEGY_SCHEMA_VERSION (1)
 *   taskId           {string|null}
 *   failureClass     {string}       — one of FAILURE_CLASS values
 *   retryAction      {string}       — one of RETRY_ACTION values
 *   attempts         {number}
 *   strategyUsed     {string}       — one of RETRY_STRATEGY values
 *   cooldownMs       {number|null}  — cooldown duration in ms (null for non-cooldown actions)
 *   escalationTarget {string|null}
 *   decidedAt        {string}       — ISO 8601 timestamp
 */
export const RETRY_METRIC_SCHEMA = Object.freeze({
  schemaVersion: RETRY_STRATEGY_SCHEMA_VERSION,
  required: Object.freeze([
    "schemaVersion",
    "taskId",
    "failureClass",
    "retryAction",
    "attempts",
    "strategyUsed",
    "cooldownMs",
    "escalationTarget",
    "decidedAt",
  ]),
  outputArtifact: "state/retry_metrics.jsonl",
  retryActionEnum:  Object.freeze(Object.values(RETRY_ACTION)),
  failureClassEnum: Object.freeze(Object.values(FAILURE_CLASS)),
});

// ── Policy resolution helpers ─────────────────────────────────────────────────

const _VALID_FAILURE_CLASSES = new Set(Object.values(FAILURE_CLASS));

/**
 * Merge config-provided adaptive retry overrides over the default policy for a class.
 * Config overrides live at config.runtime.adaptiveRetry[failureClass].
 *
 * @param {string} failureClass
 * @param {object} config
 * @returns {object} merged policy
 */
function resolvePolicy(failureClass, config) {
  const defaultPolicy = DEFAULT_RETRY_POLICIES[failureClass];
  const configOverride = config?.runtime?.adaptiveRetry?.[failureClass];
  if (!configOverride || typeof configOverride !== "object") return defaultPolicy;

  const merged = { ...defaultPolicy };
  // Only merge known numeric/string keys to prevent prototype pollution
  for (const key of Object.keys(defaultPolicy)) {
    if (Object.prototype.hasOwnProperty.call(configOverride, key)) {
      const v = configOverride[key];
      const defaultV = defaultPolicy[key];
      if (typeof v === typeof defaultV) {
        merged[key] = v;
      }
    }
  }
  // cooldownMinutes can come from config as numeric
  if (typeof configOverride.cooldownMinutes === "number") {
    merged.cooldownMinutes = configOverride.cooldownMinutes;
  }
  return merged;
}

// ── Main router ───────────────────────────────────────────────────────────────

/**
 * Resolve the retry action for a failed task based on its failure class and attempt count.
 *
 * In "adaptive" mode: routes to the class-specific policy.
 * In "uniform" mode:  always returns RETRY_ACTION.RETRY (legacy behavior).
 *
 * Decision predicate for POLICY class (AC#14 / Athena missing item #4):
 *   attempts < policy.reassignBeforeAttempt  → REASSIGN
 *   attempts < policy.escalateAfter          → SPLIT
 *   attempts >= policy.escalateAfter         → ESCALATE
 *
 * @param {string}      failureClass — one of FAILURE_CLASS values
 * @param {number}      attempts     — zero-based attempt count (0 = first failure)
 * @param {object}      [config]     — BOX config (reads runtime.retryStrategy + adaptiveRetry)
 * @param {string|null} [taskId]     — task identifier (for state/metric records)
 *
 * @returns {{ ok: true,  decision: RetryDecision } |
 *           { ok: false, code: string, field?: string, message: string }}
 *
 * RetryDecision fields (all required, per RETRY_STATE_SCHEMA):
 *   schemaVersion    {number}
 *   taskId           {string|null}
 *   failureClass     {string}
 *   attempts         {number}
 *   retryAction      {string}       — one of RETRY_ACTION values
 *   cooldownUntilMs  {number|null}  — epoch ms when cooldown expires, or null
 *   cooldownMs       {number|null}  — cooldown duration in ms, or null
 *   escalationTarget {string|null}
 *   reworkQueue      {string|null}
 *   verificationStep {string|null}
 *   strategyUsed     {string}       — "adaptive" or "uniform"
 *   reason           {string}
 *   decidedAt        {string}
 */
export function resolveRetryAction(failureClass, attempts, config = {}, taskId = null) {
  // ── Input validation (AC#9 / AC#10) ──────────────────────────────────────
  if (failureClass === null || failureClass === undefined) {
    return {
      ok: false,
      code: RETRY_RESOLVE_REASON.MISSING_PARAM,
      field: "failureClass",
      message: "failureClass is required (got null/undefined)",
    };
  }
  if (!_VALID_FAILURE_CLASSES.has(failureClass)) {
    return {
      ok: false,
      code: RETRY_RESOLVE_REASON.UNKNOWN_FAILURE_CLASS,
      field: "failureClass",
      message: `failureClass '${failureClass}' is not a valid FAILURE_CLASS value`,
    };
  }
  if (attempts === null || attempts === undefined) {
    return {
      ok: false,
      code: RETRY_RESOLVE_REASON.MISSING_PARAM,
      field: "attempts",
      message: "attempts is required (got null/undefined)",
    };
  }
  const attemptNum = Number(attempts);
  if (!Number.isInteger(attemptNum) || attemptNum < 0) {
    return {
      ok: false,
      code: RETRY_RESOLVE_REASON.INVALID_ATTEMPTS,
      field: "attempts",
      message: `attempts must be a non-negative integer; got ${JSON.stringify(attempts)}`,
    };
  }

  const decidedAt = new Date().toISOString();
  const taskIdStr = taskId != null ? String(taskId) : null;

  // ── Uniform mode (rollback path) ─────────────────────────────────────────
  const strategyMode = String(config?.runtime?.retryStrategy || RETRY_STRATEGY.ADAPTIVE).toLowerCase();
  if (strategyMode === RETRY_STRATEGY.UNIFORM) {
    return {
      ok: true,
      decision: {
        schemaVersion:    RETRY_STRATEGY_SCHEMA_VERSION,
        taskId:           taskIdStr,
        failureClass,
        attempts:         attemptNum,
        retryAction:      RETRY_ACTION.RETRY,
        cooldownUntilMs:  null,
        cooldownMs:       null,
        escalationTarget: null,
        reworkQueue:      null,
        verificationStep: null,
        strategyUsed:     RETRY_STRATEGY.UNIFORM,
        reason:           "uniform retry strategy active — retrying immediately",
        decidedAt,
      },
    };
  }

  // ── Adaptive mode — resolve per-class policy ──────────────────────────────
  const policy = resolvePolicy(failureClass, config);

  let retryAction;
  let cooldownMs  = null;
  let cooldownUntilMs = null;
  // escalationTarget is always set in every adaptive branch below (no null init needed)
  let escalationTarget;
  let reworkQueue      = null;
  let verificationStep = null;
  let reason;

  // ── Environment / Model / External_API: cooldown or escalate ─────────────
  if (
    failureClass === FAILURE_CLASS.ENVIRONMENT ||
    failureClass === FAILURE_CLASS.MODEL ||
    failureClass === FAILURE_CLASS.EXTERNAL_API
  ) {
    const escalateAfter = Number(policy.escalateAfter ?? 3);
    if (attemptNum >= escalateAfter) {
      retryAction      = RETRY_ACTION.ESCALATE;
      escalationTarget = policy.escalationTarget || "daemon_queue";
      reason = `${failureClass} blocker: attempt ${attemptNum} >= escalateAfter(${escalateAfter}) — escalating to ${escalationTarget}`;
    } else {
      retryAction          = RETRY_ACTION.COOLDOWN_RETRY;
      const cooldownMinutes = Number(policy.cooldownMinutes ?? 30);
      cooldownMs           = cooldownMinutes * 60 * 1000;
      cooldownUntilMs      = Date.now() + cooldownMs;
      escalationTarget     = policy.escalationTarget || "daemon_queue";
      reason = `${failureClass} blocker: cooldown ${cooldownMinutes}min, attempt ${attemptNum}/${escalateAfter - 1} — retrying after cooldown`;
    }
  }

  // ── Logic defect / Verification: rework or escalate ──────────────────────
  else if (
    failureClass === FAILURE_CLASS.LOGIC_DEFECT ||
    failureClass === FAILURE_CLASS.VERIFICATION
  ) {
    const escalateAfter = Number(policy.escalateAfter ?? 2);
    if (attemptNum >= escalateAfter) {
      retryAction      = RETRY_ACTION.ESCALATE;
      escalationTarget = policy.escalationTarget || "daemon_queue";
      reason = `${failureClass}: rework attempts exhausted (${attemptNum} >= escalateAfter(${escalateAfter})) — escalating to ${escalationTarget}`;
    } else {
      retryAction      = RETRY_ACTION.REWORK;
      reworkQueue      = policy.reworkQueue      || "rework_queue";
      verificationStep = policy.verificationStep || "verification_gate";
      escalationTarget = policy.escalationTarget || "daemon_queue";
      reason = `${failureClass}: routing to verification-backed rework via ${reworkQueue} (step: ${verificationStep}), attempt ${attemptNum}/${escalateAfter - 1}`;
    }
  }

  // ── Policy: reassign → split → escalate (AC#14) ──────────────────────────
  else if (failureClass === FAILURE_CLASS.POLICY) {
    const reassignBefore = Number(policy.reassignBeforeAttempt ?? 2);
    const splitAfter     = Number(policy.splitAfterAttempt     ?? 2);
    const escalateAfter  = Number(policy.escalateAfter         ?? 3);
    escalationTarget     = policy.escalationTarget || "daemon_queue";

    if (attemptNum >= escalateAfter) {
      retryAction = RETRY_ACTION.ESCALATE;
      reason = `policy violation: attempt ${attemptNum} >= escalateAfter(${escalateAfter}) — escalating to ${escalationTarget}`;
    } else if (attemptNum >= splitAfter) {
      // Decision predicate: reassign exhausted → split
      retryAction = RETRY_ACTION.SPLIT;
      reason = `policy violation: attempt ${attemptNum} >= splitAfterAttempt(${splitAfter}) — splitting task`;
    } else {
      // Decision predicate: first failure(s) → reassign role
      retryAction = RETRY_ACTION.REASSIGN;
      reason = `policy violation: attempt ${attemptNum} < reassignBeforeAttempt(${reassignBefore}) — reassigning worker role`;
    }
  }

  // ── Unreachable: caught by validation above ───────────────────────────────
  else {
    // AC#10: no silent fallback — this branch should never be reached
    return {
      ok: false,
      code: RETRY_RESOLVE_REASON.UNKNOWN_FAILURE_CLASS,
      field: "failureClass",
      message: `unreachable: unhandled failureClass '${failureClass}'`,
    };
  }

  return {
    ok: true,
    decision: {
      schemaVersion:    RETRY_STRATEGY_SCHEMA_VERSION,
      taskId:           taskIdStr,
      failureClass,
      attempts:         attemptNum,
      retryAction,
      cooldownUntilMs,
      cooldownMs,
      escalationTarget: escalationTarget ?? null,
      reworkQueue,
      verificationStep,
      strategyUsed:     RETRY_STRATEGY.ADAPTIVE,
      reason,
      decidedAt,
    },
  };
}

// ── Metric persistence ────────────────────────────────────────────────────────

/**
 * Build a retry metric record from a resolved retry decision.
 *
 * AC#5 / AC#15 / Athena missing item #5: produces a machine-readable metric
 * conforming to RETRY_METRIC_SCHEMA. The caller persists this to
 * state/retry_metrics.jsonl (one JSON per line).
 *
 * @param {object} decision — RetryDecision from resolveRetryAction
 * @returns {object} metric record conforming to RETRY_METRIC_SCHEMA
 */
export function buildRetryMetric(decision) {
  return {
    schemaVersion:    RETRY_STRATEGY_SCHEMA_VERSION,
    taskId:           decision.taskId ?? null,
    failureClass:     decision.failureClass,
    retryAction:      decision.retryAction,
    attempts:         decision.attempts,
    strategyUsed:     decision.strategyUsed,
    cooldownMs:       decision.cooldownMs ?? null,
    escalationTarget: decision.escalationTarget ?? null,
    decidedAt:        decision.decidedAt,
  };
}

// ── State persistence helpers ─────────────────────────────────────────────────

import path from "node:path";
import { appendFileSync, mkdirSync, existsSync } from "node:fs";

/**
 * Append a retry metric record to state/retry_metrics.jsonl (one JSON per line).
 *
 * Non-fatal: errors are caught and never propagate to callers.
 *
 * AC#5 / AC#15: output artifact path is RETRY_METRIC_SCHEMA.outputArtifact.
 *
 * @param {object} config
 * @param {object} decision — RetryDecision from resolveRetryAction
 */
export function persistRetryMetric(config, decision) {
  try {
    const stateDir = config?.paths?.stateDir || "state";
    const metricsPath = path.join(stateDir, "retry_metrics.jsonl");
    if (!existsSync(stateDir)) {
      mkdirSync(stateDir, { recursive: true });
    }
    const metric = buildRetryMetric(decision);
    appendFileSync(metricsPath, JSON.stringify(metric) + "\n", "utf8");
  } catch {
    // Non-fatal: metric persistence must never block orchestration
  }
}
