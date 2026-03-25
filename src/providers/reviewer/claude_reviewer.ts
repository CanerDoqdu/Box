import { tryExtractJson, validatePlan, validateDecision, validateOpusDecision } from "./utils.js";

const API_URL = "https://api.anthropic.com/v1/messages";

function getEvidenceQuotes(workerResult: Record<string, unknown>): string[] {
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

export class ClaudeReviewer {
  apiKey: string;
  model: string;
  reviewMaxRetries: number;
  reviewMaxTokens: number;
  planMaxTokens: number;
  thinking: { type: string; effort?: string } | undefined;

  constructor(apiKey: string, options: { model?: string; reviewMaxRetries?: number; reviewMaxTokens?: number; planMaxTokens?: number; thinking?: { type: string; effort?: string } } = {}) {
    this.apiKey = apiKey;
    this.model = options.model || "claude-sonnet-4-6";
    this.reviewMaxRetries = Number(options.reviewMaxRetries || 1);
    this.reviewMaxTokens = Number(options.reviewMaxTokens || 16000);
    this.planMaxTokens = Number(options.planMaxTokens || 16000);
    this.thinking = options.thinking || { type: "adaptive", effort: "medium" };
  }

  buildOutputConfig(): { effort: string } | undefined {
    if (!this.thinking || this.thinking.type !== "adaptive") {
      return undefined;
    }
    return { effort: this.thinking.effort || "medium" };
  }

  async requestJson<T>(prompt: string, maxTokens: number, fallback: T, validator: (payload: any, fallback: T) => T): Promise<T> {
    let lastError = null;

    for (let attempt = 1; attempt <= this.reviewMaxRetries + 1; attempt += 1) {
      try {
        const response = await fetch(API_URL, {
          method: "POST",
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
          const body = await response.text();
          throw new Error(`claude request failed: ${response.status} ${body}`);
        }

        const json = await response.json();
        const text = (json as any)?.content?.map((c) => c.text).filter(Boolean).join("\n") || "";
        const parsed = tryExtractJson(text);
        const validated = validator(parsed, fallback);
        return validated;
      } catch (error) {
        lastError = error;
      }
    }

    throw lastError;
  }

  async reviewPlan(summary: Record<string, unknown>, tasks: unknown[]): Promise<{ tasks: unknown[] }> {
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

    return this.requestJson(prompt, this.planMaxTokens, { tasks }, (payload, fb) => validatePlan(payload, fb.tasks));
  }

  async reviewResult(task: Record<string, unknown>, workerResult: Record<string, unknown>, gates: Record<string, unknown>): Promise<{ approved: boolean; reason: string }> {
    if (!this.apiKey) {
      return { approved: Boolean(gates.ok), reason: "claude disabled" };
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
      `<worker_result>${JSON.stringify(workerResult)}</worker_result>`,
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
      { approved: Boolean(gates.ok), reason: "fallback deterministic decision" },
      validateDecision
    );
  }

  async recommendOpusForTask(task: Record<string, unknown>, summary: Record<string, unknown>, budget: Record<string, unknown>): Promise<{ allowOpus: boolean; reason: string }> {
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
}
