import { readJson, writeJson } from "./fs_utils.js";

export async function loadBudget(config) {
  return readJson(config.paths.budgetFile, {
    initialUsd: config.env.budgetUsd,
    remainingUsd: config.env.budgetUsd,
    claudeCalls: 0,
    workerRuns: 0,
    updatedAt: new Date().toISOString()
  });
}

export async function chargeBudget(config, patch) {
  const budget = await loadBudget(config);
  budget.remainingUsd = Math.max(0, Number((budget.remainingUsd - (patch.usd ?? 0)).toFixed(4)));
  budget.claudeCalls += patch.claudeCalls ?? 0;
  budget.workerRuns += patch.workerRuns ?? 0;
  budget.updatedAt = new Date().toISOString();
  await writeJson(config.paths.budgetFile, budget);
  return budget;
}

export function canUseClaude(budget) {
  return budget.remainingUsd > 0.2;
}
