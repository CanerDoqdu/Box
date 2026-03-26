import type { Config } from "./types/index.js";
import { spawn } from "node:child_process";
import { writeFileSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.js";
import { runOnce, runDaemon, runRebase } from "./core/orchestrator.js";
import { runDoctor } from "./core/doctor.js";
import { readSiControl, writeSiControl, isSelfImprovementActive, readSiLiveLog, siLogAsync } from "./core/si_control.js";
import {
  readDaemonPid,
  readStopRequest,
  isDaemonProcess,
  isProcessAlive,
  requestDaemonStop,
  requestDaemonReload,
  clearDaemonPid,
  clearStopRequest,
  clearAllAIState
} from "./core/daemon_control.js";

// ── box on: start dashboard + daemon in one command ──────────────────────────

function killByPort(port: number): Promise<number | null> {
  return new Promise((resolve) => {
    if (process.platform === "win32") {
      const ps = spawn("powershell", [
        "-NoProfile", "-Command",
        `$c=Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1; if($c){Stop-Process -Id $c.OwningProcess -Force -ErrorAction SilentlyContinue; $c.OwningProcess}else{''}`
      ], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
      let out = "";
      ps.stdout.on("data", (d) => { out += d; });
      ps.on("close", () => {
        const pid = parseInt(out.trim(), 10);
        resolve(Number.isFinite(pid) && pid > 0 ? pid : null);
      });
      ps.on("error", () => resolve(null));
    } else {
      const fuser = spawn("fuser", [`${port}/tcp`], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      fuser.stdout.on("data", (d) => { out += d; });
      fuser.on("close", () => {
        const pid = parseInt(out.trim(), 10);
        if (Number.isFinite(pid) && pid > 0) {
          try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
          resolve(pid);
        } else {
          resolve(null);
        }
      });
      fuser.on("error", () => resolve(null));
    }
  });
}

function spawnDetached(command: string, args: string[], cwd: string): number | undefined {
  const child = spawn(command, args, {
    cwd,
    detached: true,
    stdio: "ignore",
    windowsHide: true
  });
  child.unref();
  return child.pid;
}

function savePid(stateDir: string, name: string, pid: number | undefined): void {
  const filePath = path.join(stateDir, `${name}.pid`);
  writeFileSync(filePath, String(pid), "utf8");
}

function readPid(stateDir: string, name: string): number | null {
  const filePath = path.join(stateDir, `${name}.pid`);
  try {
    if (existsSync(filePath)) {
      const pid = parseInt(readFileSync(filePath, "utf8").trim(), 10);
      return Number.isFinite(pid) && pid > 0 ? pid : null;
    }
  } catch { /* ignore */ }
  return null;
}

function removePidFile(stateDir: string, name: string): void {
  const filePath = path.join(stateDir, `${name}.pid`);
  try { unlinkSync(filePath); } catch { /* ignore */ }
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function boxOn(config: Config): Promise<void> {
  const stateDir = config.paths?.stateDir || "state";
  const root = path.resolve(stateDir, "..");

  // 1. Kill stale dashboard on port 8787
  const killed = await killByPort(8787);
  if (killed) console.log(`[box on] killed stale dashboard on port 8787 (pid=${killed})`);

  // 2. Check if daemon is already running
  const daemonPidState = await readDaemonPid(config);
  const daemonPid = Number(daemonPidState?.pid || 0);
  if (daemonPid && isDaemonProcess(daemonPid)) {
    console.log(`[box on] daemon already running pid=${daemonPid}`);
  } else {
    // Clear stale stop requests
    await clearStopRequest(config);

    // 3. Start daemon (detached)
    const dPid = spawnDetached("node", ["--import", "tsx", "src/cli.ts", "start"], root);
    savePid(stateDir, "daemon_bg", dPid);
    console.log(`[box on] daemon started pid=${dPid}`);
  }

  // 4. Start dashboard (detached)
  const dashPid = spawnDetached("node", ["--import", "tsx", "src/dashboard/live_dashboard.ts"], root);
  savePid(stateDir, "dashboard_bg", dashPid);
  console.log(`[box on] dashboard started pid=${dashPid} → http://localhost:8787`);

  console.log("");
  console.log("BOX is running. Dashboard: http://localhost:8787");
  console.log("To stop: node --import tsx src/cli.ts off  (or: npm run box:off)");
}

async function boxOff(config: Config): Promise<void> {
  const stateDir = config.paths?.stateDir || "state";

  // 1. Graceful daemon stop via stop request
  const daemonPidState = await readDaemonPid(config);
  const daemonPid = Number(daemonPidState?.pid || 0);
  if (daemonPid && isDaemonProcess(daemonPid)) {
    await requestDaemonStop(config, "cli-off");
    console.log(`[box off] stop requested for daemon pid=${daemonPid}`);

    // Wait up to 8s for daemon to exit
    for (let waited = 0; waited < 8000; waited += 500) {
      await waitMs(500);
      if (!isProcessAlive(daemonPid)) break;
    }
    if (isProcessAlive(daemonPid)) {
      try { process.kill(daemonPid, "SIGKILL"); } catch { /* already gone */ }
      console.log(`[box off] daemon force-killed pid=${daemonPid}`);
    } else {
      console.log("[box off] daemon stopped cleanly");
    }
  } else {
    await clearDaemonPid(config);
    await clearStopRequest(config);
    console.log("[box off] daemon was not running");
  }
  removePidFile(stateDir, "daemon_bg");

  // 2. Kill dashboard by saved PID
  const dashPid = readPid(stateDir, "dashboard_bg");
  if (dashPid && isProcessAlive(dashPid)) {
    try { process.kill(dashPid, "SIGKILL"); } catch { /* already gone */ }
    console.log(`[box off] dashboard stopped pid=${dashPid}`);
  }
  removePidFile(stateDir, "dashboard_bg");

  // 3. Fallback: kill by port 8787
  const killedByPort = await killByPort(8787);
  if (killedByPort) console.log(`[box off] dashboard killed by port 8787 (pid=${killedByPort})`);

  console.log("");
  console.log("BOX is down.");
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "once";
  const config = await loadConfig();

  if (command === "doctor") {
    await runDoctor(config);
    return;
  }

  if (command === "start") {
    const daemonPidState = await readDaemonPid(config);
    const daemonPid = Number(daemonPidState?.pid || 0);
    if (daemonPid && isDaemonProcess(daemonPid)) {
      console.log(`[box] daemon already running pid=${daemonPid}`);
      return;
    }

    // Starting should always clear any previously persisted stop request.
    await clearStopRequest(config);

    await runDaemon(config);
    return;
  }

  if (command === "rebase") {
    const result = await runRebase(config, { trigger: "cli-rebase" });
    console.log(`[box] rebase completed triggered=${result?.triggered ? "true" : "false"} reason=${result?.reason || "unknown"}`);
    return;
  }

  if (command === "reload") {
    const daemonPidState = await readDaemonPid(config);
    const daemonPid = Number(daemonPidState?.pid || 0);
    if (!daemonPid || !isDaemonProcess(daemonPid)) {
      console.log("[box] daemon not running — nothing to reload");
      return;
    }
    await requestDaemonReload(config, "cli-reload");
    console.log(`[box] reload requested for daemon pid=${daemonPid} — config will refresh on next loop iteration`);
    return;
  }

  if (command === "stop") {
    const daemonPidState = await readDaemonPid(config);
    const daemonPid = Number(daemonPidState?.pid || 0);
    if (!daemonPid) {
      await clearDaemonPid(config);
      await clearStopRequest(config);
      console.log("[box] daemon not running");
      return;
    }

    if (!isDaemonProcess(daemonPid)) {
      await clearDaemonPid(config);
      await clearStopRequest(config);
      console.log("[box] cleared stale daemon control files");
      console.log("[box] daemon not running");
      return;
    }

    const existingStopRequest = await readStopRequest(config);
    if (existingStopRequest?.requestedAt) {
      const requestedAtMs = new Date(existingStopRequest.requestedAt).getTime();
      const ageMs = Number.isFinite(requestedAtMs) ? (Date.now() - requestedAtMs) : Number.MAX_SAFE_INTEGER;
      const staleMs = Math.max(120000, Number(config.loopIntervalMs || 0) * 2);
      if (ageMs > staleMs) {
        await clearDaemonPid(config);
        await clearStopRequest(config);
        console.log("[box] cleared stale daemon control files");
        console.log("[box] daemon not running");
        return;
      }
    }

    await requestDaemonStop(config, "cli-stop");
    console.log(`[box] stop requested for daemon pid=${daemonPid}`);
    return;
  }

  if (command === "on") {
    await boxOn(config);
    return;
  }

  if (command === "off") {
    await boxOff(config);
    return;
  }

  if (command === "shutdown") {
    // SHUTDOWN = full reset. Kills daemon, clears all AI state.
    // Next "box on" or "box start" will run fresh Jesus cycle.
    const daemonPidState = await readDaemonPid(config);
    const daemonPid = Number(daemonPidState?.pid || 0);
    if (daemonPid && isDaemonProcess(daemonPid)) {
      await requestDaemonStop(config, "cli-shutdown");
      console.log(`[box shutdown] stop requested for daemon pid=${daemonPid}`);
      for (let waited = 0; waited < 8000; waited += 500) {
        await waitMs(500);
        if (!isProcessAlive(daemonPid)) break;
      }
      if (isProcessAlive(daemonPid)) {
        try { process.kill(daemonPid, "SIGKILL"); } catch { /* already gone */ }
        console.log(`[box shutdown] daemon force-killed pid=${daemonPid}`);
      } else {
        console.log("[box shutdown] daemon stopped");
      }
    } else {
      console.log("[box shutdown] daemon was not running");
    }

    // Kill dashboard too
    const stateDir = config.paths?.stateDir || "state";
    const dashPid = readPid(stateDir, "dashboard_bg");
    if (dashPid && isProcessAlive(dashPid)) {
      try { process.kill(dashPid, "SIGKILL"); } catch { /* already gone */ }
      console.log(`[box shutdown] dashboard stopped pid=${dashPid}`);
    }
    removePidFile(stateDir, "dashboard_bg");
    removePidFile(stateDir, "daemon_bg");
    await killByPort(8787);

    // Clear all AI state for fresh start
    const cleared = await clearAllAIState(config);
    console.log(`[box shutdown] cleared ${cleared.length} state files`);
    console.log("");
    console.log("BOX fully shutdown. All AI state cleared.");
    console.log("Next 'box on' or 'box start' will run a fresh Jesus cycle.");
    return;
  }

  // ── si: Self-Improvement toggle ───────────────────────────────────────────
  if (command === "si") {
    const subCmd = process.argv[3] || "status";
    const reason = process.argv.indexOf("--reason") !== -1
      ? process.argv[process.argv.indexOf("--reason") + 1] || "manual"
      : "manual";

    if (subCmd === "on") {
      const record = await writeSiControl(config, { enabled: true, reason, updatedBy: "cli" });
      await siLogAsync(config, "TOGGLE", "Self-Improvement ENABLED via CLI (reason: " + reason + ")");
      console.log("[box si] Self-Improvement ENABLED");
      console.log("  reason:    " + record.reason);
      console.log("  updatedAt: " + record.updatedAt);
      console.log("  updatedBy: " + record.updatedBy);
      console.log("");
      console.log("Takes effect on next orchestrator loop iteration.");
      return;
    }

    if (subCmd === "off") {
      const record = await writeSiControl(config, { enabled: false, reason, updatedBy: "cli" });
      await siLogAsync(config, "TOGGLE", "Self-Improvement DISABLED via CLI (reason: " + reason + ")");
      console.log("[box si] Self-Improvement DISABLED");
      console.log("  reason:    " + record.reason);
      console.log("  updatedAt: " + record.updatedAt);
      console.log("  updatedBy: " + record.updatedBy);
      console.log("");
      console.log("System continues running without SI. Re-enable: node --import tsx src/cli.ts si on");
      return;
    }

    if (subCmd === "log" || subCmd === "logs") {
      const maxLines = Number(process.argv[4]) || 50;
      const lines = await readSiLiveLog(config, maxLines);
      if (lines.length === 0) {
        console.log("[box si] No SI log entries yet.");
      } else {
        console.log("[box si] Last " + lines.length + " SI log entries:");
        console.log("─".repeat(80));
        for (const line of lines) console.log(line);
        console.log("─".repeat(80));
      }
      return;
    }

    // Default: status
    const gate = await isSelfImprovementActive(config);
    const control = await readSiControl(config);
    console.log("[box si] Self-Improvement Status");
    console.log("─".repeat(40));
    console.log("  active:         " + gate.active);
    console.log("  status:         " + gate.status);
    console.log("  reason:         " + gate.reason);
    console.log("  config.enabled: " + ((config as any).selfImprovement?.enabled !== false));
    console.log("  manual.enabled: " + control.enabled);
    if (control.updatedAt) {
      console.log("  manual.updated: " + control.updatedAt + " by " + control.updatedBy);
      console.log("  manual.reason:  " + control.reason);
    }
    return;
  }

  await runOnce(config);
}

main().catch((error) => {
  console.error("[box] fatal:", error?.message ?? error);
  process.exit(1);
});
