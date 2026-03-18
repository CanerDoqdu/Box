import { isSelfDevMode, validateFileChanges, validatePrSize } from "../../core/self_dev_guard.js";

const API_URL = "https://api.anthropic.com/v1/messages";

function tryExtractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = text.match(/\{[\s\S]*\}/);
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

function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

function sanitizeTask(task) {
  return {
    id: Number(task.id),
    title: String(task.title || ""),
    priority: Number(task.priority || 0),
    kind: String(task.kind || "general")
  };
}

function validatePlan(payload, fallbackTasks) {
  const tasks = safeArray(payload?.tasks)
    .map(sanitizeTask)
    .filter((t) => Number.isFinite(t.id) && t.title.length > 0 && Number.isFinite(t.priority));
  return tasks.length > 0 ? { tasks } : { tasks: fallbackTasks };
}

function validateDecision(payload, fallback) {
  if (typeof payload?.approved !== "boolean") {
    return fallback;
  }

  const reason = String(payload?.reason || "review completed");
  return { approved: payload.approved, reason };
}

function validateOpusDecision(payload, fallback) {
  if (typeof payload?.allowOpus !== "boolean") {
    return fallback;
  }

  return {
    allowOpus: payload.allowOpus,
    reason: String(payload?.reason || "no reason provided")
  };
}

function validateAutonomyAudit(payload, fallback) {
  if (typeof payload?.healthy !== "boolean") {
    return fallback;
  }
  return {
    healthy: payload.healthy,
    reason: String(payload?.reason || "autonomy audit completed"),
    notifyUser: Boolean(payload?.notifyUser)
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

function getEvidenceQuotes(workerResult) {
  const lines = [];
  const stdoutLines = String(workerResult?.stdout || "").split(/\r?\n/).filter(Boolean);
  const stderrLines = String(workerResult?.stderr || "").split(/\r?\n/).filter(Boolean);

  lines.push(...stdoutLines.slice(-4).map((l) => `stdout: ${l}`));
  lines.push(...stderrLines.slice(-6).map((l) => `stderr: ${l}`));

  if (lines.length === 0) {
    lines.push("stderr: no output captured");
  }

  return lines;
}

function summarizeWorkerResult(workerResult) {
  const stdoutLines = String(workerResult?.stdout || "").split(/\r?\n/).filter(Boolean);
  const stderrLines = String(workerResult?.stderr || "").split(/\r?\n/).filter(Boolean);
  const stdoutTail = stdoutLines.slice(-10).join("\n");
  const stderrTail = stderrLines.slice(-12).join("\n");

  return {
    ok: Boolean(workerResult?.ok),
    exitCode: Number(workerResult?.exitCode ?? -1),
    buildOk: Boolean(workerResult?.buildOk),
    testsOk: Boolean(workerResult?.testsOk),
    lintOk: Boolean(workerResult?.lintOk),
    securityOk: Boolean(workerResult?.securityOk),
    copilotMeta: workerResult?.copilotMeta || null,
    stdoutTail,
    stderrTail
  };
}

export class ClaudeReviewer {
  constructor(apiKey, options = {}) {
    this.apiKey = apiKey;
    this.model = options.model || "claude-sonnet-4-6";
    this.reviewMaxRetries = Number(options.reviewMaxRetries || 1);
    this.reviewMaxTokens = Number(options.reviewMaxTokens || 800);
    this.planMaxTokens = Number(options.planMaxTokens || 1400);
    this.thinking = options.thinking || { type: "adaptive", effort: "medium" };
    this.pricing = {
      inputUsdPerMToken: Number(options?.pricing?.inputUsdPerMToken ?? 3),
      outputUsdPerMToken: Number(options?.pricing?.outputUsdPerMToken ?? 15),
      cacheReadUsdPerMToken: Number(options?.pricing?.cacheReadUsdPerMToken ?? 0.3),
      cacheCreationUsdPerMToken: Number(options?.pricing?.cacheCreationUsdPerMToken ?? 3.75)
    };
    this.lastUsage = null;
  }

  estimateUsd(usage) {
    const perM = (tokens, usdPerMToken) => (Number(tokens || 0) / 1_000_000) * Number(usdPerMToken || 0);
    const total =
      perM(usage.inputTokens, this.pricing.inputUsdPerMToken) +
      perM(usage.outputTokens, this.pricing.outputUsdPerMToken) +
      perM(usage.cacheReadTokens, this.pricing.cacheReadUsdPerMToken) +
      perM(usage.cacheCreationTokens, this.pricing.cacheCreationUsdPerMToken);

    return Number(total.toFixed(6));
  }

  consumeLastUsage(stage = "unknown") {
    if (!this.lastUsage) {
      return null;
    }
    const usage = {
      ...this.lastUsage,
      stage
    };
    this.lastUsage = null;
    return usage;
  }

  buildOutputConfig() {
    if (!this.thinking || this.thinking.type !== "adaptive") {
      return undefined;
    }
    return { effort: this.thinking.effort || "medium" };
  }

  async requestJson(prompt, maxTokens, fallback, validator) {
    let lastError = null;

    for (let attempt = 1; attempt <= this.reviewMaxRetries + 1; attempt += 1) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 60_000);
        const response = await fetch(API_URL, {
          method: "POST",
          signal: controller.signal,
          headers: {
            "content-type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01"
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: maxTokens,
            thinking: this.thinking?.type ? { type: this.thinking.type } : undefined,
            output_config: this.buildOutputConfig(),
            messages: [{ role: "user", content: prompt }]
          })
        });

        if (!response.ok) {
          clearTimeout(timeoutId);
          const body = await response.text();
          throw new Error(`claude request failed: ${response.status} ${body}`);
        }

        clearTimeout(timeoutId);
        const json = await response.json();
        const usage = {
          model: this.model,
          inputTokens: Number(json?.usage?.input_tokens || 0),
          outputTokens: Number(json?.usage?.output_tokens || 0),
          cacheReadTokens: Number(json?.usage?.cache_read_input_tokens || 0),
          cacheCreationTokens: Number(json?.usage?.cache_creation_input_tokens || 0)
        };
        this.lastUsage = {
          ...usage,
          estimatedUsd: this.estimateUsd(usage)
        };
        const text = json?.content?.map((c) => c.text).filter(Boolean).join("\n") || "";
        const parsed = tryExtractJson(text);
        const validated = validator(parsed, fallback);
        return validated;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError;
  }

  async reviewPlan(summary, tasks) {
    if (!this.apiKey) {
      return { tasks };
    }

    const prompt = [
      "<role>You are BOX reviewer for planning quality and prioritization.</role>",
      "<instructions>",
      "Return strict JSON only with no markdown.",
      "Output schema: {\"tasks\":[{\"id\":number,\"title\":string,\"priority\":number,\"kind\":string}]}",
      "Preserve task ids from candidate input when possible.",
      "Prioritize production readiness and deterministic quality improvements.",
      "</instructions>",
      "<examples>",
      "<example>",
      "<input>{\"candidate\":[{\"id\":1,\"title\":\"Fix flaky test\",\"priority\":4,\"kind\":\"quality\"}]}</input>",
      "<output>{\"tasks\":[{\"id\":1,\"title\":\"Fix flaky test\",\"priority\":1,\"kind\":\"quality\"}]}</output>",
      "</example>",
      "<example>",
      "<input>{\"candidate\":[{\"id\":1,\"title\":\"Add observability\",\"priority\":2,\"kind\":\"stability\"},{\"id\":2,\"title\":\"Fix failing auth tests\",\"priority\":4,\"kind\":\"quality\"}]}</input>",
      "<output>{\"tasks\":[{\"id\":2,\"title\":\"Fix failing auth tests\",\"priority\":1,\"kind\":\"quality\"},{\"id\":1,\"title\":\"Add observability\",\"priority\":2,\"kind\":\"stability\"}]}</output>",
      "</example>",
      "<example>",
      "<input>{\"candidate\":[{\"id\":3,\"title\":\"Refactor helpers\",\"priority\":1,\"kind\":\"refactor\"}]}</input>",
      "<output>{\"tasks\":[{\"id\":3,\"title\":\"Refactor helpers\",\"priority\":3,\"kind\":\"refactor\"}]}</output>",
      "</example>",
      "</examples>",
      "<context>",
      `<project_summary>${JSON.stringify(summary)}</project_summary>`,
      `<candidate_tasks>${JSON.stringify(tasks)}</candidate_tasks>`,
      "</context>",
      "<output_requirements>Return only JSON object matching schema.</output_requirements>"
    ].join("\n");

    return this.requestJson(prompt, this.planMaxTokens, { tasks }, validatePlan);
  }

  async reviewResult(task, workerResult, gates) {
    if (!this.apiKey) {
      return { approved: gates.ok, reason: "claude disabled" };
    }

    // Self-dev guard: block changes to critical BOX files
    if (isSelfDevMode({})) {
      const changedFiles = Array.isArray(workerResult?.copilotMeta?.changedFiles)
        ? workerResult.copilotMeta.changedFiles.map(f => String(f || ""))
        : [];
      const fileCheck = validateFileChanges(changedFiles);
      if (!fileCheck.allowed) {
        return { approved: false, reason: `Self-dev guard rejected: ${fileCheck.blocked[0]}` };
      }
      const changedFilesCount = Number(workerResult?.copilotMeta?.changedFilesCount || 0);
      const sizeCheck = validatePrSize(changedFilesCount, {});
      if (!sizeCheck.allowed) {
        return { approved: false, reason: `Self-dev guard rejected: ${sizeCheck.reason}` };
      }
    }

    const quotes = getEvidenceQuotes(workerResult);

    const prompt = [
      "<role>You are the final BOX reviewer for merge gating.</role>",
      "<instructions>",
      "Return strict JSON only with no markdown.",
      "Output schema: {\"approved\":boolean,\"reason\":string}",
      "Approve only if deterministic gates are satisfied.",
      "Use evidence quotes before deciding.",
      "Reason must be concise and actionable.",
      "</instructions>",
      "<examples>",
      "<example>",
      "<input>{\"gates\":{\"ok\":true,\"failures\":[]}}</input>",
      "<output>{\"approved\":true,\"reason\":\"All required gates passed.\"}</output>",
      "</example>",
      "<example>",
      "<input>{\"gates\":{\"ok\":false,\"failures\":[\"test gate failed\"]}}</input>",
      "<output>{\"approved\":false,\"reason\":\"Rejected because required tests are failing.\"}</output>",
      "</example>",
      "</examples>",
      "<context>",
      `<task>${JSON.stringify(task)}</task>`,
      `<worker_result_summary>${JSON.stringify(summarizeWorkerResult(workerResult))}</worker_result_summary>`,
      `<gates>${JSON.stringify(gates)}</gates>`,
      "<evidence_quotes>",
      ...quotes.map((line) => `<quote>${line}</quote>`),
      "</evidence_quotes>",
      "</context>",
      "<output_requirements>Return only JSON object matching schema.</output_requirements>"
    ].join("\n");

    return this.requestJson(
      prompt,
      this.reviewMaxTokens,
      { approved: gates.ok, reason: "fallback deterministic decision" },
      validateDecision
    );
  }

  async recommendOpusForTask(task, summary, budget) {
    if (!this.apiKey) {
      return { allowOpus: false, reason: "claude disabled" };
    }

    const prompt = [
      "<role>You are BOX team lead controlling expensive model escalation.</role>",
      "<instructions>",
      "Return strict JSON only with no markdown.",
      "Output schema: {\"allowOpus\":boolean,\"reason\":string}",
      "Allow Opus only when task complexity or risk is high enough to justify extra cost.",
      "Default to false for routine implementation tasks.",
      "Consider budget remaining before allowing Opus.",
      "</instructions>",
      "<examples>",
      "<example><input>{\"task\":{\"title\":\"refactor logger\",\"kind\":\"stability\"},\"budget\":{\"remainingUsd\":2}}</input><output>{\"allowOpus\":false,\"reason\":\"Routine task, Sonnet/Codex-level model is sufficient.\"}</output></example>",
      "<example><input>{\"task\":{\"title\":\"critical auth incident fix\",\"kind\":\"production\"},\"budget\":{\"remainingUsd\":8}}</input><output>{\"allowOpus\":true,\"reason\":\"Critical production risk justifies higher reasoning cost.\"}</output></example>",
      "</examples>",
      "<context>",
      `<task>${JSON.stringify(task)}</task>`,
      `<summary>${JSON.stringify(summary)}</summary>`,
      `<budget>${JSON.stringify(budget)}</budget>`,
      "</context>",
      "<output_requirements>Return only JSON object matching schema.</output_requirements>"
    ].join("\n");

    return this.requestJson(
      prompt,
      300,
      { allowOpus: false, reason: "fallback no escalation" },
      validateOpusDecision
    );
  }

  async auditAutonomyHealth(context) {
    if (!this.apiKey) {
      return { healthy: true, reason: "claude disabled", notifyUser: false };
    }

    const prompt = [
      "<role>You are BOX CEO supervisor validating lead-worker quality and autonomous system health.</role>",
      "<instructions>",
      "Return strict JSON only with no markdown.",
      "Output schema: {\"healthy\":boolean,\"reason\":string,\"notifyUser\":boolean}",
      "Set notifyUser=true only if autonomous flow is blocked or unsafe.",
      "Keep reason concise and operational.",
      "</instructions>",
      "<context>",
      `<snapshot>${JSON.stringify(context)}</snapshot>`,
      "</context>",
      "<output_requirements>Return only JSON object matching schema.</output_requirements>"
    ].join("\n");

    return this.requestJson(
      prompt,
      400,
      { healthy: true, reason: "fallback healthy", notifyUser: false },
      validateAutonomyAudit
    );
  }

  async analyzeProjectContext(summary) {
    if (!this.apiKey) {
      return {
        frameworks: [],
        domains: [],
        criticalPaths: [],
        objectives: [],
        risks: []
      };
    }

    const prompt = [
      "<role>You are BOX team lead performing deep repository analysis before planning.</role>",
      "<instructions>",
      "Return strict JSON only with no markdown.",
      "Output schema: {\"frameworks\":string[],\"domains\":string[],\"criticalPaths\":string[],\"objectives\":string[],\"risks\":string[]}",
      "Use only evidence in project summary and repository signals.",
      "criticalPaths should be concrete repository paths.",
      "objectives should be actionable, short, and implementation-oriented.",
      "</instructions>",
      "<context>",
      `<project_summary>${JSON.stringify(summary)}</project_summary>`,
      "</context>",
      "<output_requirements>Return only JSON object matching schema.</output_requirements>"
    ].join("\n");

    return this.requestJson(
      prompt,
      this.planMaxTokens,
      {
        frameworks: [],
        domains: [],
        criticalPaths: [],
        objectives: [],
        risks: []
      },
      validateProjectAnalysis
    );
  }

  async chooseLoopMode(context) {
    if (!this.apiKey) {
      return {
        mode: context?.strategicDue ? "strategic" : "tactical",
        reason: "claude disabled"
      };
    }

    const fallback = {
      mode: context?.strategicDue ? "strategic" : "tactical",
      reason: context?.strategicDue
        ? "deterministic selector: strategic interval due"
        : "deterministic selector: active sprint queue"
    };

    const prompt = [
      "<role>You are Jesus, deciding BOX loop mode for resilient autonomous continuation.</role>",
      "<instructions>",
      "Return strict JSON only with no markdown.",
      "Output schema: {\"mode\":\"strategic|tactical\",\"reason\":string}",
      "Choose strategic when backlog quality is degrading, tactical when current sprint execution should continue.",
      "Prioritize continuity after restarts and avoid unnecessary mode flapping.",
      "</instructions>",
      "<context>",
      `<snapshot>${JSON.stringify(context)}</snapshot>`,
      "</context>",
      "<output_requirements>Return only JSON object matching schema.</output_requirements>"
    ].join("\n");

    return this.requestJson(prompt, 320, fallback, validateLoopDecision);
  }

  async decidePlannerTrigger(context) {
    if (!this.apiKey) {
      return {
        shouldPlan: Boolean(context?.strategicDue) || Number(context?.queueTotals?.queued || 0) === 0,
        reason: "claude disabled"
      };
    }

    const fallback = {
      shouldPlan: Boolean(context?.strategicDue) || Number(context?.queueTotals?.queued || 0) === 0,
      reason: context?.strategicDue
        ? "deterministic planner trigger: strategic due"
        : "deterministic planner trigger: queue depleted"
    };

    const prompt = [
      "<role>You are Jesus, deciding if Trump planner should run now.</role>",
      "<instructions>",
      "Return strict JSON only with no markdown.",
      "Output schema: {\"shouldPlan\":boolean,\"reason\":string}",
      "Choose true when strategic refresh is required or tactical queue is not healthy.",
      "Choose false when current tactical queue should continue without planner churn.",
      "</instructions>",
      "<context>",
      `<snapshot>${JSON.stringify(context)}</snapshot>`,
      "</context>",
      "<output_requirements>Return only JSON object matching schema.</output_requirements>"
    ].join("\n");

    return this.requestJson(prompt, 320, fallback, validatePlannerTriggerDecision);
  }

  async analyzeTaskFailure(context) {
    if (!this.apiKey) {
      return {
        action: Number(context?.task?.attempt || 1) < Number(context?.maxAttempts || 3) ? "retry" : "split",
        reason: "claude disabled"
      };
    }

    const fallback = {
      action: Number(context?.task?.attempt || 1) < Number(context?.maxAttempts || 3) ? "retry" : "split",
      reason: "deterministic fallback: bounded autonomous recovery"
    };

    const prompt = [
      "<role>You are Moses, lead worker coordinating incident recovery after a worker failure.</role>",
      "<instructions>",
      "Return strict JSON only with no markdown.",
      "Output schema: {\"action\":\"retry|split|park|escalate_jesus\",\"reason\":string}",
      "Choose retry for transient issues, split for decomposable complexity, park for cooldown patterns, escalate_jesus when lead-level recovery is exhausted.",
      "Do not choose actions that violate retry/safety constraints in context.",
      "</instructions>",
      "<context>",
      `<snapshot>${JSON.stringify(context)}</snapshot>`,
      "</context>",
      "<output_requirements>Return only JSON object matching schema.</output_requirements>"
    ].join("\n");

    return this.requestJson(prompt, 360, fallback, validateFailureChainDecision);
  }

  async resolveEscalatedFailure(context) {
    if (!this.apiKey) {
      return {
        action: context?.environmentBlocked ? "notify_user" : "park",
        reason: "claude disabled",
        notifyUser: Boolean(context?.environmentBlocked)
      };
    }

    const fallback = {
      action: context?.environmentBlocked ? "notify_user" : "park",
      reason: context?.environmentBlocked
        ? "deterministic fallback: environment blocker requires user visibility"
        : "deterministic fallback: Jesus parks unresolved incident",
      notifyUser: Boolean(context?.environmentBlocked)
    };

    const prompt = [
      "<role>You are Jesus, final incident supervisor after Moses escalation.</role>",
      "<instructions>",
      "Return strict JSON only with no markdown.",
      "Output schema: {\"action\":\"retry|park|notify_user\",\"reason\":string,\"notifyUser\":boolean}",
      "Choose notify_user only when autonomous path cannot safely recover.",
      "Choose retry only if bounded deterministic constraints still permit safe retry.",
      "</instructions>",
      "<context>",
      `<snapshot>${JSON.stringify(context)}</snapshot>`,
      "</context>",
      "<output_requirements>Return only JSON object matching schema.</output_requirements>"
    ].join("\n");

    return this.requestJson(prompt, 360, fallback, validateEscalatedFailureResolution);
  }

  async decideWaveDistribution(context) {
    if (!this.apiKey) {
      return {
        orderedTaskIds: safeArray(context?.plannedTasks).map((task) => Number(task?.id || 0)).filter((id) => Number.isFinite(id) && id > 0),
        deferTaskIds: [],
        reason: "claude disabled"
      };
    }

    const fallback = {
      orderedTaskIds: safeArray(context?.plannedTasks).map((task) => Number(task?.id || 0)).filter((id) => Number.isFinite(id) && id > 0),
      deferTaskIds: [],
      reason: "deterministic fallback: priority order and ownership constraints"
    };

    const prompt = [
      "<role>You are Moses, distributing Trump planning wave to role workers.</role>",
      "<instructions>",
      "Return strict JSON only with no markdown.",
      "Output schema: {\"orderedTaskIds\":number[],\"deferTaskIds\":number[],\"reason\":string}",
      "orderedTaskIds and deferTaskIds must contain only IDs present in plannedTasks.",
      "Use deferTaskIds for tasks blocked by dependency/conflict pressure.",
      "Never violate deterministic ownership/policy constraints in context.",
      "</instructions>",
      "<context>",
      `<snapshot>${JSON.stringify(context)}</snapshot>`,
      "</context>",
      "<output_requirements>Return only JSON object matching schema.</output_requirements>"
    ].join("\n");

    return this.requestJson(prompt, 360, fallback, validateWaveDistributionDecision);
  }
}
