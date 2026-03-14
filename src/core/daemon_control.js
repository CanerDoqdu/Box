import fs from "node:fs/promises";
import path from "node:path";
import { execSync } from "node:child_process";
import { readJson, writeJson } from "./fs_utils.js";

function daemonPidFile(config) {
  return path.join(config.paths.stateDir, "daemon.pid.json");
}

function daemonStopFile(config) {
  return path.join(config.paths.stateDir, "daemon.stop.json");
}

export async function readDaemonPid(config) {
  return readJson(daemonPidFile(config), null);
}

export async function writeDaemonPid(config) {
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
  await writeJson(daemonStopFile(config), {
    requestedAt: new Date().toISOString(),
    reason
  });
}

export async function clearStopRequest(config) {
  await fs.rm(daemonStopFile(config), { force: true });
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
