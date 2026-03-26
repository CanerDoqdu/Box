import { readFileSync } from "node:fs";
import { buildRoleExecutionBatches } from "./src/core/worker_batch_planner.js";
import { loadConfig } from "./src/config.js";

const config = await loadConfig();
const raw = JSON.parse(readFileSync("state/prometheus_analysis.json", "utf8"));
const plans = Array.isArray(raw?.plans) ? raw.plans : [];
const batches = buildRoleExecutionBatches(plans, config);
console.log(JSON.stringify({ planCount: plans.length, batchCount: batches.length, byBatch: batches.map((b, i) => ({ index: i + 1, role: b.role, plans: Array.isArray(b.plans) ? b.plans.length : 0, model: b.model })) }, null, 2));
