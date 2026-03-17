/**
 * BOX Orchestrator — Resume-From-Checkpoint Architecture
 *
 * Startup:
 *   1. Read last checkpoint (moses_coordination.json + worker_sessions.json)
 *   2. If workers are active → resume monitoring them, ZERO AI calls
 *   3. If no checkpoint exists → first-ever run → Jesus activates ONCE
 *   4. If Moses reports a systemic error → escalate to Jesus
 *
 * Ongoing loop (worker monitoring):
 *   - Workers active → wait for them to finish (no AI cost)
 *   - Workers finished + remaining plans → Moses dispatches next batch
 *   - All plans done → system sleeps (no Jesus re-trigger)
 *   - Only Moses escalation (jesus_escalation.json) can wake Jesus mid-run
 */

import path from "node:path";
import { appendProgress } from "./state_tracker.js";
import { readStopRequest, writeDaemonPid, clearDaemonPid, clearStopRequest, readReloadRequest, clearReloadRequest } from "./daemon_control.js";
import { loadConfig } from "../config.js";
import { runJesusCycle } from "./jesus_supervisor.js";
import { runTrumpAnalysis } from "./trump.js";
import { runMosesCycle } from "./moses_coordinator.js";
import { warn } from "./logger.js";
import { readJson, writeJson } from "./fs_utils.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Attempt to start the dashboard server alongside the daemon (non-blocking, non-fatal). */
async function tryStartDashboard() {
  try {
    const { startDashboard } = await import("../dashboard/live_dashboard.js");
    startDashboard();
  } catch (err) {
    warn(`[orchestrator] dashboard auto-start failed (non-fatal): ${String(err?.message || err)}`);
  }
}

export async function runDaemon(config) {
  const liveConfig = Object.assign({}, config);
  const pid = process.pid;
  const stateDir = liveConfig.paths?.stateDir || "state";
  await writeDaemonPid(liveConfig, pid);
  await appendProgress(liveConfig, `[BOX] Daemon started pid=${pid}`);

  await tryStartDashboard();

  process.on("SIGTERM", async () => {
    await appendProgress(liveConfig, "[BOX] SIGTERM received, stopping");
    await clearDaemonPid(liveConfig);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await appendProgress(liveConfig, "[BOX] SIGINT received, stopping");
    await clearDaemonPid(liveConfig);
    process.exit(0);
  });

  // ── Checkpoint-based startup: resume from where we left off ──
  const sessions = await readJson(path.join(stateDir, "worker_sessions.json"), {});
  const mosesState = await readJson(path.join(stateDir, "moses_coordination.json"), {});
  const jesusDirective = await readJson(path.join(stateDir, "jesus_directive.json"), null);
  const activeWorkers = Object.entries(sessions)
    .filter(([, s]) => s?.status === "working")
    .map(([name]) => name);

  const hasCheckpoint = mosesState?.coordinatedAt || (jesusDirective && jesusDirective.decidedAt);

  if (activeWorkers.length > 0) {
    // Workers still running from last session — just monitor them, zero AI cost
    await appendProgress(liveConfig,
      `[STARTUP] Resuming from checkpoint — ${activeWorkers.length} workers active (${activeWorkers.join(", ")}). No AI calls.`
    );
  } else if (hasCheckpoint) {
    // Checkpoint exists but no active workers — continue from last coordination state
    await appendProgress(liveConfig, "[STARTUP] Resuming from checkpoint — no active workers, entering main loop");
  } else {
    // No checkpoint at all — first ever run, Jesus must initialize
    await appendProgress(liveConfig, "[STARTUP] No checkpoint found — first run, Jesus activating");
    await runStartupCycle(liveConfig);
  }

  await mainLoop(liveConfig);
}

export async function runOnce(config) {
  await runStartupCycle(config);
}

export async function runRebase(_config, _opts = {}) {
  return { triggered: false, reason: "not applicable in conversation-based architecture" };
}

// ── Loop intervals ────────────────────────────────────────────────────────────
const _ESCALATION_POLL_MS = 30 * 1000;   // 30 sec — only checks stop+escalation, no AI
const WORKERS_DONE_POLL_MS = 30 * 1000; // 30 sec — wait for all workers to finish

function roleToWorkerStateFile(role) {
  const slug = String(role || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `worker_${slug}.json`;
}

function getLastWorkerReportedStatus(session, role) {
  const history = Array.isArray(session?.history) ? session.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (!entry || entry.from === "moses") continue;
    if (role && entry.from && entry.from !== role) continue;
    const status = String(entry.status || "").toLowerCase();
    if (status) return status;
  }
  return "";
}

async function recoverStaleWorkerSessions(config, stateDir, sessions) {
  const recoveredRoles = [];

  for (const [role, session] of Object.entries(sessions || {})) {
    if (session?.status !== "working") continue;

    const reportedStatus = getLastWorkerReportedStatus(session, role);
    if (["done", "partial", "blocked"].includes(reportedStatus)) {
      session.status = "idle";
      recoveredRoles.push(role);
      continue;
    }

    // No time-based recovery: long-running workers are allowed to run indefinitely.
  }

  if (recoveredRoles.length === 0) return false;

  await writeJson(path.join(stateDir, "worker_sessions.json"), sessions);

  for (const role of recoveredRoles) {
    const workerStatePath = path.join(stateDir, roleToWorkerStateFile(role));
    const workerState = await readJson(workerStatePath, null);
    if (workerState && workerState.status === "working") {
      workerState.status = "idle";
      await writeJson(workerStatePath, workerState);
    }
  }

  await appendProgress(
    config,
    `[LOOP] Recovered stale worker states (${recoveredRoles.length}): ${recoveredRoles.join(", ")}`
  );
  warn(`[orchestrator] Recovered stale worker states: ${recoveredRoles.join(", ")}`);
  return true;
}

async function hasActiveWorkersAsync(config) {
  try {
    const stateDir = config.paths?.stateDir || "state";
    const sessions = await readJson(path.join(stateDir, "worker_sessions.json"), {});
    await recoverStaleWorkerSessions(config, stateDir, sessions);
    return Object.values(sessions).some(s => s?.status === "working");
  } catch { return false; }
}

// Wait until all workers are done (or timeout), then call Moses once for final report
async function waitForWorkersAndFinalize(config) {
  while (true) {
    const stopReq = await readStopRequest(config);
    if (stopReq?.requestedAt) {
      await appendProgress(
        config,
        `[LOOP] Stop requested while waiting workers: reason=${stopReq.reason || "unknown"}`
      );
      return false; // stop requested — bail
    }

    const stillActive = await hasActiveWorkersAsync(config);
    if (!stillActive) {
      await appendProgress(config, "[LOOP] All workers done — cycle complete");
      return true;
    }
    await sleep(WORKERS_DONE_POLL_MS);
  }
}

// ── Startup cycle: Jesus → Trump? → Moses (only called on first-ever run or escalation) ──
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

// ── Main loop: checkpoint-based ──────────────────────────────
async function mainLoop(config) {
  const stateDir = config.paths?.stateDir || "state";
  const RE_EVAL_SLEEP_MS = 2 * 60 * 1000;
  const STALLED_WAVE_CYCLES_THRESHOLD = Math.max(2, Number(config?.planner?.stalledWaveEscalationCycles || 3));
  const STALLED_WAVE_ESCALATION_COOLDOWN_MS = Math.max(60000, Number(config?.planner?.stalledWaveEscalationCooldownMs || (5 * 60 * 1000)));
  let previousCompletedCount = null;
  let stalledCycles = 0;
  let lastAutoEscalationAtMs = 0;

  // Phase 1: wait for any active workers to finish
  await waitForWorkersAndFinalize(config);

  // Phase 2: continuation loop
  while (true) {
    const stopReq = await readStopRequest(config);
    if (stopReq?.requestedAt) {
      await appendProgress(config, `[BOX] Stop request detected, shutting down (reason=${stopReq.reason || "unknown"})`);
      await clearStopRequest(config);
      await clearDaemonPid(config);
      break;
    }

    // Hot-reload
    try {
      const reloadReq = await readReloadRequest(config);
      if (reloadReq?.requestedAt) {
        await clearReloadRequest(config);
        const freshConfig = await loadConfig();
        for (const key of Object.keys(freshConfig)) {
          config[key] = freshConfig[key];
        }
        await appendProgress(config, `[BOX] Hot-reload applied — config refreshed (reason=${reloadReq.reason || "cli-reload"})`);
      }
    } catch (err) {
      warn(`[orchestrator] reload error: ${String(err?.message || err)}`);
    }

    // Moses escalation → Jesus (systemic problems ONLY)
    try {
      const escalation = await readJson(path.join(stateDir, "jesus_escalation.json"), null);
      if (escalation?.requestedAt) {
        await appendProgress(config, `[LOOP] Moses escalated to Jesus: ${escalation.reason || "(no reason)"} — running Jesus cycle`);
        await import("./fs_utils.js").then(m => m.writeJson(path.join(stateDir, "jesus_escalation.json"), {}));
        await runStartupCycle(config);
        await waitForWorkersAndFinalize(config);
        continue;
      }
    } catch { /* escalation file may not exist */ }

    // Check remaining work
    const trumpAnalysis = await readJson(path.join(stateDir, "trump_analysis.json"), null);
    const jesusDirective = await readJson(path.join(stateDir, "jesus_directive.json"), {});
    const mosesState = await readJson(path.join(stateDir, "moses_coordination.json"), {});
    const completedTasks = Array.isArray(mosesState?.completedTasks) ? mosesState.completedTasks : [];
    const totalPlans = Array.isArray(trumpAnalysis?.plans) ? trumpAnalysis.plans.length : 0;
    const totalWaves = Array.isArray(trumpAnalysis?.executionStrategy?.waves)
      ? trumpAnalysis.executionStrategy.waves.length
      : 0;

    // Trump plans are "active" if they exist and have plans, regardless of callTrump flag.
    // callTrump only controls whether to RE-RUN Trump, not whether existing plans are valid.
    const trumpActive = trumpAnalysis && totalPlans > 0;
    const hasRemainingWork = trumpActive && completedTasks.length < totalPlans;

    if (hasRemainingWork && totalWaves > 0) {
      if (previousCompletedCount !== null && completedTasks.length <= previousCompletedCount) {
        stalledCycles += 1;
      } else {
        stalledCycles = 0;
      }
      previousCompletedCount = completedTasks.length;

      const nowMs = Date.now();
      const escalationCooldownPassed = (nowMs - lastAutoEscalationAtMs) >= STALLED_WAVE_ESCALATION_COOLDOWN_MS;
      if (stalledCycles >= STALLED_WAVE_CYCLES_THRESHOLD && escalationCooldownPassed) {
        await appendProgress(config,
          `[LOOP][WATCHDOG] Wave progress stalled (${completedTasks.length}/${totalWaves} waves across ${stalledCycles} cycles) — escalating to Jesus`
        );
        await writeJson(path.join(stateDir, "jesus_escalation.json"), {
          requestedAt: new Date().toISOString(),
          reason: `auto-watchdog: no wave progress for ${stalledCycles} cycles`
        });
        lastAutoEscalationAtMs = nowMs;
        stalledCycles = 0;
        continue;
      }
    } else {
      previousCompletedCount = null;
      stalledCycles = 0;
    }

    if (hasRemainingWork) {
      await appendProgress(config, `[LOOP] Moses continuation — ${completedTasks.length}/${totalPlans} plans done`);
      try {
        await runMosesCycle(config, jesusDirective, trumpAnalysis);
        await waitForWorkersAndFinalize(config);
      } catch (err) {
        warn(`[orchestrator] Moses continuation error: ${String(err?.message || err)}`);
      }
      await sleep(RE_EVAL_SLEEP_MS);
    } else {
      // Workers still busy → just wait, zero cost
      const workersStillBusy = await hasActiveWorkersAsync(config);
      if (workersStillBusy) {
        await sleep(WORKERS_DONE_POLL_MS);
        continue;
      }

      // All work done — system sleeps until stop or escalation. NO Jesus re-trigger.
      await appendProgress(config, `[LOOP] All work complete (${completedTasks.length}/${totalPlans}). System idle — waiting for stop request or escalation.`);
      await sleep(RE_EVAL_SLEEP_MS);
    }
  }
}

