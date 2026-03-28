/**
 * orchestrator_gate_precedence.test.ts
 *
 * Tests for GATE_PRECEDENCE and BLOCK_REASON exports and their integration
 * with evaluatePreDispatchGovernanceGate.
 *
 * Acceptance criteria:
 *   - GATE_PRECEDENCE values are unique integers 1..N with no gaps or duplicates.
 *   - BLOCK_REASON values are unique non-empty strings.
 *   - Every blocked result from evaluatePreDispatchGovernanceGate includes a gateIndex
 *     matching the corresponding GATE_PRECEDENCE entry.
 *   - reason strings produced by each gate start with the corresponding BLOCK_REASON prefix.
 *   - Non-blocked result does not include a gateIndex field (or it is undefined).
 *   - Guardrail gate emits GATE_PRECEDENCE.GUARDRAIL_PAUSE when active.
 *   - Governance freeze gate emits GATE_PRECEDENCE.GOVERNANCE_FREEZE when active.
 *   - Drift debt gate emits GATE_PRECEDENCE.MANDATORY_DRIFT_DEBT when active.
 *   - Plan evidence coupling gate emits GATE_PRECEDENCE.PLAN_EVIDENCE_COUPLING when active.
 *   - Negative path: non-blocked result has reason=null and no gateIndex.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  GATE_PRECEDENCE,
  BLOCK_REASON,
  evaluatePreDispatchGovernanceGate,
  type GovernanceBlockDecision,
} from "../../src/core/orchestrator.js";
import type { ArchitectureDriftReport } from "../../src/core/architecture_drift.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Minimal config that passes ALL gates (nothing enabled, no debt, no plans). */
function passAllConfig(overrides: Record<string, unknown> = {}) {
  return {
    systemGuardian: { enabled: false },
    governance: { freeze: { active: false } },
    carryForward: { maxCriticalOverdue: 999 },
    budget: { enabled: false },
    workerPool: { minLanes: 1 },
    paths: { stateDir: "/tmp/box-gate-precedence-test" },
    runtime: {},
    ...overrides,
  };
}

function makeDriftReportHighPriority(): ArchitectureDriftReport {
  return {
    scannedDocs: ["docs/arch.md"],
    presentCount: 0,
    staleCount: 1,
    staleReferences: [
      { docPath: "docs/arch.md", referencedPath: "src/core/ghost.ts", line: 1 },
    ],
    deprecatedTokenCount: 0,
    deprecatedTokenRefs: [],
  };
}

// ── Structural invariant tests ────────────────────────────────────────────────

describe("GATE_PRECEDENCE structural invariants", () => {
  it("has only integer values", () => {
    for (const [key, val] of Object.entries(GATE_PRECEDENCE)) {
      assert.ok(Number.isInteger(val), `GATE_PRECEDENCE.${key} must be an integer, got ${val}`);
    }
  });

  it("values are unique (no two gates share a precedence number)", () => {
    const values = Object.values(GATE_PRECEDENCE);
    const unique = new Set(values);
    assert.equal(unique.size, values.length, "GATE_PRECEDENCE values must be unique");
  });

  it("values form a contiguous range starting from 1", () => {
    const values = Object.values(GATE_PRECEDENCE).sort((a, b) => a - b);
    for (let i = 0; i < values.length; i++) {
      assert.equal(values[i], i + 1, `Expected GATE_PRECEDENCE to be contiguous from 1; gap at index ${i}`);
    }
  });

  it("is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(GATE_PRECEDENCE), "GATE_PRECEDENCE must be frozen");
  });
});

describe("BLOCK_REASON structural invariants", () => {
  it("has only non-empty string values", () => {
    for (const [key, val] of Object.entries(BLOCK_REASON)) {
      assert.equal(typeof val, "string", `BLOCK_REASON.${key} must be a string`);
      assert.ok(val.length > 0, `BLOCK_REASON.${key} must not be empty`);
    }
  });

  it("values are unique (no two block reasons share a prefix)", () => {
    const values = Object.values(BLOCK_REASON);
    const unique = new Set(values);
    assert.equal(unique.size, values.length, "BLOCK_REASON values must be unique");
  });

  it("is frozen (immutable)", () => {
    assert.ok(Object.isFrozen(BLOCK_REASON), "BLOCK_REASON must be frozen");
  });

  it("covers the same number of gates as GATE_PRECEDENCE", () => {
    assert.equal(
      Object.keys(BLOCK_REASON).length,
      Object.keys(GATE_PRECEDENCE).length,
      "BLOCK_REASON must have one entry per gate in GATE_PRECEDENCE"
    );
  });
});

// ── Integration tests: gateIndex on blocked results ──────────────────────────

describe("evaluatePreDispatchGovernanceGate — gateIndex on blocked results", () => {
  it("non-blocked result has reason=null and no gateIndex", async () => {
    const result = await evaluatePreDispatchGovernanceGate(passAllConfig(), [], "test-cycle", null);
    assert.equal(result.blocked, false);
    assert.equal(result.reason, null);
    assert.equal((result as any).gateIndex, undefined, "non-blocked result must not have gateIndex");
  });

  it("governance freeze gate: blocked reason starts with BLOCK_REASON.GOVERNANCE_FREEZE_ACTIVE", async () => {
    const config = passAllConfig({ governanceFreeze: { manualOverrideActive: true } });
    const result = await evaluatePreDispatchGovernanceGate(config, [], "test-cycle");
    assert.equal(result.blocked, true);
    assert.ok(
      result.reason?.startsWith(BLOCK_REASON.GOVERNANCE_FREEZE_ACTIVE),
      `reason must start with '${BLOCK_REASON.GOVERNANCE_FREEZE_ACTIVE}' — got: ${result.reason}`
    );
    assert.equal(
      (result as any).gateIndex,
      GATE_PRECEDENCE.GOVERNANCE_FREEZE,
      `gateIndex must equal GATE_PRECEDENCE.GOVERNANCE_FREEZE (${GATE_PRECEDENCE.GOVERNANCE_FREEZE})`
    );
  });

  it("governance freeze gate: reason includes the freeze sub-reason after ':'", async () => {
    const config = passAllConfig({ governanceFreeze: { manualOverrideActive: true } });
    const result = await evaluatePreDispatchGovernanceGate(config, [], "test-cycle");
    assert.ok(
      result.reason?.includes("MANUAL_OVERRIDE_ACTIVE"),
      `reason must include the freeze sub-reason — got: ${result.reason}`
    );
  });

  it("mandatory drift debt gate: blocked reason starts with BLOCK_REASON.MANDATORY_DRIFT_DEBT_UNRESOLVED", async () => {
    const result = await evaluatePreDispatchGovernanceGate(
      passAllConfig(), [], "test-cycle", makeDriftReportHighPriority()
    );
    assert.equal(result.blocked, true);
    assert.ok(
      result.reason?.startsWith(BLOCK_REASON.MANDATORY_DRIFT_DEBT_UNRESOLVED),
      `reason must start with '${BLOCK_REASON.MANDATORY_DRIFT_DEBT_UNRESOLVED}' — got: ${result.reason}`
    );
    assert.equal(
      (result as any).gateIndex,
      GATE_PRECEDENCE.MANDATORY_DRIFT_DEBT,
      `gateIndex must equal GATE_PRECEDENCE.MANDATORY_DRIFT_DEBT (${GATE_PRECEDENCE.MANDATORY_DRIFT_DEBT})`
    );
  });

  it("plan evidence coupling gate: blocked reason starts with BLOCK_REASON.PLAN_EVIDENCE_COUPLING_INVALID", async () => {
    // A plan with no verification_commands and no acceptance_criteria triggers the evidence coupling gate.
    const plans = [{ task_id: "T-001", task: "do something", role: "backend" }];
    const result = await evaluatePreDispatchGovernanceGate(passAllConfig(), plans, "test-cycle", null);
    assert.equal(result.blocked, true);
    assert.ok(
      result.reason?.startsWith(BLOCK_REASON.PLAN_EVIDENCE_COUPLING_INVALID),
      `reason must start with '${BLOCK_REASON.PLAN_EVIDENCE_COUPLING_INVALID}' — got: ${result.reason}`
    );
    assert.equal(
      (result as any).gateIndex,
      GATE_PRECEDENCE.PLAN_EVIDENCE_COUPLING,
      `gateIndex must equal GATE_PRECEDENCE.PLAN_EVIDENCE_COUPLING (${GATE_PRECEDENCE.PLAN_EVIDENCE_COUPLING})`
    );
  });

  it("lineage cycle gate: gateIndex is lower than drift debt gate (fires earlier)", () => {
    assert.ok(
      GATE_PRECEDENCE.LINEAGE_CYCLE < GATE_PRECEDENCE.MANDATORY_DRIFT_DEBT,
      "LINEAGE_CYCLE gate must fire before MANDATORY_DRIFT_DEBT gate"
    );
  });

  it("budget gate has lowest precedence number (fires first of all)", () => {
    const minPrecedence = Math.min(...Object.values(GATE_PRECEDENCE));
    assert.equal(
      GATE_PRECEDENCE.BUDGET_ELIGIBILITY,
      minPrecedence,
      "BUDGET_ELIGIBILITY must have the lowest precedence number (fires first)"
    );
  });

  it("plan evidence coupling gate has highest precedence number (fires last)", () => {
    const maxPrecedence = Math.max(...Object.values(GATE_PRECEDENCE));
    assert.equal(
      GATE_PRECEDENCE.PLAN_EVIDENCE_COUPLING,
      maxPrecedence,
      "PLAN_EVIDENCE_COUPLING must have the highest precedence number (fires last)"
    );
  });

  it("negative path: drift gate disabled with disableDriftDebtGate=true does not block", async () => {
    const config = passAllConfig({ runtime: { disableDriftDebtGate: true } });
    const result = await evaluatePreDispatchGovernanceGate(
      config, [], "test-cycle", makeDriftReportHighPriority()
    );
    assert.equal(result.blocked, false, "gate must not block when disableDriftDebtGate=true");
    assert.equal((result as any).gateIndex, undefined);
  });

  it("BLOCK_REASON.GUARDRAIL_PAUSE_WORKERS_ACTIVE matches the legacy guardrail reason string", () => {
    // Ensure constant value matches what the guardrail gate previously emitted inline.
    assert.equal(BLOCK_REASON.GUARDRAIL_PAUSE_WORKERS_ACTIVE, "guardrail_pause_workers_active");
  });

  it("BLOCK_REASON.MANDATORY_DRIFT_DEBT_UNRESOLVED matches the legacy drift gate reason prefix", () => {
    assert.equal(BLOCK_REASON.MANDATORY_DRIFT_DEBT_UNRESOLVED, "mandatory_drift_debt_unresolved");
  });
});

// ── GovernanceBlockDecision envelope contract ─────────────────────────────────

describe("GovernanceBlockDecision envelope contract", () => {
  it("blocked result contains all required envelope fields with correct types", async () => {
    const config = passAllConfig({ governanceFreeze: { manualOverrideActive: true } });
    const result: GovernanceBlockDecision = await evaluatePreDispatchGovernanceGate(config, [], "envelope-blocked-test");
    assert.equal(typeof result.blocked, "boolean", "blocked must be boolean");
    assert.equal(result.blocked, true);
    assert.equal(typeof result.reason, "string", "reason must be a string on blocked result");
    assert.equal(result.cycleId, "envelope-blocked-test", "cycleId must be carried through");
    assert.ok("budgetEligibility" in result, "budgetEligibility must always be present");
    assert.equal(typeof result.budgetEligibility, "object", "budgetEligibility must be an object");
    assert.ok("graphResult" in result, "graphResult must always be present");
    assert.ok("action" in result, "action must always be present");
    assert.equal(typeof result.gateIndex, "number", "gateIndex must be a number on blocked result");
  });

  it("non-blocked result has gateIndex=undefined, reason=null, and action=undefined", async () => {
    const result: GovernanceBlockDecision = await evaluatePreDispatchGovernanceGate(passAllConfig(), [], "envelope-pass-test");
    assert.equal(result.blocked, false);
    assert.equal(result.reason, null, "reason must be null on non-blocked result");
    assert.equal(result.gateIndex, undefined, "gateIndex must be absent on non-blocked result");
    assert.equal(result.action, undefined, "action must be undefined on non-blocked result");
    assert.ok("budgetEligibility" in result, "budgetEligibility must always be present");
    assert.ok("graphResult" in result, "graphResult must always be present");
  });

  it("drift block carries mandatoryDriftPaths in the envelope", async () => {
    const result: GovernanceBlockDecision = await evaluatePreDispatchGovernanceGate(
      passAllConfig(), [], "envelope-drift-test", makeDriftReportHighPriority()
    );
    assert.equal(result.blocked, true);
    assert.ok(Array.isArray(result.mandatoryDriftPaths), "mandatoryDriftPaths must be an array on drift block");
    assert.ok(result.mandatoryDriftPaths!.length > 0, "mandatoryDriftPaths must be non-empty on drift block");
    assert.equal(result.gateIndex, GATE_PRECEDENCE.MANDATORY_DRIFT_DEBT);
  });

  it("negative path: envelope is consistent across all gate pass scenarios (no extra fields leak)", async () => {
    // With no gates active and no plans, result must only contain the standard envelope fields.
    const result: GovernanceBlockDecision = await evaluatePreDispatchGovernanceGate(passAllConfig(), [], "envelope-clean-test");
    assert.equal(result.blocked, false);
    assert.equal(result.mandatoryDriftPaths, undefined, "mandatoryDriftPaths must be absent on pass");
    assert.equal(result.rollbackResult, undefined, "rollbackResult must be absent on pass");
    assert.equal(result.gateIndex, undefined, "gateIndex must be absent on pass");
  });
});
