/**
 * evidence_envelope.test.ts
 *
 * Unit tests for validateEvidenceEnvelope — the hard admission control that
 * blocks malformed envelopes from reaching Athena's postmortem logic.
 *
 * Covers:
 *   - Valid envelope passes
 *   - Missing required fields fail
 *   - Invalid verificationEvidence slot values fail
 *   - Null / non-object input fails
 *   - Negative path: partial envelope (only some required fields)
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { validateEvidenceEnvelope, validatePlanEvidenceCoupling } from "../../src/core/evidence_envelope.js";

const VALID_EVIDENCE = { build: "pass", tests: "pass", lint: "n/a" };

function validEnvelope() {
  return {
    roleName: "evolution-worker",
    status: "done",
    summary: "Task completed successfully.",
    verificationEvidence: { build: "pass", tests: "pass", lint: "n/a" },
  };
}

describe("validateEvidenceEnvelope", () => {
  it("accepts a fully valid envelope", () => {
    const result = validateEvidenceEnvelope(validEnvelope());
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it("accepts envelope with all optional fields present", () => {
    const envelope = {
      ...validEnvelope(),
      prUrl: "https://github.com/owner/repo/pull/1",
      filesTouched: ["src/core/foo.ts"],
      verificationOutput: "Tests passed",
      verificationPassed: true,
      prChecks: { ok: true, passed: true, failed: [], pending: [], total: 3 },
      preReviewAssessment: "Looks good",
      preReviewIssues: [],
    };
    const result = validateEvidenceEnvelope(envelope);
    assert.equal(result.valid, true);
  });

  it("rejects null", () => {
    const result = validateEvidenceEnvelope(null);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it("rejects non-object (string)", () => {
    const result = validateEvidenceEnvelope("bad");
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it("rejects missing roleName", () => {
    const { roleName: _, ...envelope } = validEnvelope();
    const result = validateEvidenceEnvelope(envelope);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("roleName")));
  });

  it("rejects empty roleName", () => {
    const result = validateEvidenceEnvelope({ ...validEnvelope(), roleName: "  " });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("roleName")));
  });

  it("rejects missing status", () => {
    const { status: _, ...envelope } = validEnvelope();
    const result = validateEvidenceEnvelope(envelope);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("status")));
  });

  it("rejects missing summary", () => {
    const { summary: _, ...envelope } = validEnvelope();
    const result = validateEvidenceEnvelope(envelope);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("summary")));
  });

  it("rejects missing verificationEvidence", () => {
    const { verificationEvidence: _, ...envelope } = validEnvelope();
    const result = validateEvidenceEnvelope(envelope);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("verificationEvidence")));
  });

  it("rejects verificationEvidence with invalid build slot", () => {
    const result = validateEvidenceEnvelope({
      ...validEnvelope(),
      verificationEvidence: { build: "unknown", tests: "pass", lint: "n/a" },
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("verificationEvidence.build")));
  });

  it("rejects verificationEvidence with invalid tests slot", () => {
    const result = validateEvidenceEnvelope({
      ...validEnvelope(),
      verificationEvidence: { build: "pass", tests: null, lint: "n/a" },
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("verificationEvidence.tests")));
  });

  it("rejects verificationEvidence with invalid lint slot", () => {
    const result = validateEvidenceEnvelope({
      ...validEnvelope(),
      verificationEvidence: { build: "pass", tests: "fail", lint: "bad" },
    });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("verificationEvidence.lint")));
  });

  it("collects all errors when multiple fields are invalid", () => {
    const result = validateEvidenceEnvelope({
      roleName: "",
      status: "",
      summary: "",
      verificationEvidence: { build: "bad", tests: "bad", lint: "bad" },
    });
    assert.equal(result.valid, false);
    // roleName, status, summary, + 3 evidence slot errors = at least 6
    assert.ok(result.errors.length >= 6, `expected ≥6 errors, got ${result.errors.length}`);
  });

  it("negative path: envelope with only roleName is invalid", () => {
    const result = validateEvidenceEnvelope({ roleName: "worker" });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("status")));
    assert.ok(result.errors.some(e => e.includes("summary")));
  });

  it("accepts all valid slot combinations", () => {
    const slots = ["pass", "fail", "n/a"] as const;
    for (const b of slots) {
      for (const t of slots) {
        for (const l of slots) {
          const result = validateEvidenceEnvelope({
            ...validEnvelope(),
            verificationEvidence: { build: b, tests: t, lint: l },
          });
          assert.equal(result.valid, true, `expected valid for build=${b} tests=${t} lint=${l}`);
        }
      }
    }
  });
});

// ── Task 3 hardening: validatePlanEvidenceCoupling — pre-dispatch plan gate ───

describe("validatePlanEvidenceCoupling — plan evidence coupling validation", () => {
  function validPlan(overrides: Record<string, unknown> = {}) {
    return {
      task_id: "T-001",
      task: "Implement trust boundary check",
      verification_commands: ["npm test"],
      acceptance_criteria: ["All tests pass"],
      ...overrides,
    };
  }

  it("accepts a fully valid plan with commands and criteria", () => {
    const result = validatePlanEvidenceCoupling(validPlan());
    assert.equal(result.valid, true);
    assert.deepEqual(result.errors, []);
  });

  it("accepts a plan with acceptance_criteria as a string", () => {
    const result = validatePlanEvidenceCoupling(validPlan({ acceptance_criteria: "All tests must pass" }));
    assert.equal(result.valid, true);
  });

  it("accepts a plan with acceptance_criteria as a multi-element array", () => {
    const result = validatePlanEvidenceCoupling(validPlan({
      acceptance_criteria: ["No regressions", "Test coverage ≥ 80%"]
    }));
    assert.equal(result.valid, true);
  });

  it("rejects null input", () => {
    const result = validatePlanEvidenceCoupling(null);
    assert.equal(result.valid, false);
    assert.ok(result.errors.length > 0);
  });

  it("rejects non-object input", () => {
    const result = validatePlanEvidenceCoupling("not a plan");
    assert.equal(result.valid, false);
  });

  it("rejects plan with missing verification_commands", () => {
    const { verification_commands: _, ...plan } = validPlan();
    const result = validatePlanEvidenceCoupling(plan);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("verification_commands")));
  });

  it("rejects plan with empty verification_commands array", () => {
    const result = validatePlanEvidenceCoupling(validPlan({ verification_commands: [] }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("verification_commands")));
  });

  it("rejects plan with only empty-string verification_commands", () => {
    const result = validatePlanEvidenceCoupling(validPlan({ verification_commands: ["", "  "] }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("verification_commands")));
  });

  it("rejects plan with missing acceptance_criteria", () => {
    const { acceptance_criteria: _, ...plan } = validPlan();
    const result = validatePlanEvidenceCoupling(plan);
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("acceptance_criteria")));
  });

  it("rejects plan with empty acceptance_criteria string", () => {
    const result = validatePlanEvidenceCoupling(validPlan({ acceptance_criteria: "   " }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("acceptance_criteria")));
  });

  it("rejects plan with empty acceptance_criteria array", () => {
    const result = validatePlanEvidenceCoupling(validPlan({ acceptance_criteria: [] }));
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("acceptance_criteria")));
  });

  it("collects all errors when both required fields are missing", () => {
    const result = validatePlanEvidenceCoupling({ task: "do something" });
    assert.equal(result.valid, false);
    assert.ok(result.errors.some(e => e.includes("verification_commands")));
    assert.ok(result.errors.some(e => e.includes("acceptance_criteria")));
    assert.equal(result.errors.length, 2);
  });

  it("negative path: plan without any evidence fields is invalid", () => {
    const result = validatePlanEvidenceCoupling({ task: "do something", wave: 1 });
    assert.equal(result.valid, false);
    assert.equal(result.errors.length, 2, "both coupling fields must be reported missing");
  });
});

// ── Athena consumption boundary: runAthenaPostmortem rejects invalid envelopes ─

import { runAthenaPostmortem } from "../../src/core/athena_reviewer.js";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

function makeConfig(tmpDir: string) {
  return {
    paths: { stateDir: tmpDir, progressFile: path.join(tmpDir, "progress.txt") },
    env: { copilotCliCommand: "__missing_copilot_binary__", targetRepo: "CanerDoqdu/Box" },
    roleRegistry: {
      qualityReviewer: { name: "Athena", model: "Claude Sonnet 4.6" }
    },
    runtime: {},
  };
}

function validEnvelopeForAthena() {
  return {
    roleName: "evolution-worker",
    status: "done",
    summary: "All changes implemented and tests pass.",
    verificationEvidence: { build: "pass", tests: "pass", lint: "n/a" },
    verificationPassed: true,
  };
}

describe("runAthenaPostmortem — Athena consumption boundary validation", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-athena-boundary-"));
    await fs.writeFile(path.join(tmpDir, "policy.json"), JSON.stringify({ blockedCommands: [] }), "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("throws when the envelope is missing required fields (no roleName)", async () => {
    const config = makeConfig(tmpDir);
    const invalidEnvelope = {
      status: "done",
      summary: "Task completed.",
      verificationEvidence: { build: "pass", tests: "pass", lint: "n/a" },
    };
    await assert.rejects(
      () => runAthenaPostmortem(config, invalidEnvelope as any, {}),
      (err: Error) => {
        assert.ok(err.message.includes("[ATHENA] Evidence envelope invalid"), `unexpected message: ${err.message}`);
        assert.ok(err.message.includes("roleName"), `expected roleName error, got: ${err.message}`);
        return true;
      }
    );
  });

  it("throws when verificationEvidence has invalid slot values", async () => {
    const config = makeConfig(tmpDir);
    const invalidEnvelope = {
      roleName: "evolution-worker",
      status: "done",
      summary: "Task completed.",
      verificationEvidence: { build: "yes", tests: "no", lint: "n/a" },
    };
    await assert.rejects(
      () => runAthenaPostmortem(config, invalidEnvelope as any, {}),
      (err: Error) => {
        assert.ok(err.message.includes("[ATHENA] Evidence envelope invalid"), `unexpected message: ${err.message}`);
        return true;
      }
    );
  });

  it("throws when summary is empty", async () => {
    const config = makeConfig(tmpDir);
    const invalidEnvelope = {
      roleName: "evolution-worker",
      status: "done",
      summary: "   ",
      verificationEvidence: { build: "pass", tests: "pass", lint: "n/a" },
    };
    await assert.rejects(
      () => runAthenaPostmortem(config, invalidEnvelope as any, {}),
      (err: Error) => {
        assert.ok(err.message.includes("[ATHENA] Evidence envelope invalid"), `unexpected message: ${err.message}`);
        assert.ok(err.message.includes("summary"), `expected summary error, got: ${err.message}`);
        return true;
      }
    );
  });

  it("negative path: null envelope throws with evidence envelope error", async () => {
    const config = makeConfig(tmpDir);
    await assert.rejects(
      () => runAthenaPostmortem(config, null as any, {}),
      (err: Error) => {
        assert.ok(err.message.includes("[ATHENA] Evidence envelope invalid"), `unexpected message: ${err.message}`);
        return true;
      }
    );
  });

  it("does not throw envelope error for a structurally valid envelope (AI failure is expected)", async () => {
    const config = makeConfig(tmpDir);
    // The AI call will fail (missing binary), but the envelope is valid — so we should NOT get
    // an envelope validation error. Any other error (AI failure) is acceptable here.
    try {
      await runAthenaPostmortem(config, validEnvelopeForAthena() as any, {
        task: "T-001",
        verification: "npm test",
        context: "test"
      });
      // If it returns (e.g., deterministic fast-path), that's fine too.
    } catch (err: any) {
      // Must NOT be an envelope validation error
      assert.ok(
        !err.message.includes("[ATHENA] Evidence envelope invalid"),
        `valid envelope must not trigger validation error; got: ${err.message}`
      );
    }
  });
});

