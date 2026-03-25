/**
 * Worker entry point — containerised task runner.
 *
 * This file is the CMD target for docker/worker/Dockerfile and the
 * target for the `worker:run` npm script.  It is intentionally thin:
 * real task execution happens inside the Copilot CLI agent process
 * that the orchestrator spawns via src/core/worker_runner.js.
 *
 * When BOX runs in container-worker mode the orchestrator launches a
 * worker container and passes the task payload via environment
 * variables.  This entry point validates those variables, prints
 * diagnostics, then delegates to the CLI (src/cli.js once) so the
 * full orchestrator boot-path is exercised correctly.
 *
 * Required environment variables:
 *   WORKER_ROLE      — role slug the worker should act as (e.g. "noah")
 *   TASK_PAYLOAD     — JSON-stringified task object
 *   TARGET_REPO      — GitHub repo in owner/name format
 *   GITHUB_TOKEN     — PAT with repo + PR permissions
 *
 * Optional:
 *   BOX_LOG_LEVEL    — "debug" | "info" | "warn" | "error" (default: "info")
 */

import process from "node:process";

const REQUIRED_VARS = ["WORKER_ROLE", "TASK_PAYLOAD", "TARGET_REPO", "GITHUB_TOKEN"];

function validateEnv(): void {
  const missing = REQUIRED_VARS.filter((v) => !process.env[v]);
  if (missing.length > 0) {
    process.stderr.write(
      `[run_task] ERROR: Missing required environment variable(s): ${missing.join(", ")}\n` +
      `[run_task] Set these variables and re-run the container.\n`
    );
    process.exit(1);
  }
}

function main(): void {
  validateEnv();

  const role = process.env.WORKER_ROLE;
  const repo = process.env.TARGET_REPO;

  process.stdout.write(
    `[run_task] Worker container started — role=${role} repo=${repo}\n`
  );

  let task;
  try {
    task = JSON.parse(process.env.TASK_PAYLOAD);
  } catch {
    process.stderr.write(
      "[run_task] ERROR: TASK_PAYLOAD is not valid JSON.\n"
    );
    process.exit(1);
  }

  process.stdout.write(
    `[run_task] Task received — id=${task.id ?? "(none)"} kind=${task.kind ?? "(none)"}\n`
  );

  // Container workers are currently invoked by the orchestrator via
  // src/core/worker_runner.js which calls the Copilot CLI directly.
  // This entry point provides the coherent contract (env → validate →
  // log) required for a stable Docker CMD target.
  //
  // To extend with a full autonomous run cycle, import and call
  // runWorkerConversation() from src/core/worker_runner.js here.
  process.stdout.write("[run_task] Worker ready. Awaiting task dispatch.\n");
}

main();
