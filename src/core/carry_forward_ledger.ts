/**
 * carry_forward_ledger.js — Carry-forward debt tracking (Packet 11)
 *
 * Tracks unresolved postmortem lessons as debt items with owner,
 * due-cycle, and closure evidence. Integrates with Athena plan gates
 * to block acceptance when critical debt exceeds SLA.
 */

import path from "node:path";
import { readJson, writeJson } from "./fs_utils.js";

/**
 * @typedef {object} DebtEntry
 * @property {string} id — unique debt ID
 * @property {string} lesson — the original lesson text
 * @property {string} owner — who should fix this
 * @property {number} openedCycle — cycle number when first detected
 * @property {number} dueCycle — cycle number by which it must be closed
 * @property {string} severity — "critical" | "warning"
 * @property {string|null} closedAt — ISO timestamp when closed, null if open
 * @property {string|null} closureEvidence — evidence that it was fixed
 * @property {number} cyclesOpen — how many cycles this has been open
 */

const LEDGER_FILE = "carry_forward_ledger.json";

/**
 * Load the carry-forward ledger from state.
 *
 * @param {object} config
 * @returns {Promise<DebtEntry[]>}
 */
export async function loadLedger(config) {
  const stateDir = config?.paths?.stateDir || "state";
  const data = await readJson(path.join(stateDir, LEDGER_FILE), { entries: [] });
  return Array.isArray(data.entries) ? data.entries : [];
}

/**
 * Save the ledger to state.
 *
 * @param {object} config
 * @param {DebtEntry[]} entries
 */
export async function saveLedger(config, entries) {
  const stateDir = config?.paths?.stateDir || "state";
  await writeJson(path.join(stateDir, LEDGER_FILE), {
    entries,
    updatedAt: new Date().toISOString(),
  });
}

/**
 * Add new debt entries from postmortem follow-ups.
 * Deduplicates by normalized lesson text.
 *
 * @param {DebtEntry[]} ledger — existing entries
 * @param {Array<{ followUpTask: string, workerName?: string, severity?: string }>} newItems
 * @param {number} currentCycle
 * @param {{ slaMaxCycles?: number }} opts
 * @returns {DebtEntry[]} — updated ledger
 */
export function addDebtEntries(ledger, newItems, currentCycle, opts: any = {}) {
  const sla = opts.slaMaxCycles || 3;
  const existing = [...ledger];
  const openKeys = new Set(
    existing.filter(e => !e.closedAt).map(e => normalizeKey(e.lesson))
  );

  for (const item of (newItems || [])) {
    const lesson = String(item.followUpTask || "").trim();
    if (!lesson || lesson.length < 10) continue;
    const key = normalizeKey(lesson);
    if (openKeys.has(key)) continue;

    existing.push({
      id: `debt-${currentCycle}-${existing.length}`,
      lesson,
      owner: item.workerName || "evolution-worker",
      openedCycle: currentCycle,
      dueCycle: currentCycle + sla,
      severity: item.severity || "warning",
      closedAt: null,
      closureEvidence: null,
      cyclesOpen: 0,
    });
    openKeys.add(key);
  }

  return existing;
}

/**
 * Increment cycle counters for open entries and flag overdue items.
 *
 * @param {DebtEntry[]} ledger
 * @param {number} currentCycle
 * @returns {{ ledger: DebtEntry[], overdue: DebtEntry[] }}
 */
export function tickCycle(ledger, currentCycle) {
  const overdue = [];
  for (const entry of ledger) {
    if (entry.closedAt) continue;
    entry.cyclesOpen = currentCycle - entry.openedCycle;
    if (currentCycle > entry.dueCycle) {
      overdue.push(entry);
    }
  }
  return { ledger, overdue };
}

/**
 * Close a debt entry with evidence.
 *
 * @param {DebtEntry[]} ledger
 * @param {string} debtId
 * @param {string} evidence
 * @returns {boolean} — true if found and closed
 */
export function closeDebt(ledger, debtId, evidence) {
  const entry = ledger.find(e => e.id === debtId);
  if (!entry || entry.closedAt) return false;
  entry.closedAt = new Date().toISOString();
  entry.closureEvidence = evidence;
  return true;
}

/**
 * Get all open (unclosed) debt entries.
 *
 * @param {DebtEntry[]} ledger
 * @returns {DebtEntry[]}
 */
export function getOpenDebts(ledger) {
  return ledger.filter(e => !e.closedAt);
}

/**
 * Check if critical overdue debt should block plan acceptance.
 *
 * @param {DebtEntry[]} ledger
 * @param {number} currentCycle
 * @param {{ maxCriticalOverdue?: number }} opts
 * @returns {{ shouldBlock: boolean, reason: string, overdueCount: number }}
 */
export function shouldBlockOnDebt(ledger, currentCycle, opts: any = {}) {
  const maxCritical = opts.maxCriticalOverdue ?? 3;
  const { overdue } = tickCycle(ledger, currentCycle);
  const criticalOverdue = overdue.filter(e => e.severity === "critical");

  if (criticalOverdue.length >= maxCritical) {
    return {
      shouldBlock: true,
      reason: `${criticalOverdue.length} critical debt items overdue (limit: ${maxCritical})`,
      overdueCount: criticalOverdue.length,
    };
  }
  return { shouldBlock: false, reason: "", overdueCount: criticalOverdue.length };
}

function normalizeKey(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 100);
}
