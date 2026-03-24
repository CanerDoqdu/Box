/**
 * strategy_retuner.js — Strategy auto-retune engine (Wave 6).
 *
 * Monitors capability deltas and automatically adjusts system parameters
 * when trends indicate suboptimal performance.
 *
 * Parameters that can be retuned:
 * - Prometheus freshness window
 * - Plan quality threshold
 * - Worker max parallel count
 * - SLO thresholds
 *
 * Integration: called by orchestrator at cycle end, after delta_analytics.
 */

/**
 * @typedef {object} RetuneAction
 * @property {string} parameter — config path being adjusted
 * @property {*} currentValue — current value
 * @property {*} newValue — recommended new value
 * @property {string} reason — why the retune is recommended
 * @property {string} trigger — which trend triggered this
 */

/**
 * Evaluate whether strategy parameters need retuning based on trends.
 *
 * @param {object} config — current BOX config
 * @param {object} deltaReport — from computeCapabilityDelta
 * @returns {{ actions: RetuneAction[], shouldRetune: boolean }}
 */
export function evaluateRetune(config, deltaReport) {
  if (!deltaReport || typeof deltaReport !== "object") {
    return { actions: [], shouldRetune: false };
  }

  const trends = deltaReport.trends || {};
  const actions = [];

  // 1. If parser confidence is degrading, tighten freshness window
  if (trends.parserConfidence === "degrading") {
    const current = config?.runtime?.prometheusAnalysisFreshnessMinutes || 10;
    if (current > 5) {
      actions.push({
        parameter: "runtime.prometheusAnalysisFreshnessMinutes",
        currentValue: current,
        newValue: Math.max(5, current - 2),
        reason: "Parser confidence degrading — reduce freshness window to force re-analysis",
        trigger: "parserConfidence:degrading"
      });
    }
  }

  // 2. If plan count is degrading, relax Prometheus analysis constraints
  if (trends.planCount === "degrading") {
    const currentMaxTasks = config?.planner?.maxTasks || 0;
    if (currentMaxTasks > 0 && currentMaxTasks < 20) {
      actions.push({
        parameter: "planner.maxTasks",
        currentValue: currentMaxTasks,
        newValue: Math.min(20, currentMaxTasks + 5),
        reason: "Plan count degrading — increase max tasks allowance",
        trigger: "planCount:degrading"
      });
    }
  }

  // 3. If budget usage is increasing but workers done is stable/degrading → efficiency drop
  if (trends.budgetUsed === "improving" && (trends.workersDone === "degrading" || trends.workersDone === "stable")) {
    // "improving" budget means it's going UP which is bad for cost
    // Actually, for budgetUsed, increasing = wasted budget. Recommend tighter budget.
    actions.push({
      parameter: "budget.awareness",
      currentValue: "current",
      newValue: "tighten",
      reason: "Budget usage increasing while worker output stable/degrading — efficiency concern",
      trigger: "budgetUsed:improving+workersDone:not-improving"
    });
  }

  // 4. If overall score is very low, recommend full re-evaluation
  if (typeof deltaReport.overallScore === "number" && deltaReport.overallScore < 25) {
    actions.push({
      parameter: "strategy.fullReEval",
      currentValue: false,
      newValue: true,
      reason: `Overall capability score very low (${deltaReport.overallScore}/100) — full strategy re-evaluation recommended`,
      trigger: "overallScore:critical"
    });
  }

  return {
    actions,
    shouldRetune: actions.length > 0
  };
}

/**
 * Apply retune actions to a config object (in-memory only).
 * Returns a modified copy — does NOT write to disk.
 *
 * @param {object} config
 * @param {RetuneAction[]} actions
 * @returns {{ config: object, applied: string[] }}
 */
export function applyRetune(config, actions) {
  if (!Array.isArray(actions) || actions.length === 0) {
    return { config, applied: [] };
  }

  const updated = JSON.parse(JSON.stringify(config));
  const applied = [];

  for (const action of actions) {
    const parts = action.parameter.split(".");
    if (parts.length === 2) {
      if (!updated[parts[0]]) updated[parts[0]] = {};
      updated[parts[0]][parts[1]] = action.newValue;
      applied.push(action.parameter);
    }
  }

  return { config: updated, applied };
}
