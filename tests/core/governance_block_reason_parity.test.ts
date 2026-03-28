/**
 * governance_block_reason_parity.test.ts
 *
 * Cross-module terminology-parity tests between governance block reasons
 * (governance_contract.ts) and policy-engine reason taxonomy (policy_engine.ts).
 *
 * Purpose: drift-prevention. If a contributor accidentally changes reason codes
 * to use the other module's format, these tests fail deterministically.
 *
 * Parity contract:
 *   governance_contract enforceGovernance  → { blocked, blockReason, ok, riskLevel }
 *     blockReason format: "SCREAMING_SNAKE: detail" when blocked, null when not blocked
 *
 *   policy_engine applyGovernanceDecision  → { blocked, reason, precedenceLevel }
 *     reason format:  "domain:kebab-action" for all outcomes (blocked and unblocked)
 *
 * Both modules share the `blocked: boolean` field — the single structural invariant
 * that unites them despite their different reason-code taxonomies.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { applyGovernanceDecision } from "../../src/core/policy_engine.js";
import { enforceGovernance, classifyRiskLevel, RISK_LEVEL } from "../../src/core/governance_contract.js";

// ── Shared helpers ─────────────────────────────────────────────────────────────

/** Minimal high-risk change fixture that triggers dual-approval requirement. */
function makeHighRiskChange() {
  return { changeType: "dependency_change", riskScore: 0.8, filesChanged: [] };
}

/** Minimal policy that enables dual-approval enforcement for high-risk changes. */
function makePolicy() {
  return {
    governanceContract: {
      highRiskScoreThreshold: 0.7,
      criticalRiskScoreThreshold: 0.9,
    },
    protectedPaths: [],
  };
}

/** Empty approval evidence — will fail dual-approval validation. */
function makeEmptyApprovals() {
  return { approvals: [] };
}

// ── Structural parity: shared `blocked` field ─────────────────────────────────

describe("governance block reason parity — shared structural contract", () => {
  it("both modules always include a boolean `blocked` field in their output", () => {
    // policy_engine
    const policyBlocked = applyGovernanceDecision({ guardrailActive: true });
    const policyPassed  = applyGovernanceDecision({});
    assert.equal(typeof policyBlocked.blocked, "boolean",
      "policy_engine blocked result must have boolean `blocked`");
    assert.equal(typeof policyPassed.blocked, "boolean",
      "policy_engine passed result must have boolean `blocked`");

    // governance_contract
    const govBlocked = enforceGovernance(makeHighRiskChange(), makeEmptyApprovals(), makePolicy());
    const govPassed  = enforceGovernance(
      { changeType: "docs", riskScore: 0.1, filesChanged: [] },
      {},
      makePolicy()
    );
    assert.equal(typeof govBlocked.blocked, "boolean",
      "governance_contract blocked result must have boolean `blocked`");
    assert.equal(typeof govPassed.blocked, "boolean",
      "governance_contract passed result must have boolean `blocked`");
  });

  it("both modules set blocked=true when a gate fires", () => {
    const policyResult = applyGovernanceDecision({ guardrailActive: true });
    assert.equal(policyResult.blocked, true, "policy_engine must set blocked=true for guardrail");

    const govResult = enforceGovernance(makeHighRiskChange(), makeEmptyApprovals(), makePolicy());
    assert.equal(govResult.blocked, true, "governance_contract must set blocked=true for missing approval");
  });

  it("both modules set blocked=false when no gate fires", () => {
    const policyResult = applyGovernanceDecision({});
    assert.equal(policyResult.blocked, false, "policy_engine must set blocked=false when all gates pass");

    const govResult = enforceGovernance(
      { changeType: "docs", riskScore: 0.1, filesChanged: [] },
      {},
      makePolicy()
    );
    assert.equal(govResult.blocked, false, "governance_contract must set blocked=false for low-risk change");
  });
});

// ── Taxonomy parity: policy_engine uses domain:kebab format ──────────────────

describe("policy_engine reason taxonomy — domain:kebab-action format", () => {
  const DOMAIN_KEBAB_RE = /^[a-z][a-z0-9-]*:[a-z][a-z0-9-]*$/;

  it("all policy_engine block reasons use domain:kebab-action format", () => {
    const blockedResults = [
      applyGovernanceDecision({ guardrailActive: true }),
      applyGovernanceDecision({ freezeActive: true }),
      applyGovernanceDecision({ canaryBreachActive: true }),
    ];

    for (const result of blockedResults) {
      assert.equal(result.blocked, true);
      assert.match(result.reason, DOMAIN_KEBAB_RE,
        `policy_engine blocked reason "${result.reason}" must match domain:kebab-action format`);
    }
  });

  it("policy_engine non-blocking reason uses lowercase format (not SCREAMING_SNAKE)", () => {
    const result = applyGovernanceDecision({});
    assert.equal(result.blocked, false);
    assert.equal(typeof result.reason, "string");
    assert.ok(result.reason.length > 0, "non-blocking reason must be a non-empty string");
    // Must not use SCREAMING_SNAKE format (reserved for governance_contract)
    assert.doesNotMatch(result.reason, /^[A-Z_]+:/,
      "policy_engine reasons must not use SCREAMING_SNAKE: format — that is governance_contract taxonomy");
  });

  it("policy_engine never uses governance_contract SCREAMING_SNAKE blockReason codes", () => {
    // Enumerate all known governance_contract blockReason prefixes
    const GOVERNANCE_PREFIXES = [
      "DUAL_APPROVAL_REQUIRED",
      "APPROVALS_MISSING",
      "INSUFFICIENT_APPROVERS",
      "APPROVAL_SCHEMA_INVALID",
      "INSUFFICIENT_DISTINCT_ROLES",
      "SCHEMA_INVALID",
      "IO_ERROR",
    ];

    const policyReasons = [
      applyGovernanceDecision({ guardrailActive: true }).reason,
      applyGovernanceDecision({ freezeActive: true }).reason,
      applyGovernanceDecision({ canaryBreachActive: true }).reason,
      applyGovernanceDecision({}).reason,
    ];

    for (const reason of policyReasons) {
      for (const prefix of GOVERNANCE_PREFIXES) {
        assert.ok(!reason.startsWith(prefix),
          `policy_engine reason "${reason}" must not start with governance_contract prefix "${prefix}"`);
      }
    }
  });
});

// ── Taxonomy parity: governance_contract uses SCREAMING_SNAKE: detail ────────

describe("governance_contract blockReason taxonomy — SCREAMING_SNAKE: detail format", () => {
  const SCREAMING_SNAKE_RE = /^[A-Z][A-Z0-9_]+: /;

  it("all governance_contract blockReasons use SCREAMING_SNAKE: detail format when blocked", () => {
    const blockedResult = enforceGovernance(makeHighRiskChange(), makeEmptyApprovals(), makePolicy());

    assert.equal(blockedResult.blocked, true);
    assert.ok(typeof blockedResult.blockReason === "string",
      "blockReason must be a string when blocked");
    assert.match(blockedResult.blockReason!, SCREAMING_SNAKE_RE,
      `blockReason "${blockedResult.blockReason}" must match SCREAMING_SNAKE: detail format`);
  });

  it("governance_contract blockReason is null (not a string) when not blocked", () => {
    const passedResult = enforceGovernance(
      { changeType: "docs", riskScore: 0.1, filesChanged: [] },
      {},
      makePolicy()
    );

    assert.equal(passedResult.blocked, false);
    assert.equal(passedResult.blockReason, null,
      "blockReason must be null when not blocked — not an empty string or undefined");
  });

  it("governance_contract never uses policy_engine domain:kebab reason codes", () => {
    // Enumerate all known policy_engine reason codes
    const POLICY_REASONS = [
      "guardrail:active",
      "freeze:active",
      "canary:breach-active",
      "all-gates-passed",
    ];

    const govResult = enforceGovernance(makeHighRiskChange(), makeEmptyApprovals(), makePolicy());
    const blockReason = govResult.blockReason!;

    for (const policyReason of POLICY_REASONS) {
      assert.ok(!blockReason.includes(policyReason),
        `governance_contract blockReason "${blockReason}" must not embed policy_engine reason code "${policyReason}"`);
    }
  });
});

// ── Negative path: reason codes are distinct and non-interchangeable ─────────

describe("governance block reason parity — negative path: no terminology bleed", () => {
  it("policy_engine reason codes do not appear in governance_contract blockReason strings", () => {
    const govBlocked = enforceGovernance(makeHighRiskChange(), makeEmptyApprovals(), makePolicy());
    assert.ok(govBlocked.blocked && typeof govBlocked.blockReason === "string");

    // Policy engine uses colon-separated lowercase — governance uses SCREAMING_SNAKE:
    // If these appear in governance output it indicates taxonomy drift.
    const policyStylePattern = /^[a-z]+:[a-z]+/;
    assert.doesNotMatch(govBlocked.blockReason!, policyStylePattern,
      "governance_contract blockReason must not start with policy_engine's lowercase domain:action format");
  });

  it("governance_contract reason codes do not appear as policy_engine reason values", () => {
    const policyBlocked = applyGovernanceDecision({ guardrailActive: true });
    assert.equal(policyBlocked.blocked, true);

    // Governance uses SCREAMING_SNAKE: prefix — policy_engine must not use this
    const governanceStylePattern = /^[A-Z_]+:/;
    assert.doesNotMatch(policyBlocked.reason, governanceStylePattern,
      "policy_engine reason must not use SCREAMING_SNAKE: prefix reserved for governance_contract");
  });

  it("both modules produce a non-empty reason/blockReason string on every block — no silent failures", () => {
    // policy_engine: blocked by guardrail
    const pe = applyGovernanceDecision({ guardrailActive: true });
    assert.equal(pe.blocked, true);
    assert.ok(typeof pe.reason === "string" && pe.reason.length > 0,
      "policy_engine must produce a non-empty reason string on block");

    // governance_contract: blocked by missing approval
    const gc = enforceGovernance(makeHighRiskChange(), makeEmptyApprovals(), makePolicy());
    assert.equal(gc.blocked, true);
    assert.ok(typeof gc.blockReason === "string" && gc.blockReason.length > 0,
      "governance_contract must produce a non-empty blockReason string on block");
  });
});
