import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { info, warn } from "./logger.js";

function check(command) {
  try {
    execSync(command, { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/**
 * Run preflight capability checks before a cycle starts.
 * Returns a structured result so the orchestrator can decide whether to proceed.
 *
 * @param {object} config
 * @returns {Promise<{ ok: boolean, checks: Record<string, boolean>, warnings: string[] }>}
 */
export async function runDoctor(config) {
  const warnings = [];
  const stateDir = config?.paths?.stateDir || "state";

  const checks = {
    node: check("node --version"),
    docker: check("docker --version"),
    claudeApiKey: Boolean(config.env?.claudeApiKey),
    githubToken: Boolean(config.env?.githubToken),
    targetRepo: Boolean(config.env?.targetRepo),
    stateDir: existsSync(stateDir),
    copilotCli: check(`${config.env?.copilotCliCommand || "copilot"} --version`),
    gitAvailable: check("git --version"),
  };

  info("doctor checks", checks);

  if (!checks.githubToken || !checks.targetRepo) {
    warnings.push("GitHub integration not ready: set GITHUB_TOKEN and TARGET_REPO in .env");
  }
  if (!checks.stateDir) {
    warnings.push(`State directory "${stateDir}" does not exist`);
  }
  if (!checks.copilotCli) {
    warnings.push("Copilot CLI not found — AI agent calls will fail");
  }
  if (!checks.gitAvailable) {
    warnings.push("Git not available — source control operations will fail");
  }

  for (const w of warnings) warn(w);

  const ok = checks.node && checks.githubToken && checks.targetRepo && checks.stateDir;
  return { ok, checks, warnings };
}
