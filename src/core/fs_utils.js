import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export async function ensureParent(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

/**
 * Exhaustive reason enum for readJson/readJsonSafe outcomes.
 * - MISSING: file does not exist (ENOENT)
 * - INVALID: file exists but JSON.parse failed, or an unexpected read error occurred
 */
export const READ_JSON_REASON = Object.freeze({
  MISSING: "missing",
  INVALID: "invalid"
});

/**
 * readJsonSafe — structured outcome contract for JSON file reads.
 *
 * Returns: { ok: boolean, data: any|null, reason: 'missing'|'invalid'|null, error: Error|null }
 *   ok=true  → data contains parsed object, reason and error are null
 *   ok=false → data is null, reason is READ_JSON_REASON.MISSING or .INVALID, error is the raw Error
 *
 * Never throws. Never silently swallows errors — callers receive full diagnostic information.
 */
export async function readJsonSafe(filePath) {
  let raw;
  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (readErr) {
    const reason = readErr.code === "ENOENT" ? READ_JSON_REASON.MISSING : READ_JSON_REASON.INVALID;
    return { ok: false, data: null, reason, error: readErr };
  }
  try {
    const data = JSON.parse(raw);
    return { ok: true, data, reason: null, error: null };
  } catch (parseErr) {
    return { ok: false, data: null, reason: READ_JSON_REASON.INVALID, error: parseErr };
  }
}

/**
 * readJson — backward-compatible convenience wrapper around readJsonSafe.
 *
 * Emits a `box:readError` event on process for every read failure, ensuring
 * no error is silently swallowed.  The event payload is:
 *   { filePath: string, reason: 'missing'|'invalid', error: Error, timestamp: string }
 *
 * For critical state files that must NOT fall back silently, use readJsonSafe
 * directly and inspect the structured outcome.
 *
 * Classification:
 *   Non-critical callers: pass a fallback value here — they get the fallback on
 *     any failure, but the event is still emitted for telemetry.
 *   Critical callers: call readJsonSafe and handle { ok, reason } explicitly.
 */
export async function readJson(filePath, fallback) {
  const result = await readJsonSafe(filePath);
  if (!result.ok) {
    process.emit("box:readError", {
      filePath,
      reason: result.reason,
      error: result.error,
      timestamp: new Date().toISOString()
    });
    return fallback;
  }
  return result.data;
}

export async function writeJson(filePath, value) {
  await ensureParent(filePath);
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

export function spawnAsync(command, args, options) {
  return new Promise((resolve) => {
    const stdoutChunks = [];
    const stderrChunks = [];
    const stdinInput = options.input || null;
    const child = spawn(command, args, {
      env: options.env,
      cwd: options.cwd,
      windowsHide: true,
      stdio: [stdinInput ? "pipe" : "ignore", "pipe", "pipe"]
    });
    if (stdinInput) {
      child.stdin.write(stdinInput);
      child.stdin.end();
    }
    child.stdout.on("data", (chunk) => {
      stdoutChunks.push(chunk);
      if (options.onStdout) options.onStdout(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderrChunks.push(chunk);
      if (options.onStderr) options.onStderr(chunk);
    });

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
