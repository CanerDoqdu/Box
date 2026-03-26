/**
 * learning_policy_compiler.js — Converts postmortem lessons into enforced policy checks.
 *
 * Problem: Postmortem lessons sit as text in JSON files. The same defects recur
 * because lessons are advisory, not enforced.
 *
 * Solution: This compiler extracts actionable patterns from lessons and generates
 * deterministic policy assertions that can be checked before worker dispatch.
 *
 * Integration: called by orchestrator after postmortem, before next cycle start.
 */

/**
 * Known lesson patterns that can be compiled into policy checks.
 * Each pattern has a regex to match lessons and a policy assertion to enforce.
 *
 * @type {Array<{ id: string, pattern: RegExp, assertion: string, severity: string }>}
 */
const COMPILABLE_PATTERNS = [
  {
    id: "glob-false-fail",
    pattern: /glob|node --test tests[\\/]\*|wildcard|path.*expansion/i,
    assertion: "Verification must use 'npm test' not 'node --test tests/**'",
    severity: "critical"
  },
  {
    id: "missing-test",
    pattern: /no\s+test|missing\s+test|untested|test.*coverage/i,
    assertion: "New code must include at least one test file",
    severity: "warning"
  },
  {
    id: "lint-failure",
    pattern: /lint|eslint|unused\s+(var|import|export)/i,
    assertion: "Run npm run lint before marking task complete",
    severity: "warning"
  },
  {
    id: "import-error",
    pattern: /import.*error|module.*not\s+found|cannot\s+find\s+module/i,
    assertion: "All imports must resolve; verify with node -e 'import(\"./path\")'",
    severity: "critical"
  },
  {
    id: "state-corruption",
    pattern: /state.*corrupt|json.*parse|invalid\s+json|malformed/i,
    assertion: "State files must be written atomically with writeJson",
    severity: "critical"
  },
  {
    id: "syntax-error",
    pattern: /syntax\s*error|unexpected\s+token|parse\s+error/i,
    assertion: "Code must parse without SyntaxError before commit",
    severity: "critical"
  },
  {
    id: "hardcoded-path",
    pattern: /hardcoded|absolute\s+path|windows.*path|backslash/i,
    assertion: "Use path.join() for all file paths; no hardcoded separators",
    severity: "warning"
  },
  {
    id: "missing-error-handling",
    pattern: /unhandled|uncaught|swallow.*error|silent.*fail/i,
    assertion: "Async operations at system boundaries must have try/catch",
    severity: "warning"
  },
];

/**
 * @typedef {object} CompiledPolicy
 * @property {string} id — policy rule ID
 * @property {string} assertion — human-readable policy assertion
 * @property {string} severity — "critical" | "warning"
 * @property {string} sourceLesson — the lesson text that triggered this policy
 * @property {string} detectedAt — ISO timestamp
 */

/**
 * Compile lessons from postmortem history into enforced policy checks.
 *
 * @param {object[]} postmortems — postmortem entries with lessonLearned field
 * @param {{ existingPolicies?: string[] }} opts
 * @returns {CompiledPolicy[]}
 */
export function compileLessonsToPolicies(postmortems, opts: any = {}) {
  if (!Array.isArray(postmortems)) return [];

  const existing = new Set(opts.existingPolicies || []);
  /** @type {CompiledPolicy[]} */
  const policies = [];
  const seen = new Set();

  for (const pm of postmortems) {
    const lesson = String(pm?.lessonLearned || "").trim();
    if (lesson.length < 10) continue;

    for (const template of COMPILABLE_PATTERNS) {
      if (template.pattern.test(lesson) && !seen.has(template.id) && !existing.has(template.id)) {
        seen.add(template.id);
        policies.push({
          id: template.id,
          assertion: template.assertion,
          severity: template.severity,
          sourceLesson: lesson.slice(0, 200),
          detectedAt: pm.reviewedAt || new Date().toISOString()
        });
      }
    }
  }

  return policies;
}

/**
 * Validate a plan against compiled policies.
 * Returns violations if the plan conflicts with any active policy.
 *
 * @param {object} plan — plan object
 * @param {CompiledPolicy[]} policies — active compiled policies
 * @returns {{ ok: boolean, violations: Array<{ policyId: string, assertion: string, severity: string }> }}
 */
export function validatePlanAgainstPolicies(plan, policies) {
  if (!plan || !Array.isArray(policies)) return { ok: true, violations: [] };

  const violations = [];
  const verification = String(plan.verification || "").toLowerCase();
  const task = String(plan.task || "").toLowerCase();

  for (const policy of policies) {
    // Check specific known violations
    if (policy.id === "glob-false-fail" && /node\s+--test\s+tests/.test(verification)) {
      violations.push({ policyId: policy.id, assertion: policy.assertion, severity: policy.severity });
    }
    if (policy.id === "missing-test" && /implement|create|add/.test(task) && !/test/.test(task) && !/test/.test(verification)) {
      violations.push({ policyId: policy.id, assertion: policy.assertion, severity: policy.severity });
    }
  }

  return { ok: violations.length === 0, violations };
}

/**
 * Check if unresolved carry-forward lessons should block plan acceptance (Packet 10/16).
 * Plans are blocked when the same lesson has gone unresolved for more than maxCycles.
 *
 * Enhanced (Packet 16): Also validates that mandatory carry-forward items appear
 * explicitly in the current plan set. Plans missing mandatory items are blocked.
 *
 * @param {object[]} postmortems — postmortem entries with followUpNeeded/followUpTask
 * @param {object[]} currentPlans — current plan set to check against
 * @param {{ maxUnresolvedCycles?: number, mandatoryCarryForward?: string[] }} opts
 * @returns {{ shouldBlock: boolean, reason: string, unresolvedLessons: string[], missingMandatory: string[] }}
 */
export function checkCarryForwardGate(postmortems, currentPlans, opts: any = {}) {
  const maxCycles = opts.maxUnresolvedCycles || 3;
  if (!Array.isArray(postmortems)) return { shouldBlock: false, reason: "", unresolvedLessons: [], missingMandatory: [] };

  // Count how many times each lesson appears unresolved
  const lessonCounts = new Map();
  for (const pm of postmortems) {
    if (!pm.followUpNeeded || !pm.followUpTask) continue;
    const normalized = normalizeKey(pm.followUpTask);
    if (!normalized) continue;
    lessonCounts.set(normalized, (lessonCounts.get(normalized) || 0) + 1);
  }

  // Check if current plans address any of the unresolved lessons
  const planTexts = (currentPlans || []).map(p => normalizeKey(String(p.task || "")));

  const unresolvedLessons = [];
  for (const [lesson, count] of lessonCounts) {
    if (count < maxCycles) continue;
    // Check if current plan addresses this lesson
    const addressed = planTexts.some(pt => pt.includes(lesson.slice(0, 40)) || lesson.includes(pt.slice(0, 40)));
    if (!addressed) {
      unresolvedLessons.push(lesson.slice(0, 100));
    }
  }

  // Packet 16: Validate mandatory carry-forward items
  const mandatory = Array.isArray(opts.mandatoryCarryForward) ? opts.mandatoryCarryForward : [];
  const missingMandatory = [];
  for (const item of mandatory) {
    const normalizedItem = normalizeKey(item);
    const found = planTexts.some(pt => pt.includes(normalizedItem.slice(0, 40)) || normalizedItem.includes(pt.slice(0, 40)));
    if (!found) {
      missingMandatory.push(item.slice(0, 100));
    }
  }

  const shouldBlock = unresolvedLessons.length > 0 || missingMandatory.length > 0;
  const reasons = [];
  if (unresolvedLessons.length > 0) {
    reasons.push(`${unresolvedLessons.length} lesson(s) unresolved for >${maxCycles} cycles and not addressed in current plan`);
  }
  if (missingMandatory.length > 0) {
    reasons.push(`${missingMandatory.length} mandatory carry-forward item(s) missing from plan`);
  }

  return {
    shouldBlock,
    reason: reasons.join("; "),
    unresolvedLessons,
    missingMandatory,
  };
}

function normalizeKey(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
}

/** Exported for testing. */
export { COMPILABLE_PATTERNS };

/**
 * Hard-gate: auto-compile unresolved recurrences into enforceable policies (Packet 15).
 *
 * When the same lesson recurs more than `maxRecurrences` times without resolution,
 * this function forcibly compiles it into a policy assertion that blocks future plans
 * matching the same pattern.
 *
 * @param {object[]} postmortems — full postmortem history
 * @param {string[]} existingPolicyIds — already-active policy IDs
 * @param {{ maxRecurrences?: number }} opts
 * @returns {{ newPolicies: CompiledPolicy[], escalations: string[] }}
 */
export function hardGateRecurrenceToPolicies(postmortems, existingPolicyIds = [], opts: any = {}) {
  const maxRecurrences = opts.maxRecurrences || 3;
  if (!Array.isArray(postmortems)) return { newPolicies: [], escalations: [] };

  const existing = new Set(existingPolicyIds);
  const lessonCounts = new Map();

  // Count lesson occurrences
  for (const pm of postmortems) {
    if (!pm.followUpNeeded) continue;
    const lesson = String(pm.lessonLearned || "").trim();
    if (lesson.length < 10) continue;
    lessonCounts.set(lesson, (lessonCounts.get(lesson) || 0) + 1);
  }

  const newPolicies = [];
  const escalations = [];

  for (const [lesson, count] of lessonCounts) {
    if (count < maxRecurrences) continue;

    // Try to compile into a known pattern
    let compiled = false;
    for (const template of COMPILABLE_PATTERNS) {
      if (template.pattern.test(lesson) && !existing.has(template.id)) {
        existing.add(template.id);
        newPolicies.push({
          id: template.id,
          assertion: template.assertion,
          severity: "critical", // Force critical for recurring issues
          sourceLesson: lesson.slice(0, 200),
          detectedAt: new Date().toISOString(),
          _hardGated: true,
          _recurrenceCount: count,
        });
        compiled = true;
        break;
      }
    }

    // If no known pattern matches, escalate as a custom rule
    if (!compiled) {
      const customId = `custom-recurrence-${normalizeKey(lesson).slice(0, 30).replace(/\s/g, "-")}`;
      if (!existing.has(customId)) {
        existing.add(customId);
        newPolicies.push({
          id: customId,
          assertion: `Recurring unresolved: ${lesson.slice(0, 100)}`,
          severity: "warning",
          sourceLesson: lesson.slice(0, 200),
          detectedAt: new Date().toISOString(),
          _hardGated: true,
          _recurrenceCount: count,
        });
        escalations.push(`Lesson recurring ${count}x without resolution: ${lesson.slice(0, 80)}`);
      }
    }
  }

  return { newPolicies, escalations };
}

// ── Routing adjustments (Task 9) ──────────────────────────────────────────────

/**
 * @typedef {object} RoutingAdjustment
 * @property {string} policyId — the compiled policy that triggered this adjustment
 * @property {string} modelOverride — model routing override (e.g. "force-sonnet", "block-opus")
 * @property {string} reason — why this routing adjustment was applied
 * @property {"critical"|"warning"} severity — mirrors the triggering policy severity
 */

/**
 * Map from policy ID to the routing adjustment it should trigger.
 * Critical policies (recurring failures) route to safer, more predictable models.
 * Import-related issues block Opus escalation since model complexity is not the problem.
 */
const POLICY_ROUTING_MAP: Record<string, { modelOverride: string; reason: string }> = {
  "glob-false-fail":          { modelOverride: "force-sonnet", reason: "glob failures are tooling issues, not reasoning gaps — Sonnet sufficient" },
  "lint-failure":             { modelOverride: "force-sonnet", reason: "lint failures require precision, not reasoning depth" },
  "hardcoded-path":           { modelOverride: "force-sonnet", reason: "path issues are mechanical — Sonnet sufficient" },
  "import-error":             { modelOverride: "block-opus",   reason: "import errors indicate env/dependency issues, not model capability gaps" },
  "missing-error-handling":   { modelOverride: "force-sonnet", reason: "error handling is a discipline issue, not a reasoning issue" },
  "missing-test":             { modelOverride: "force-sonnet", reason: "test coverage is discipline-driven, not model-driven" },
  "state-corruption":         { modelOverride: "force-sonnet", reason: "state atomicity is a tooling discipline; model change unhelpful" },
  "syntax-error":             { modelOverride: "block-opus",   reason: "syntax errors are never fixed by a more expensive model" },
};

/**
 * Derive routing adjustments from compiled policies.
 *
 * Recurring failure classes adjust model routing to prevent the same model from
 * being used on tasks where it has demonstrated repeated failure.
 *
 * @param {CompiledPolicy[]} policies — active compiled policies (from compileLessonsToPolicies or hardGateRecurrenceToPolicies)
 * @returns {RoutingAdjustment[]}
 */
export function deriveRoutingAdjustments(policies) {
  if (!Array.isArray(policies)) return [];

  const adjustments = [];
  const seen = new Set<string>();

  for (const policy of policies) {
    const id = String(policy?.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const mapping = POLICY_ROUTING_MAP[id];
    if (mapping) {
      adjustments.push({
        policyId: id,
        modelOverride: mapping.modelOverride,
        reason: mapping.reason,
        severity: policy.severity || "warning",
      });
    }
    // For hard-gated custom recurrence policies, default to force-sonnet
    else if (id.startsWith("custom-recurrence-") && (policy as any)._hardGated) {
      adjustments.push({
        policyId: id,
        modelOverride: "force-sonnet",
        reason: `Recurring custom failure class: ${policy.assertion?.slice(0, 80) || id}`,
        severity: policy.severity || "warning",
      });
    }
  }

  return adjustments;
}

/**
 * @typedef {object} PromptHardConstraint
 * @property {string} policyId — the compiled policy that triggered this constraint
 * @property {string} constraint — the hard constraint to inject into the worker prompt
 * @property {boolean} blocking — if true, violation of this constraint causes immediate rework
 * @property {"critical"|"warning"} severity — mirrors the triggering policy severity
 */

/**
 * Map from policy ID to the prompt hard constraint it injects.
 * Hard constraints are injected into the worker prompt preamble so the model
 * cannot silently violate them — violation triggers an immediate rework gate.
 */
const POLICY_PROMPT_CONSTRAINT_MAP: Record<string, { constraint: string; blocking: boolean }> = {
  "glob-false-fail":          { constraint: "HARD CONSTRAINT: Use 'npm test' only. Never use 'node --test tests/**' glob patterns.", blocking: true },
  "missing-test":             { constraint: "HARD CONSTRAINT: Every code change must include or update at least one test file.", blocking: true },
  "lint-failure":             { constraint: "HARD CONSTRAINT: Run 'npm run lint' before marking done. Zero new lint errors are required.", blocking: true },
  "import-error":             { constraint: "HARD CONSTRAINT: Verify all imports resolve before committing. Run 'node -e \"import('./path')\"' on new imports.", blocking: true },
  "state-corruption":         { constraint: "HARD CONSTRAINT: All state file writes must use writeJson (atomic write). Never use fs.writeFile directly on JSON state.", blocking: true },
  "syntax-error":             { constraint: "HARD CONSTRAINT: Syntax-check all changed files before commit. No SyntaxError is acceptable.", blocking: true },
  "hardcoded-path":           { constraint: "HARD CONSTRAINT: Use path.join() for all file paths. No hardcoded separators (/ or \\\\).", blocking: false },
  "missing-error-handling":   { constraint: "HARD CONSTRAINT: All async operations at system boundaries must have explicit try/catch with logged errors.", blocking: false },
};

/**
 * Build prompt hard constraints from compiled policies.
 *
 * These constraints are injected into the worker prompt so the model has
 * explicit in-context rules derived from recurring postmortem failure classes.
 *
 * @param {CompiledPolicy[]} policies — active compiled policies
 * @returns {PromptHardConstraint[]}
 */
export function buildPromptHardConstraints(policies) {
  if (!Array.isArray(policies)) return [];

  const constraints = [];
  const seen = new Set<string>();

  for (const policy of policies) {
    const id = String(policy?.id || "");
    if (!id || seen.has(id)) continue;
    seen.add(id);

    const mapping = POLICY_PROMPT_CONSTRAINT_MAP[id];
    if (mapping) {
      constraints.push({
        policyId: id,
        constraint: mapping.constraint,
        blocking: mapping.blocking,
        severity: policy.severity || "warning",
      });
    }
    // For hard-gated custom recurrence policies, generate a generic constraint
    else if (id.startsWith("custom-recurrence-") && (policy as any)._hardGated) {
      constraints.push({
        policyId: id,
        constraint: `HARD CONSTRAINT (recurring): ${policy.assertion?.slice(0, 120) || id}`,
        blocking: policy.severity === "critical",
        severity: policy.severity || "warning",
      });
    }
  }

  return constraints;
}
