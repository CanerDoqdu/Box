/**
 * executor_dispatch_gate_integration.test.ts
 *
 * Integration test proving that the executor dispatch path consumes sanitised
 * verification commands produced by the dispatch gate.
 *
 * The executor flow being tested:
 *   raw task → repairPrometheusTask → sanitizeTaskForDispatch (applyDispatchCommandGate)
 *                                   → sanitised commands consumed by executor
 *
 * The dispatch gate (applyDispatchCommandGate via verification_gate.ts) rewrites
 * non-portable verification commands (shell globs, bash/sh scripts, daemon invocations)
 * to their canonical, cross-platform equivalents before any worker sees them.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { repairPrometheusTask, sanitizeTaskForDispatch, validateVerificationPortability } from "../../src/core/evolution_executor.js";
import { applyDispatchCommandGate } from "../../src/core/verification_gate.js";

describe("executor dispatch gate integration — sanitised commands consumed by executor", () => {
  it("repairPrometheusTask rewrites non-portable commands so the gate finds them already clean", () => {
    // raw task with non-portable verification_commands
    const rawTask = {
      task_id: "T-001",
      title: "Add validation tests",
      scope: "src/core/",
      acceptance_criteria: ["Tests pass"],
      verification_commands: [
        "node --test tests/**/*.test.ts",  // non-portable shell glob
        "bash scripts/run_tests.sh",        // non-portable bash invocation
        "npm run lint",                      // already portable
      ],
    };

    // Step 1: executor repair normalises commands
    const repairedTask = repairPrometheusTask(rawTask);

    // All commands must be portable after repair
    for (const cmd of repairedTask.verification_commands) {
      const portability = validateVerificationPortability([cmd]);
      assert.equal(portability.portable, true,
        `command "${cmd}" must be portable after repairPrometheusTask`);
    }

    // Non-portable originals must not survive repair
    assert.ok(!repairedTask.verification_commands.includes("node --test tests/**/*.test.ts"),
      "shell glob command must not survive repair");
    assert.ok(!repairedTask.verification_commands.includes("bash scripts/run_tests.sh"),
      "bash invocation must not survive repair");
  });

  it("sanitizeTaskForDispatch (dispatch gate) confirms safe=true after repairPrometheusTask", () => {
    const rawTask = {
      task_id: "T-002",
      title: "Add tests",
      scope: "src/core/",
      acceptance_criteria: ["Tests pass"],
      verification_commands: [
        "node --test tests/**/*.test.ts",
        "npm run lint",
      ],
    };

    // Step 1: executor repair
    const repairedTask = repairPrometheusTask(rawTask);

    // Step 2: executor applies dispatch gate as audit checkpoint
    const { task: dispatchedTask, gate } = sanitizeTaskForDispatch(repairedTask);

    // Gate confirms all commands are already portable (repair already sanitised them)
    assert.equal(gate.safe, true,
      "dispatch gate must confirm safe=true after repairPrometheusTask has run");
    assert.deepEqual(gate.rewrites, [],
      "no rewrites expected when repair has already normalised all commands");

    // The dispatched task's commands are identical to the repaired task
    assert.deepEqual(
      dispatchedTask.verification_commands,
      repairedTask.verification_commands,
      "dispatched task commands must equal repaired task commands when gate is safe"
    );
  });

  it("dispatch gate acts as safety net — sanitises non-portable commands not yet through repair", () => {
    // Simulate a raw task being passed directly to the dispatch gate (bypassing repair)
    const rawTask = {
      task_id: "T-003",
      title: "Test task",
      scope: "src/core/",
      acceptance_criteria: ["Tests pass"],
      verification_commands: [
        "node --test tests/**/*.test.ts",   // non-portable
        "npm run lint",                       // portable
      ],
    };

    const { task: sanitizedTask, gate } = applyDispatchCommandGate(rawTask);

    // Gate detects and rewrites the non-portable command
    assert.equal(gate.safe, false,
      "dispatch gate must detect non-portable commands");
    assert.equal(gate.rewrites.length, 1,
      "exactly one command should be rewritten");
    assert.equal(gate.rewrites[0].original, "node --test tests/**/*.test.ts");
    assert.equal(gate.rewrites[0].rewritten, "npm test",
      "shell glob must be rewritten to 'npm test'");
    assert.ok(typeof gate.rewrites[0].reason === "string" && gate.rewrites[0].reason.length > 0,
      "rewrite reason must be a non-empty string");

    // Sanitised task uses portable commands
    assert.deepEqual(sanitizedTask.verification_commands, ["npm test", "npm run lint"],
      "sanitised task must have only portable commands in canonical order");
  });

  it("negative path — all forbidden commands rewritten; executor would only run portable commands", () => {
    const rawTask = {
      task_id: "T-004",
      title: "Bad commands task",
      scope: "src/core/",
      acceptance_criteria: ["Tests pass"],
      verification_commands: [
        "node --test tests/**",       // non-portable glob
        "sh run.sh",                   // non-portable shell
        "npm run build",               // portable
      ],
    };

    // Full executor dispatch path: repair → gate
    const repairedTask = repairPrometheusTask(rawTask);
    const { task: dispatchedTask, gate } = sanitizeTaskForDispatch(repairedTask);

    // After full path, all commands are portable
    for (const cmd of dispatchedTask.verification_commands) {
      const portability = validateVerificationPortability([cmd]);
      assert.equal(portability.portable, true,
        `"${cmd}" must be portable after full executor dispatch path`);
    }

    // No daemon/shell commands survived the dispatch path
    const forbiddenSurvived = dispatchedTask.verification_commands.some(cmd =>
      /^sh\s/.test(cmd) || /node\s+--test\s+[^\s]*\*/.test(cmd)
    );
    assert.equal(forbiddenSurvived, false,
      "no forbidden commands must survive the full executor dispatch path");

    // gate.safe may be true (repair already cleaned) or false (if something slipped through)
    // Either way, the dispatched task must only contain portable commands
    assert.ok(Array.isArray(gate.sanitizedCommands),
      "gate must always produce a sanitizedCommands array");
  });

  it("deduplication: repair + gate produce exactly one 'npm test' even with multiple non-portable sources", () => {
    const rawTask = {
      task_id: "T-005",
      title: "Dedup test",
      scope: "src/core/",
      acceptance_criteria: ["Tests pass"],
      verification_commands: [
        "node --test tests/**/*.test.ts",   // rewrites to npm test
        "bash run.sh",                       // rewrites to npm test
        "npm test",                          // already canonical
      ],
    };

    const repairedTask = repairPrometheusTask(rawTask);
    const { task: dispatchedTask } = sanitizeTaskForDispatch(repairedTask);

    // Only one "npm test" should remain after deduplication
    const testCmdCount = dispatchedTask.verification_commands.filter(c => c === "npm test").length;
    assert.equal(testCmdCount, 1,
      "deduplication must produce exactly one 'npm test' regardless of how many non-portable sources rewrote to it");
  });
});
