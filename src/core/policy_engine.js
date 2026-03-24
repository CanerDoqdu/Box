import { readJson } from "./fs_utils.js";
import { runShadowEvaluation } from "./shadow_policy_evaluator.js";
import {
  validateGovernanceContract,
  GovernanceContractError
} from "./governance_contract.js";
import {
  assignCohort,
  COHORT,
  isGovernanceCanaryBreachActive
} from "./governance_canary.js";

export async function loadPolicy(config) {
  return readJson(config.paths.policyFile, {
    protectedPaths: [],
    requireReviewerApprovalForProtectedPaths: true,
    blockedCommands: [],
    rolePolicies: {}
  });
}

/**
 * Load policy and validate the embedded governance contract.
 *
 * On governance validation failure, throws GovernanceContractError with:
 *   - message format: "[governance] <errorCode>: <detail>"
 *   - err.errorCode : one of GOVERNANCE_ERROR_CODE values
 *   - err.exitCode  : GOVERNANCE_STARTUP_EXIT_CODE (1)
 *
 * Callers at startup SHOULD catch GovernanceContractError and call process.exit(err.exitCode).
 *
 * Recovery path: fix policy.json governanceContract section and restart.
 *
 * @param {object} config
 * @returns {Promise<object>} loaded and governance-validated policy
 * @throws {GovernanceContractError} when governance contract is missing or invalid
 */
export async function loadPolicyWithGovernance(config) {
  const policy = await loadPolicy(config);
  const result = validateGovernanceContract(policy);
  if (!result.ok) {
    throw new GovernanceContractError(result.errorCode, result.message.replace(`[governance] ${result.errorCode}: `, ""));
  }
  return policy;
}

// Re-export governance contract utilities for callers that import from policy_engine
export {
  validateGovernanceContract,
  GovernanceContractError,
  GOVERNANCE_STARTUP_EXIT_CODE
} from "./governance_contract.js";

// Re-export governance freeze utilities (T-040)
export {
  FREEZE_RISK_LEVEL,
  FREEZE_HIGH_RISK_LEVELS,
  FREEZE_NON_CRITICAL_LEVELS,
  FREEZE_GATE_RESULT,
  RISK_SCORE_THRESHOLDS,
  SYSTEMIC_GAP_SEVERITY,
  FREEZE_WEEKLY_METRICS_SCHEMA,
  YEAR_END_REPORT_SCHEMA,
  NEXT_YEAR_SEED_SCHEMA,
  isFreezeActive,
  classifyRiskLevel,
  evaluateFreezeGate,
  validateCriticalOverride,
  computeWeekKey,
  recordFreezeWeeklyMetrics,
  generateYearEndReport,
  generateNextYearSeedQuestion,
  checkFreezeRollbackCriteria
} from "./governance_freeze.js";

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function matchPathPattern(targetPath, pattern) {
  const pathNorm = normalizePath(targetPath);
  const patternNorm = normalizePath(pattern);
  if (!pathNorm || !patternNorm) return false;

  // Support prefix globs like "src/core/**"
  if (patternNorm.endsWith("/**")) {
    const prefix = patternNorm.slice(0, -3);
    return pathNorm === prefix || pathNorm.startsWith(`${prefix}/`);
  }

  // Support suffix globs like "**/orchestrator.js" or "**/*.test.js".
  // The match is anchored to a path-separator boundary so that "bad_orchestrator.js"
  // does not falsely match "**/orchestrator.js". A bare "*" in the suffix matches
  // any run of non-separator characters (e.g. "**/*.test.js" covers all .test.js files).
  if (patternNorm.startsWith("**/")) {
    const suffix = patternNorm.slice(3);
    const reStr = suffix
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // escape regex metacharacters
      .replace(/\*/g, "[^/]*"); // glob * → match any non-separator chars
    return new RegExp(`(^|/)${reStr}$`).test(pathNorm);
  }

  return pathNorm === patternNorm;
}

export function isProtectedPath(policy, filePath) {
  const patterns = Array.isArray(policy?.protectedPaths) ? policy.protectedPaths : [];
  return patterns.some((pattern) => matchPathPattern(filePath, pattern));
}

export function getProtectedPathMatches(policy, filePaths) {
  const files = Array.isArray(filePaths) ? filePaths : [];
  return files.filter((file) => isProtectedPath(policy, file));
}

export function validateShellCommand(policy, command) {
  const normalized = String(command || "").toLowerCase();
  const blocked = (Array.isArray(policy?.blockedCommands) ? policy.blockedCommands : [])
    .find((item) => normalized.includes(String(item).toLowerCase()));
  if (blocked) {
    return { ok: false, reason: `blocked command matched: ${blocked}` };
  }
  return { ok: true };
}

function normalizeRoleName(roleName) {
  return String(roleName || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function getRolePolicy(policy, roleName) {
  const all = policy?.rolePolicies;
  if (!all || typeof all !== "object") return null;

  const normalized = normalizeRoleName(roleName);
  if (!normalized) return null;

  if (all[normalized]) return all[normalized];

  const direct = String(roleName || "").trim();
  if (direct && all[direct]) return all[direct];
  return null;
}

function matchesAnyPattern(text, patterns) {
  const normalized = String(text || "").toLowerCase();
  return patterns.some((item) => normalized.includes(String(item).toLowerCase()));
}

export function validateRoleInstruction(policy, roleName, taskText) {
  const rolePolicy = getRolePolicy(policy, roleName);
  if (!rolePolicy) return { ok: true };

  const blockedTaskPatterns = Array.isArray(rolePolicy?.blockedTaskPatterns)
    ? rolePolicy.blockedTaskPatterns
    : [];
  if (blockedTaskPatterns.length > 0 && matchesAnyPattern(taskText, blockedTaskPatterns)) {
    return {
      ok: false,
      reason: `role policy blocked task for ${roleName}`
    };
  }

  const requiredTaskPatterns = Array.isArray(rolePolicy?.requiredTaskPatterns)
    ? rolePolicy.requiredTaskPatterns
    : [];
  if (requiredTaskPatterns.length > 0 && !matchesAnyPattern(taskText, requiredTaskPatterns)) {
    return {
      ok: false,
      reason: `role policy missing required task intent for ${roleName}`
    };
  }

  return { ok: true };
}
export function getRolePathViolations(policy, roleName, filePaths) {
  const rolePolicy = getRolePolicy(policy, roleName);
  const files = Array.isArray(filePaths) ? filePaths : [];
  if (!rolePolicy || files.length === 0) {
    return {
      role: String(roleName || ""),
      deniedMatches: [],
      outsideAllowed: [],
      hasViolation: false
    };
  }

  const allowedPaths = Array.isArray(rolePolicy?.allowedPaths) ? rolePolicy.allowedPaths : [];
  const deniedPaths = Array.isArray(rolePolicy?.deniedPaths) ? rolePolicy.deniedPaths : [];

  const deniedMatches = deniedPaths.length > 0
    ? files.filter((file) => deniedPaths.some((pattern) => matchPathPattern(file, pattern)))
    : [];

  const outsideAllowed = allowedPaths.length > 0
    ? files.filter((file) => !allowedPaths.some((pattern) => matchPathPattern(file, pattern)))
    : [];

  return {
    role: String(roleName || ""),
    deniedMatches,
    outsideAllowed,
    hasViolation: deniedMatches.length > 0 || outsideAllowed.length > 0
  };
}

/**
 * Gate a policy promotion through shadow evaluation.
 *
 * Runs runShadowEvaluation against recent cycle history before any policy change
 * is applied to the runtime. Returns the evaluation result; callers must inspect
 * result.blocked to decide whether to proceed.
 *
 * @param {object}   currentPolicy    The currently loaded policy.
 * @param {object[]} proposedChanges  Proposed changes (see shadow_policy_evaluator.js schema).
 * @param {object}   [options]        Forwarded to runShadowEvaluation (stateDir, threshold, owner).
 * @returns {Promise<object>}         Shadow evaluation result (schemaVersion: 1).
 */
export async function evaluatePolicyPromotion(currentPolicy, proposedChanges, options = {}) {
  return runShadowEvaluation(currentPolicy, proposedChanges, options);
}

/**
 * Apply a single composed governance decision with guardrail > freeze > canary precedence.
 *
 * Precedence order (highest to lowest):
 *   1. guardrail — active hardware-level guard takes absolute priority
 *   2. freeze    — year-end stabilization freeze blocks changes
 *   3. canary    — active canary breach halts new governance rules
 *
 * All three inputs are booleans; the caller is responsible for resolving their
 * true/false status from the respective sub-systems before calling this function.
 *
 * @param {{ guardrailActive?: boolean, freezeActive?: boolean, canaryBreachActive?: boolean }} inputs
 * @returns {{ blocked: boolean, reason: string, precedenceLevel: number }}
 */
export function applyGovernanceDecision({
  guardrailActive    = false,
  freezeActive       = false,
  canaryBreachActive = false
} = {}) {
  if (guardrailActive) {
    return { blocked: true,  reason: "guardrail:active",      precedenceLevel: 1 };
  }
  if (freezeActive) {
    return { blocked: true,  reason: "freeze:active",         precedenceLevel: 2 };
  }
  if (canaryBreachActive) {
    return { blocked: true,  reason: "canary:breach-active",  precedenceLevel: 3 };
  }
  return { blocked: false, reason: "all-gates-passed", precedenceLevel: 0 };
}

/**
 * Determine whether a governance rule should be applied to a given cycle.
 *
 * Uses the governance canary cohort selection algorithm to deterministically
 * assign the cycle to "canary" or "control". Canary cycles have new governance
 * rules applied; control cycles use the existing policy baseline.
 *
 * If a governance canary breach is active (status=rolled_back with
 * breachAction=halt_new_assignments), new governance rules are NOT applied
 * to ANY cycle until the breach is cleared (AC4 — rollback behavior).
 *
 * @param {object} config   - full runtime config
 * @param {string} cycleId  - opaque cycle identifier (entropy source for hash-mod)
 * @returns {Promise<{ cohort: "canary"|"control", applyNewRules: boolean, reason: string }>}
 */
export async function shouldApplyGovernanceRule(config, cycleId) {
  if (!cycleId || typeof cycleId !== "string") {
    // AC9: missing input → explicit reason code, default to control (safe)
    return {
      cohort:       COHORT.CONTROL,
      applyNewRules: false,
      reason:       "MISSING_CYCLE_ID:defaulting_to_control"
    };
  }

  // Check if a breach is active — if so, halt new assignments (AC4)
  let breachStatus;
  try {
    breachStatus = await isGovernanceCanaryBreachActive(config);
  } catch {
    // Non-fatal: if the check fails, default to control (safe fallback)
    return {
      cohort:        COHORT.CONTROL,
      applyNewRules: false,
      reason:        "BREACH_CHECK_FAILED:defaulting_to_control"
    };
  }

  if (breachStatus.breachActive) {
    return {
      cohort:        COHORT.CONTROL,
      applyNewRules: false,
      reason:        `BREACH_ACTIVE:${breachStatus.reason || "halt_new_assignments"}`
    };
  }

  const ratio  = config?.canary?.governance?.canaryRatio
    ?? config?.canary?.defaultRatio
    ?? 0.2;
  const cohort = assignCohort(cycleId, ratio);

  return {
    cohort,
    applyNewRules: cohort === COHORT.CANARY,
    reason:        `COHORT_ASSIGNED:${cohort}:algorithm=hash-mod:ratio=${ratio}`
  };
}
