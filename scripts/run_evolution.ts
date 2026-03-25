/**
 * run_evolution.mjs — CLI entry point for the Evolution Executor
 *
 * Runs the 40 master evolution tasks sequentially, one at a time.
 * After each task a worker executes the code change, then Athena
 * reviews the result. Only when Athena says "proceed" does the system
 * advance to the next task.
 *
 * Usage:
 *   node scripts/run_evolution.ts                  # start / resume
 *   node scripts/run_evolution.ts --from T-005     # start from specific task
 *   node scripts/run_evolution.ts --dry-run        # print plan, skip workers
 *   node scripts/run_evolution.ts --status         # show progress summary
 */

import { loadConfig } from "../src/config.js";
import { runEvolutionLoop, loadEvolutionPlan } from "../src/core/evolution_executor.js";
import { readJson } from "../src/core/fs_utils.js";
import path from "node:path";

// ── Arg parsing ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const fromIdx = args.indexOf("--from");
const fromTaskId = fromIdx !== -1 ? args[fromIdx + 1] : null;
const dryRun = args.includes("--dry-run");
const showStatus = args.includes("--status");

// ── Status mode ───────────────────────────────────────────────────────────────

if (showStatus) {
  const config = await loadConfig();
  const stateDir = config.paths?.stateDir || "state";
  const progress = await readJson(path.join(stateDir, "evolution_progress.json"), null);

  if (!progress) {
    console.log("[evolution] No progress file found — run without --status to start");
    process.exit(0);
  }

  const { cycle_id, tasks, current_task_index } = progress as any;
  console.log(`\nEvolution Plan: ${cycle_id}`);
  console.log(`Current index: ${current_task_index}`);
  console.log("");

  const counts = { done: 0, pending: 0, escalated: 0, rework: 0, in_progress: 0, skipped: 0 };
  for (const [taskId, state] of Object.entries((tasks || {}) as Record<string, any>)) {
    counts[state.status] = (counts[state.status] || 0) + 1;
    const icon =
      state.status === "done"      ? "✓" :
      state.status === "escalated" ? "⚠" :
      state.status === "in_progress" ? "⏳" :
      state.status === "rework"    ? "↩" :
      state.status === "skipped"   ? "—" : " ";
    const attempts = state.attempts > 0 ? ` (${state.attempts} attempts)` : "";
    const verdict = state.athena_verdict?.recommendation
      ? ` [Athena: ${state.athena_verdict.recommendation}]` : "";
    console.log(`  ${icon} ${taskId.padEnd(7)} ${state.status.padEnd(12)}${attempts}${verdict}`);
  }

  console.log("\nSummary:");
  for (const [status, count] of Object.entries(counts)) {
    if (count > 0) console.log(`  ${status}: ${count}`);
  }
  console.log("");
  process.exit(0);
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log("=".repeat(60));
console.log("BOX EVOLUTION EXECUTOR");
console.log(`Date: ${new Date().toISOString()}`);
if (fromTaskId) console.log(`Starting from: ${fromTaskId}`);
if (dryRun) console.log("MODE: DRY RUN");
console.log("=".repeat(60));

let config;
try {
  config = await loadConfig();
} catch (err) {
  console.error(`[evolution] Failed to load config: ${err.message}`);
  process.exit(1);
}

// Validate plan is loadable before starting
try {
  const stateDir = config.paths?.stateDir || "state";
  const { cycleId, tasks } = loadEvolutionPlan(stateDir);
  console.log(`[evolution] Plan validated: ${cycleId} — ${tasks.length} tasks`);
  console.log(`[evolution] Tasks: ${tasks.map(t => t.task_id).join(", ")}`);
} catch (err) {
  console.error(`[evolution] Plan validation failed: ${err.message}`);
  process.exit(1);
}

console.log("");

try {
  const result = await runEvolutionLoop(config, { fromTaskId, dryRun }) as any;

  const { done = 0, escalated = 0, pending = 0 } = result.summary;
  const total = Object.values(result.summary as Record<string, number>).reduce((a, b) => a + Number(b || 0), 0);

  console.log(`\n[evolution] Final: ${done}/${total} done, ${escalated} escalated, ${pending} pending`);

  if (escalated > 0) {
    console.log("[evolution] Some tasks were escalated — review state/evolution_progress.json for details");
  }

  process.exit(escalated > 0 ? 2 : 0); // exit 2 = partial success
} catch (err) {
  console.error(`[evolution] Fatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
}
