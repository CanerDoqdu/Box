/**
 * plan_critic.js — Internal critic for Prometheus dual-pass planning.
 *
 * Pass-A: Prometheus generates plans (existing flow).
 * Pass-B: This critic evaluates each plan against a rubric and flags issues.
 * Plans that fail the critic gate are demoted or removed before Athena review.
 *
 * This is NOT a replacement for Athena; it is a fast, deterministic pre-filter
 * that catches obvious plan deficiencies cheaply (no AI call).
 */

/**
 * Critic rubric dimensions. Each returns a 0-1 score.
 * @enum {string}
 */
export const CRITIC_DIMENSION = Object.freeze({
  HAS_MEASURABLE_AC:      "HAS_MEASURABLE_AC",
  HAS_VERIFICATION:       "HAS_VERIFICATION",
  HAS_CLEAR_SCOPE:        "HAS_CLEAR_SCOPE",
  HAS_DEPENDENCIES:       "HAS_DEPENDENCIES",
  NO_VAGUE_TASK:          "NO_VAGUE_TASK",
  REASONABLE_RISK:        "REASONABLE_RISK",
});

/** Minimum composite score to pass the critic gate (0-1 scale). */
export const CRITIC_PASS_THRESHOLD = 0.4;

/** Minimum AC richness score for Athena acceptance (Packet 9). */
export const AC_RICHNESS_THRESHOLD = 0.5;

/**
 * Evaluate AC (acceptance criteria) richness for a plan.
 * Returns a 0-1 score based on quantity and quality of criteria.
 *
 * @param {object} plan
 * @returns {{ score: number, issues: string[], passed: boolean }}
 */
export function evaluateACRichness(plan) {
  if (!plan) return { score: 0, issues: ["Plan is null"], passed: false };

  const issues = [];
  let score = 0;

  const ac = Array.isArray(plan.acceptance_criteria) ? plan.acceptance_criteria : [];
  const verification = String(plan.verification || "").trim();

  // Score based on AC array population
  if (ac.length === 0) {
    issues.push("acceptance_criteria array is empty");
  } else if (ac.length === 1) {
    score += 0.3;
    issues.push("Only 1 acceptance criterion — should have ≥2 measurable conditions");
  } else {
    score += 0.5;
  }

  // Score based on verification command presence
  if (/npm\s+test|npm\s+run/.test(verification)) {
    score += 0.25;
  } else if (verification.length > 20) {
    score += 0.1;
  } else {
    issues.push("No concrete verification command (npm test/npm run)");
  }

  // Score based on measurability keywords in AC
  const measurable = ac.some(c => /pass|fail|assert|count|exist|contain|match|output|exit/i.test(c));
  if (measurable) {
    score += 0.25;
  } else if (ac.length > 0) {
    issues.push("Acceptance criteria lack measurable keywords (pass/fail/assert/exist/count)");
  }

  return { score: Math.min(1, Math.round(score * 100) / 100), issues, passed: score >= AC_RICHNESS_THRESHOLD };
}

/**
 * @typedef {object} CriticResult
 * @property {boolean} passed — whether the plan passed the critic gate
 * @property {number} score — composite score 0-1
 * @property {object} dimensions — per-dimension scores
 * @property {string[]} issues — list of identified issues
 */

/**
 * Evaluate a single plan against the critic rubric.
 *
 * @param {object} plan — normalized plan object
 * @returns {CriticResult}
 */
export function critiquePlan(plan) {
  if (!plan || typeof plan !== "object") {
    return { passed: false, score: 0, dimensions: {}, issues: ["Plan is null or invalid"] };
  }

  const issues = [];
  const dimensions = {};

  // 1. Measurable acceptance criteria
  const verification = String(plan.verification || plan.acceptanceCriteria || "").trim();
  const hasAC = verification.length > 10;
  dimensions[CRITIC_DIMENSION.HAS_MEASURABLE_AC] = hasAC ? 1.0 : 0.0;
  if (!hasAC) issues.push("Missing or too-short acceptance criteria / verification");

  // 2. Verification command present
  const hasVerification = /npm\s+test|npm\s+run|node\s+--test|npx\s+/.test(verification);
  dimensions[CRITIC_DIMENSION.HAS_VERIFICATION] = hasVerification ? 1.0 : (verification.length > 20 ? 0.5 : 0.0);
  if (!hasVerification && verification.length <= 20) issues.push("No concrete verification command");

  // 3. Clear scope (files, module, or component mentioned)
  const task = String(plan.task || "").trim();
  const context = String(plan.context || "").trim();
  const scopeText = `${task} ${context}`;
  const hasScope = /\.(js|ts|json|md|yml|yaml)\b/.test(scopeText) || /src\/|tests\/|config/.test(scopeText);
  dimensions[CRITIC_DIMENSION.HAS_CLEAR_SCOPE] = hasScope ? 1.0 : 0.0;
  if (!hasScope) issues.push("No specific files or modules referenced in scope");

  // 4. Dependencies declared (bonus, not penalized if absent)
  const hasDeps = Array.isArray(plan.dependencies) && plan.dependencies.length > 0;
  dimensions[CRITIC_DIMENSION.HAS_DEPENDENCIES] = hasDeps ? 1.0 : 0.5;

  // 5. Vague task detection
  const vaguePatterns = /improve|enhance|optimize|refactor|clean up|look into|investigate/i;
  const isVague = vaguePatterns.test(task) && task.length < 40;
  dimensions[CRITIC_DIMENSION.NO_VAGUE_TASK] = isVague ? 0.0 : 1.0;
  if (isVague) issues.push(`Task appears vague: "${task.slice(0, 60)}"`);

  // 6. Risk assessment
  const riskLevel = String(plan.riskLevel || "").toLowerCase();
  const hasRisk = riskLevel.length > 0;
  dimensions[CRITIC_DIMENSION.REASONABLE_RISK] = hasRisk ? 1.0 : 0.5;

  // Composite score (equal weight)
  const values = Object.values(dimensions);
  const score = values.length > 0 ? values.reduce((a, b) => a + b, 0) / values.length : 0;

  return {
    passed: score >= CRITIC_PASS_THRESHOLD,
    score: Math.round(score * 100) / 100,
    dimensions,
    issues
  };
}

/**
 * Run the critic pass on all plans (Pass-B of dual-pass planning).
 *
 * @param {object[]} plans — array of normalized plan objects
 * @param {{ threshold?: number }} opts
 * @returns {{ approved: object[], rejected: object[], results: CriticResult[] }}
 */
export function runCriticPass(plans, opts = {}) {
  if (!Array.isArray(plans)) return { approved: [], rejected: [], results: [] };

  const threshold = opts.threshold || CRITIC_PASS_THRESHOLD;
  const approved = [];
  const rejected = [];
  const results = [];

  for (const plan of plans) {
    const result = critiquePlan(plan);
    results.push(result);

    if (result.score >= threshold) {
      approved.push(plan);
    } else {
      rejected.push(plan);
    }
  }

  return { approved, rejected, results };
}

/**
 * Repair a plan by enriching it with deterministic fixes for critic issues (Packet 7).
 * This is the "repair" pass in generate→critic→repair.
 *
 * @param {object} plan — the plan to repair
 * @param {CriticResult} criticResult — critic output for this plan
 * @returns {{ plan: object, repaired: boolean, repairs: string[] }}
 */
export function repairPlan(plan, criticResult) {
  if (!plan || !criticResult) return { plan, repaired: false, repairs: [] };

  const repaired = { ...plan };
  const repairs = [];

  // Repair missing acceptance criteria
  if (criticResult.dimensions[CRITIC_DIMENSION.HAS_MEASURABLE_AC] < 1.0) {
    const task = String(plan.task || "").toLowerCase();
    const defaultAC = ["npm test passes with no new failures", "npm run lint passes with no new errors"];
    if (/fix|bug|error/.test(task)) defaultAC.push("Regression test confirms fix");
    if (/add|create|implement/.test(task)) defaultAC.push("Changed files covered by at least one test assertion");
    repaired.acceptance_criteria = Array.isArray(plan.acceptance_criteria) && plan.acceptance_criteria.length > 0
      ? plan.acceptance_criteria
      : defaultAC;
    repaired.verification = repaired.verification || defaultAC.join("\n");
    repairs.push("Added default acceptance criteria");
  }

  // Repair missing verification command
  if (criticResult.dimensions[CRITIC_DIMENSION.HAS_VERIFICATION] < 1.0) {
    const existing = String(repaired.verification || "").trim();
    if (!existing || existing.length <= 20) {
      repaired.verification = existing ? `${existing}\nnpm test` : "npm test";
      repairs.push("Added npm test as verification command");
    }
  }

  // Repair missing scope
  if (criticResult.dimensions[CRITIC_DIMENSION.HAS_CLEAR_SCOPE] < 1.0) {
    const task = String(plan.task || "");
    // Try to infer scope from task title
    const fileMatch = task.match(/(?:src|tests|scripts)\/[^\s,)]+/);
    if (fileMatch) {
      repaired.scope = fileMatch[0];
      repairs.push(`Inferred scope from task: ${fileMatch[0]}`);
    }
  }

  return { plan: repaired, repaired: repairs.length > 0, repairs };
}

/**
 * Full dual-pass: run critic on all plans, repair rejected ones, re-evaluate.
 *
 * @param {object[]} plans
 * @param {{ threshold?: number }} opts
 * @returns {{ plans: object[], repairCount: number, finalApproved: number, finalRejected: number, results: CriticResult[] }}
 */
export function dualPassCriticRepair(plans, opts = {}) {
  if (!Array.isArray(plans)) return { plans: [], repairCount: 0, finalApproved: 0, finalRejected: 0, results: [] };

  const threshold = opts.threshold || CRITIC_PASS_THRESHOLD;
  const firstPass = runCriticPass(plans, { threshold });

  // Repair rejected plans
  let repairCount = 0;
  const repairedPlans = [];

  for (let i = 0; i < plans.length; i++) {
    const result = firstPass.results[i];
    if (result.score >= threshold) {
      repairedPlans.push({ ...plans[i], _criticScore: result.score, _criticIssues: result.issues });
    } else {
      const { plan: fixedPlan, repaired, repairs } = repairPlan(plans[i], result);
      if (repaired) repairCount++;
      const reResult = critiquePlan(fixedPlan);
      repairedPlans.push({ ...fixedPlan, _criticScore: reResult.score, _criticIssues: reResult.issues, _repairs: repairs });
    }
  }

  // Final pass to classify
  const finalResults = repairedPlans.map(p => critiquePlan(p));
  const finalApproved = finalResults.filter(r => r.score >= threshold).length;
  const finalRejected = finalResults.filter(r => r.score < threshold).length;

  return { plans: repairedPlans, repairCount, finalApproved, finalRejected, results: finalResults };
}
