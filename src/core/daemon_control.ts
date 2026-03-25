import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { readJson, writeJson, writeJsonAtomic } from "./fs_utils.js";

// ── State files that must be cleared on shutdown (full reset) ────────────────
const SHUTDOWN_CLEAR_FILES = [
  "jesus_directive.json",
  "prometheus_analysis.json",
  "athena_coordination.json",
  "worker_sessions.json",
  "jesus_escalation.json",
  "daemon.pid.json",
  "daemon.stop.json",
  "daemon.reload.json",
  "leadership_live.txt",
  "leadership_thinking.txt",
  "si_live.log"
];

// Worker state files pattern
const WORKER_STATE_PATTERN = /^worker_[a-z_]+\.json$/;
const DEBUG_WORKER_PATTERN = /^debug_worker_[A-Za-z_]+\.txt$/;

function daemonPidFile(config) {
  return path.join(config.paths.stateDir, "daemon.pid.json");
}

function daemonStopFile(config) {
  return path.join(config.paths.stateDir, "daemon.stop.json");
}

function daemonReloadFile(config) {
  return path.join(config.paths.stateDir, "daemon.reload.json");
}

export async function readDaemonPid(config) {
  return readJson(daemonPidFile(config), null);
}

export async function writeDaemonPid(config, _pid?: any) {
  const pidFile = daemonPidFile(config);
  const content = JSON.stringify({
    pid: process.pid,
    startedAt: new Date().toISOString()
  });
  // O_EXCL ensures atomic creation — fails if file already exists
  try {
    const fh = await fs.open(pidFile, "wx");
    await fh.writeFile(content, "utf8");
    await fh.close();
  } catch (err) {
    if (err.code === "EEXIST") {
      // PID file already exists — check if stale
      const existing = await readJson(pidFile, null);
      if (existing?.pid && isProcessAlive(existing.pid)) {
        throw new Error(`daemon already running (pid=${existing.pid})`, { cause: err });
      }
      // Stale PID file — overwrite safely
      await writeJson(pidFile, JSON.parse(content));
    } else {
      throw err;
    }
  }
}

export async function clearDaemonPid(config) {
  await fs.rm(daemonPidFile(config), { force: true });
}

export async function readStopRequest(config) {
  return readJson(daemonStopFile(config), null);
}

export async function requestDaemonStop(config, reason = "cli-stop") {
  await writeJsonAtomic(daemonStopFile(config), {
    requestedAt: new Date().toISOString(),
    reason
  });
}

export async function clearStopRequest(config) {
  await fs.rm(daemonStopFile(config), { force: true });
}

export async function readReloadRequest(config) {
  return readJson(daemonReloadFile(config), null);
}

export async function requestDaemonReload(config, reason = "cli-reload") {
  await writeJsonAtomic(daemonReloadFile(config), {
    requestedAt: new Date().toISOString(),
    reason
  });
}

export async function clearReloadRequest(config) {
  await fs.rm(daemonReloadFile(config), { force: true });
}

export function isProcessAlive(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) {
    return false;
  }

  try {
    process.kill(n, 0);
    return true;
  } catch {
    return false;
  }
}

export function isDaemonProcess(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 0) {
    return false;
  }

  try {
    if (process.platform === "win32") {
      const cmd = `$p=Get-CimInstance Win32_Process -Filter "ProcessId=${n}"; if($p){$p.CommandLine}else{''}`;      const output = execSync(`powershell -NoProfile -Command "${cmd}"`, {
        stdio: ["ignore", "pipe", "ignore"],
        encoding: "utf8",
        windowsHide: true
      });
      return /src[\\/]cli\.js\s+start/i.test(String(output || ""));
    }

    const output = execSync(`ps -p ${n} -o command=`, {
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
      windowsHide: true
    });
    return /src[\\/]cli\.js\s+start/i.test(String(output || ""));
  } catch {
    return false;
  }
}

/**
 * Full shutdown — clear all AI state so next start runs a fresh Jesus cycle.
 * This is the "kapat" command: kills daemon, clears leadership/worker state.
 * Progress log and premium usage are preserved for audit.
 */
export async function clearAllAIState(config) {
  const stateDir = config.paths?.stateDir || "state";
  const cleared = [];

  // Remove fixed state files
  for (const file of SHUTDOWN_CLEAR_FILES) {
    try {
      await fs.rm(path.join(stateDir, file), { force: true });
      cleared.push(file);
    } catch { /* already gone */ }
  }

  // Remove per-worker state and debug files
  try {
    const entries = await fs.readdir(stateDir);
    for (const entry of entries) {
      if (WORKER_STATE_PATTERN.test(entry) || DEBUG_WORKER_PATTERN.test(entry)) {
        await fs.rm(path.join(stateDir, entry), { force: true });
        cleared.push(entry);
      }
    }
  } catch { /* state dir may not exist */ }

  return cleared;
}
