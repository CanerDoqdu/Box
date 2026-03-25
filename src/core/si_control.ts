/**
 * si_control.js — Self-Improvement unified control & live logging.
 *
 * Single source of truth for whether Self-Improvement is active.
 * Checks three layers:
 *   1. config.selfImprovement.enabled             (box.config.json)
 *   2. state/self_improvement_control.json         (manual CLI toggle)
 *   3. FREEZE_SELF_IMPROVEMENT guardrail           (catastrophe detector)
 *
 * Also provides a dedicated live-log file (state/si_live.log) so operators
 * can tail SI activity in real time and the dashboard can display it.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";
import { readJson, writeJson, ensureParent } from "./fs_utils.js";
import { isGuardrailActive } from "./guardrail_executor.js";
import { GUARDRAIL_ACTION } from "./catastrophe_detector.js";

// ── Constants ───────────────────────────────────────────────────────────────

const SI_CONTROL_FILE = "self_improvement_control.json";
const SI_LIVE_LOG_FILE = "si_live.log";
const SI_LIVE_LOG_MAX_BYTES = 512 * 1024; // 512 KB — auto-trim when exceeded

export const SI_STATUS = Object.freeze({
  ACTIVE: "active",
  DISABLED_CONFIG: "disabled_config",
  DISABLED_MANUAL: "disabled_manual",
  DISABLED_GUARDRAIL: "disabled_guardrail",
});

// ── Read / Write control state ──────────────────────────────────────────────

function controlPath(config) {
  const stateDir = config.paths?.stateDir || "state";
  return path.join(stateDir, SI_CONTROL_FILE);
}

function liveLogPath(config) {
  const stateDir = config.paths?.stateDir || "state";
  return path.join(stateDir, SI_LIVE_LOG_FILE);
}

/**
 * Read current SI manual control state.
 * Returns { enabled, reason, updatedAt, updatedBy } or defaults if file missing.
 */
export async function readSiControl(config) {
  const defaults = { enabled: true, reason: "", updatedAt: null, updatedBy: "" };
  const raw = await readJson(controlPath(config), defaults);
  return {
    enabled: raw.enabled !== false,
    reason: String(raw.reason || ""),
    updatedAt: raw.updatedAt || null,
    updatedBy: String(raw.updatedBy || ""),
  };
}

/**
 * Write SI manual control state.
 */
export async function writeSiControl(config, { enabled, reason, updatedBy }) {
  const record = {
    enabled: Boolean(enabled),
    reason: String(reason || ""),
    updatedAt: new Date().toISOString(),
    updatedBy: String(updatedBy || "cli"),
  };
  await writeJson(controlPath(config), record);
  return record;
}

// ── Unified gate ────────────────────────────────────────────────────────────

/**
 * Determine whether Self-Improvement is currently active.
 *
 * Checks three layers with fail-safe priority:
 *   1. config.selfImprovement.enabled === false  → disabled
 *   2. manual control file enabled === false      → disabled
 *   3. FREEZE_SELF_IMPROVEMENT guardrail active   → disabled
 *
 * @param {object} config
 * @returns {Promise<{ active: boolean, status: string, reason: string }>}
 */
export async function isSelfImprovementActive(config) {
  // Layer 1: config file
  if (config.selfImprovement?.enabled === false) {
    return { active: false, status: SI_STATUS.DISABLED_CONFIG, reason: "selfImprovement.enabled=false in config" };
  }

  // Layer 2: manual control (CLI toggle)
  const control = await readSiControl(config);
  if (!control.enabled) {
    return {
      active: false,
      status: SI_STATUS.DISABLED_MANUAL,
      reason: "Manually disabled" + (control.reason ? ": " + control.reason : "") +
              (control.updatedBy ? " (by " + control.updatedBy + ")" : ""),
    };
  }

  // Layer 3: catastrophe guardrail
  const frozen = await isGuardrailActive(config, GUARDRAIL_ACTION.FREEZE_SELF_IMPROVEMENT);
  if (frozen) {
    return { active: false, status: SI_STATUS.DISABLED_GUARDRAIL, reason: "FREEZE_SELF_IMPROVEMENT guardrail active" };
  }

  return { active: true, status: SI_STATUS.ACTIVE, reason: "All gates passed" };
}

// ── Live logging ────────────────────────────────────────────────────────────

function ts() {
  return new Date().toISOString().replace("T", " ").slice(0, 19);
}

/**
 * Append a line to the SI live log (synchronous, best-effort).
 * Format: [YYYY-MM-DD HH:MM:SS] [LEVEL] message
 *
 * @param {object} config
 * @param {"INFO"|"WARN"|"GATE"|"REPAIR"|"HEALTH"|"TOGGLE"} level
 * @param {string} message
 */
export function siLog(config, level, message) {
  try {
    const logFile = liveLogPath(config);
    const line = "[" + ts() + "] [" + String(level).padEnd(6) + "] " + message + "\n";
    appendFileSync(logFile, line, "utf8");
  } catch {
    // best-effort — never crash caller
  }
}

/**
 * Async version that also handles log rotation.
 */
export async function siLogAsync(config, level, message) {
  const logFile = liveLogPath(config);
  await ensureParent(logFile);
  const line = "[" + ts() + "] [" + String(level).padEnd(6) + "] " + message + "\n";
  await fs.appendFile(logFile, line, "utf8");

  // Auto-trim if too large
  try {
    const stat = await fs.stat(logFile);
    if (stat.size > SI_LIVE_LOG_MAX_BYTES) {
      const content = await fs.readFile(logFile, "utf8");
      const lines = content.split("\n");
      const half = Math.floor(lines.length / 2);
      await fs.writeFile(logFile, lines.slice(half).join("\n"), "utf8");
    }
  } catch { /* non-fatal */ }
}

/**
 * Read tail lines from SI live log (for dashboard and debugging).
 *
 * @param {object} config
 * @param {number} [maxLines=50]
 * @returns {Promise<string[]>}
 */
export async function readSiLiveLog(config, maxLines = 50) {
  try {
    const logFile = liveLogPath(config);
    const content = await fs.readFile(logFile, "utf8");
    const lines = content.split("\n").filter(l => l.trim());
    return lines.slice(-maxLines);
  } catch {
    return [];
  }
}
