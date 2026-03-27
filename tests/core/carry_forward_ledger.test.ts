import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import {
  addDebtEntries,
  tickCycle,
  closeDebt,
  getOpenDebts,
  shouldBlockOnDebt,
  computeFingerprint,
  loadLedgerMeta,
  saveLedgerFull,
} from "../../src/core/carry_forward_ledger.js";

describe("carry_forward_ledger", () => {
  describe("addDebtEntries", () => {
    it("adds valid debt entries to empty ledger", () => {
      const result = addDebtEntries([], [
        { followUpTask: "Fix flaky test in worker runner module", workerName: "evolution-worker", severity: "critical" },
      ], 5);
      assert.equal(result.length, 1);
      assert.equal(result[0].lesson, "Fix flaky test in worker runner module");
      assert.equal(result[0].owner, "evolution-worker");
      assert.equal(result[0].openedCycle, 5);
      assert.equal(result[0].dueCycle, 8); // default SLA = 3
      assert.equal(result[0].severity, "critical");
      assert.equal(result[0].closedAt, null);
      // fingerprint is stamped and deterministic
      assert.ok(typeof result[0].fingerprint === "string" && result[0].fingerprint.length === 16);
      assert.equal(result[0].fingerprint, computeFingerprint("Fix flaky test in worker runner module"));
    });

    it("deduplicates by deterministic fingerprint", () => {
      const existing = [{
        id: "debt-1-0",
        lesson: "Fix flaky test",
        fingerprint: computeFingerprint("Fix flaky test"),
        owner: "w",
        openedCycle: 1,
        dueCycle: 4,
        severity: "warning",
        closedAt: null,
        closureEvidence: null,
        cyclesOpen: 0,
      }];
      const result = addDebtEntries(existing, [
        { followUpTask: "Fix flaky test" }, // identical canonical form → same fingerprint
      ], 2);
      assert.equal(result.length, 1); // no duplicate added
    });

    it("deduplicates legacy entries without fingerprint field by computing on-the-fly", () => {
      const existing = [{
        id: "debt-1-0",
        lesson: "Fix flaky test",
        // no fingerprint field — simulates a pre-upgrade ledger entry
        owner: "w",
        openedCycle: 1,
        dueCycle: 4,
        severity: "warning",
        closedAt: null,
        closureEvidence: null,
        cyclesOpen: 0,
      }];
      const result = addDebtEntries(existing, [
        { followUpTask: "Fix flaky test" },
      ], 2);
      assert.equal(result.length, 1);
    });

    it("ignores items with short lesson text", () => {
      const result = addDebtEntries([], [
        { followUpTask: "short" },
      ], 1);
      assert.equal(result.length, 0);
    });

    it("respects custom SLA", () => {
      const result = addDebtEntries([], [
        { followUpTask: "A sufficiently long lesson text for testing", severity: "warning" },
      ], 10, { slaMaxCycles: 5 });
      assert.equal(result[0].dueCycle, 15);
    });
  });

  describe("tickCycle", () => {
    it("increments cyclesOpen and detects overdue", () => {
      const ledger = [{
        id: "debt-1-0",
        lesson: "Old unresolved lesson",
        owner: "w",
        openedCycle: 1,
        dueCycle: 3,
        severity: "critical",
        closedAt: null,
        closureEvidence: null,
        cyclesOpen: 0,
      }];
      const { overdue } = tickCycle(ledger, 5);
      assert.equal(ledger[0].cyclesOpen, 4);
      assert.equal(overdue.length, 1);
    });

    it("skips closed entries", () => {
      const ledger = [{
        id: "debt-1-0",
        lesson: "Closed lesson",
        owner: "w",
        openedCycle: 1,
        dueCycle: 3,
        severity: "critical",
        closedAt: "2025-01-01T00:00:00Z",
        closureEvidence: "fixed",
        cyclesOpen: 0,
      }];
      const { overdue } = tickCycle(ledger, 5);
      assert.equal(overdue.length, 0);
      assert.equal(ledger[0].cyclesOpen, 0); // unchanged
    });
  });

  describe("closeDebt", () => {
    it("closes an open entry", () => {
      const ledger = [{
        id: "debt-1-0",
        lesson: "Lesson",
        owner: "w",
        openedCycle: 1,
        dueCycle: 4,
        severity: "warning",
        closedAt: null,
        closureEvidence: null,
        cyclesOpen: 2,
      }];
      const result = closeDebt(ledger, "debt-1-0", "PR #123 merged");
      assert.equal(result, true);
      assert.ok(ledger[0].closedAt);
      assert.equal(ledger[0].closureEvidence, "PR #123 merged");
    });

    it("returns false for unknown id", () => {
      assert.equal(closeDebt([], "nonexistent", "evidence"), false);
    });

    it("returns false for already-closed entry", () => {
      const ledger = [{
        id: "debt-1-0",
        lesson: "Lesson",
        owner: "w",
        openedCycle: 1,
        dueCycle: 4,
        severity: "warning",
        closedAt: "2025-01-01",
        closureEvidence: "fixed",
        cyclesOpen: 0,
      }];
      assert.equal(closeDebt(ledger, "debt-1-0", "new evidence"), false);
    });
  });

  describe("getOpenDebts", () => {
    it("returns only unclosed entries", () => {
      const ledger = [
        { id: "d1", closedAt: null },
        { id: "d2", closedAt: "2025-01-01" },
        { id: "d3", closedAt: null },
      ];
      const open = getOpenDebts(ledger);
      assert.equal(open.length, 2);
      assert.deepEqual(open.map(e => e.id), ["d1", "d3"]);
    });
  });

  describe("shouldBlockOnDebt", () => {
    it("blocks when critical overdue count exceeds threshold", () => {
      const ledger = [
        { id: "d1", lesson: "A", openedCycle: 1, dueCycle: 2, severity: "critical", closedAt: null, cyclesOpen: 0 },
        { id: "d2", lesson: "B", openedCycle: 1, dueCycle: 2, severity: "critical", closedAt: null, cyclesOpen: 0 },
        { id: "d3", lesson: "C", openedCycle: 1, dueCycle: 2, severity: "critical", closedAt: null, cyclesOpen: 0 },
      ];
      const result = shouldBlockOnDebt(ledger, 10, { maxCriticalOverdue: 3 });
      assert.equal(result.shouldBlock, true);
      assert.equal(result.overdueCount, 3);
    });

    it("does not block when under threshold", () => {
      const ledger = [
        { id: "d1", lesson: "A", openedCycle: 1, dueCycle: 2, severity: "critical", closedAt: null, cyclesOpen: 0 },
        { id: "d2", lesson: "B", openedCycle: 1, dueCycle: 2, severity: "warning", closedAt: null, cyclesOpen: 0 },
      ];
      const result = shouldBlockOnDebt(ledger, 10, { maxCriticalOverdue: 3 });
      assert.equal(result.shouldBlock, false);
    });

    it("does not block with empty ledger", () => {
      const result = shouldBlockOnDebt([], 10);
      assert.equal(result.shouldBlock, false);
      assert.equal(result.overdueCount, 0);
    });
  });

  describe("computeFingerprint", () => {
    it("returns a 16-character hex string", () => {
      const fp = computeFingerprint("Fix the validation harness in worker runner");
      assert.ok(typeof fp === "string");
      assert.equal(fp.length, 16);
      assert.match(fp, /^[0-9a-f]{16}$/);
    });

    it("is deterministic — same input always produces same fingerprint", () => {
      const text = "Upgrade evaluation stack to reduce flakiness";
      assert.equal(computeFingerprint(text), computeFingerprint(text));
    });

    it("strips boilerplate before hashing — noise-equivalent texts share a fingerprint", () => {
      const withNoise = "Create and complete a task to fix the verification harness";
      const canonical = "fix the verification harness";
      assert.equal(computeFingerprint(withNoise), computeFingerprint(canonical));
    });

    it("distinguishes semantically different texts", () => {
      assert.notEqual(
        computeFingerprint("Fix flaky test in worker runner"),
        computeFingerprint("Add circuit breaker for model calls")
      );
    });

    it("returns null for text that is too short after canonicalization", () => {
      assert.equal(computeFingerprint(""), null);
      assert.equal(computeFingerprint("  "), null);
    });
  });
});

// ── loadLedgerMeta / saveLedgerFull — persistence layer ──────────────────────

describe("loadLedgerMeta / saveLedgerFull", () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-cfl-meta-"));
  });

  after(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function cfg() {
    return { paths: { stateDir: tmpDir } };
  }

  it("defaults cycleCounter to 1 when ledger file does not exist", async () => {
    const { entries, cycleCounter } = await loadLedgerMeta(cfg());
    assert.deepEqual(entries, []);
    assert.equal(cycleCounter, 1);
  });

  it("saveLedgerFull persists entries and cycleCounter; loadLedgerMeta reads them back", async () => {
    const entry = {
      id: "debt-1-0",
      lesson: "Fix the validation harness",
      fingerprint: computeFingerprint("Fix the validation harness"),
      owner: "evolution-worker",
      openedCycle: 1,
      dueCycle: 4,
      severity: "critical",
      closedAt: null,
      closureEvidence: null,
      cyclesOpen: 0,
    };
    await saveLedgerFull(cfg(), [entry], 7);

    const { entries, cycleCounter } = await loadLedgerMeta(cfg());
    assert.equal(entries.length, 1);
    assert.equal(entries[0].id, "debt-1-0");
    assert.equal(cycleCounter, 7);
  });

  it("loadLedgerMeta falls back to cycleCounter=1 when field is missing from file", async () => {
    const filePath = path.join(tmpDir, "carry_forward_ledger.json");
    await fs.writeFile(filePath, JSON.stringify({ entries: [] }), "utf8");

    const { cycleCounter } = await loadLedgerMeta(cfg());
    assert.equal(cycleCounter, 1);
  });

  it("loadLedgerMeta falls back to cycleCounter=1 when field is zero or negative", async () => {
    const filePath = path.join(tmpDir, "carry_forward_ledger.json");
    await fs.writeFile(filePath, JSON.stringify({ entries: [], cycleCounter: 0 }), "utf8");

    const { cycleCounter } = await loadLedgerMeta(cfg());
    assert.equal(cycleCounter, 1);
  });
});
