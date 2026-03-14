import { spawnSync } from "node:child_process";
import { toCopilotModelSlug } from "../../core/agent_loader.js";

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function tryExtractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

function validatePlan(payload, fallbackTasks) {
  const tasks = safeArray(payload?.tasks)
    .map((task, idx) => ({
      id: Number(task?.id || idx + 1),
      title: String(task?.title || "").trim(),
      priority: Number(task?.priority || 3),
      kind: String(task?.kind || "general").trim().toLowerCase()
    }))
    .filter((task) => Number.isFinite(task.id) && task.title.length > 0 && Number.isFinite(task.priority));

  return tasks.length > 0 ? { tasks } : { tasks: fallbackTasks };
}

function validateDecision(payload, fallback) {
  if (typeof payload?.approved !== "boolean") {
    return fallback;
  }
  return {
    approved: payload.approved,
    reason: String(payload?.reason || fallback.reason || "review completed")
  };
}

function validateOpusDecision(payload, fallback) {
  if (typeof payload?.allowOpus !== "boolean") {
    return fallback;
  }
  return {
    allowOpus: payload.allowOpus,
    reason: String(payload?.reason || fallback.reason || "no reason provided")
  };
}

function validateAutonomyAudit(payload, fallback) {
  if (typeof payload?.healthy !== "boolean") {
    return fallback;
  }
  return {
    healthy: payload.healthy,
    reason: String(payload?.reason || fallback.reason || "autonomy audit completed"),
    notifyUser: Boolean(payload?.notifyUser)
  };
}

function validateLoopDecision(payload, fallback) {
  const mode = String(payload?.mode || "").trim().toLowerCase();
  if (mode !== "strategic" && mode !== "tactical") {
    return fallback;
  }
  return {
    mode,
    reason: String(payload?.reason || fallback.reason || "loop decision completed")
  };
}

function validatePlannerTriggerDecision(payload, fallback) {
  if (typeof payload?.shouldPlan !== "boolean") {
    return fallback;
  }
  return {
    shouldPlan: payload.shouldPlan,
    reason: String(payload?.reason || fallback.reason || "planner trigger decision completed")
  };
}

function validateFailureChainDecision(payload, fallback) {
  const action = String(payload?.action || "").trim().toLowerCase();
  const allowed = new Set(["retry", "split", "park", "escalate_jesus"]);
  if (!allowed.has(action)) {
    return fallback;
  }
  return {
    action,
    reason: String(payload?.reason || fallback.reason || "failure chain decision completed")
  };
}

function validateEscalatedFailureResolution(payload, fallback) {
  const action = String(payload?.action || "").trim().toLowerCase();
  const allowed = new Set(["retry", "park", "notify_user"]);
  if (!allowed.has(action)) {
    return fallback;
  }
  return {
    action,
    reason: String(payload?.reason || fallback.reason || "escalated failure resolution completed"),
    notifyUser: Boolean(payload?.notifyUser)
  };
}

function validateWaveDistributionDecision(payload, fallback) {
  const orderedTaskIdsRaw = safeArray(payload?.orderedTaskIds).map((item) => Number(item)).filter((item) => Number.isFinite(item));
  const deferTaskIdsRaw = safeArray(payload?.deferTaskIds).map((item) => Number(item)).filter((item) => Number.isFinite(item));

  if (orderedTaskIdsRaw.length === 0 && deferTaskIdsRaw.length === 0) {
    return fallback;
  }

  return {
    orderedTaskIds: [...new Set(orderedTaskIdsRaw)],
    deferTaskIds: [...new Set(deferTaskIdsRaw)],
    reason: String(payload?.reason || fallback.reason || "wave distribution decision completed")
  };
}

function validateProjectAnalysis(payload, fallback) {
  const frameworks = safeArray(payload?.frameworks).map((item) => String(item).trim()).filter(Boolean);
  const domains = safeArray(payload?.domains).map((item) => String(item).trim()).filter(Boolean);
  const criticalPaths = safeArray(payload?.criticalPaths).map((item) => String(item).trim()).filter(Boolean);
  const objectives = safeArray(payload?.objectives).map((item) => String(item).trim()).filter(Boolean);
  const risks = safeArray(payload?.risks).map((item) => String(item).trim()).filter(Boolean);

  if (frameworks.length === 0 && domains.length === 0 && criticalPaths.length === 0 && objectives.length === 0) {
    return fallback;
  }

  return {
    frameworks,
    domains,
    criticalPaths,
    objectives,
    risks
  };
}

function validateIdleRecoveryDecision(payload, fallback) {
  if (typeof payload?.activate_idle_path !== "boolean") {
    return fallback;
  }
  return {
    activate_idle_path: Boolean(payload.activate_idle_path),
    force_strategic_mode: Boolean(payload?.force_strategic_mode),
    task_seeding_trigger: Boolean(payload?.task_seeding_trigger),
    docker_containers_needed: Math.max(0, Number(payload?.docker_containers_needed || 0)),
    notes: String(payload?.notes || fallback.notes || "idle recovery evaluated")
  };
}

function validateMosesCoordinationDecision(payload, fallback) {
  const tasksToQueue = safeArray(payload?.tasks_to_queue).filter((t) => t && typeof t === "object");
  if (typeof payload?.idle_path_tasks_triggered !== "boolean" && tasksToQueue.length === 0) {
    return fallback;
  }
  return {
    tasks_to_queue: tasksToQueue.slice(0, 5).map((t) => ({
      issue_id: Number(t?.issue_id || 0),
      task_type: String(t?.task_type || "general"),
      priority: String(t?.priority || "medium"),
      scope_files: safeArray(t?.scope_files).map((f) => String(f)).filter(Boolean)
    })),
    idle_path_tasks_triggered: Boolean(payload?.idle_path_tasks_triggered),
    notes: String(payload?.notes || fallback.notes || "coordination complete")
  };
}

function summarizeGates(gates) {
  if (!gates || typeof gates !== "object") {
    return "no gate result";
  }
  if (gates.ok) {
    return "all required gates passed";
  }
  const failures = safeArray(gates.failures).map((item) => String(item).trim()).filter(Boolean);
  return failures.length > 0 ? failures.join(", ") : "required gates failed";
}

function hasForbiddenPathChange(workerResult) {
  const files = Array.isArray(workerResult?.copilotMeta?.changedFiles)
    ? workerResult.copilotMeta.changedFiles.map((item) => String(item || "").toLowerCase())
    : [];
  const forbiddenPrefixes = [".github/workflows/", "infra/", "security/"];
  return files.find((file) => forbiddenPrefixes.some((prefix) => file.startsWith(prefix))) || "";
}

function deterministicAudit(context) {
  const totals = context?.queueTotals || {};
  const failed = Number(totals.failed || 0);
  const running = Number(totals.running || 0);
  const blocked = Number(totals.blocked || 0);

  if (blocked > 0) {
    return { healthy: false, reason: `blocked tasks detected (${blocked})`, notifyUser: true };
  }
  if (failed >= 3 && running === 0) {
    return { healthy: false, reason: `pipeline stalled: ${failed} failed tasks and no running workers`, notifyUser: true };
  }
  return { healthy: true, reason: "autonomy flow within expected limits", notifyUser: false };
}

export class CopilotReviewer {
  constructor(options = {}) {
    this.provider = "copilot";
    this.model = String(options?.model || "Claude Sonnet 4.6");
    this.command = String(options?.command || "copilot");
    this.lastUsage = null;
  }

  consumeLastUsage(stage = "unknown") {
    if (!this.lastUsage) {
      return null;
    }
    const usage = { ...this.lastUsage, stage };
    this.lastUsage = null;
    return usage;
  }

  requestJson(prompt, fallback, validator) {
    const args = ["--allow-all-tools", "-p", String(prompt || "")];
    const slug = toCopilotModelSlug(this.model);
    if (slug) {
      args.push("--model", slug);
    }

    const result = spawnSync(this.command, args, {
      encoding: "utf8",
      env: process.env,
      timeout: 120_000,
      windowsHide: true
    });

    const stdout = String(result?.stdout || "");
    const stderr = String(result?.stderr || "");
    const merged = `${stdout}\n${stderr}`;

    if (result.status !== 0) {
      const errSnippet = stderr.slice(0, 200) || stdout.slice(0, 200);
      console.error(`[CopilotReviewer] copilot exited ${result.status}: ${errSnippet}`);
      return fallback;
    }

    const parsed = tryExtractJson(merged);
    if (!parsed) {
      console.error(`[CopilotReviewer] failed to parse JSON from copilot output (${merged.length} chars)`);
      return fallback;
    }
    const validated = validator(parsed, fallback);
    this.lastUsage = { model: this.model, provider: "copilot" };
    return validated;
  }

  async reviewPlan(summary, tasks) {
    const fallback = { tasks: safeArray(tasks) };
    const prompt = [
      "Return only strict JSON with schema: {\"tasks\":[{\"id\":number,\"title\":string,\"priority\":number,\"kind\":string}]}",
      "Re-rank candidate tasks for production-safe execution.",
      "Preserve ids where possible.",
      `<summary>${JSON.stringify(summary)}</summary>`,
      `<candidate>${JSON.stringify(tasks)}</candidate>`
    ].join("\n");

    return this.requestJson(prompt, fallback, (payload, fb) => validatePlan(payload, fb.tasks));
  }

  async reviewResult(task, workerResult, gates) {
    const changedFilesCount = Number(workerResult?.copilotMeta?.changedFilesCount || 0);
    const forbiddenChangedPath = hasForbiddenPathChange(workerResult);
    if (changedFilesCount > 20) {
      return {
        approved: false,
        reason: `Deterministic reviewer rejected: unrelated change scope (files changed ${changedFilesCount} > 20)`,
        model: this.model,
        provider: this.provider,
        taskId: Number(task?.id || 0),
        workerExitCode: Number(workerResult?.exitCode ?? -1)
      };
    }
    if (forbiddenChangedPath) {
      return {
        approved: false,
        reason: `Deterministic reviewer rejected: forbidden path modified (${forbiddenChangedPath})`,
        model: this.model,
        provider: this.provider,
        taskId: Number(task?.id || 0),
        workerExitCode: Number(workerResult?.exitCode ?? -1)
      };
    }

    const fallback = {
      approved: Boolean(gates?.ok),
      reason: gates?.ok
        ? "Deterministic reviewer approved: all required gates passed"
        : `Deterministic reviewer rejected: ${summarizeGates(gates)}`
    };

    const prompt = [
      "Return only strict JSON with schema: {\"approved\":boolean,\"reason\":string}",
      "Approve only if required gates are satisfied and change scope is task-related.",
      "Reject if architecture boundaries are violated or unrelated files are modified.",
      "Reject if security risk or forbidden path changes are present.",
      "Hard reject criteria:",
      "1) changedFilesCount > 20.",
      "2) Any changed file under .github/workflows/, infra/, or security/ unless explicitly required by task.",
      "3) Required gates are not green.",
      "4) Changes are unrelated to task goal or violate architecture boundaries.",
      `<task>${JSON.stringify({ id: task?.id, title: task?.title, kind: task?.kind })}</task>`,
      `<worker>${JSON.stringify({ exitCode: workerResult?.exitCode, ok: workerResult?.ok })}</worker>`,
      `<changes>${JSON.stringify({
        changedFilesCount,
        changedFiles: workerResult?.copilotMeta?.changedFiles || []
      })}</changes>`,
      `<gates>${JSON.stringify(gates)}</gates>`
    ].join("\n");

    const decision = this.requestJson(prompt, fallback, validateDecision);
    return {
      ...decision,
      model: this.model,
      provider: this.provider,
      taskId: Number(task?.id || 0),
      workerExitCode: Number(workerResult?.exitCode ?? -1)
    };
  }

  async recommendOpusForTask(task, summary, budget) {
    const fallback = { allowOpus: false, reason: "Copilot reviewer policy: Opus escalation disabled" };
    const prompt = [
      "Return only strict JSON with schema: {\"allowOpus\":boolean,\"reason\":string}",
      "Default to false unless critical production risk justifies higher cost.",
      `<task>${JSON.stringify(task)}</task>`,
      `<summary>${JSON.stringify(summary)}</summary>`,
      `<budget>${JSON.stringify(budget)}</budget>`
    ].join("\n");

    return this.requestJson(prompt, fallback, validateOpusDecision);
  }

  async auditAutonomyHealth(context) {
    const fallback = deterministicAudit(context);
    const prompt = [
      "Return only strict JSON with schema: {\"healthy\":boolean,\"reason\":string,\"notifyUser\":boolean}",
      "Set notifyUser=true only if autonomous flow is blocked or unsafe.",
      `<context>${JSON.stringify(context)}</context>`
    ].join("\n");

    return this.requestJson(prompt, fallback, validateAutonomyAudit);
  }

  async chooseLoopMode(context) {
    const fallback = {
      mode: context?.strategicDue ? "strategic" : "tactical",
      reason: context?.strategicDue
        ? "deterministic selector: strategic interval due"
        : "deterministic selector: active sprint queue"
    };

    const prompt = [
      "Return only strict JSON with schema: {\"mode\":\"strategic|tactical\",\"reason\":string}",
      "Prefer strategic when blocked/failed inventory indicates tactical loop is not resolving issues.",
      `<context>${JSON.stringify(context)}</context>`
    ].join("\n");

    return this.requestJson(prompt, fallback, validateLoopDecision);
  }

  async decidePlannerTrigger(context) {
    const fallback = {
      shouldPlan: Boolean(context?.strategicDue) || Number(context?.queueTotals?.queued || 0) === 0,
      reason: context?.strategicDue
        ? "deterministic planner trigger: strategic due"
        : "deterministic planner trigger: queue depleted"
    };

    const prompt = [
      "Return only strict JSON with schema: {\"shouldPlan\":boolean,\"reason\":string}",
      "Set shouldPlan=true when Trump planner should regenerate/refresh plan now.",
      "Prefer false when tactical queue is healthy and actively draining.",
      `<context>${JSON.stringify(context)}</context>`
    ].join("\n");

    return this.requestJson(prompt, fallback, validatePlannerTriggerDecision);
  }

  async analyzeTaskFailure(context) {
    const fallback = {
      action: Number(context?.task?.attempt || 1) < Number(context?.maxAttempts || 3) ? "retry" : "split",
      reason: "deterministic fallback: bounded autonomous recovery"
    };

    const prompt = [
      "Return only strict JSON with schema: {\"action\":\"retry|split|park|escalate_jesus\",\"reason\":string}",
      "You are Moses. Choose a bounded recovery action after worker failure.",
      "Prefer retry for transient failures, split for complex deterministic fixes, park for cooldown-worthy families, escalate_jesus when lead cannot safely recover.",
      `<context>${JSON.stringify(context)}</context>`
    ].join("\n");

    return this.requestJson(prompt, fallback, validateFailureChainDecision);
  }

  async resolveEscalatedFailure(context) {
    const fallback = {
      action: context?.environmentBlocked ? "notify_user" : "park",
      reason: context?.environmentBlocked
        ? "deterministic fallback: environment blocker requires user visibility"
        : "deterministic fallback: Jesus parks unresolved incident",
      notifyUser: Boolean(context?.environmentBlocked)
    };

    const prompt = [
      "Return only strict JSON with schema: {\"action\":\"retry|park|notify_user\",\"reason\":string,\"notifyUser\":boolean}",
      "You are Jesus. Moses could not close the incident. Decide final bounded action.",
      "Set notify_user true only when autonomous recovery cannot safely continue.",
      `<context>${JSON.stringify(context)}</context>`
    ].join("\n");

    return this.requestJson(prompt, fallback, validateEscalatedFailureResolution);
  }

  async decideWaveDistribution(context) {
    const fallback = {
      orderedTaskIds: safeArray(context?.plannedTasks).map((task) => Number(task?.id || 0)).filter((id) => Number.isFinite(id) && id > 0),
      deferTaskIds: [],
      reason: "deterministic fallback: priority order and ownership constraints"
    };

    const prompt = [
      "Return only strict JSON with schema: {\"orderedTaskIds\":number[],\"deferTaskIds\":number[],\"reason\":string}",
      "You are Moses. Rebalance Trump wave for execution readiness.",
      "Use deferTaskIds when a task should wait due to dependency/conflict pressure.",
      "Do not violate role ownership policy; IDs must come from plannedTasks list only.",
      `<context>${JSON.stringify(context)}</context>`
    ].join("\n");

    return this.requestJson(prompt, fallback, validateWaveDistributionDecision);
  }

  async analyzeProjectContext(summary) {
    const fallback = {
      frameworks: safeArray(summary?.frameworks).map((item) => String(item)).filter(Boolean),
      domains: safeArray(summary?.domains).map((item) => String(item)).filter(Boolean),
      criticalPaths: [],
      objectives: ["stabilize queue throughput", "keep deterministic task contracts"],
      risks: []
    };

    const prompt = [
      "Return only strict JSON with schema: {\"frameworks\":string[],\"domains\":string[],\"criticalPaths\":string[],\"objectives\":string[],\"risks\":string[]}",
      "Analyze repository summary and propose planning intelligence.",
      `<summary>${JSON.stringify(summary)}</summary>`
    ].join("\n");

    return this.requestJson(prompt, fallback, validateProjectAnalysis);
  }

  async evaluateIdleRecovery(context) {
    const fallback = {
      activate_idle_path: true,
      force_strategic_mode: Number(context?.queueTotals?.queued || 0) === 0,
      task_seeding_trigger: Number(context?.openIssueCount || 0) > 0,
      docker_containers_needed: 1,
      notes: "deterministic fallback: pipeline starved, activate all recovery paths"
    };

    const prompt = [
      "Return only strict JSON with schema: {\"activate_idle_path\":boolean,\"force_strategic_mode\":boolean,\"task_seeding_trigger\":boolean,\"docker_containers_needed\":number,\"notes\":string}",
      "You are Jesus, the Strategic AI (CEO) of BOX. The system is currently idle.",
      "Analyze the system state and decide strategic recovery actions.",
      "Set task_seeding_trigger=true when open issues exist and queue is empty.",
      "Set force_strategic_mode=true when tactical loops cannot resolve the idle state.",
      "Set docker_containers_needed to the number of worker containers needed (0-3).",
      `<context>${JSON.stringify(context)}</context>`
    ].join("\n");

    return this.requestJson(prompt, fallback, validateIdleRecoveryDecision);
  }

  async coordinateIdleRecovery(context) {
    const fallback = {
      tasks_to_queue: [],
      idle_path_tasks_triggered: Number(context?.openIssueCount || 0) > 0,
      notes: "deterministic fallback: delegate to seeder for task generation"
    };

    const prompt = [
      "Return only strict JSON with schema: {\"tasks_to_queue\":[{\"issue_id\":number,\"task_type\":string,\"priority\":string,\"scope_files\":string[]}],\"idle_path_tasks_triggered\":boolean,\"notes\":string}",
      "You are Moses, Lead AI Coordinator. Convert Jesus strategic directives into execution steps.",
      "Identify which open issues should become executable tasks.",
      "Respect bounded autonomy: max 3 tasks per cycle.",
      "Avoid retrying tasks with identical failure fingerprints.",
      `<context>${JSON.stringify(context)}</context>`
    ].join("\n");

    return this.requestJson(prompt, fallback, validateMosesCoordinationDecision);
  }
}
