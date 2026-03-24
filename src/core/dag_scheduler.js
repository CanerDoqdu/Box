/**
 * dag_scheduler.js — Dynamic DAG-aware scheduler for wave dispatch.
 *
 * Wraps the existing dependency_graph_resolver with runtime awareness:
 * - Completed tasks are removed from the graph before scheduling
 * - Failed tasks propagate blocks to dependents
 * - Re-scheduling can happen mid-cycle when a wave finishes
 *
 * Integration: called by orchestrator between waves to re-evaluate the schedule.
 */

import { resolveDependencyGraph } from "./dependency_graph_resolver.js";

/**
 * @typedef {object} ScheduleResult
 * @property {object[][]} readyWaves — array of waves, each wave is an array of plan objects
 * @property {object[]} blocked — plans blocked by unresolved dependencies
 * @property {string} status — "ok" | "all_done" | "deadlocked"
 */

/**
 * Compute the next dispatchable wave(s) given current completion state.
 *
 * @param {object[]} allPlans — full list of plans from Prometheus
 * @param {Set<string>} completedTaskIds — IDs of tasks already completed
 * @param {Set<string>} failedTaskIds — IDs of tasks that failed
 * @returns {ScheduleResult}
 */
export function computeNextWaves(allPlans, completedTaskIds = new Set(), failedTaskIds = new Set()) {
  if (!Array.isArray(allPlans) || allPlans.length === 0) {
    return { readyWaves: [], blocked: [], status: "all_done" };
  }

  // Filter out completed plans
  const remaining = allPlans.filter(p => {
    const id = p.task || p.role || "";
    return !completedTaskIds.has(id);
  });

  if (remaining.length === 0) {
    return { readyWaves: [], blocked: [], status: "all_done" };
  }

  // Mark plans whose dependencies include failed tasks as blocked
  const blocked = [];
  const schedulable = [];

  for (const plan of remaining) {
    const deps = Array.isArray(plan.dependencies) ? plan.dependencies : [];
    const hasFailedDep = deps.some(d => failedTaskIds.has(d));
    if (hasFailedDep) {
      blocked.push(plan);
    } else {
      schedulable.push(plan);
    }
  }

  if (schedulable.length === 0) {
    return { readyWaves: [], blocked, status: "deadlocked" };
  }

  // Build graph tasks for resolution
  // Standardize field names: accept both dependsOn/dependencies and filesInScope/files (Packet 4)
  const graphTasks = schedulable.map(p => {
    const deps = Array.isArray(p.dependsOn) ? p.dependsOn
      : Array.isArray(p.dependencies) ? p.dependencies : [];
    const files = Array.isArray(p.filesInScope) ? p.filesInScope
      : Array.isArray(p.files) ? p.files : [];
    return {
      id: p.task || p.role || "",
      role: p.role || "",
      dependencies: deps.filter(d => !completedTaskIds.has(d)),
      files,
    };
  });

  const graph = resolveDependencyGraph(graphTasks);

  // Convert graph waves back to plan references
  const planById = new Map();
  for (const p of schedulable) {
    planById.set(p.task || p.role || "", p);
  }

  const readyWaves = (graph.waves || []).map(wave =>
    (wave.taskIds || []).map(id => planById.get(id)).filter(Boolean)
  ).filter(w => w.length > 0);

  return {
    readyWaves,
    blocked,
    status: readyWaves.length > 0 ? "ok" : "deadlocked"
  };
}
