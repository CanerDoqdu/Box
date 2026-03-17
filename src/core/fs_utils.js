import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export async function ensureParent(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

export async function readJson(filePath, fallback) {
  try {
    const raw = await fs.readFile(filePath, "utf8");
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

export async function writeJson(filePath, value) {
  await ensureParent(filePath);
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function spawnAsync(command, args, options) {
  return new Promise((resolve) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const child = spawn(command, args, {
      env: options.env,
      cwd: options.cwd,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
      if (options.onStdout) options.onStdout(chunk);
    });
    child.stderr.on("data", (chunk) => stderrChunks.push(chunk));

    let settled = false;
    const timeoutMs = options.timeoutMs ?? 45 * 60 * 1000; // 45-minute default
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolve({
        status: -1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: `[BOX] Process killed after ${timeoutMs / 1000}s timeout`,
        timedOut: true
      });
    }, timeoutMs);

    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        status: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString("utf8"),
        stderr: Buffer.concat(stderrChunks).toString("utf8")
      });
    });
    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status: 1, stdout: "", stderr: String(err.message) });
    });
  });
}
