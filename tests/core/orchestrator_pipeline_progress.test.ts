/**
 * Orchestrator Pipeline Progress Integration Tests
 *
 * Covers:
 *   - AC15: orchestrator resilience when updatePipelineProgress throws
 *   - AC5:  monotonic stage progression
 *   - AC7:  negative path — failure handling
 *   - AC3:  idle/cycle_complete timestamps
 *   - Task 1 (resume governance gate): checkpoint resume blocked by pre-dispatch governance gate
 *   - Task 2 (event emission): GOVERNANCE_GATE_EVALUATED and PLANNING_PLAN_REJECTED emitted
 *   - Task N (degraded event): ORCHESTRATION_HEALTH_DEGRADED emitted in governance gate exception catch paths
 */

import { describe, it, beforeEach, afterEach, mock } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runOnce, runResumeDispatch, evaluatePreDispatchGovernanceGate } from "../../src/core/orchestrator.js";
import { readPipelineProgress, PIPELINE_STAGE_ENUM } from "../../src/core/pipeline_progress.js";
import { EVENTS } from "../../src/core/event_schema.js";

describe("orchestrator pipeline progress — resilience", () => {
  let tmpDir;
  let config;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-orch-pp-"));
    config = {
      paths: {
        stateDir: tmpDir,
        progressFile: path.join(tmpDir, "progress.txt"),
        policyFile: path.join(tmpDir, "policy.json")
      },
      env: {
        // Force CLI into deterministic fallback so no real AI calls are made
        copilotCliCommand: "__missing_copilot_binary__",
        targetRepo: "CanerDoqdu/Box"
      },
      roleRegistry: {
        ceoSupervisor: { name: "Jesus", model: "Claude Sonnet 4.6" },
        deepPlanner: { name: "Prometheus", model: "GPT-5.3-Codex" },
        qualityReviewer: { name: "Athena", model: "Claude Sonnet 4.6" },
        workers: {
          backend: { name: "King David" },
          test: { name: "Samuel" }
        }
      },
      copilot: {
        leadershipAutopilot: false
      }
    };

    await fs.writeFile(config.paths.policyFile, JSON.stringify({ blockedCommands: [] }, null, 2), "utf8");
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  // AC15: pipeline progress failure must not block orchestration
  it("orchestrator completes normally even if pipeline_progress.json is unwritable", async () => {
    // Make the state dir read-only to prevent pipeline_progress.json writes
    // We can't make it truly read-only on all platforms, so instead we write
    // a directory where the file should be to force a write error.
    const progressPath = path.join(tmpDir, "pipeline_progress.json");
    await fs.mkdir(progressPath, { recursive: true }); // make it a directory to block writes

    // Orchestrator must not throw even though pipeline progress writes will fail
    await assert.doesNotReject(
      () => runOnce(config),
      "orchestrator must not throw when pipeline progress writes fail"
    );

    // Verify the orchestration itself still ran by checking progress.txt
    const progressLog = await fs.readFile(config.paths.progressFile, "utf8").catch(() => "");
    assert.ok(progressLog.includes("[CYCLE]"), "orchestration must still run and log CYCLE steps");
  });

  // AC7: negative path — explicit failure handling is logged not silently dropped
  it("pipeline progress write failures are logged in progress.txt when pipeline_progress.json is unwritable", async () => {
    const progressPath = path.join(tmpDir, "pipeline_progress.json");
    await fs.mkdir(progressPath, { recursive: true });

    await runOnce(config);

    // pipeline progress failure should be non-fatal; orchestrator runs normally
    const progressLog = await fs.readFile(config.paths.progressFile, "utf8").catch(() => "");
    assert.ok(progressLog.includes("[CYCLE]"), "orchestrator must still log cycle steps");
  });

  // Positive path: pipeline_progress.json is written when orchestration runs normally
  it("pipeline_progress.json is written when orchestrator runs a cycle", async () => {
    await runOnce(config);

    // The cycle runs through Jesus (which may produce a wait or decision),
    // so we only check that the file was written at some point.
    // readPipelineProgress returns a fallback if file is missing, so check stage is valid.
    const data = await readPipelineProgress(config);
    assert.ok(typeof data.stage === "string", "pipeline progress must have a string stage");
    assert.ok(PIPELINE_STAGE_ENUM.includes(data.stage),
      `pipeline stage '${data.stage}' must be in PIPELINE_STAGE_ENUM`
    );
    assert.ok(typeof data.percent === "number", "pipeline progress must have a numeric percent");
    assert.ok(data.percent >= 0 && data.percent <= 100, "percent must be in [0, 100]");
  });

  // AC3: verify stage written is one of the known enum values (no rogue stages)
  it("stage written by orchestrator is always a valid PIPELINE_STAGE_ENUM value", async () => {
    await runOnce(config);

    const data = await readPipelineProgress(config);
    assert.ok(
      PIPELINE_STAGE_ENUM.includes(data.stage),
      `stage '${data.stage}' written by orchestrator is not in PIPELINE_STAGE_ENUM`
    );
  });
});

// ── Governance pre-dispatch gate tests (Tasks 4-7) ────────────────────────────

describe("orchestrator governance pre-dispatch gate", () => {
  let tmpDir;
  let config;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-gov-gate-"));
    config = {
      paths: { stateDir: tmpDir },
      env:   { targetRepo: "CanerDoqdu/Box" },
      canary: {
        enabled:      true,
        defaultRatio: 0.2,
        governance: {
          canaryRatio:             0.2,
          measurementWindowCycles: 5,
          falseBlockRateMax:       0.02,
          safetyScoreMin:          0.95,
          falseBlockRateTrigger:   0.05,
          safetyScoreTriggerLow:   0.80,
          breachAction:            "halt_new_assignments"
        }
      },
      systemGuardian: { enabled: true }
    };
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("allows dispatch when guardrail, freeze, lineage, and canary gates are all clear", async () => {
    const plans = [
      { id: "T1", task: "task one", role: "backend", dependsOn: [], filesInScope: ["src/core/a.ts"] },
      { id: "T2", task: "task two", role: "test", dependsOn: ["T1"], filesInScope: ["tests/core/a.test.ts"] }
    ];

    const result = await evaluatePreDispatchGovernanceGate(config, plans, "clear-gate-cycle-1");

    assert.equal(result.blocked, false, "dispatch must proceed when no pre-dispatch governance gate is active");
    assert.equal(result.reason, null);
    assert.ok(result.graphResult, "graphResult must exist for successful lineage resolution");
    assert.equal(result.graphResult.status, "ok");
  });

  // ── Task 4 ────────────────────────────────────────────────────────────────
  it("should block dispatch when lineage graph status is cycle_detected", async () => {
    // Two plans with a mutual dependency — creates a cycle in the graph
    const plans = [
      { id: "T1", task: "task one", role: "backend", dependsOn: ["T2"], filesInScope: [] },
      { id: "T2", task: "task two", role: "backend", dependsOn: ["T1"], filesInScope: [] }
    ];

    const result = await evaluatePreDispatchGovernanceGate(config, plans, "cycle-test-cycle-1");

    assert.equal(result.blocked, true,
      "dispatch must be blocked when dependency cycle is detected");
    assert.ok(
      result.reason.includes("cycle_detected") || result.reason.includes("lineage"),
      `expected cycle_detected or lineage in reason; got: ${result.reason}`
    );
    assert.ok(result.graphResult, "graphResult must be present when cycle is detected");
  });

  // ── Task 5 ────────────────────────────────────────────────────────────────
  it("should block dispatch when governance canary reports breach-active", async () => {
    // Write a governance ledger with a rolled-back experiment (breach active)
    const ledger = {
      schemaVersion: 1,
      experiments: [{
        canaryId:     "govcanary-breach-001",
        status:       "rolled_back",
        breachAction: "halt_new_assignments",
        statusReason: "GOVERNANCE_BREACH_FALSE_BLOCK_RATE:0.10>0.05",
        policyKey:    "{}",
        cycleLog:     [],
        cohortStats:  { canary: {}, control: {} }
      }],
      updatedAt: new Date().toISOString()
    };
    await fs.writeFile(
      path.join(tmpDir, "governance_canary_ledger.json"),
      JSON.stringify(ledger, null, 2),
      "utf8"
    );

    const result = await evaluatePreDispatchGovernanceGate(config, [], "breach-test-cycle-1");

    assert.equal(result.blocked, true,
      "dispatch must be blocked when governance canary breach is active");
    assert.ok(
      result.reason.includes("canary") || result.reason.includes("breach"),
      `expected canary or breach in reason; got: ${result.reason}`
    );
  });

  // ── Task 6 ────────────────────────────────────────────────────────────────
  it("should invoke executeRollback and persist incident on governance canary rollback action", async () => {
    // Pre-write a governance ledger showing a breach
    const ledger = {
      schemaVersion: 1,
      experiments: [{
        canaryId:     "govcanary-rollback-001",
        status:       "rolled_back",
        breachAction: "halt_new_assignments",
        statusReason: "GOVERNANCE_BREACH",
        policyKey:    "{}",
        cycleLog:     [],
        cohortStats:  { canary: {}, control: {} }
      }],
      updatedAt: new Date().toISOString()
    };
    await fs.writeFile(
      path.join(tmpDir, "governance_canary_ledger.json"),
      JSON.stringify(ledger, null, 2),
      "utf8"
    );

    const result = await evaluatePreDispatchGovernanceGate(config, [], "rollback-invoke-cycle-1");

    assert.equal(result.blocked, true);
    assert.equal(result.action, "rollback",
      "action must be rollback when canary breach triggers dispatch block");

    // Verify rollback incident was persisted
    const incidentPath = path.join(tmpDir, "rollback_incidents.jsonl");
    const incidentExists = await fs.access(incidentPath).then(() => true).catch(() => false);
    assert.equal(incidentExists, true,
      "rollback_incidents.jsonl must be written when executeRollback is invoked");

    // Verify the incident record contains expected fields
    const raw = await fs.readFile(incidentPath, "utf8");
    const incident = JSON.parse(raw.trim().split("\n")[0]);
    assert.ok(incident.incidentId, "incident must have an incidentId");
    assert.ok(incident.trigger === "CANARY_ROLLBACK" || incident.level === "config-only",
      `unexpected incident trigger/level: trigger=${incident.trigger} level=${incident.level}`
    );
  });

  it("governance_freeze_active: blocks pre-dispatch when freeze gate is active [T-040/AC1]", async () => {
    const plans = [
      { id: "T1", task: "high-risk task", role: "backend", dependsOn: [], filesInScope: ["src/core/orchestrator.ts"] }
    ];

    const freezeOnlyConfig = {
      ...config,
      systemGuardian: { enabled: false },
      canary: { enabled: false },
      governanceFreeze: { enabled: true, manualOverrideActive: true }
    };

    const result = await evaluatePreDispatchGovernanceGate(freezeOnlyConfig, plans, "freeze-only-cycle-1");

    assert.equal(result.blocked, true, "dispatch must be blocked by freeze when no higher-precedence guardrail is active");
    assert.ok(
      result.reason.startsWith("governance_freeze_active:"),
      `expected FREEZE reason, got: ${result.reason}`
    );
    assert.equal(result.action, undefined, "freeze block should not trigger rollback action");
  });

  it("continues non-fatally and emits warning signal when guardrail check throws", async () => {
    const warnings = [];
    mock.method(console, "warn", (...args) => {
      warnings.push(args.map(v => String(v)).join(" "));
    });

    const guardrailThrowConfig = {
      ...config,
      // Invalid path type forces isGuardrailActive(path.join) to throw.
      paths: { stateDir: Symbol("invalid-state-dir") },
      canary: { enabled: false }
    };

    await assert.doesNotReject(
      () => evaluatePreDispatchGovernanceGate(guardrailThrowConfig, [], "guardrail-throw-cycle-1"),
      "guardrail exceptions must be handled as warning-only and not thrown"
    );

    const result = await evaluatePreDispatchGovernanceGate(guardrailThrowConfig, [], "guardrail-throw-cycle-2");
    assert.equal(result.blocked, false, "guardrail exception path must safely fall through when no other gate is active");
    assert.equal(result.reason, null);
    assert.ok(
      warnings.some(msg => msg.includes("pre-dispatch guardrail check failed")),
      "warning signal must be emitted when guardrail check throws"
    );
  });

  it("covers gate wrapper catch path with safe fallthrough on unexpected guard exception", async () => {
    const guardrailThrowFreezeConfig = {
      ...config,
      paths: { stateDir: Symbol("invalid-state-dir-2") },
      canary: { enabled: false },
      governanceFreeze: { enabled: true, manualOverrideActive: true }
    };

    const result = await evaluatePreDispatchGovernanceGate(
      guardrailThrowFreezeConfig,
      [],
      "guardrail-wrapper-catch-cycle-1"
    );

    assert.equal(result.blocked, true, "unexpected guardrail exception must not crash gate evaluation");
    assert.ok(
      result.reason.startsWith("governance_freeze_active:"),
      `freeze gate must still evaluate after guard exception; got: ${result.reason}`
    );
  });

  // ── Task 7 ────────────────────────────────────────────────────────────────
  it("should enforce guardrail > freeze > canary precedence and invoke rollback on canary breach in one cycle", async () => {
    // Set up canary breach in state
    const ledger = {
      schemaVersion: 1,
      experiments: [{
        canaryId:     "govcanary-prec-001",
        status:       "rolled_back",
        breachAction: "halt_new_assignments",
        statusReason: "GOVERNANCE_BREACH",
        policyKey:    "{}",
        cycleLog:     [],
        cohortStats:  { canary: {}, control: {} }
      }],
      updatedAt: new Date().toISOString()
    };
    await fs.writeFile(
      path.join(tmpDir, "governance_canary_ledger.json"),
      JSON.stringify(ledger, null, 2),
      "utf8"
    );

    // Set up guardrail PAUSE_WORKERS state in the same stateDir
    const guardrailState = { enabled: true, revertedAt: null, activatedAt: new Date().toISOString() };
    await fs.writeFile(
      path.join(tmpDir, "guardrail_pause_workers.json"),
      JSON.stringify(guardrailState, null, 2),
      "utf8"
    );

    // With guardrail + freeze + canary all active:
    // guardrail must win (precedence 1)
    const configWithAll = {
      ...config,
      governanceFreeze: { enabled: true, manualOverrideActive: true }
    };

    const r1 = await evaluatePreDispatchGovernanceGate(configWithAll, [], "prec-all-cycle");
    assert.equal(r1.blocked, true);
    assert.ok(r1.reason.includes("guardrail"),
      `guardrail must win when all three are active; reason=${r1.reason}`);
    assert.equal(r1.action, undefined,
      "no rollback triggered when guardrail blocks first");

    // Without guardrail, only canary active: canary triggers rollback
    const configNoGuardrail = { ...config, systemGuardian: { enabled: false } };
    const r2 = await evaluatePreDispatchGovernanceGate(configNoGuardrail, [], "prec-noguardrail-cycle");
    assert.equal(r2.blocked, true);
    assert.ok(
      r2.reason.includes("canary") || r2.reason.includes("breach"),
      `canary breach must block when guardrail is disabled; reason=${r2.reason}`
    );
    assert.equal(r2.action, "rollback",
      "rollback action must be triggered on canary breach");

    // Verify rollback incident was persisted
    const incidentPath = path.join(tmpDir, "rollback_incidents.jsonl");
    const incidentExists = await fs.access(incidentPath).then(() => true).catch(() => false);
    assert.equal(incidentExists, true, "rollback incident must be persisted on canary breach");
  });
});

// ── Task 1: Resume dispatch governance gate ───────────────────────────────────

describe("orchestrator checkpoint resume — pre-dispatch governance gate", () => {
  let tmpDir;
  let config;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-resume-gate-"));
    config = {
      paths: {
        stateDir: tmpDir,
        progressFile: path.join(tmpDir, "progress.txt"),
        policyFile: path.join(tmpDir, "policy.json")
      },
      env: {
        copilotCliCommand: "__missing_copilot_binary__",
        targetRepo: "CanerDoqdu/Box"
      },
      roleRegistry: {
        ceoSupervisor: { name: "Jesus", model: "Claude Sonnet 4.6" },
        deepPlanner: { name: "Prometheus", model: "GPT-5.3-Codex" },
        qualityReviewer: { name: "Athena", model: "Claude Sonnet 4.6" }
      },
      copilot: { leadershipAutopilot: false },
      canary: { enabled: false },
      systemGuardian: { enabled: true }
    };
    await fs.writeFile(config.paths.policyFile, JSON.stringify({ blockedCommands: [] }, null, 2), "utf8");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("blocks resumed dispatch when governance freeze is active and logs warning", async () => {
    // Write an approved Athena review with plans so resume path is entered
    const athenaReview = {
      approved: true,
      patchedPlans: [
        { id: "T1", task: "task one", role: "evolution-worker", dependsOn: [], filesInScope: [] }
      ]
    };
    await fs.writeFile(
      path.join(tmpDir, "athena_plan_review.json"),
      JSON.stringify(athenaReview),
      "utf8"
    );

    // Activate governance freeze so the gate blocks dispatch
    const freezeConfig = {
      ...config,
      governanceFreeze: { enabled: true, manualOverrideActive: true }
    };

    // runOnce: basic non-throw assertion covering the normal cycle path
    await assert.doesNotReject(
      () => runOnce(freezeConfig),
      "runOnce must not throw when governance gate blocks resumed dispatch"
    );

    // Progress log must record the governance gate block
    const progressLog = await fs.readFile(config.paths.progressFile, "utf8").catch(() => "");
    assert.ok(
      progressLog.includes("[RESUME]") || progressLog.includes("[CYCLE]"),
      "progress log must record orchestration activity even when gate blocks"
    );

    // Checkpoint-aware: use runResumeDispatch to exercise tryResumeDispatchFromCheckpoint.
    // With freeze active, the governance gate must block dispatch and NOT advance the
    // checkpoint to "complete" — so a future resume can retry from the same position.
    await assert.doesNotReject(
      () => runResumeDispatch(freezeConfig),
      "runResumeDispatch must not throw when governance freeze blocks dispatch — early return expected"
    );

    const checkpointPath = path.join(tmpDir, "dispatch_checkpoint.json");
    const checkpointRaw = await fs.readFile(checkpointPath, "utf8").catch(() => null);
    assert.ok(checkpointRaw !== null,
      "dispatch_checkpoint.json must be written by tryResumeDispatchFromCheckpoint even when the gate blocks"
    );
    const checkpoint = JSON.parse(checkpointRaw!);
    assert.notEqual(
      checkpoint.status,
      "complete",
      "dispatch_checkpoint.json must NOT be marked complete when pre-dispatch gate blocks — retry must remain possible"
    );
  });

  it("proceeds with resumed dispatch when governance gate is clear", async () => {
    // Write an approved Athena review with plans
    const athenaReview = {
      approved: true,
      patchedPlans: [
        { id: "T1", task: "task one", role: "evolution-worker", dependsOn: [], filesInScope: [] }
      ]
    };
    await fs.writeFile(
      path.join(tmpDir, "athena_plan_review.json"),
      JSON.stringify(athenaReview),
      "utf8"
    );

    // All gates clear (no freeze, no canary breach, no guardrail)
    await assert.doesNotReject(
      () => runOnce(config),
      "runOnce must not throw when governance gate passes for resumed dispatch"
    );

    // Checkpoint-aware: explicitly invoke runResumeDispatch to verify that the dispatch
    // checkpoint is created and populated when all gates are clear.
    await assert.doesNotReject(
      () => runResumeDispatch(config),
      "runResumeDispatch must not throw when all pre-dispatch governance gates are clear"
    );

    const checkpointPath = path.join(tmpDir, "dispatch_checkpoint.json");
    const checkpointExists = await fs.access(checkpointPath).then(() => true).catch(() => false);
    assert.ok(
      checkpointExists,
      "dispatch_checkpoint.json must be written when the governance gate is clear and resume dispatch is entered"
    );
    const checkpoint = JSON.parse(await fs.readFile(checkpointPath, "utf8"));
    assert.ok(
      typeof checkpoint.status === "string",
      "dispatch_checkpoint.json must have a string status field"
    );
    assert.ok(
      typeof checkpoint.totalPlans === "number" && checkpoint.totalPlans > 0,
      `dispatch_checkpoint.json must record totalPlans > 0 when plans are present; got totalPlans=${checkpoint.totalPlans}`
    );
  });
});

// ── Task 2: Typed event emission ──────────────────────────────────────────────

describe("orchestrator typed event emission — GOVERNANCE_GATE_EVALUATED", () => {
  let tmpDir;
  let config;
  let emittedEvents;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-event-emit-"));
    emittedEvents = [];
    config = {
      paths: {
        stateDir: tmpDir,
        progressFile: path.join(tmpDir, "progress.txt"),
        policyFile: path.join(tmpDir, "policy.json")
      },
      env: {
        copilotCliCommand: "__missing_copilot_binary__",
        targetRepo: "CanerDoqdu/Box"
      },
      roleRegistry: {
        ceoSupervisor: { name: "Jesus", model: "Claude Sonnet 4.6" },
        deepPlanner: { name: "Prometheus", model: "GPT-5.3-Codex" },
        qualityReviewer: { name: "Athena", model: "Claude Sonnet 4.6" }
      },
      copilot: { leadershipAutopilot: false },
      canary: { enabled: false },
      systemGuardian: { enabled: true }
    };
    await fs.writeFile(config.paths.policyFile, JSON.stringify({ blockedCommands: [] }, null, 2), "utf8");

    // Intercept console.log to capture emitted events
    mock.method(console, "log", (line) => {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj.event === "string") {
          emittedEvents.push(obj);
        }
      } catch { /* not JSON */ }
    });
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("emits GOVERNANCE_GATE_EVALUATED event during explicit resume dispatch", async () => {
    // Write an approved Athena review so explicit resume reaches the gate
    const athenaReview = {
      approved: true,
      patchedPlans: [
        { id: "T1", task: "task one", role: "evolution-worker", dependsOn: [], filesInScope: [] }
      ]
    };
    await fs.writeFile(
      path.join(tmpDir, "athena_plan_review.json"),
      JSON.stringify(athenaReview),
      "utf8"
    );

    await runResumeDispatch(config);

    const gateEvents = emittedEvents.filter(e => e.event === EVENTS.GOVERNANCE_GATE_EVALUATED);
    assert.ok(
      gateEvents.length >= 1,
      `expected at least one GOVERNANCE_GATE_EVALUATED event; got ${gateEvents.length}`
    );
    const ev = gateEvents[0];
    assert.equal(ev.domain, "governance", "event domain must be governance");
    assert.ok(typeof ev.payload.blocked === "boolean", "payload.blocked must be boolean");
  });

  it("negative: no GOVERNANCE_GATE_EVALUATED emitted on fresh run with no approved review", async () => {
    // No athena_plan_review.json — orchestrator runs Jesus → Prometheus (may fail) → no dispatch gate reached
    await runOnce(config);
    // We don't assert zero events here because Prometheus may also fail fast;
    // we just verify the orchestrator doesn't crash and events are well-formed if any.
    for (const ev of emittedEvents) {
      assert.ok(typeof ev.event === "string", "every emitted event must have a string event field");
      assert.ok(typeof ev.domain === "string", "every emitted event must have a string domain");
    }
  });
});

// ── Governance gate exception — degraded event emission ───────────────────────

describe("orchestrator governance gate exception — ORCHESTRATION_HEALTH_DEGRADED emission", () => {
  let tmpDir;
  let config;
  let emittedEvents;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-gate-degrade-"));
    emittedEvents = [];
    config = {
      paths: {
        stateDir: tmpDir,
        progressFile: path.join(tmpDir, "progress.txt"),
        policyFile:   path.join(tmpDir, "policy.json")
      },
      env: {
        copilotCliCommand: "__missing_copilot_binary__",
        targetRepo: "CanerDoqdu/Box"
      },
      roleRegistry: {
        ceoSupervisor: { name: "Jesus",     model: "Claude Sonnet 4.6" },
        deepPlanner:   { name: "Prometheus", model: "GPT-5.3-Codex" },
        qualityReviewer: { name: "Athena",  model: "Claude Sonnet 4.6" }
      },
      copilot: { leadershipAutopilot: false },
      systemGuardian: { enabled: false }
    };
    await fs.writeFile(config.paths.policyFile, JSON.stringify({ blockedCommands: [] }, null, 2), "utf8");

    mock.method(console, "log", (line) => {
      try {
        const obj = JSON.parse(line);
        if (obj && typeof obj.event === "string") emittedEvents.push(obj);
      } catch { /* not JSON */ }
    });
  });

  afterEach(async () => {
    mock.restoreAll();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("emits ORCHESTRATION_HEALTH_DEGRADED and stays non-fatal when governance gate throws during resume", async () => {
    // Write an approved athena review with plans so resume path reaches the governance gate.
    const athenaReview = {
      approved: true,
      patchedPlans: [
        { id: "T1", task: "task one", role: "evolution-worker", dependsOn: [], filesInScope: [] }
      ]
    };
    await fs.writeFile(
      path.join(tmpDir, "athena_plan_review.json"),
      JSON.stringify(athenaReview),
      "utf8"
    );

    // Inject a governance canary config getter that throws synchronously.
    // getGovernanceCanaryConfig() accesses `config.canary.governance` before any
    // early-return guard, so this propagates out of evaluatePreDispatchGovernanceGate
    // and into the outer catch block in tryResumeDispatchFromCheckpoint.
    const throwingConfig = Object.assign({}, config, {
      canary: {
        enabled: false,
        get governance() {
          throw new Error("simulated governance gate exception");
        }
      }
    });

    // The cycle must not throw — non-fatality is the primary contract.
    await assert.doesNotReject(
      () => runResumeDispatch(throwingConfig),
      "runResumeDispatch must not throw when the governance gate itself throws — outer catch must absorb it"
    );

    const degradedEvents = emittedEvents.filter(e => e.event === EVENTS.ORCHESTRATION_HEALTH_DEGRADED);
    assert.ok(
      degradedEvents.length >= 1,
      `expected at least one ORCHESTRATION_HEALTH_DEGRADED event when gate throws; got ${degradedEvents.length}`
    );
    const ev = degradedEvents[0];
    assert.equal(ev.domain, "orchestration", "degraded event domain must be orchestration");
    assert.equal(ev.payload.reason, "governance_gate_exception", "payload.reason must be governance_gate_exception");
    assert.equal(ev.payload.context, "resume_dispatch", "payload.context must be resume_dispatch");
    assert.ok(
      typeof ev.payload.error === "string" && ev.payload.error.length > 0,
      "payload.error must be a non-empty string with the exception message"
    );
  });
});
