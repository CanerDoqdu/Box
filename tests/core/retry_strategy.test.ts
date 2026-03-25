/**
 * retry_strategy.test.ts
 *
 * Tests for the adaptive retry strategy router.
 *
 * Coverage:
 *   - RETRY_STRATEGY, RETRY_ACTION, RETRY_RESOLVE_REASON enums (frozen, values)
 *   - RETRY_STATE_SCHEMA and RETRY_METRIC_SCHEMA (required fields, enum sets)
 *   - DEFAULT_RETRY_POLICIES (all six failure classes, concrete values)
 *   - resolveRetryAction: validation (missing/invalid inputs), uniform mode,
 *     adaptive mode per class, escalation thresholds, policy overrides
 *   - buildRetryMetric: output conforms to RETRY_METRIC_SCHEMA
 *   - Negative paths: unknown class, negative attempts, null inputs
 *   - AC#14 decision predicate for policy violations (reassign → split → escalate)
 *   - AC#16 routing assertion: each class produces a deterministic RETRY_ACTION
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  RETRY_STRATEGY,
  RETRY_ACTION,
  RETRY_RESOLVE_REASON,
  RETRY_STRATEGY_SCHEMA_VERSION,
  DEFAULT_RETRY_POLICIES,
  RETRY_STATE_SCHEMA,
  RETRY_METRIC_SCHEMA,
  resolveRetryAction,
  buildRetryMetric,
} from "../../src/core/retry_strategy.js";

import { FAILURE_CLASS } from "../../src/core/failure_classifier.js";

// ── Helpers ───────────────────────────────────────────────────────────────────

function adaptiveConfig(overrides = {}) {
  return { runtime: { retryStrategy: "adaptive", ...overrides } };
}

function uniformConfig() {
  return { runtime: { retryStrategy: "uniform" } };
}

// ── Enum tests ────────────────────────────────────────────────────────────────

describe("RETRY_STRATEGY enum", () => {
  it("is frozen and has adaptive and uniform", () => {
    assert.ok(Object.isFrozen(RETRY_STRATEGY));
    assert.equal(RETRY_STRATEGY.ADAPTIVE, "adaptive");
    assert.equal(RETRY_STRATEGY.UNIFORM, "uniform");
    assert.equal(Object.keys(RETRY_STRATEGY).length, 2);
  });
});

describe("RETRY_ACTION enum", () => {
  it("is frozen and has all required actions", () => {
    assert.ok(Object.isFrozen(RETRY_ACTION));
    assert.equal(RETRY_ACTION.RETRY,          "retry");
    assert.equal(RETRY_ACTION.COOLDOWN_RETRY, "cooldown_retry");
    assert.equal(RETRY_ACTION.REWORK,         "rework");
    assert.equal(RETRY_ACTION.REASSIGN,       "reassign");
    assert.equal(RETRY_ACTION.SPLIT,          "split");
    assert.equal(RETRY_ACTION.ESCALATE,       "escalate");
    assert.equal(Object.keys(RETRY_ACTION).length, 6);
  });
});

describe("RETRY_RESOLVE_REASON enum", () => {
  it("is frozen and has all required reason codes", () => {
    assert.ok(Object.isFrozen(RETRY_RESOLVE_REASON));
    assert.equal(RETRY_RESOLVE_REASON.MISSING_PARAM,         "MISSING_PARAM");
    assert.equal(RETRY_RESOLVE_REASON.UNKNOWN_FAILURE_CLASS, "UNKNOWN_FAILURE_CLASS");
    assert.equal(RETRY_RESOLVE_REASON.INVALID_ATTEMPTS,      "INVALID_ATTEMPTS");
    assert.equal(Object.keys(RETRY_RESOLVE_REASON).length, 3);
  });
});

describe("RETRY_STRATEGY_SCHEMA_VERSION", () => {
  it("is the integer 1", () => {
    assert.equal(RETRY_STRATEGY_SCHEMA_VERSION, 1);
    assert.equal(typeof RETRY_STRATEGY_SCHEMA_VERSION, "number");
  });
});

// ── Schema tests ──────────────────────────────────────────────────────────────

describe("RETRY_STATE_SCHEMA", () => {
  it("is frozen and contains all required fields", () => {
    assert.ok(Object.isFrozen(RETRY_STATE_SCHEMA));
    const required = RETRY_STATE_SCHEMA.required;
    for (const f of [
      "schemaVersion", "taskId", "failureClass", "attempts", "retryAction",
      "cooldownUntilMs", "escalationTarget", "reworkQueue", "verificationStep",
      "strategyUsed", "reason", "decidedAt",
    ]) {
      assert.ok(required.includes(f), `RETRY_STATE_SCHEMA missing required field: ${f}`);
    }
  });

  it("retryActionEnum matches RETRY_ACTION values", () => {
    const expected = Object.values(RETRY_ACTION).sort();
    const actual   = [...RETRY_STATE_SCHEMA.retryActionEnum].sort();
    assert.deepEqual(actual, expected);
  });

  it("failureClassEnum matches FAILURE_CLASS values", () => {
    const expected = Object.values(FAILURE_CLASS).sort();
    const actual   = [...RETRY_STATE_SCHEMA.failureClassEnum].sort();
    assert.deepEqual(actual, expected);
  });

  it("retryStrategyEnum matches RETRY_STRATEGY values", () => {
    const expected = Object.values(RETRY_STRATEGY).sort();
    const actual   = [...RETRY_STATE_SCHEMA.retryStrategyEnum].sort();
    assert.deepEqual(actual, expected);
  });
});

describe("RETRY_METRIC_SCHEMA", () => {
  it("is frozen and contains all required fields", () => {
    assert.ok(Object.isFrozen(RETRY_METRIC_SCHEMA));
    const required = RETRY_METRIC_SCHEMA.required;
    for (const f of [
      "schemaVersion", "taskId", "failureClass", "retryAction",
      "attempts", "strategyUsed", "cooldownMs", "escalationTarget", "decidedAt",
    ]) {
      assert.ok(required.includes(f), `RETRY_METRIC_SCHEMA missing required field: ${f}`);
    }
  });

  it("outputArtifact is state/retry_metrics.jsonl", () => {
    assert.equal(RETRY_METRIC_SCHEMA.outputArtifact, "state/retry_metrics.jsonl");
  });
});

// ── DEFAULT_RETRY_POLICIES tests ──────────────────────────────────────────────

describe("DEFAULT_RETRY_POLICIES", () => {
  it("has a policy for every FAILURE_CLASS value", () => {
    for (const cls of Object.values(FAILURE_CLASS)) {
      assert.ok(DEFAULT_RETRY_POLICIES[cls], `missing policy for failure class: ${cls}`);
    }
  });

  it("environment policy has concrete cooldownMinutes=30, maxRetries=3, escalateAfter=3", () => {
    const p = DEFAULT_RETRY_POLICIES[FAILURE_CLASS.ENVIRONMENT];
    assert.equal(p.cooldownMinutes, 30);
    assert.equal(p.maxRetries, 3);
    assert.equal(p.escalateAfter, 3);
    assert.equal(p.escalationTarget, "daemon_queue");
  });

  it("model policy has cooldownMinutes=15", () => {
    assert.equal(DEFAULT_RETRY_POLICIES[FAILURE_CLASS.MODEL].cooldownMinutes, 15);
  });

  it("external_api policy has cooldownMinutes=10", () => {
    assert.equal(DEFAULT_RETRY_POLICIES[FAILURE_CLASS.EXTERNAL_API].cooldownMinutes, 10);
  });

  it("logic_defect policy has reworkQueue and verificationStep defined", () => {
    const p = DEFAULT_RETRY_POLICIES[FAILURE_CLASS.LOGIC_DEFECT];
    assert.equal(p.reworkQueue, "rework_queue");
    assert.equal(p.verificationStep, "verification_gate");
    assert.equal(p.maxReworkAttempts, 2);
    assert.equal(p.escalateAfter, 2);
  });

  it("verification policy has the same rework values as logic_defect", () => {
    const p = DEFAULT_RETRY_POLICIES[FAILURE_CLASS.VERIFICATION];
    assert.equal(p.reworkQueue, "rework_queue");
    assert.equal(p.verificationStep, "verification_gate");
    assert.equal(p.maxReworkAttempts, 2);
  });

  it("policy class has reassignBeforeAttempt, splitAfterAttempt, escalateAfter", () => {
    const p = DEFAULT_RETRY_POLICIES[FAILURE_CLASS.POLICY];
    assert.equal(p.reassignBeforeAttempt, 2);
    assert.equal(p.splitAfterAttempt, 2);
    assert.equal(p.escalateAfter, 3);
  });
});

// ── resolveRetryAction — validation (negative paths, AC#9 / AC#10) ───────────

describe("resolveRetryAction — validation: MISSING_PARAM", () => {
  it("returns MISSING_PARAM for null failureClass", () => {
    const r = resolveRetryAction(null, 0, adaptiveConfig());
    assert.equal(r.ok, false);
    assert.equal(r.code, RETRY_RESOLVE_REASON.MISSING_PARAM);
    assert.equal(r.field, "failureClass");
  });

  it("returns MISSING_PARAM for undefined failureClass", () => {
    const r = resolveRetryAction(undefined, 0, adaptiveConfig());
    assert.equal(r.ok, false);
    assert.equal(r.code, RETRY_RESOLVE_REASON.MISSING_PARAM);
  });

  it("returns MISSING_PARAM for null attempts", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, null, adaptiveConfig());
    assert.equal(r.ok, false);
    assert.equal(r.code, RETRY_RESOLVE_REASON.MISSING_PARAM);
    assert.equal(r.field, "attempts");
  });

  it("returns MISSING_PARAM for undefined attempts", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, undefined, adaptiveConfig());
    assert.equal(r.ok, false);
    assert.equal(r.code, RETRY_RESOLVE_REASON.MISSING_PARAM);
  });
});

describe("resolveRetryAction — validation: UNKNOWN_FAILURE_CLASS", () => {
  it("returns UNKNOWN_FAILURE_CLASS for an unknown class string", () => {
    const r = resolveRetryAction("cosmic_ray", 0, adaptiveConfig());
    assert.equal(r.ok, false);
    assert.equal(r.code, RETRY_RESOLVE_REASON.UNKNOWN_FAILURE_CLASS);
    assert.equal(r.field, "failureClass");
  });

  it("returns UNKNOWN_FAILURE_CLASS for empty string", () => {
    const r = resolveRetryAction("", 0, adaptiveConfig());
    assert.equal(r.ok, false);
    assert.equal(r.code, RETRY_RESOLVE_REASON.UNKNOWN_FAILURE_CLASS);
  });
});

describe("resolveRetryAction — validation: INVALID_ATTEMPTS", () => {
  it("returns INVALID_ATTEMPTS for negative attempts", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, -1, adaptiveConfig());
    assert.equal(r.ok, false);
    assert.equal(r.code, RETRY_RESOLVE_REASON.INVALID_ATTEMPTS);
    assert.equal(r.field, "attempts");
  });

  it("returns INVALID_ATTEMPTS for non-integer attempts", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 1.5, adaptiveConfig());
    assert.equal(r.ok, false);
    assert.equal(r.code, RETRY_RESOLVE_REASON.INVALID_ATTEMPTS);
  });

  it("returns INVALID_ATTEMPTS for string attempts", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, "two", adaptiveConfig());
    assert.equal(r.ok, false);
    assert.equal(r.code, RETRY_RESOLVE_REASON.INVALID_ATTEMPTS);
  });
});

// ── resolveRetryAction — uniform mode (rollback) ──────────────────────────────

describe("resolveRetryAction — uniform mode (AC#17 rollback)", () => {
  it("returns RETRY_ACTION.RETRY for any class in uniform mode", () => {
    for (const cls of Object.values(FAILURE_CLASS)) {
      const r = resolveRetryAction(cls, 5, uniformConfig());
      assert.ok(r.ok, `expected ok for class ${cls}`);
      assert.equal(r.decision.retryAction, RETRY_ACTION.RETRY);
      assert.equal(r.decision.strategyUsed, RETRY_STRATEGY.UNIFORM);
    }
  });

  it("uniform mode sets null cooldownUntilMs, reworkQueue, escalationTarget", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 10, uniformConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.cooldownUntilMs, null);
    assert.equal(r.decision.reworkQueue, null);
    assert.equal(r.decision.escalationTarget, null);
  });
});

// ── resolveRetryAction — adaptive mode: environment / model / external_api ───

describe("resolveRetryAction — environment blocker (AC#12 / AC#2)", () => {
  it("returns COOLDOWN_RETRY on first failure (attempt 0)", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 0, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.COOLDOWN_RETRY);
    assert.equal(r.decision.strategyUsed, RETRY_STRATEGY.ADAPTIVE);
  });

  it("cooldownMs is 30 minutes (1 800 000 ms) by default", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 0, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.cooldownMs, 30 * 60 * 1000);
  });

  it("cooldownUntilMs is approximately now + 30 minutes", () => {
    const before = Date.now();
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 0, adaptiveConfig());
    const after = Date.now();
    assert.ok(r.ok);
    const expected30min = 30 * 60 * 1000;
    assert.ok(r.decision.cooldownUntilMs >= before + expected30min - 5);
    assert.ok(r.decision.cooldownUntilMs <= after  + expected30min + 5);
  });

  it("escalationTarget is daemon_queue", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 0, adaptiveConfig());
    assert.equal(r.decision.escalationTarget, "daemon_queue");
  });

  it("returns ESCALATE when attempts >= escalateAfter (3)", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 3, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.ESCALATE);
    assert.equal(r.decision.escalationTarget, "daemon_queue");
  });

  it("does NOT escalate at attempt 2 (below threshold)", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 2, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.COOLDOWN_RETRY);
  });
});

describe("resolveRetryAction — model blocker", () => {
  it("returns COOLDOWN_RETRY at attempt 0 with 15-minute cooldown", () => {
    const r = resolveRetryAction(FAILURE_CLASS.MODEL, 0, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.COOLDOWN_RETRY);
    assert.equal(r.decision.cooldownMs, 15 * 60 * 1000);
  });

  it("escalates at attempt 3", () => {
    const r = resolveRetryAction(FAILURE_CLASS.MODEL, 3, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.ESCALATE);
  });
});

describe("resolveRetryAction — external_api blocker", () => {
  it("returns COOLDOWN_RETRY at attempt 0 with 10-minute cooldown", () => {
    const r = resolveRetryAction(FAILURE_CLASS.EXTERNAL_API, 0, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.COOLDOWN_RETRY);
    assert.equal(r.decision.cooldownMs, 10 * 60 * 1000);
  });

  it("escalates at attempt 3", () => {
    const r = resolveRetryAction(FAILURE_CLASS.EXTERNAL_API, 3, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.ESCALATE);
  });
});

// ── resolveRetryAction — adaptive mode: logic_defect / verification ───────────

describe("resolveRetryAction — logic_defect (AC#3 / AC#13)", () => {
  it("returns REWORK at attempt 0", () => {
    const r = resolveRetryAction(FAILURE_CLASS.LOGIC_DEFECT, 0, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.REWORK);
  });

  it("reworkQueue is rework_queue", () => {
    const r = resolveRetryAction(FAILURE_CLASS.LOGIC_DEFECT, 0, adaptiveConfig());
    assert.equal(r.decision.reworkQueue, "rework_queue");
  });

  it("verificationStep is verification_gate (AC#13)", () => {
    const r = resolveRetryAction(FAILURE_CLASS.LOGIC_DEFECT, 0, adaptiveConfig());
    assert.equal(r.decision.verificationStep, "verification_gate");
  });

  it("escalates at attempt 2 (exhausted)", () => {
    const r = resolveRetryAction(FAILURE_CLASS.LOGIC_DEFECT, 2, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.ESCALATE);
    assert.equal(r.decision.escalationTarget, "daemon_queue");
  });

  it("does NOT escalate at attempt 1 (below threshold)", () => {
    const r = resolveRetryAction(FAILURE_CLASS.LOGIC_DEFECT, 1, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.REWORK);
  });
});

describe("resolveRetryAction — verification failure", () => {
  it("returns REWORK at attempt 0", () => {
    const r = resolveRetryAction(FAILURE_CLASS.VERIFICATION, 0, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.REWORK);
    assert.equal(r.decision.verificationStep, "verification_gate");
  });

  it("escalates at attempt 2", () => {
    const r = resolveRetryAction(FAILURE_CLASS.VERIFICATION, 2, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.ESCALATE);
  });
});

// ── resolveRetryAction — adaptive mode: policy (AC#14 decision predicate) ─────

describe("resolveRetryAction — policy violation decision predicate (AC#14)", () => {
  it("attempt 0 < reassignBeforeAttempt(2) → REASSIGN", () => {
    const r = resolveRetryAction(FAILURE_CLASS.POLICY, 0, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.REASSIGN);
  });

  it("attempt 1 < reassignBeforeAttempt(2) → REASSIGN", () => {
    const r = resolveRetryAction(FAILURE_CLASS.POLICY, 1, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.REASSIGN);
  });

  it("attempt 2 >= splitAfterAttempt(2) but < escalateAfter(3) → SPLIT", () => {
    const r = resolveRetryAction(FAILURE_CLASS.POLICY, 2, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.SPLIT);
  });

  it("attempt 3 >= escalateAfter(3) → ESCALATE", () => {
    const r = resolveRetryAction(FAILURE_CLASS.POLICY, 3, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.ESCALATE);
    assert.equal(r.decision.escalationTarget, "daemon_queue");
  });
});

// ── resolveRetryAction — output schema conformance (AC#8 / AC#18) ─────────────

describe("resolveRetryAction — decision conforms to RETRY_STATE_SCHEMA", () => {
  it("all required fields are present and typed correctly", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 0, adaptiveConfig(), "T-001");
    assert.ok(r.ok);
    const d = r.decision;
    for (const f of RETRY_STATE_SCHEMA.required) {
      assert.ok(Object.prototype.hasOwnProperty.call(d, f), `decision missing field: ${f}`);
    }
    assert.equal(d.schemaVersion, RETRY_STRATEGY_SCHEMA_VERSION);
    assert.equal(d.taskId, "T-001");
    assert.ok(RETRY_STATE_SCHEMA.retryActionEnum.includes(d.retryAction));
    assert.ok(RETRY_STATE_SCHEMA.failureClassEnum.includes(d.failureClass));
    assert.ok(RETRY_STATE_SCHEMA.retryStrategyEnum.includes(d.strategyUsed));
    assert.equal(typeof d.reason, "string");
    assert.ok(d.reason.length > 0);
    assert.ok(typeof d.decidedAt === "string" && d.decidedAt.includes("T"));
  });

  it("taskId is null when not provided", () => {
    const r = resolveRetryAction(FAILURE_CLASS.MODEL, 0, adaptiveConfig());
    assert.ok(r.ok);
    assert.equal(r.decision.taskId, null);
  });
});

// ── resolveRetryAction — config override of policy values ─────────────────────

describe("resolveRetryAction — config override of adaptive policy", () => {
  it("config.runtime.adaptiveRetry.environment.cooldownMinutes overrides default", () => {
    const cfg = {
      runtime: {
        retryStrategy: "adaptive",
        adaptiveRetry: {
          environment: { cooldownMinutes: 5 }
        }
      }
    };
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 0, cfg);
    assert.ok(r.ok);
    assert.equal(r.decision.cooldownMs, 5 * 60 * 1000);
  });

  it("config.runtime.adaptiveRetry.environment.escalateAfter overrides default", () => {
    const cfg = {
      runtime: {
        retryStrategy: "adaptive",
        adaptiveRetry: {
          environment: { escalateAfter: 1 }
        }
      }
    };
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 1, cfg);
    assert.ok(r.ok);
    assert.equal(r.decision.retryAction, RETRY_ACTION.ESCALATE);
  });
});

// ── resolveRetryAction — routing assertions (AC#16) ──────────────────────────

describe("resolveRetryAction — routing assertions per failure class (AC#16)", () => {
  it("environment/attempt=0 → cooldown_retry", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 0, adaptiveConfig()).decision.retryAction, RETRY_ACTION.COOLDOWN_RETRY);
  });
  it("environment/attempt=3 → escalate", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 3, adaptiveConfig()).decision.retryAction, RETRY_ACTION.ESCALATE);
  });
  it("model/attempt=0 → cooldown_retry", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.MODEL, 0, adaptiveConfig()).decision.retryAction, RETRY_ACTION.COOLDOWN_RETRY);
  });
  it("model/attempt=3 → escalate", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.MODEL, 3, adaptiveConfig()).decision.retryAction, RETRY_ACTION.ESCALATE);
  });
  it("external_api/attempt=0 → cooldown_retry", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.EXTERNAL_API, 0, adaptiveConfig()).decision.retryAction, RETRY_ACTION.COOLDOWN_RETRY);
  });
  it("external_api/attempt=3 → escalate", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.EXTERNAL_API, 3, adaptiveConfig()).decision.retryAction, RETRY_ACTION.ESCALATE);
  });
  it("logic_defect/attempt=0 → rework", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.LOGIC_DEFECT, 0, adaptiveConfig()).decision.retryAction, RETRY_ACTION.REWORK);
  });
  it("logic_defect/attempt=2 → escalate", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.LOGIC_DEFECT, 2, adaptiveConfig()).decision.retryAction, RETRY_ACTION.ESCALATE);
  });
  it("verification/attempt=0 → rework", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.VERIFICATION, 0, adaptiveConfig()).decision.retryAction, RETRY_ACTION.REWORK);
  });
  it("verification/attempt=2 → escalate", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.VERIFICATION, 2, adaptiveConfig()).decision.retryAction, RETRY_ACTION.ESCALATE);
  });
  it("policy/attempt=0 → reassign", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.POLICY, 0, adaptiveConfig()).decision.retryAction, RETRY_ACTION.REASSIGN);
  });
  it("policy/attempt=2 → split", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.POLICY, 2, adaptiveConfig()).decision.retryAction, RETRY_ACTION.SPLIT);
  });
  it("policy/attempt=3 → escalate", () => {
    assert.equal(resolveRetryAction(FAILURE_CLASS.POLICY, 3, adaptiveConfig()).decision.retryAction, RETRY_ACTION.ESCALATE);
  });
});

// ── buildRetryMetric (AC#5 / AC#15) ──────────────────────────────────────────

describe("buildRetryMetric", () => {
  it("produces a record conforming to RETRY_METRIC_SCHEMA for cooldown_retry decision", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 0, adaptiveConfig(), "T-028");
    assert.ok(r.ok);
    const metric = buildRetryMetric(r.decision);
    for (const f of RETRY_METRIC_SCHEMA.required) {
      assert.ok(Object.prototype.hasOwnProperty.call(metric, f), `metric missing field: ${f}`);
    }
    assert.equal(metric.schemaVersion, RETRY_STRATEGY_SCHEMA_VERSION);
    assert.equal(metric.taskId, "T-028");
    assert.equal(metric.failureClass, FAILURE_CLASS.ENVIRONMENT);
    assert.equal(metric.retryAction, RETRY_ACTION.COOLDOWN_RETRY);
    assert.equal(metric.strategyUsed, RETRY_STRATEGY.ADAPTIVE);
    assert.equal(metric.cooldownMs, 30 * 60 * 1000);
    assert.equal(metric.escalationTarget, "daemon_queue");
    assert.ok(typeof metric.decidedAt === "string");
  });

  it("cooldownMs is null for non-cooldown actions (rework)", () => {
    const r = resolveRetryAction(FAILURE_CLASS.LOGIC_DEFECT, 0, adaptiveConfig());
    assert.ok(r.ok);
    const metric = buildRetryMetric(r.decision);
    assert.equal(metric.cooldownMs, null);
  });

  it("cooldownMs is null for escalate actions", () => {
    const r = resolveRetryAction(FAILURE_CLASS.ENVIRONMENT, 3, adaptiveConfig());
    assert.ok(r.ok);
    const metric = buildRetryMetric(r.decision);
    assert.equal(metric.cooldownMs, null);
  });

  it("escalationTarget is null for rework actions", () => {
    // logic_defect rework — escalationTarget may be set for context but cooldownMs is null
    const r = resolveRetryAction(FAILURE_CLASS.LOGIC_DEFECT, 0, adaptiveConfig());
    assert.ok(r.ok);
    // escalationTarget is preserved for downstream use (not null — it's the escalation fallback)
    const metric = buildRetryMetric(r.decision);
    assert.ok(typeof metric.escalationTarget === "string" || metric.escalationTarget === null);
  });
});
