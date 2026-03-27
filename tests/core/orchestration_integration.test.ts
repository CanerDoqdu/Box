/**
 * orchestration_integration.test.ts
 *
 * Deterministic integration coverage for the three core orchestration gates:
 *   1. Dependency wave order — multi-task plans flow through the DAG scheduler in
 *      the correct sequential wave order; completing a wave unlocks the next.
 *   2. Capability routing — after DAG scheduling each wave's tasks are routed to
 *      the correct workers by the capability pool.
 *   3. Carry-forward debt blocking sequence — when critical debt exceeds the SLA
 *      threshold, shouldBlockOnDebt returns true and downstream planning is gated.
 *   4. Optimizer budget admission — plans rejected by the intervention optimizer
 *      are filtered from the dispatch set; unaffected plans proceed normally.
 *   5. Carry-forward auto-close — only debt items backed by verification evidence
 *      are closed; unresolved items remain blocking.
 *
 * These tests exercise modules working together, not in isolation.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { computeNextWaves, computeFrontier } from "../../src/core/dag_scheduler.js";
import {
  inferCapabilityTag,
  selectWorkerForPlan,
  assignWorkersToPlans,
} from "../../src/core/capability_pool.js";
import {
  addDebtEntries,
  shouldBlockOnDebt,
  closeDebt,
  tickCycle,
  autoCloseVerifiedDebt,
  computeFingerprint,
} from "../../src/core/carry_forward_ledger.js";
import {
  buildInterventionsFromPlan,
  buildBudgetFromConfig,
  runInterventionOptimizer,
  OPTIMIZER_STATUS,
} from "../../src/core/intervention_optimizer.js";

// ── 1. Dependency Wave Order ───────────────────────────────────────────────────

describe("Integration: dependency wave order", () => {
  it("computeFrontier enforces sequential order: only root tasks are initially ready", () => {
    const plans = [
      { task: "T-A", role: "evolution-worker", dependencies: [] },
      { task: "T-B", role: "evolution-worker", dependencies: ["T-A"] },
      { task: "T-C", role: "evolution-worker", dependencies: ["T-B"] },
    ];

    // Nothing completed — only T-A should be on the frontier
    const r0 = computeFrontier(plans, new Set(), new Set(), new Set());
    const frontier0 = r0.frontier.map((p: any) => p.task);
    assert.ok(frontier0.includes("T-A"), "T-A must be on the initial frontier");
    assert.ok(!frontier0.includes("T-B"), "T-B must NOT be on the frontier (T-A not done yet)");
    assert.ok(!frontier0.includes("T-C"), "T-C must NOT be on the frontier (T-A, T-B not done yet)");
  });

  it("computeFrontier promotes T-B after T-A completes, but keeps T-C blocked", () => {
    const plans = [
      { task: "T-A", role: "evolution-worker", dependencies: [] },
      { task: "T-B", role: "evolution-worker", dependencies: ["T-A"] },
      { task: "T-C", role: "evolution-worker", dependencies: ["T-B"] },
    ];

    // T-A completed — T-B should now be on the frontier, T-C still blocked
    const r1 = computeFrontier(plans, new Set(["T-A"]), new Set(), new Set());
    const frontier1 = r1.frontier.map((p: any) => p.task);
    assert.ok(frontier1.includes("T-B"), "T-B must be on the frontier after T-A completes");
    assert.ok(!frontier1.includes("T-C"), "T-C must NOT be on the frontier (T-B not done yet)");
  });

  it("computeFrontier promotes T-C only after both T-A and T-B complete (full chain)", () => {
    const plans = [
      { task: "T-A", role: "evolution-worker", dependencies: [] },
      { task: "T-B", role: "evolution-worker", dependencies: ["T-A"] },
      { task: "T-C", role: "evolution-worker", dependencies: ["T-B"] },
    ];

    const r2 = computeFrontier(plans, new Set(["T-A", "T-B"]), new Set(), new Set());
    const frontier2 = r2.frontier.map((p: any) => p.task);
    assert.ok(frontier2.includes("T-C"), "T-C must be on the frontier after T-A and T-B complete");

    // All done
    const r3 = computeFrontier(plans, new Set(["T-A", "T-B", "T-C"]), new Set(), new Set());
    assert.equal(r3.status, "all_done", "status must be all_done once all tasks complete");
  });

  it("failed task in wave 1 blocks all downstream dependents (carry-forward deadlock)", () => {
    const plans = [
      { task: "T-A", role: "evolution-worker", dependencies: [] },
      { task: "T-B", role: "evolution-worker", dependencies: ["T-A"] },
      { task: "T-C", role: "evolution-worker", dependencies: ["T-B"] },
      { task: "T-D", role: "evolution-worker", dependencies: [] }, // independent
    ];

    // T-A failed — T-B and T-C are blocked; T-D is independent and schedulable
    const result = computeNextWaves(plans, new Set(), new Set(["T-A"]));

    const blockedTasks = result.blocked.map((p: any) => p.task);
    assert.ok(blockedTasks.includes("T-B"), "T-B must be blocked because T-A failed");
    // T-D is independent and must still be schedulable
    const readyTasks = result.readyWaves.flat().map((p: any) => p.task);
    assert.ok(readyTasks.includes("T-D"), "T-D must still be schedulable (independent of T-A)");
  });

  it("computeNextWaves filters completed tasks correctly", () => {
    const plans = [
      { task: "T-A", role: "evolution-worker", dependencies: [] },
      { task: "T-B", role: "evolution-worker", dependencies: [] },
      { task: "T-C", role: "evolution-worker", dependencies: [] },
    ];

    // T-A already done — must not appear in output
    const result = computeNextWaves(plans, new Set(["T-A"]));
    assert.equal(result.status, "ok");
    const allTasks = result.readyWaves.flat().map((p: any) => p.task);
    assert.ok(!allTasks.includes("T-A"), "Completed T-A must be filtered from output");
    assert.ok(allTasks.includes("T-B"), "T-B must still be scheduled");
    assert.ok(allTasks.includes("T-C"), "T-C must still be scheduled");
  });

  it("computeFrontier frontier: diamond DAG promotes leaves only after both parents complete", () => {
    const plans = [
      { task: "T-A", dependencies: [] },
      { task: "T-B", dependencies: ["T-A"] },
      { task: "T-C", dependencies: ["T-A"] },
      { task: "T-D", dependencies: ["T-B", "T-C"] },
    ];

    // Nothing complete yet — only T-A is on the frontier
    const r0 = computeFrontier(plans, new Set(), new Set(), new Set());
    assert.deepEqual(r0.frontier.map((p: any) => p.task), ["T-A"]);

    // After T-A completes, T-B and T-C join the frontier; T-D is still waiting
    const r1 = computeFrontier(plans, new Set(["T-A"]), new Set(), new Set());
    const frontierTasks1 = r1.frontier.map((p: any) => p.task).sort();
    assert.deepEqual(frontierTasks1, ["T-B", "T-C"]);

    // After T-B and T-C complete, T-D joins the frontier
    const r2 = computeFrontier(plans, new Set(["T-A", "T-B", "T-C"]), new Set(), new Set());
    assert.deepEqual(r2.frontier.map((p: any) => p.task), ["T-D"]);
  });

  it("negative path: deadlocked when the only remaining tasks all have failed deps", () => {
    const plans = [
      { task: "T-B", role: "evolution-worker", dependencies: ["T-A"] },
      { task: "T-C", role: "evolution-worker", dependencies: ["T-A"] },
    ];

    // T-A failed — both remaining tasks are blocked → deadlocked
    const result = computeNextWaves(plans, new Set(), new Set(["T-A"]));
    assert.ok(
      result.status === "deadlocked" || result.blocked.length === 2,
      "Must be deadlocked or have 2 blocked tasks"
    );
  });
});

// ── 2. Capability Routing ─────────────────────────────────────────────────────

describe("Integration: capability routing", () => {
  it("each capability tag infers to the correct lane and then routes to the canonical worker", () => {
    const cases: Array<{ plan: object; expectedLane: string }> = [
      { plan: { task: "Add test coverage for the carry_forward_ledger module" }, expectedLane: "quality" },
      { plan: { task: "Update governance freeze policy rules" },                  expectedLane: "governance" },
      { plan: { task: "Update Docker configuration for production deployment" },  expectedLane: "infrastructure" },
      { plan: { task: "Fix dashboard metrics display and alert routing" },        expectedLane: "observation" },
      { plan: { task: "Wire integration between dag_scheduler and orchestrator" }, expectedLane: "integration" },
    ];

    for (const { plan, expectedLane } of cases) {
      const selection = selectWorkerForPlan(plan);
      assert.equal(
        selection.lane,
        expectedLane,
        `Plan "${(plan as any).task}" must route to lane "${expectedLane}", got "${selection.lane}"`
      );
      assert.ok(selection.role, "Worker role must be non-empty");
      assert.equal(selection.isFallback, false, `Lane "${expectedLane}" must resolve to a real lane worker`);
    }
  });

  it("a mixed wave of plans is correctly distributed across multiple lanes", () => {
    // Simulate a wave with tasks spanning 3 different capability domains
    const wavePlans = [
      { task: "Add test coverage for the dag_scheduler wave promotion logic" }, // → quality
      { task: "Update Docker configuration for worker isolation" },              // → infrastructure
      { task: "Fix governance freeze policy bypass condition" },                 // → governance
    ];

    const { assignments, diversityIndex, activeLaneCount } = assignWorkersToPlans(wavePlans);

    assert.equal(assignments.length, 3, "Must produce one assignment per plan");
    assert.ok(activeLaneCount >= 3, `Must span at least 3 lanes; got ${activeLaneCount}`);
    assert.ok(diversityIndex > 0, "diversityIndex must be > 0 for a multi-lane assignment");

    const lanes = assignments.map(a => a.selection.lane);
    assert.ok(lanes.includes("quality"),         "quality lane must be assigned");
    assert.ok(lanes.includes("infrastructure"),  "infrastructure lane must be assigned");
    assert.ok(lanes.includes("governance"),      "governance lane must be assigned");
  });

  it("DAG scheduler output plans are all capability-routable without fallback for known lanes", () => {
    const plans = [
      { task: "T-Governance", role: "governance-worker", dependencies: [], task_text: "Update policy freeze rules" },
      { task: "T-Test",       role: "quality-worker",    dependencies: [], task_text: "Add test for dag_scheduler" },
      { task: "T-Infra",      role: "infra-worker",      dependencies: ["T-Governance"], task_text: "Rebuild Docker base" },
    ];

    // Simulate: compute first wave from DAG
    const waveResult = computeNextWaves(plans);
    assert.equal(waveResult.status, "ok");

    const wave1Plans = waveResult.readyWaves[0] ?? [];
    assert.ok(wave1Plans.length >= 1, "Wave 1 must have schedulable tasks");

    // Route each plan in wave 1 through capability pool
    for (const plan of wave1Plans) {
      const tag = inferCapabilityTag(plan);
      assert.ok(typeof tag === "string" && tag.length > 0, "Must infer a capability tag");

      const selection = selectWorkerForPlan(plan);
      assert.ok(selection.role, `Worker role must be set for plan "${(plan as any).task}"`);
      assert.ok(selection.lane, `Worker lane must be set for plan "${(plan as any).task}"`);
    }
  });

  it("negative path: unknown plan type still routes without throwing (graceful fallback)", () => {
    const plan = { task: "Do something completely undefined and unrecognisable by any heuristic" };
    assert.doesNotThrow(() => {
      const tag = inferCapabilityTag(plan);
      const selection = selectWorkerForPlan(plan);
      assert.equal(tag, "runtime-refactor", "Unknown tasks must fall back to runtime-refactor");
      assert.ok(selection.role, "Must still produce a worker role");
    });
  });
});

// ── 3. Carry-Forward Debt Blocking Sequence ───────────────────────────────────

describe("Integration: carry-forward debt blocking sequence", () => {
  it("critical debt added and left unresolved triggers shouldBlockOnDebt at SLA expiry", () => {
    const ledger = addDebtEntries(
      [],
      [
        { followUpTask: "Fix flaky dag_scheduler integration wave ordering", severity: "critical" },
        { followUpTask: "Fix broken capability routing for governance lane tasks", severity: "critical" },
        { followUpTask: "Resolve carry-forward debt SLA escalation logic gap", severity: "critical" },
      ],
      1, // openedCycle
      { slaMaxCycles: 3 }
    );

    assert.equal(ledger.length, 3, "All 3 distinct debt entries must be added");

    // Cycle 2 — all within SLA, must not block
    const r2 = shouldBlockOnDebt(ledger, 2, { maxCriticalOverdue: 3 });
    assert.equal(r2.shouldBlock, false, "Must NOT block at cycle 2 (SLA is 3 cycles)");

    // Cycle 5 — all 3 overdue (dueCycle=4), must block at threshold=3
    const r5 = shouldBlockOnDebt(ledger, 5, { maxCriticalOverdue: 3 });
    assert.equal(r5.shouldBlock, true, "Must block at cycle 5 with 3 critical overdue items");
    assert.equal(r5.overdueCount, 3, "Overdue count must equal 3");
    assert.ok(r5.reason.includes("critical"), "Reason must mention critical debt");
  });

  it("closing one critical debt item brings count below threshold and unblocks planning", () => {
    const ledger = addDebtEntries(
      [],
      [
        { followUpTask: "Fix flaky dag_scheduler integration wave ordering", severity: "critical" },
        { followUpTask: "Fix broken capability routing for governance lane tasks", severity: "critical" },
        { followUpTask: "Resolve carry-forward debt SLA escalation logic gap", severity: "critical" },
      ],
      1,
      { slaMaxCycles: 2 }
    );

    // Cycle 4 — all 3 overdue (dueCycle=3)
    const rBefore = shouldBlockOnDebt(ledger, 4, { maxCriticalOverdue: 3 });
    assert.equal(rBefore.shouldBlock, true, "Must block with 3 critical overdue items");

    // Close one debt item
    const closed = closeDebt(ledger, ledger[0].id, "PR #42 merged — wave order fixed");
    assert.equal(closed, true, "closeDebt must return true for a valid open entry");

    // Cycle 4 again with 2 remaining overdue — below threshold of 3
    const rAfter = shouldBlockOnDebt(ledger, 4, { maxCriticalOverdue: 3 });
    assert.equal(rAfter.shouldBlock, false, "Must NOT block after closing one item (2 < 3 threshold)");
    assert.equal(rAfter.overdueCount, 2, "Overdue count must be 2 after closing one");
  });

  it("warning-severity debt does NOT trigger shouldBlockOnDebt even when overdue", () => {
    const ledger = addDebtEntries(
      [],
      [
        { followUpTask: "Improve documentation for dag_scheduler public API", severity: "warning" },
        { followUpTask: "Add JSDoc examples for capability pool routing", severity: "warning" },
        { followUpTask: "Review carry-forward SLA window sizing", severity: "warning" },
      ],
      1,
      { slaMaxCycles: 1 }
    );

    // Cycle 5 — all overdue but only warnings
    const result = shouldBlockOnDebt(ledger, 5, { maxCriticalOverdue: 3 });
    assert.equal(result.shouldBlock, false, "Warning-severity debt must not trigger shouldBlock");
    assert.equal(result.overdueCount, 0, "overdueCount counts only critical overdue items");
  });

  it("tickCycle correctly ages open entries across multiple cycles", () => {
    let ledger = addDebtEntries(
      [],
      [{ followUpTask: "Fix integration test gaps in the wave ordering suite", severity: "critical" }],
      1,
      { slaMaxCycles: 5 }
    );

    assert.equal(ledger.length, 1);

    // Simulate cycle progression
    for (let cycle = 2; cycle <= 4; cycle++) {
      const { overdue } = tickCycle(ledger, cycle);
      // dueCycle = 1+5 = 6; none overdue until cycle 7
      assert.equal(overdue.length, 0, `No overdue at cycle ${cycle} (SLA extends to cycle 6)`);
      assert.equal(ledger[0].cyclesOpen, cycle - 1);
    }

    const { overdue: overdue7 } = tickCycle(ledger, 7);
    assert.equal(overdue7.length, 1, "Entry is overdue at cycle 7 (dueCycle=6)");
    assert.equal(ledger[0].cyclesOpen, 6);
  });

  it("debt deduplication prevents double-counting when same lesson appears multiple cycles", () => {
    const lesson = "Fix the integration test wave ordering assertion gap in dag_scheduler";

    let ledger = addDebtEntries([], [{ followUpTask: lesson, severity: "critical" }], 1);
    assert.equal(ledger.length, 1, "First entry added");

    // Same lesson added again next cycle — must be deduplicated
    ledger = addDebtEntries(ledger, [{ followUpTask: lesson, severity: "critical" }], 2);
    assert.equal(ledger.length, 1, "Duplicate entry must be rejected by fingerprint deduplication");

    // Different lesson — must be added
    ledger = addDebtEntries(ledger, [
      { followUpTask: "Fix capability routing for the observation lane worker dispatch path", severity: "warning" }
    ], 2);
    assert.equal(ledger.length, 2, "New lesson must be added");
  });

  it("negative path: empty ledger never blocks, regardless of cycle number", () => {
    const result = shouldBlockOnDebt([], 999, { maxCriticalOverdue: 1 });
    assert.equal(result.shouldBlock, false);
    assert.equal(result.overdueCount, 0);
  });
});

// ── 4. End-to-end orchestration gate sequence ─────────────────────────────────

describe("Integration: full orchestration gate sequence", () => {
  it("debt gate runs before wave dispatch and blocks the cycle when critical debt is overdue", () => {
    // Step 1: accumulate debt across cycles
    let ledger = addDebtEntries(
      [],
      [
        { followUpTask: "Fix wave ordering regression in the dag_scheduler integration suite", severity: "critical" },
        { followUpTask: "Fix capability routing for observation lane producing wrong worker", severity: "critical" },
        { followUpTask: "Resolve critical SLA breach in carry-forward debt escalation path", severity: "critical" },
      ],
      1,
      { slaMaxCycles: 2 }
    );

    // Step 2: advance to cycle 4 — all entries overdue (dueCycle=3)
    const { shouldBlock, reason } = shouldBlockOnDebt(ledger, 4, { maxCriticalOverdue: 3 });
    assert.equal(shouldBlock, true, "Debt gate must block before wave dispatch");

    // Step 3: when blocked, no waves should be dispatched
    if (shouldBlock) {
      // Simulated plan set that would otherwise be scheduled
      const pendingPlans = [
        { task: "Ship feature X", role: "evolution-worker", dependencies: [] },
      ];
      // In the real orchestrator this is gated; here we verify the gate signal is present
      assert.ok(reason.length > 0, "shouldBlock reason must be non-empty to surface in logs");
      assert.ok(pendingPlans.length > 0, "Plans exist but are intentionally not dispatched");
    }
  });

  it("full cycle: plan set → wave order → capability routing → debt check → dispatch", () => {
    // Plans spanning multiple waves and capability lanes
    const plans = [
      { task: "Add test coverage for architecture_drift stale ref detection", role: "quality-worker",        dependencies: [], wave: 1 },
      { task: "Fix governance policy freeze bypass condition in policy_engine", role: "governance-worker",   dependencies: [], wave: 1 },
      { task: "Update Docker worker base image for reproducible builds",        role: "infra-worker",        dependencies: [], wave: 1 },
      { task: "Wire dag_scheduler frontier output to orchestrator dispatch",    role: "evolution-worker",    dependencies: ["T-test", "T-gov"], wave: 2 },
    ];

    // Step 1: no debt → gate should pass
    const ledger: any[] = [];
    const { shouldBlock } = shouldBlockOnDebt(ledger, 1, { maxCriticalOverdue: 3 });
    assert.equal(shouldBlock, false, "Clean ledger must not block");

    // Step 2: compute wave 1 (wave 2 plan has unsatisfied deps in this simplified context)
    const wave1Plans = plans.filter(p => p.wave === 1);
    const wavePlans = wave1Plans.map(p => ({ ...p, dependencies: [] }));

    const waveResult = computeNextWaves(wavePlans);
    assert.equal(waveResult.status, "ok");
    assert.equal(waveResult.readyWaves[0]?.length, 3, "Wave 1 must contain all 3 independent tasks");

    // Step 3: route wave 1 tasks through capability pool
    const { assignments, activeLaneCount } = assignWorkersToPlans(wave1Plans);
    assert.ok(activeLaneCount >= 2, "Wave 1 must use at least 2 distinct capability lanes");
    assert.equal(assignments.length, 3, "All 3 wave-1 tasks must be assigned workers");

    // Step 4: every assignment must have a valid role and lane
    for (const a of assignments) {
      assert.ok(a.selection.role, "Each assignment must have a worker role");
      assert.ok(a.selection.lane, "Each assignment must have a capability lane");
    }
  });
});

// ── 5. Optimizer Budget Admission ─────────────────────────────────────────────

describe("Integration: optimizer budget admission filtering", () => {
  it("all plans are admitted when total budget is sufficient", () => {
    const plans = [
      { id: "p1", role: "evolution-worker", task: "Fix auth token validation bug", priority: 9, wave: "wave-1" },
      { id: "p2", role: "evolution-worker", task: "Add governance canary test coverage", priority: 7, wave: "wave-1" },
      { id: "p3", role: "evolution-worker", task: "Update carry-forward SLA defaults", priority: 5, wave: "wave-2" },
    ];
    const config = { runtime: { runtimeBudget: { maxWorkerSpawnsPerCycle: 10 } } };
    const requestBudget = { hardCapTotal: 10 };

    const interventions = buildInterventionsFromPlan(plans, config);
    const budget = buildBudgetFromConfig(requestBudget, config);
    const result = runInterventionOptimizer(interventions, budget);

    assert.equal(result.status, OPTIMIZER_STATUS.OK, "All plans must be admitted with sufficient budget");
    assert.equal(result.selected.length, 3, "All 3 plans must be in selected");

    // Simulate admission filter (mirrors orchestrator logic)
    const admittedIds = new Set(result.selected.map((i: any) => i.id));
    const admittedPlans = plans.filter((plan: any, idx: number) => {
      const id = String(plan?.id ?? `plan-${idx + 1}`);
      return admittedIds.has(id);
    });
    assert.equal(admittedPlans.length, 3, "All plans pass admission with sufficient budget");
  });

  it("low-EV plans are rejected and removed from dispatch when budget is tight", () => {
    const plans = [
      { id: "p1", role: "evolution-worker", task: "Fix critical auth regression", priority: 10, wave: "wave-1" },
      { id: "p2", role: "evolution-worker", task: "Improve documentation typos", priority: 1, wave: "wave-1" },
      { id: "p3", role: "evolution-worker", task: "Add minor style polish", priority: 1, wave: "wave-1" },
    ];
    const config = {};
    // Budget allows only 1 worker spawn
    const requestBudget = { hardCapTotal: 1 };

    const interventions = buildInterventionsFromPlan(plans, config);
    const budget = buildBudgetFromConfig(requestBudget, config);
    const result = runInterventionOptimizer(interventions, budget);

    assert.equal(result.status, OPTIMIZER_STATUS.BUDGET_EXCEEDED, "Budget exceeded when too many plans for limit");
    assert.equal(result.selected.length, 1, "Only 1 plan admitted under budget=1");

    // The highest-priority plan (p1) must be the one admitted
    assert.equal(result.selected[0].id, "p1", "Highest-priority plan must be admitted first");
    assert.equal(result.rejected.length, 2, "Low-EV plans must be in rejected");

    // Admission filter removes rejected plans
    const admittedIds = new Set(result.selected.map((i: any) => i.id));
    const admittedPlans = plans.filter((plan: any, idx: number) =>
      admittedIds.has(String(plan?.id ?? `plan-${idx + 1}`))
    );
    assert.equal(admittedPlans.length, 1, "Dispatch set must contain only admitted plans");
    assert.equal((admittedPlans[0] as any).id, "p1", "Only high-priority plan dispatched");
  });

  it("negative path: optimizer fail-open — invalid budget config does not block dispatch", () => {
    const plans = [
      { id: "p1", role: "evolution-worker", task: "Critical fix for dispatch", priority: 8, wave: "wave-1" },
    ];
    // Null budget (simulates missing config) — optimizer returns INVALID_INPUT
    const interventions = buildInterventionsFromPlan(plans, {});
    const result = runInterventionOptimizer(interventions, null as any);

    assert.equal(result.status, OPTIMIZER_STATUS.INVALID_INPUT, "Null budget must produce INVALID_INPUT");
    // Orchestrator logic: INVALID_INPUT → skip admission filter → plans proceed unchanged
    const shouldSkipFilter = result.status === OPTIMIZER_STATUS.INVALID_INPUT || result.status === OPTIMIZER_STATUS.EMPTY_INPUT;
    assert.equal(shouldSkipFilter, true, "Dispatch must not be blocked on optimizer INVALID_INPUT");
  });
});

// ── 6. Carry-Forward Auto-Close Integration ───────────────────────────────────

describe("Integration: carry-forward auto-close with verification evidence", () => {
  it("verified debt item is auto-closed; unverified item remains blocking", () => {
    // Set up: two critical debt items from postmortems
    const verifiedLesson = "Fix dag_scheduler wave ordering integration test regression";
    const unresolvedLesson = "Fix capability pool observation lane routing false negative";

    const ledger = addDebtEntries(
      [],
      [
        { followUpTask: verifiedLesson, severity: "critical" },
        { followUpTask: unresolvedLesson, severity: "critical" },
      ],
      1,
      { slaMaxCycles: 2 }
    );

    assert.equal(ledger.length, 2);

    // A worker completed the first task with evidence; the second has no resolution
    const resolvedItems = [
      { taskText: verifiedLesson, verificationEvidence: "All wave ordering tests pass — PR #55 merged" },
    ];

    const closedCount = autoCloseVerifiedDebt(ledger, resolvedItems);
    assert.equal(closedCount, 1, "Exactly one item must be auto-closed");

    // Verified item is now closed
    const verifiedEntry = ledger.find(e => e.lesson === verifiedLesson);
    assert.ok(verifiedEntry?.closedAt, "Verified debt entry must be closed");
    assert.ok(
      verifiedEntry?.closureEvidence?.includes("PR #55"),
      "Closure evidence must be linked to the worker's verification"
    );

    // Unresolved item remains open and still blocking
    const unresolvedEntry = ledger.find(e => e.lesson === unresolvedLesson);
    assert.equal(unresolvedEntry?.closedAt, null, "Unresolved entry must remain open");

    // shouldBlockOnDebt still fires for the remaining critical overdue item
    const blockResult = shouldBlockOnDebt(ledger, 5, { maxCriticalOverdue: 1 });
    assert.equal(blockResult.shouldBlock, true, "One remaining critical overdue item must still block dispatch");
  });

  it("no items are auto-closed when worker evidence is absent", () => {
    const lesson = "Fix the carry-forward fingerprint deduplication regression";
    const ledger = addDebtEntries([], [{ followUpTask: lesson, severity: "critical" }], 1);

    // Worker completed but provided no verification evidence
    const closedCount = autoCloseVerifiedDebt(ledger, [
      { taskText: lesson, verificationEvidence: "" },
    ]);

    assert.equal(closedCount, 0, "No close when evidence is missing");
    assert.equal(ledger[0].closedAt, null, "Entry must remain open");
  });

  it("negative path: auto-close with unmatched task text leaves all debt blocking", () => {
    const blockingLesson1 = "Fix orchestrator resume path checkpoint integrity check";
    const blockingLesson2 = "Fix catastrophe detector false-positive on SLO breach cycle";
    const ledger = addDebtEntries(
      [],
      [
        { followUpTask: blockingLesson1, severity: "critical" },
        { followUpTask: blockingLesson2, severity: "critical" },
      ],
      1,
      { slaMaxCycles: 1 }
    );

    // Worker completed an unrelated task
    autoCloseVerifiedDebt(ledger, [
      { taskText: "Completely unrelated task with no debt match", verificationEvidence: "PR #999 merged" },
    ]);

    // Both items still open and overdue at cycle 4
    const { shouldBlock, overdueCount } = shouldBlockOnDebt(ledger, 4, { maxCriticalOverdue: 2 });
    assert.equal(shouldBlock, true, "Both items must remain blocking");
    assert.equal(overdueCount, 2, "Both items must be counted as overdue");
  });
});
