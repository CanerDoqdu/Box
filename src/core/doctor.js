import { execSync } from "node:child_process";
import { info, warn } from "./logger.js";

function check(command) {
  try {
    execSync(command, { stdio: "ignore", windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

export async function runDoctor(config) {
  const checks = {
    node: check("node --version"),
    docker: check("docker --version"),
    claudeApiKey: Boolean(config.env.claudeApiKey),
    githubToken: Boolean(config.env.githubToken),
    targetRepo: Boolean(config.env.targetRepo)
  };

  info("doctor checks", checks);

  if (!checks.githubToken || !checks.targetRepo) {
    warn("GitHub integration not ready: set GITHUB_TOKEN and TARGET_REPO in .env");
  }
}
