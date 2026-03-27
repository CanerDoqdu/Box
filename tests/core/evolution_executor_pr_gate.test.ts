import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  assessStatusCheckRollup,
  injectAthenaMissingItems,
  hardenTaskForAthena,
  repairPrometheusTask,
  shouldHaltOnPreReviewReject,
  shouldRetryAthenaPreReview,
  checkScopeConformance,
  buildVerificationTargets,
} from "../../src/core/evolution_executor.js";

describe("assessStatusCheckRollup", () => {
  it("passes when all checks are successful", () => {
    const result = assessStatusCheckRollup([
      { name: "CI", status: "COMPLETED", conclusion: "SUCCESS" },
      { name: "Security", status: "COMPLETED", conclusion: "NEUTRAL" }
    ]);

    assert.equal(result.passed, true);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.pending, []);
  });

  it("fails when at least one check fails", () => {
    const result = assessStatusCheckRollup([
      { name: "CI", status: "COMPLETED", conclusion: "FAILURE" },
      { name: "Security", status: "COMPLETED", conclusion: "SUCCESS" }
    ]);

    assert.equal(result.passed, false);
    assert.deepEqual(result.failed, ["CI"]);
    assert.deepEqual(result.pending, []);
  });

  it("treats non-completed checks as pending", () => {
    const result = assessStatusCheckRollup([
      { name: "CI", status: "IN_PROGRESS", conclusion: null },
      { name: "Security", status: "COMPLETED", conclusion: "SUCCESS" }
    ]);

    assert.equal(result.passed, false);
    assert.deepEqual(result.failed, []);
    assert.deepEqual(result.pending, ["CI"]);
  });
});

describe("Athena pre-review hardening", () => {
  it("retries when Athena rejection indicates measurability/schema ambiguity", () => {
    const retry = shouldRetryAthenaPreReview({
      reason: "Acceptance criteria are not measurable and schema is undefined",
      issues: ["Missing deterministic enum for output status"]
    });

    assert.equal(retry, true);
  });

  it("does not retry for non-quality operational rejections", () => {
    const retry = shouldRetryAthenaPreReview({
      reason: "Repository write permissions are missing for protected path",
      issues: ["External approval required"]
    });

    assert.equal(retry, false);
  });

  it("appends deterministic hardening criteria and safe verification commands", () => {
    const task = {
      task_id: "T-099",
      title: "Test task",
      scope: "Update state serialization",
      acceptance_criteria: ["Existing criterion"],
      verification_commands: ["node --import tsx src/cli.ts once"]
    };

    const hardened = hardenTaskForAthena(task, {
      reason: "Criteria are untestable",
      issues: ["Missing schema"]
    });

    assert.ok(hardened.acceptance_criteria.length > task.acceptance_criteria.length);
    assert.ok(hardened.acceptance_criteria.some(c => c.includes("deterministic pass/fail evidence")));
    assert.ok(hardened.scope.includes("Athena hardening notes"));
    assert.deepEqual(hardened.verification_commands, ["node --import tsx src/cli.ts once", "npm test", "npm run lint"]);
  });
});

describe("Athena pre-review halt policy", () => {
  it("continues by default when pre-review is rejected", () => {
    assert.equal(shouldHaltOnPreReviewReject({ runtime: {} }), false);
    assert.equal(shouldHaltOnPreReviewReject({}), false);
  });

  it("halts only when explicitly enabled", () => {
    assert.equal(
      shouldHaltOnPreReviewReject({ runtime: { evolutionStopOnPreReviewReject: true } }),
      true
    );
  });
});

describe("Prometheus task repair", () => {
  it("repairs missing critical fields with deterministic defaults", () => {
    const repaired = repairPrometheusTask({
      task_id: "T-777",
      title: "",
      scope: "",
      acceptance_criteria: [],
      verification_commands: []
    });

    assert.equal(repaired.title, "T-777");
    assert.ok(repaired.scope.length > 0);
    assert.ok(repaired.acceptance_criteria.length >= 3);
    assert.ok(repaired.verification_commands.length > 0);
  });

  it("normalizes non-string entries and keeps commands runnable", () => {
    const repaired = repairPrometheusTask({
      task_id: "T-778",
      title: "task",
      scope: "scope",
      acceptance_criteria: ["criterion", null, 42],
      verification_commands: ["npm test", "", null]
    });

    assert.ok(repaired.acceptance_criteria.includes("criterion"));
    assert.ok(repaired.acceptance_criteria.includes("42"));
    assert.deepEqual(repaired.verification_commands, ["npm test"]);
  });
});

describe("Athena missing-item injection", () => {
  it("adds Athena issues into task scope and acceptance criteria", () => {
    const task = {
      task_id: "T-900",
      title: "Example",
      scope: "Base scope",
      acceptance_criteria: ["Existing criterion"],
      verification_commands: ["npm test"]
    };

    const updated = injectAthenaMissingItems(task, {
      reason: "reject",
      issues: ["Define outcome object schema", "Define reason code enum"]
    });

    assert.ok(updated.scope.includes("Athena missing items"));
    assert.ok(updated.scope.includes("Define outcome object schema"));
    assert.ok(updated.acceptance_criteria.some(c => c.includes("Athena missing item resolved")));
    assert.ok(updated.verification_commands.includes("npm run lint"));
  });

  it("falls back to reason text when issue list is missing", () => {
    const task = {
      task_id: "T-901",
      title: "Example",
      scope: "Base",
      acceptance_criteria: ["A"],
      verification_commands: ["npm test"]
    };

    const updated = injectAthenaMissingItems(task, {
      reason: "Need deterministic degraded state definition",
      issues: []
    });

    assert.ok(updated.scope.includes("Need deterministic degraded state definition"));
    assert.ok(updated.acceptance_criteria.some(c => c.includes("Need deterministic degraded state definition")));
  });
});

// ── Scope Conformance Gate (Task 7) ───────────────────────────────────────────

describe("checkScopeConformance", () => {
  it("passes when all touched files are within declared scope", () => {
    const result = checkScopeConformance(
      ["src/core/foo.ts", "tests/core/foo.test.ts"],
      ["src/core/foo.ts", "tests/core/foo.test.ts"]
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.unrelatedFiles, []);
    assert.equal(result.recoveryInstruction, "");
  });

  it("passes when touched file is under a declared directory prefix", () => {
    const result = checkScopeConformance(
      ["src/core/orchestrator.ts", "src/core/policy_engine.ts"],
      ["src/core/"]
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.unrelatedFiles, []);
  });

  it("blocks when an unrelated file is touched", () => {
    const result = checkScopeConformance(
      ["src/core/foo.ts", "src/dashboard/live_dashboard.ts"],
      ["src/core/foo.ts"]
    );
    assert.equal(result.ok, false);
    assert.ok(result.unrelatedFiles.includes("src/dashboard/live_dashboard.ts"));
    assert.ok(result.recoveryInstruction.includes("SCOPE VIOLATION"));
    assert.ok(result.recoveryInstruction.includes("git checkout"));
  });

  it("passes when no files_hint declared (cannot enforce without scope)", () => {
    const result = checkScopeConformance(
      ["src/core/foo.ts", "src/core/bar.ts"],
      []
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.unrelatedFiles, []);
  });

  it("passes when no files are touched", () => {
    const result = checkScopeConformance([], ["src/core/foo.ts"]);
    assert.equal(result.ok, true);
  });

  it("recovery instruction names all unrelated files", () => {
    const result = checkScopeConformance(
      ["src/core/foo.ts", "scripts/deploy.sh", "docker/Dockerfile"],
      ["src/core/foo.ts"]
    );
    assert.equal(result.ok, false);
    assert.equal(result.unrelatedFiles.length, 2);
    assert.ok(result.recoveryInstruction.includes("scripts/deploy.sh"));
    assert.ok(result.recoveryInstruction.includes("docker/Dockerfile"));
  });

  it("handles Windows-style backslash paths in filesTouched", () => {
    const result = checkScopeConformance(
      ["src\\core\\foo.ts"],
      ["src/core/foo.ts"]
    );
    assert.equal(result.ok, true, "backslash paths must be normalized for comparison");
  });

  it("negative: multiple unrelated files all appear in recoveryInstruction", () => {
    const result = checkScopeConformance(
      ["src/core/foo.ts", "README.md", "package.json", ".env"],
      ["src/core/foo.ts"]
    );
    assert.equal(result.ok, false);
    assert.equal(result.unrelatedFiles.length, 3);
    for (const f of result.unrelatedFiles) {
      assert.ok(result.recoveryInstruction.includes(f), `recoveryInstruction must mention ${f}`);
    }
  });
});

// ── buildVerificationTargets — explicit verification evidence ─────────────────

describe("buildVerificationTargets", () => {
  it("maps each requested command to a target with cmd, passed, blocked fields", () => {
    const targets = buildVerificationTargets(
      ["npm test", "npm run lint"],
      [{ cmd: "npm test", passed: true }, { cmd: "npm run lint", passed: true }],
      []
    );
    assert.equal(targets.length, 2);
    for (const t of targets) {
      assert.ok("cmd" in t);
      assert.ok("passed" in t);
      assert.ok("blocked" in t);
    }
  });

  it("marks non-blocked commands as executed with their actual pass/fail result", () => {
    const targets = buildVerificationTargets(
      ["npm test", "npm run lint"],
      [{ cmd: "npm test", passed: true }, { cmd: "npm run lint", passed: false }],
      []
    );
    const testTarget = targets.find(t => t.cmd === "npm test")!;
    const lintTarget = targets.find(t => t.cmd === "npm run lint")!;
    assert.equal(testTarget.blocked, false);
    assert.equal(testTarget.passed, true);
    assert.equal(lintTarget.blocked, false);
    assert.equal(lintTarget.passed, false);
  });

  it("marks blocked commands with blocked=true and passed=false", () => {
    const targets = buildVerificationTargets(
      ["npm start", "npm test"],
      [{ cmd: "npm test", passed: true }],
      ["npm start"]
    );
    const startTarget = targets.find(t => t.cmd === "npm start")!;
    const testTarget  = targets.find(t => t.cmd === "npm test")!;
    assert.equal(startTarget.blocked, true);
    assert.equal(startTarget.passed, false);
    assert.equal(testTarget.blocked, false);
    assert.equal(testTarget.passed, true);
  });

  it("appends fallback command when all task-named commands were blocked (negative path)", () => {
    const targets = buildVerificationTargets(
      ["npm start"],
      [{ cmd: "npm test", passed: true }],
      ["npm start"],
      "npm test"
    );
    // Original blocked command
    const startTarget = targets.find(t => t.cmd === "npm start")!;
    assert.equal(startTarget.blocked, true);
    // Fallback command appended
    const fallbackTarget = targets.find(t => t.cmd === "npm test")!;
    assert.ok(fallbackTarget, "fallback command must appear in targets when all task commands blocked");
    assert.equal(fallbackTarget.blocked, false);
    assert.equal(fallbackTarget.passed, true);
  });

  it("does not append fallback when not all commands were blocked", () => {
    const targets = buildVerificationTargets(
      ["npm test", "npm start"],
      [{ cmd: "npm test", passed: true }],
      ["npm start"],
      "npm test"
    );
    // npm test appears only once (as a requested command, not as a duplicate fallback)
    const testOccurrences = targets.filter(t => t.cmd === "npm test");
    assert.equal(testOccurrences.length, 1, "fallback must not duplicate an already-present target");
  });

  it("returns empty array for empty requested commands list", () => {
    const targets = buildVerificationTargets([], [], []);
    assert.deepEqual(targets, []);
  });
});
