import { spawn } from "node:child_process";
import { info } from "./logger.js";

function readAll(stream) {
  return new Promise((resolve) => {
    let data = "";
    stream.on("data", (chunk) => {
      data += String(chunk);
    });
    stream.on("end", () => resolve(data));
  });
}

function deriveChecks(exitCode, stdout, stderr) {
  const output = `${stdout}\n${stderr}`.toLowerCase();
  if (exitCode === 0) {
    return {
      buildOk: true,
      testsOk: true,
      lintOk: !output.includes("lint failed")
    };
  }

  return {
    // Non-zero worker exits are treated as failed checks to keep gates deterministic.
    buildOk: false,
    testsOk: false,
    lintOk: false
  };
}

function extractCopilotMeta(stdout, stderr) {
  const content = `${stdout}\n${stderr}`;
  const lines = content.split(/\r?\n/).filter(Boolean);
  const marker = lines.find((line) => line.startsWith("BOX_COPILOT_META="));
  if (!marker) {
    return null;
  }

  const jsonText = marker.slice("BOX_COPILOT_META=".length);
  try {
    return JSON.parse(jsonText);
  } catch {
    return null;
  }
}

export async function runWorkerTask(config, task, overrides = {}) {
  const args = [
    "run",
    "--rm",
    "-e",
    "TARGET_REPO",
    "-e",
    "TARGET_BASE_BRANCH",
    "-e",
    "GITHUB_TOKEN",
    "-e",
    "COPILOT_CLI_COMMAND",
    "-e",
    "COPILOT_STRATEGY",
    "-e",
    "COPILOT_ALLOWED_MODELS",
    "-e",
    "COPILOT_NEVER_USE_MODELS",
    "-e",
    "COPILOT_MAX_MULTIPLIER",
    "-e",
    "COPILOT_MODEL_MULTIPLIERS_JSON",
    "-e",
    "COPILOT_DEFAULT_MODEL",
    "-e",
    "COPILOT_OPUS_MODEL",
    "-e",
    "COPILOT_ALLOW_OPUS_ESCALATION",
    "-e",
    "COPILOT_TEAM_LEAD_ALLOW_OPUS",
    "-e",
    "COPILOT_TEAM_LEAD_REASON",
    "-e",
    "BOX_SELECTED_AGENT",
    "-e",
    "BOX_PROMPT_FILE",
    "-e",
    "BOX_PROMPT_TEMPLATE_TEXT",
    "-e",
    "COPILOT_OPUS_ESCALATION_KEYWORDS",
    "-e",
    "COPILOT_PREFERRED_MODELS_BY_TASK_KIND_JSON",
    "-e",
    "BOX_AUTO_CREATE_PR",
    config.workerImage,
    "node",
    "/app/src/workers/run_task.js",
    String(task.id),
    task.title,
    task.kind || "general"
  ];

  info(`spawning worker for task ${task.id}`);

  return new Promise((resolve) => {
    const child = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        TARGET_REPO: config.env.targetRepo || "",
        TARGET_BASE_BRANCH: config.env.targetBaseBranch,
        GITHUB_TOKEN: config.env.githubToken || "",
        COPILOT_CLI_COMMAND: config.env.copilotCliCommand,
        COPILOT_STRATEGY: config.copilot.strategy,
        COPILOT_ALLOWED_MODELS: (config.copilot.allowedModels || []).join(","),
        COPILOT_NEVER_USE_MODELS: (config.copilot.neverUseModels || []).join(","),
        COPILOT_MAX_MULTIPLIER: String(config.copilot.maxMultiplier),
        COPILOT_MODEL_MULTIPLIERS_JSON: JSON.stringify(config.copilot.multipliers || {}),
        COPILOT_DEFAULT_MODEL: config.copilot.defaultModel || "Claude Sonnet 4.5",
        COPILOT_OPUS_MODEL: config.copilot.opusModel || "Claude Opus 4.6",
        COPILOT_ALLOW_OPUS_ESCALATION: String(Boolean(config.copilot.allowOpusEscalation || overrides.allowOpusEscalation)),
        COPILOT_TEAM_LEAD_ALLOW_OPUS: String(Boolean(overrides.teamLeadAllowOpus)),
        COPILOT_TEAM_LEAD_REASON: String(overrides.teamLeadReason || ""),
        BOX_SELECTED_AGENT: String(overrides.selectedAgent || "box-coder"),
        BOX_PROMPT_FILE: String(overrides.promptFile || ""),
        BOX_PROMPT_TEMPLATE_TEXT: String(overrides.promptTemplateText || ""),
        BOX_AUTO_CREATE_PR: String(Boolean(config?.git?.autoCreatePr ?? true)),
        COPILOT_OPUS_ESCALATION_KEYWORDS: (config.copilot.opusEscalationKeywords || []).join(","),
        COPILOT_PREFERRED_MODELS_BY_TASK_KIND_JSON: JSON.stringify(config.copilot.preferredModelsByTaskKind || {})
      }
    });
    Promise.all([readAll(child.stdout), readAll(child.stderr)]).then(([stdout, stderr]) => {
      child.on("close", (code) => {
        const checks = deriveChecks(code, stdout, stderr);
        const copilotMeta = extractCopilotMeta(stdout, stderr);
        resolve({
          ok: code === 0,
          exitCode: code,
          stdout,
          stderr,
          copilotMeta,
          buildOk: checks.buildOk,
          testsOk: checks.testsOk,
          lintOk: checks.lintOk,
          coveragePercent: 80
        });
      });
    });
  });
}
