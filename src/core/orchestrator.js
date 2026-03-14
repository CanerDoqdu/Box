/**
 * BOX Orchestrator — Startup-Once Architecture
 *
 * Startup:
 *   1. Jesus activates ONCE — analyzes everything, sets strategy
 *   2. If full scan needed → Trump runs deep repo analysis
 *   3. Jesus sends complete directive + Trump plans to Moses
 *   4. Moses dispatches workers in parallel (max throughput)
 *
 * Ongoing loop (worker monitoring):
 *   - Every 2 min: check for Moses escalation (jesus_escalation.json)
 *   - If escalation found: re-run full startup cycle, then resume monitoring
 *   - If workers active: Moses tactical follow-up
 *   - No periodic Jesus re-triggering — Jesus is startup-only
 */

import path from "node:path";
import { appendProgress } from "./state_tracker.js";
import { readStopRequest, writeDaemonPid, clearDaemonPid } from "./daemon_control.js";
import { runJesusCycle } from "./jesus_supervisor.js";
import { runTrumpAnalysis } from "./trump.js";
import { runMosesCycle } from "./moses_coordinator.js";
import { warn } from "./logger.js";
import { readJson } from "./fs_utils.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runDaemon(config) {
  const pid = process.pid;
  await writeDaemonPid(config, pid);
  await appendProgress(config, `[BOX] Daemon started pid=${pid}`);

  process.on("SIGTERM", async () => {
    await appendProgress(config, "[BOX] SIGTERM received, stopping");
    await clearDaemonPid(config);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await appendProgress(config, "[BOX] SIGINT received, stopping");
    await clearDaemonPid(config);
    process.exit(0);
  });

  // Jesus activates ONCE at startup
  await appendProgress(config, "[BOX] Startup — Jesus activating for initial strategic analysis");
  await runStartupCycle(config);

  // Then transition to worker monitoring loop
  await mainLoop(config);
}

export async function runOnce(config) {
  await runStartupCycle(config);
}

export async function runRebase(_config, _opts = {}) {
  return { triggered: false, reason: "not applicable in conversation-based architecture" };
}

// ── Loop intervals ────────────────────────────────────────────────────────────
const WORKER_POLL_MS = 2 * 60 * 1000; //  2 min — worker monitoring and escalation check
const IDLE_SLEEP_MS  = 5 * 60 * 1000; //  5 min — nothing active

async function hasActiveWorkersAsync(config) {
  try {
    const stateDir = config.paths?.stateDir || "state";
    const sessions = await readJson(path.join(stateDir, "worker_sessions.json"), {});
    return Object.values(sessions).some(s => s?.status === "working");
  } catch { return false; }
}

// ── Startup cycle: Jesus → Trump? → Moses ────────────────────────────────────
async function runStartupCycle(config) {
  try {
    await appendProgress(config, "[STARTUP] ── Jesus strategic cycle starting ──");

    const jesusDecision = await runJesusCycle(config);

    if (!jesusDecision || jesusDecision.wait === true) {
      await appendProgress(config, "[STARTUP] Jesus says: wait — nothing to do");
      return;
    }

    let trumpPlans = null;
    if (jesusDecision.callTrump === true) {
      await appendProgress(config, "[STARTUP] Trump activated for deep project analysis");
      trumpPlans = await runTrumpAnalysis(config, jesusDecision);
    }

    if (jesusDecision.wakeMoses !== false) {
      await runMosesCycle(config, jesusDecision, trumpPlans);
    }

    await appendProgress(config, "[STARTUP] ── Jesus strategic cycle complete ──");
  } catch (err) {
    await appendProgress(config, `[STARTUP] Error: ${String(err?.message || err)}`);
    warn(`[orchestrator] startup cycle error: ${String(err?.message || err)}`);
  }
}

// ── Worker monitoring loop (runs after startup) ───────────────────────────────
async function mainLoop(config) {
  const stateDir = config.paths?.stateDir || "state";

  while (true) {
    const stopReq = await readStopRequest(config);
    if (stopReq?.requestedAt) {
      await appendProgress(config, "[BOX] Stop request detected, shutting down");
      await clearDaemonPid(config);
      break;
    }

    // Check if Moses escalated a system problem to Jesus
    try {
      const escalation = await readJson(path.join(stateDir, "jesus_escalation.json"), null);
      if (escalation?.requestedAt) {
        await appendProgress(config, `[LOOP] Moses escalated to Jesus: ${escalation.reason || "(no reason)"} — re-running startup cycle`);
        // Clear the escalation request before running (avoid re-trigger on error)
        await import("./fs_utils.js").then(m => m.writeJson(path.join(stateDir, "jesus_escalation.json"), {}));
        await runStartupCycle(config);
        await sleep(WORKER_POLL_MS);
        continue;
      }
    } catch { /* escalation file may not exist — that's fine */ }

    // Workers active → Moses tactical follow-up
    const workersActive = await hasActiveWorkersAsync(config);
    if (workersActive) {
      await appendProgress(config, "[LOOP] Workers active — Moses tactical follow-up");
      try {
        const jesusDirective = await readJson(path.join(stateDir, "jesus_directive.json"), {});
        await runMosesCycle(config, jesusDirective, null);
      } catch (err) {
        warn(`[orchestrator] tactical Moses error: ${String(err?.message || err)}`);
      }
      await sleep(WORKER_POLL_MS);
    } else {
      await sleep(IDLE_SLEEP_MS);
    }
  }
}


