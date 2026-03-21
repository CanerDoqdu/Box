import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

export async function ensureParent(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
}

/**
 * Exhaustive reason enum for writeJsonAtomic / writeJsonAtomicSafe outcomes.
 * - NULL_VALUE:        value is null or undefined (missing input)
 * - NOT_SERIALIZABLE:  JSON.stringify threw — value cannot be serialized (invalid input)
 * - TEMP_WRITE_FAILED: writing the temporary file failed (filesystem error)
 * - RENAME_FAILED:     atomic rename from tmp → final path failed (filesystem error)
 */
export const WRITE_JSON_REASON = Object.freeze({
  NULL_VALUE: "null_value",
  NOT_SERIALIZABLE: "not_serializable",
  TEMP_WRITE_FAILED: "temp_write_failed",
  RENAME_FAILED: "rename_failed"
});

/**
 * writeJsonAtomicSafe — atomic write with structured outcome contract.
 *
 * Algorithm:
 *   1. Validate value (not null/undefined, JSON-serializable).
 *   2. Write serialized content to <filePath>.tmp.
 *   3. Rename <filePath>.tmp → <filePath> (atomic on POSIX; best-effort on Windows).
 *   4. On any failure: clean up the .tmp file, return structured error.
 *
 * Returns: { ok: boolean, reason: WRITE_JSON_REASON|null, error: Error|null }
 *   ok=true  → file written atomically, reason and error are null
 *   ok=false → reason is one of WRITE_JSON_REASON.*, error is the raw Error
 *
 * Never throws. Distinguishes missing input (NULL_VALUE) from invalid input
 * (NOT_SERIALIZABLE) from filesystem errors (TEMP_WRITE_FAILED / RENAME_FAILED).
 */
export async function writeJsonAtomicSafe(filePath, value) {
  if (value === null || value === undefined) {
    return {
      ok: false,
      reason: WRITE_JSON_REASON.NULL_VALUE,
      error: new TypeError(`writeJsonAtomic: value must not be null or undefined (path=${filePath})`)
    };
  }

  let content;
  try {
    content = `${JSON.stringify(value, null, 2)}\n`;
  } catch (serErr) {
    return { ok: false, reason: WRITE_JSON_REASON.NOT_SERIALIZABLE, error: serErr };
  }

  const tmpPath = `${filePath}.tmp`;
  try {
    await ensureParent(filePath);
    await fs.writeFile(tmpPath, content, "utf8");
  } catch (writeErr) {
    try { await fs.rm(tmpPath, { force: true }); } catch { /* best-effort cleanup */ }
    return { ok: false, reason: WRITE_JSON_REASON.TEMP_WRITE_FAILED, error: writeErr };
  }

  try {
    await fs.rename(tmpPath, filePath);
  } catch (renameErr) {
    try { await fs.rm(tmpPath, { force: true }); } catch { /* best-effort cleanup */ }
    return { ok: false, reason: WRITE_JSON_REASON.RENAME_FAILED, error: renameErr };
  }

  return { ok: true, reason: null, error: null };
}

/**
 * writeJsonAtomic — atomic write that throws on failure.
 *
 * Uses temp-file + rename to prevent truncated JSON on crash or kill.
 * Thrown errors carry a `reason` property from WRITE_JSON_REASON for
 * machine-readable diagnostics.
 *
 * Callers that need structured outcomes without throwing: use writeJsonAtomicSafe.
 */
export async function writeJsonAtomic(filePath, value) {
  const result = await writeJsonAtomicSafe(filePath, value);
  if (!result.ok) {
    const err = result.error || new Error(`writeJsonAtomic failed: reason=${result.reason} path=${filePath}`);
    err.reason = result.reason;
    throw err;
  }
}

/**
 * cleanupStaleTempFiles — remove leftover .tmp files from a crashed atomic write.
 *
 * Called at daemon/orchestrator startup to ensure no partial-write artifacts
 * remain from a previous crash or kill. Removal is best-effort: individual
 * file failures are silently skipped, but the overall scan continues.
 *
 * Returns: { ok: boolean, removed: string[], error: Error|null }
 *   ok=true  → scan completed (even if some files could not be removed)
 *   ok=false → directory could not be read (error is the raw Error)
 */
export async function cleanupStaleTempFiles(dir) {
  try {
    const entries = await fs.readdir(dir);
    const removed = [];
    for (const entry of entries) {
      if (entry.endsWith(".tmp")) {
        try {
          await fs.rm(path.join(dir, entry), { force: true });
          removed.push(entry);
        } catch { /* already gone — skip */ }
      }
    }
    return { ok: true, removed, error: null };
  } catch (err) {
    if (err.code === "ENOENT") return { ok: true, removed: [], error: null };
    return { ok: false, removed: [], error: err };
  }
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

/**
 * writeJson — backward-compatible convenience wrapper around writeJsonAtomic.
 *
 * All writes go through temp-file + atomic rename.
 * Throws on failure (same contract as before this change).
 */
export async function writeJson(filePath, value) {
  await writeJsonAtomic(filePath, value);
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
