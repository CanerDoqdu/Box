/**
 * carry_forward_ledger.js — Carry-forward debt tracking (Packet 11)
 *
 * Tracks unresolved postmortem lessons as debt items with owner,
 * due-cycle, and closure evidence. Integrates with Athena plan gates
 * to block acceptance when critical debt exceeds SLA.
 */

import path from "node:path";
import { createHash } from "node:crypto";
import { readJson, writeJson } from "./fs_utils.js";

/**
 * @typedef {object} DebtEntry
 * @property {string} id — unique debt ID
 * @property {string} lesson — the original lesson text
 * @property {string} fingerprint — deterministic SHA-256 fingerprint of the canonical lesson text
 * @property {string} owner — who should fix this
 * @property {number} openedCycle — cycle number when first detected
 * @property {number} dueCycle — cycle number by which it must be closed
 * @property {string} severity — "critical" | "warning"
 * @property {string|null} closedAt — ISO timestamp when closed, null if open
 * @property {string|null} closureEvidence — evidence that it was fixed
 * @property {number} cyclesOpen — how many cycles this has been open
 */

/**
 * Canonical form used for fingerprinting — strips prompt boilerplate phrases
 * so that semantically identical lessons produce the same fingerprint regardless
 * of preamble wording. Mirrors the normalisation in prometheus.ts.
 */
function canonicalize(text: string): string {
  const s = String(text || "").toLowerCase();
  return s
    .replace(/[`'"(){}]|\[|\]/g, " ")
    .replace(/create\s+and\s+complete\s+a\s+task\s+to\s+/g, "")
    .replace(/create\s+a\s+dedicated\s+task\s+to\s+/g, "")
    .replace(/this\s+is\s+now\s+a\s+gate\s*-?\s*blocking\s+item[^.]*\.?/g, "")
    .replace(/athena\s+must\s+(block|reject)[^.]*\.?/g, "")
    .replace(/this\s+fix\s+must\s+ship[^.]*\.?/g, "")
    .replace(/blocking\s+defect[^:]*:\s*/g, "")
    .replace(/\b(five|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen)\s+consecutive\s+postmortem\s+audit\s+records\b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Compute a deterministic 16-hex-char SHA-256 fingerprint of a lesson/task text.
 * The fingerprint is based on the canonical form so that the same semantic content
 * always maps to the same fingerprint regardless of boilerplate preamble.
 * Returns null if the canonical text is too short to be meaningful.
 *
 * @param {string} text
 * @returns {string|null}
 */
export function computeFingerprint(text: string): string | null {
  const canonical = canonicalize(text);
  if (canonical.length < 5) return null;
  return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

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
 * Load the carry-forward ledger and its cycle counter from state.
 * The cycleCounter is a persistent integer that is incremented once per
 * orchestration cycle so that debt SLA deadlines stay anchored to a
 * monotonic sequence that is independent of wall-clock timestamps.
 *
 * @param {object} config
 * @returns {Promise<{ entries: DebtEntry[], cycleCounter: number }>}
 */
export async function loadLedgerMeta(config): Promise<{ entries: any[], cycleCounter: number }> {
  const stateDir = config?.paths?.stateDir || "state";
  const data = await readJson(path.join(stateDir, LEDGER_FILE), { entries: [], cycleCounter: 1 });
  const entries = Array.isArray(data.entries) ? data.entries : [];
  const cycleCounter = typeof data.cycleCounter === "number" && data.cycleCounter > 0
    ? data.cycleCounter
    : 1;
  return { entries, cycleCounter };
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
 * Save the ledger with an explicit cycle counter.
 * Use this when advancing the cycle (end-of-cycle accumulation path).
 *
 * @param {object} config
 * @param {DebtEntry[]} entries
 * @param {number} cycleCounter
 */
export async function saveLedgerFull(config, entries, cycleCounter: number) {
  const stateDir = config?.paths?.stateDir || "state";
  await writeJson(path.join(stateDir, LEDGER_FILE), {
    entries,
    cycleCounter,
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
  // Deduplicate by fingerprint; fall back to computing from lesson text for legacy
  // entries that pre-date this field.
  const openFingerprints = new Set(
    existing
      .filter(e => !e.closedAt)
      .map(e => e.fingerprint || computeFingerprint(String(e.lesson || "")))
      .filter(Boolean)
  );

  for (const item of (newItems || [])) {
    const lesson = String(item.followUpTask || "").trim();
    if (!lesson || lesson.length < 10) continue;
    const fingerprint = computeFingerprint(lesson);
    if (!fingerprint) continue;
    if (openFingerprints.has(fingerprint)) continue;

    existing.push({
      id: `debt-${currentCycle}-${existing.length}`,
      lesson,
      fingerprint,
      owner: item.workerName || "evolution-worker",
      openedCycle: currentCycle,
      dueCycle: currentCycle + sla,
      severity: item.severity || "warning",
      closedAt: null,
      closureEvidence: null,
      cyclesOpen: 0,
    });
    openFingerprints.add(fingerprint);
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


