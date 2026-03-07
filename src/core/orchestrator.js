import { scanProject } from "./project_scanner.js";
import { createPlan } from "./task_planner.js";
import { enqueueMissingTasks, popNextQueuedTask, markTask } from "./task_queue.js";
import { loadBudget, chargeBudget, canUseClaude } from "./budget_controller.js";
import { loadPolicy } from "./policy_engine.js";
import { writeCheckpoint } from "./checkpoint_engine.js";
import { evaluateGates } from "./gates.js";
import { runWorkerTask } from "./worker_runner.js";
import { writeJson } from "./fs_utils.js";
import { ClaudeReviewer } from "../providers/reviewer/claude_reviewer.js";
import { info, warn } from "./logger.js";
import { resolveTaskRoute } from "./task_routing.js";
import {
  appendCopilotUsage,
  appendProgress,
  getCurrentMonthCopilotStats,
  updateTaskInTestsState
} from "./state_tracker.js";

async function buildWorkerOverrides({ config, task, summary, taskRoute, reviewer, claudeEnabled }) {
  const baseOverrides = {
    selectedAgent: taskRoute.selectedAgent,
    promptFile: taskRoute.promptFile,
    promptTemplateText: taskRoute.promptTemplateText
  };

  if (!claudeEnabled) {
    return {
      ...baseOverrides,
      teamLeadAllowOpus: false,
      teamLeadReason: "claude disabled"
    };
  }

  try {
    const budget = await loadBudget(config);
    const opusDecision = await reviewer.recommendOpusForTask(task, summary, budget);
    await chargeBudget(config, { usd: 0.02, claudeCalls: 1 });

    const monthlyStats = await getCurrentMonthCopilotStats(config);
    const enoughBudget = Number(budget.remainingUsd) >= Number(config.copilot.opusMinBudgetUsd || 2);
    const underMonthlyCap = Number(monthlyStats.opusCalls) < Number(config.copilot.opusMonthlyMaxCalls || 8);
    const finalAllowOpus = Boolean(opusDecision.allowOpus && enoughBudget && underMonthlyCap);

    const gateReasons = [];
    if (!enoughBudget) {
      gateReasons.push(`budget below opus floor (${budget.remainingUsd} < ${config.copilot.opusMinBudgetUsd})`);
    }
    if (!underMonthlyCap) {
      gateReasons.push(`monthly opus cap reached (${monthlyStats.opusCalls}/${config.copilot.opusMonthlyMaxCalls})`);
    }

    return {
      ...baseOverrides,
      teamLeadAllowOpus: finalAllowOpus,
      teamLeadReason: finalAllowOpus
        ? opusDecision.reason
        : [
            opusDecision.allowOpus ? null : `team lead denied: ${opusDecision.reason}`,
            ...gateReasons
          ].filter(Boolean).join("; ")
    };
  } catch (error) {
    warn("opus escalation decision failed, defaulting to no escalation", error?.message ?? error);
    return {
      ...baseOverrides,
      teamLeadAllowOpus: false,
      teamLeadReason: "decision error fallback"
    };
  }
}

async function finalizeTaskResult({ config, task, workerResult, reviewer, claudeEnabled, policy }) {
  if (workerResult.copilotMeta) {
    await appendCopilotUsage(config, {
      taskId: task.id,
      taskKind: task.kind || "general",
      taskTitle: task.title,
      copilot: workerResult.copilotMeta
    });
    await appendProgress(
      config,
      `Task ${task.id} Copilot mode=${workerResult.copilotMeta.mode || "unknown"} model=${workerResult.copilotMeta.model || "unknown"}`
    );
  }

  const gates = evaluateGates(config, workerResult);
  let review = { approved: gates.ok, reason: "claude disabled" };
  if (claudeEnabled) {
    try {
      review = await reviewer.reviewResult(task, workerResult, gates);
      await chargeBudget(config, { usd: 0.06, claudeCalls: 1 });
    } catch (error) {
      warn("claude review failed, using deterministic fallback", error?.message ?? error);
      review = { approved: gates.ok, reason: "fallback deterministic gates" };
    }
  }

  const checkpointPath = await writeCheckpoint(config, {
    timestamp: new Date().toISOString(),
    task,
    workerResult,
    gates,
    review,
    policy
  });

  if (!workerResult.ok || !gates.ok || !review.approved) {
    const failureNotes = [
      workerResult.ok ? null : `worker exit ${workerResult.exitCode ?? "unknown"}`,
      gates.ok ? null : `gates: ${gates.failures.join(", ")}`,
      review.approved ? null : `review: ${review.reason}`
    ].filter(Boolean).join(" | ");

    await markTask(config, task, "failed", {
      failureReason: [
        workerResult.ok ? null : "worker failed",
        gates.ok ? null : gates.failures.join(", "),
        review.approved ? null : `review blocked: ${review.reason}`
      ].filter(Boolean).join(" | "),
      checkpointPath
    });
    await updateTaskInTestsState(config, task, "failed", failureNotes || "Task failed");
    await chargeBudget(config, { workerRuns: 1 });
    await appendProgress(config, `Task ${task.id} failed: ${review.reason}`);
    warn(`task ${task.id} failed`, { gates, review, checkpointPath });
    return;
  }

  await markTask(config, task, "passed", { checkpointPath, reviewReason: review.reason });
  await updateTaskInTestsState(config, task, "passed", "Task gates passed and review approved");
  await chargeBudget(config, { workerRuns: 1 });
  await appendProgress(config, `Task ${task.id} passed`);
  info(`task ${task.id} passed`, { checkpointPath });
}

export async function runOnce(config) {
  const summary = await scanProject(config);
  await writeJson(config.paths.summaryFile, summary);
  await appendProgress(config, "Project scan completed");

  const budget = await loadBudget(config);
  const claudeEnabled = canUseClaude(budget) && Boolean(config.env.claudeApiKey);
  const reviewer = new ClaudeReviewer(claudeEnabled ? config.env.claudeApiKey : null, config.claude);
  const policy = await loadPolicy(config);

  const plannedTasks = await createPlan({ summary, reviewer, config });
  if (claudeEnabled && config.planner.useClaudeForPlanning) {
    await chargeBudget(config, { usd: 0.04, claudeCalls: 1 });
  }
  await enqueueMissingTasks(config, plannedTasks);
  await appendProgress(config, `Plan prepared with ${plannedTasks.length} tasks`);

  const maxWorkers = Math.max(1, Number(config.maxParallelWorkers || 1));
  const tasks = [];
  for (let i = 0; i < maxWorkers; i += 1) {
    const nextTask = await popNextQueuedTask(config);
    if (!nextTask) {
      break;
    }
    tasks.push(nextTask);
  }

  if (tasks.length === 0) {
    info("no queued tasks left");
    await appendProgress(config, "No queued tasks left");
    return;
  }

  await appendProgress(config, `Dispatching ${tasks.length} task(s) with maxParallelWorkers=${maxWorkers}`);

  const running = [];
  for (const task of tasks) {
    info(`running task ${task.id}: ${task.title}`);
    await appendProgress(config, `Task ${task.id} started: ${task.title}`);
    await updateTaskInTestsState(config, task, "running", "Worker execution started");

    const taskRoute = await resolveTaskRoute(config, task);
    await appendProgress(
      config,
      `Task ${task.id} routing agent=${taskRoute.selectedAgent} promptFile=${taskRoute.promptFile}`
    );

    const workerOverrides = await buildWorkerOverrides({
      config,
      task,
      summary,
      taskRoute,
      reviewer,
      claudeEnabled
    });

    await appendProgress(
      config,
      `Task ${task.id} team-lead Opus decision=${workerOverrides.teamLeadAllowOpus ? "allow" : "deny"} reason=${workerOverrides.teamLeadReason}`
    );

    running.push({
      task,
      workerPromise: runWorkerTask(config, task, workerOverrides)
    });
  }

  for (const item of running) {
    const workerResult = await item.workerPromise;
    await finalizeTaskResult({
      config,
      task: item.task,
      workerResult,
      reviewer,
      claudeEnabled,
      policy
    });
  }
}

export async function runDaemon(config) {
  info("daemon started");
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runOnce(config);
    } catch (error) {
      warn("runOnce crashed", error?.message ?? error);
    }
    await new Promise((resolve) => setTimeout(resolve, config.loopIntervalMs));
  }
}
