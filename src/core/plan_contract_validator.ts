/**
 * plan_contract_validator.js — Contract-first plan validation (Packet 2)
 *
 * Every plan emitted by Prometheus must pass this validator before persistence.
 * Invalid plans are tagged with violation details but still included (Athena
 * makes the final accept/reject decision).
 *
 * Required fields: task, role, wave, verification
 * Recommended fields: dependencies, filesInScope, acceptance_criteria
 */

import { checkForbiddenCommands } from "./verification_command_registry.js";

/**
 * Plan contract violation severity levels.
 * @enum {string}
 */
export const PLAN_VIOLATION_SEVERITY = Object.freeze({
  CRITICAL: "critical",
  WARNING: "warning",
});

/**
 * Validate a single plan against the contract schema.
 *
 * @param {object} plan
 * @returns {{ valid: boolean, violations: Array<{ field: string, message: string, severity: string }> }}
 */
export function validatePlanContract(plan) {
  if (!plan || typeof plan !== "object") {
    return { valid: false, violations: [{ field: "plan", message: "Plan is null or not an object", severity: PLAN_VIOLATION_SEVERITY.CRITICAL }] };
  }

  const violations = [];

  // Required fields
  if (!plan.task || String(plan.task).trim().length < 5) {
    violations.push({ field: "task", message: "Task must be a non-empty string (≥5 chars)", severity: PLAN_VIOLATION_SEVERITY.CRITICAL });
  }

  if (!plan.role || String(plan.role).trim().length === 0) {
    violations.push({ field: "role", message: "Role must be specified", severity: PLAN_VIOLATION_SEVERITY.CRITICAL });
  }

  const wave = Number(plan.wave);
  if (!Number.isFinite(wave) || wave < 1) {
    violations.push({ field: "wave", message: `Wave must be a positive integer, got: ${plan.wave}`, severity: PLAN_VIOLATION_SEVERITY.WARNING });
  }

  if (!plan.verification || String(plan.verification).trim().length === 0) {
    violations.push({ field: "verification", message: "Verification command must be specified", severity: PLAN_VIOLATION_SEVERITY.WARNING });
  }

  // Recommended fields
  if (!Array.isArray(plan.dependencies)) {
    violations.push({ field: "dependencies", message: "Dependencies should be an array", severity: PLAN_VIOLATION_SEVERITY.WARNING });
  }

  if (!Array.isArray(plan.acceptance_criteria) || plan.acceptance_criteria.length === 0) {
    violations.push({ field: "acceptance_criteria", message: "Acceptance criteria must be a non-empty array — plans without measurable AC are rejected", severity: PLAN_VIOLATION_SEVERITY.CRITICAL });
  }

  // Forbidden verification command gate (Packet 5) — uses centralized registry
  const verif = String(plan.verification || "");
  const forbidden = checkForbiddenCommands(verif);
  if (forbidden.forbidden) {
    for (const v of forbidden.violations) {
      violations.push({ field: "verification", message: `Forbidden command: ${v.reason}`, severity: PLAN_VIOLATION_SEVERITY.CRITICAL });
    }
  }

  const criticalCount = violations.filter(v => v.severity === PLAN_VIOLATION_SEVERITY.CRITICAL).length;
  return { valid: criticalCount === 0, violations };
}

/**
 * Validate all plans in a batch and compute aggregate pass rate.
 *
 * @param {object[]} plans
 * @returns {{ passRate: number, totalPlans: number, validCount: number, invalidCount: number, results: Array<{ planIndex: number, task: string, valid: boolean, violations: object[] }> }}
 */
export function validateAllPlans(plans) {
  if (!Array.isArray(plans) || plans.length === 0) {
    return { passRate: 1.0, totalPlans: 0, validCount: 0, invalidCount: 0, results: [] };
  }

  const results = plans.map((plan, i) => {
    const r = validatePlanContract(plan);
    return {
      planIndex: i,
      task: String(plan?.task || "").slice(0, 80),
      valid: r.valid,
      violations: r.violations,
    };
  });

  const validCount = results.filter(r => r.valid).length;
  const invalidCount = results.length - validCount;
  const passRate = Math.round((validCount / results.length) * 100) / 100;

  return { passRate, totalPlans: results.length, validCount, invalidCount, results };
}
