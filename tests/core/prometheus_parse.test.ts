import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizePrometheusParsedOutput,
  filterResolvedCarryForwardItems,
  CARRY_FORWARD_MAX_TOKENS,
  BEHAVIOR_PATTERNS_MAX_TOKENS,
  PROMETHEUS_STATIC_SECTIONS,
  computeDriftConfidencePenalty,
  DRIFT_REMEDIATION_THRESHOLD,
} from "../../src/core/prometheus.js";
import { compilePrompt } from "../../src/core/prompt_compiler.js";

describe("normalizePrometheusParsedOutput", () => {
  it("maps tasks/waves decision payload into planner plans", () => {
    const parsed = {
      cycleObjective: "Eliminate recurring verification false-fails",
      tasks: [
        {
          task_id: "T-VH-001",
          title: "Fix verification harness",
          verification_commands: ["npm test"],
          acceptance_criteria: ["Windows glob false-fail rate is zero"]
        },
        {
          task_id: "T-CF-003",
          title: "Automate carry-forward escalation",
          verification_commands: ["npm test"]
        }
      ],
      waves: [
        { wave: 1, tasks: ["T-VH-001"] },
        { wave: 2, tasks: ["T-CF-003"] }
      ]
    };

    const normalized = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(normalized.projectHealth, "needs-work");
    assert.equal(Array.isArray(normalized.plans), true);
    assert.equal(normalized.plans.length, 2);
    assert.equal(normalized.plans[0].task, "Fix verification harness");
    assert.equal(normalized.plans[0].wave, 1);
    assert.equal(normalized.plans[0].verification, "npm test");
    assert.equal(normalized.plans[1].wave, 2);
  });

  it("maps topBottlenecks + string-task waves (GPT analytical format) into planner plans", () => {
    const parsed = {
      projectHealth: "needs-work",
      topBottlenecks: [
        {
          id: "BN-1",
          title: "Jesus reads trump_analysis.json (non-existent)",
          severity: "critical",
          evidence: "jesus_supervisor.js:283 reads trump_analysis.json; never populated"
        },
        {
          id: "BN-2",
          title: "Sequential worker dispatch ignores wave infrastructure",
          severity: "high",
          evidence: "orchestrator.js:740 sequential for-loop"
        }
      ],
      waves: [
        {
          wave: 1,
          tasks: ["Fix-1: trump→prometheus reference fix"],
          workerSlots: 1,
          rationale: "Correctness bugs"
        },
        {
          wave: 2,
          tasks: ["Fix-2: wave-parallel worker dispatch"],
          workerSlots: 1,
          rationale: "Throughput improvement"
        }
      ],
      proofMetrics: [
        "prometheusAnalysis.projectHealth non-null in jesus_directive.json after trump fix",
        "cycle wall-clock time p50 reduction >= 40% after wave-parallel dispatch"
      ],
      requestBudget: { estimatedPremiumRequestsTotal: 2, errorMarginPercent: 30, hardCapTotal: 3 }
    };

    const normalized = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(normalized.projectHealth, "needs-work");
    assert.equal(Array.isArray(normalized.plans), true);
    assert.equal(normalized.plans.length, 2);
    // Wave 1 plan
    assert.equal(normalized.plans[0].wave, 1);
    assert.equal(normalized.plans[0].role, "evolution-worker");
    assert.equal(typeof normalized.plans[0].task, "string");
    assert.ok(normalized.plans[0].task.length > 0);
    // Wave 2 plan
    assert.equal(normalized.plans[1].wave, 2);
    // Priority should reflect severity — BN-1 is critical → priority 1
    assert.equal(normalized.plans[0].priority, 1);
  });

  it("keeps valid planner plans and fills missing required fields", () => {
    const parsed = {
      analysis: "System is stable but has quality debt",
      projectHealth: "good",
      executionStrategy: { waves: [] },
      plans: [
        {
          task: "Harden trust boundary"
        }
      ]
    };

    const normalized = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(normalized.projectHealth, "good");
    assert.equal(normalized.plans.length, 1);
    assert.equal(normalized.plans[0].role, "evolution-worker");
    assert.equal(normalized.plans[0].verification, "npm test");
    assert.equal(normalized.plans[0].priority, 1);
  });

  it("maps DECISION-style waves with string task ids into actionable plans", () => {
    const parsed = {
      maxTasks: 5,
      waves: [
        { wave: 1, tasks: ["verification-harness-fix", "decision-router-hardening"] },
        { wave: 2, dependsOn: [1], tasks: ["closed-loop-learning-ledger"] }
      ],
      blockingCarryForwardIncluded: true
    };

    const normalized = normalizePrometheusParsedOutput(parsed, {
      thinking: "Prometheus created a dependency-aware plan",
      raw: ""
    });

    assert.equal(normalized.plans.length, 3);
    assert.equal(normalized.plans[0].wave, 1);
    assert.equal(normalized.plans[1].wave, 1);
    assert.equal(normalized.plans[2].wave, 2);
    assert.equal(normalized.plans[0].task, "verification-harness-fix");
    assert.equal(normalized.plans[0].role, "evolution-worker");
  });

  it("always emits requestBudget to satisfy trust boundary", () => {
    const parsed = {
      waves: [{ wave: 1, tasks: ["premium-efficiency-controller"] }]
    };

    const normalized = normalizePrometheusParsedOutput(parsed, {
      thinking: "Plan with one task",
      raw: ""
    });

    assert.ok(normalized.requestBudget);
    assert.equal(
      Number.isFinite(Number(normalized.requestBudget.estimatedPremiumRequestsTotal)),
      true
    );
    assert.equal(Number(normalized.requestBudget.hardCapTotal) >= 1, true);
  });

  it("extracts plans from narrative wave sections when no JSON plans exist", () => {
    const parsed = {};
    const thinking = `
Wave 1 (blocking)
1) Fix Windows verification harness
2) Add planning gate for missing harness fix

Wave 2
3) Upgrade evaluation stack
`;

    const normalized = normalizePrometheusParsedOutput(parsed, { thinking, raw: "" });

    assert.equal(normalized.plans.length, 3);
    assert.equal(normalized.plans[0].wave, 1);
    assert.equal(normalized.plans[1].wave, 1);
    assert.equal(normalized.plans[2].wave, 2);
    assert.ok(normalized.plans[0].task.toLowerCase().includes("verification harness"));
  });

  it("synthesizes concrete Athena-facing fields for template-like plans", () => {
    const parsed = {
      analysis: "Capacity increase is bottlenecked by integration closure.",
      plans: [
        { task: "Add trust-boundary provider integration tests for untrusted linter payloads" },
        { task: "Introduce critical-path scheduling over dependency-aware waves" },
        { task: "Add uncertainty-aware model routing with ROI feedback loop", wave: 2 }
      ]
    };

    const normalized = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.ok(normalized.plans[0].target_files.length > 0);
    assert.ok(normalized.plans[0].scope.length > 0);
    assert.ok(normalized.plans[0].acceptance_criteria.length >= 2);
    assert.ok(/deterministic test/i.test(normalized.plans[0].before_state));

    assert.equal(normalized.plans[1].riskLevel, "high");
    assert.ok(normalized.plans[1].premortem);
    assert.ok(normalized.plans[1].premortem.failurePaths.length >= 1);

    assert.equal(normalized.plans[2].riskLevel, "high");
    assert.ok(normalized.plans[2].target_files.includes("src/core/model_router.ts"));
  });
});

describe("normalizePrometheusParsedOutput — confidence components", () => {
  it("emits full-score components when plans are JSON-direct and health is explicit", () => {
    const parsed = {
      projectHealth: "good",
      plans: [{ task: "Fix verification harness", role: "evolution-worker" }],
      requestBudget: { estimatedPremiumRequestsTotal: 2, errorMarginPercent: 15, hardCapTotal: 3 }
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.ok(result.parserConfidenceComponents, "parserConfidenceComponents must be present");
    assert.equal(result.parserConfidenceComponents.plansShape, 1.0);
    assert.equal(result.parserConfidenceComponents.healthField, 1.0);
    assert.equal(result.parserConfidenceComponents.requestBudget, 1.0);
    assert.ok(Array.isArray(result.parserConfidencePenalties), "parserConfidencePenalties must be an array");
    assert.equal(result.parserConfidencePenalties.length, 0, "no penalties expected for full-score output");
    assert.equal(result.parserConfidence, 1.0);
  });

  it("emits plansShape=0.5 and a narrative-fallback penalty when plans come from waves", () => {
    const parsed = {
      projectHealth: "needs-work",
      waves: [{ wave: 1, tasks: ["Fix trust boundary"] }],
      requestBudget: { estimatedPremiumRequestsTotal: 1, errorMarginPercent: 15, hardCapTotal: 2 }
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(result.parserConfidenceComponents.plansShape, 0.5);
    const penalty = result.parserConfidencePenalties.find(p => p.component === "plansShape");
    assert.ok(penalty, "must have a plansShape penalty");
    assert.equal(penalty.reason, "plans_from_narrative_fallback");
    assert.equal(penalty.delta, -0.5);
    assert.equal(result.parserConfidence, 0.5);
  });

  it("emits healthField=0.8 and a health-field penalty when projectHealth is missing", () => {
    const parsed = {
      plans: [{ task: "Add canary metrics", role: "evolution-worker" }],
      requestBudget: { estimatedPremiumRequestsTotal: 1, errorMarginPercent: 15, hardCapTotal: 2 }
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(result.parserConfidenceComponents.healthField, 0.8);
    const penalty = result.parserConfidencePenalties.find(p => p.component === "healthField");
    assert.ok(penalty, "must have a healthField penalty");
    assert.equal(penalty.reason, "health_field_missing_or_invalid");
    assert.equal(penalty.delta, -0.2);
    assert.equal(result.parserConfidence, 0.8);
  });

  it("emits requestBudget=0.9 and a budget-fallback penalty when requestBudget is absent", () => {
    const parsed = {
      projectHealth: "good",
      plans: [{ task: "Improve retry logic", role: "evolution-worker" }],
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(result.parserConfidenceComponents.requestBudget, 0.9);
    const penalty = result.parserConfidencePenalties.find(p => p.component === "requestBudget");
    assert.ok(penalty, "must have a requestBudget penalty");
    assert.equal(penalty.reason, "request_budget_fallback");
    assert.equal(penalty.delta, -0.1);
    assert.equal(result.parserConfidence, 0.9);
  });

  it("accumulates multiple penalties correctly", () => {
    // Narrative plans (base=0.5) + missing health (-0.2) + no budget (-0.1) = 0.2
    const parsed = {
      waves: [{ wave: 1, tasks: ["Fix parser"] }],
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    assert.equal(result.parserConfidenceComponents.plansShape, 0.5);
    assert.equal(result.parserConfidenceComponents.healthField, 0.8);
    assert.equal(result.parserConfidenceComponents.requestBudget, 0.9);
    assert.equal(result.parserConfidencePenalties.length, 3);
    // 0.5 - 0.2 - 0.1 = 0.2
    assert.equal(result.parserConfidence, 0.2);
  });

  it("emits plansShape=0.0 and no_plans_extracted penalty when no plans are found", () => {
    const result = normalizePrometheusParsedOutput({}, { raw: "" });

    assert.equal(result.parserConfidenceComponents.plansShape, 0.0);
    const penalty = result.parserConfidencePenalties.find(p => p.reason === "no_plans_extracted");
    assert.ok(penalty, "must have a no_plans_extracted penalty");
    assert.equal(penalty.component, "plansShape");
  });

  it("each penalty entry has required fields: reason, component, delta", () => {
    const parsed = {
      waves: [{ wave: 1, tasks: ["Fix something"] }],
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });

    for (const p of result.parserConfidencePenalties) {
      assert.ok(typeof p.reason === "string" && p.reason.length > 0, "penalty must have reason");
      assert.ok(typeof p.component === "string" && p.component.length > 0, "penalty must have component");
      assert.ok(typeof p.delta === "number" && p.delta < 0, "penalty delta must be a negative number");
    }
  });
});

describe("filterResolvedCarryForwardItems", () => {
  const makePending = (followUpTask, workerName = "evolution-worker") => ({
    followUpNeeded: true,
    followUpTask,
    workerName,
    reviewedAt: "2025-01-01",
  });

  it("returns all items when ledger is empty and no completedTasks", () => {
    const pending = [makePending("Fix flaky test in worker runner"), makePending("Add trust-boundary coverage")];
    const result = filterResolvedCarryForwardItems(pending, [], []);
    assert.equal(result.length, 2);
  });

  it("retires items closed in the carry-forward ledger", () => {
    const pending = [
      makePending("Fix flaky test in worker runner"),
      makePending("Add trust-boundary coverage"),
    ];
    const ledger = [
      { id: "debt-1-0", lesson: "Fix flaky test in worker runner", closedAt: "2025-02-01T00:00:00Z", closureEvidence: "PR #99" },
      { id: "debt-1-1", lesson: "Another open item", closedAt: null },
    ];
    const result = filterResolvedCarryForwardItems(pending, ledger, []);
    assert.equal(result.length, 1);
    assert.equal(result[0].followUpTask, "Add trust-boundary coverage");
  });

  it("retires items present in coordinationCompletedTasks", () => {
    const pending = [makePending("Upgrade evaluation stack"), makePending("Add circuit breaker for model calls")];
    const result = filterResolvedCarryForwardItems(pending, [], ["Upgrade evaluation stack"]);
    assert.equal(result.length, 1);
    assert.equal(result[0].followUpTask, "Add circuit breaker for model calls");
  });

  it("uses fingerprint matching — strips noise before hashing so noise-equivalent texts are retired", () => {
    const pending = [makePending("Create and complete a task to fix the verification harness")];
    const ledger = [
      // lesson matches after canonicalization; closureEvidence confirms it shipped
      { id: "d1", lesson: "fix the verification harness", closedAt: "2025-03-01T00:00:00Z", closureEvidence: "PR #101" },
    ];
    const result = filterResolvedCarryForwardItems(pending, ledger, []);
    assert.equal(result.length, 0);
  });

  it("does NOT retire items whose ledger entry is closed without closureEvidence", () => {
    const pending = [makePending("Automate carry-forward escalation")];
    const ledger = [
      // closedAt is set but closureEvidence is absent — no proof of fix
      { id: "d1", lesson: "Automate carry-forward escalation", closedAt: "2025-03-01T00:00:00Z", closureEvidence: null },
    ];
    const result = filterResolvedCarryForwardItems(pending, ledger, []);
    assert.equal(result.length, 1);
  });

  it("keeps items whose ledger entry is open (closedAt = null)", () => {
    const pending = [makePending("Automate carry-forward escalation")];
    const ledger = [
      { id: "d1", lesson: "Automate carry-forward escalation", closedAt: null },
    ];
    const result = filterResolvedCarryForwardItems(pending, ledger, []);
    assert.equal(result.length, 1);
  });

  it("handles empty pendingEntries gracefully", () => {
    const result = filterResolvedCarryForwardItems([], [{ id: "d1", lesson: "anything", closedAt: "2025-01-01", closureEvidence: "done" }], []);
    assert.equal(result.length, 0);
  });

  it("handles null/undefined inputs without throwing", () => {
    const result = filterResolvedCarryForwardItems(null, null, null);
    assert.equal(result.length, 0);
  });
});

describe("PROMETHEUS_STATIC_SECTIONS", () => {
  it("exports all required static sections", () => {
    assert.ok(PROMETHEUS_STATIC_SECTIONS.evolutionDirective);
    assert.ok(PROMETHEUS_STATIC_SECTIONS.mandatorySelfCritique);
    assert.ok(PROMETHEUS_STATIC_SECTIONS.mandatoryOperatorQuestions);
    assert.ok(PROMETHEUS_STATIC_SECTIONS.outputFormat);
  });

  it("static sections have non-empty content", () => {
    for (const [key, sec] of Object.entries(PROMETHEUS_STATIC_SECTIONS)) {
      assert.ok(sec.content && sec.content.length > 0, `${key} section must have content`);
    }
  });

  it("evolutionDirective contains EVOLUTION DIRECTIVE and EQUAL DIMENSION SET headers", () => {
    const content = PROMETHEUS_STATIC_SECTIONS.evolutionDirective.content;
    assert.ok(content.includes("EVOLUTION DIRECTIVE"), "should contain EVOLUTION DIRECTIVE header");
    assert.ok(content.includes("EQUAL DIMENSION SET"), "should contain EQUAL DIMENSION SET header");
  });

  it("outputFormat contains ACTIONABLE IMPROVEMENT PACKET FORMAT and PACKET FIELD ENFORCEMENT RULES", () => {
    const content = PROMETHEUS_STATIC_SECTIONS.outputFormat.content;
    assert.ok(content.includes("ACTIONABLE IMPROVEMENT PACKET FORMAT"));
    assert.ok(content.includes("PACKET FIELD ENFORCEMENT RULES"));
    assert.ok(content.includes("===DECISION==="), "should contain JSON output markers");
  });
});

describe("carry-forward token cap constants", () => {
  it("CARRY_FORWARD_MAX_TOKENS is a positive number", () => {
    assert.ok(Number.isFinite(CARRY_FORWARD_MAX_TOKENS));
    assert.ok(CARRY_FORWARD_MAX_TOKENS > 0);
  });

  it("BEHAVIOR_PATTERNS_MAX_TOKENS is a positive number", () => {
    assert.ok(Number.isFinite(BEHAVIOR_PATTERNS_MAX_TOKENS));
    assert.ok(BEHAVIOR_PATTERNS_MAX_TOKENS > 0);
  });
});

// ── Task 1: Required-field retention in mandatory planning contract directives ──

describe("PROMETHEUS_STATIC_SECTIONS — required field marking (Task 1)", () => {
  const MANDATORY_KEYS = ["evolutionDirective", "mandatorySelfCritique", "mandatoryOperatorQuestions", "outputFormat"] as const;

  it("mandatory planning sections are marked required:true", () => {
    for (const key of MANDATORY_KEYS) {
      const sec = PROMETHEUS_STATIC_SECTIONS[key] as Record<string, unknown>;
      assert.strictEqual(sec.required, true, `${key} must have required:true`);
    }
  });

  it("mandatory sections are retained under tight token budget (token pressure simulation)", () => {
    // Simulate a very tight budget — mandatory sections must survive
    const sections = [
      { ...PROMETHEUS_STATIC_SECTIONS.evolutionDirective },
      { ...PROMETHEUS_STATIC_SECTIONS.outputFormat },
      { name: "optional-noise", content: "o".repeat(100_000) }, // ~25000 tokens
    ];
    const result = compilePrompt(sections, { tokenBudget: 100 });
    assert.ok(
      result.includes("EVOLUTION DIRECTIVE"),
      "evolutionDirective must be retained under token pressure"
    );
    assert.ok(
      result.includes("OUTPUT FORMAT"),
      "outputFormat must be retained under token pressure"
    );
  });

  it("non-mandatory sections can be dropped under token pressure", () => {
    const sections = [
      { ...PROMETHEUS_STATIC_SECTIONS.evolutionDirective },
      { name: "optional-filler", content: "OPTIONAL_CONTENT" }, // no required:true
    ];
    const result = compilePrompt(sections, { tokenBudget: 5 }); // very tight
    // The filler is optional and large — evolutionDirective (required) should remain
    assert.ok(result.includes("EVOLUTION DIRECTIVE"), "required section must survive");
  });
});

// ── Task 4: Drift confidence penalty ──────────────────────────────────────────

describe("computeDriftConfidencePenalty (Task 4)", () => {
  it("returns zero penalty for null/undefined drift report", () => {
    assert.deepEqual(computeDriftConfidencePenalty(null), { penalty: 0, reason: "no-drift-report", requiresRemediation: false });
    assert.deepEqual(computeDriftConfidencePenalty(undefined), { penalty: 0, reason: "no-drift-report", requiresRemediation: false });
  });

  it("returns zero penalty when staleCount and deprecatedTokenCount are both 0", () => {
    const result = computeDriftConfidencePenalty({ staleCount: 0, deprecatedTokenCount: 0 });
    assert.equal(result.penalty, 0);
    assert.equal(result.requiresRemediation, false);
  });

  it("returns a positive penalty proportional to total unresolved items", () => {
    const result = computeDriftConfidencePenalty({ staleCount: 3, deprecatedTokenCount: 2 }); // total=5
    assert.ok(result.penalty > 0, "penalty must be positive for non-zero drift");
    assert.ok(result.penalty <= 0.30, "penalty must not exceed cap of 0.30");
  });

  it("caps penalty at 0.30 regardless of very high drift count", () => {
    const result = computeDriftConfidencePenalty({ staleCount: 100, deprecatedTokenCount: 100 }); // total=200
    assert.equal(result.penalty, 0.30, "penalty is capped at 0.30");
  });

  it("sets requiresRemediation=true when total >= DRIFT_REMEDIATION_THRESHOLD", () => {
    const atThreshold = computeDriftConfidencePenalty({ staleCount: DRIFT_REMEDIATION_THRESHOLD, deprecatedTokenCount: 0 });
    assert.equal(atThreshold.requiresRemediation, true);
    const belowThreshold = computeDriftConfidencePenalty({ staleCount: DRIFT_REMEDIATION_THRESHOLD - 1, deprecatedTokenCount: 0 });
    assert.equal(belowThreshold.requiresRemediation, false);
  });

  it("reason string encodes total unresolved count", () => {
    const result = computeDriftConfidencePenalty({ staleCount: 2, deprecatedTokenCount: 1 });
    assert.ok(result.reason.includes("3"), "reason must encode total count (3)");
  });
});

// ── Batch/wave packet field preservation (current task) ───────────────────────

describe("normalizePrometheusParsedOutput — batch/wave packet field preservation", () => {
  it("preserves explicit owner field from a capability-aware plan", () => {
    const parsed = {
      projectHealth: "good",
      plans: [
        {
          task: "Harden trust boundary",
          role: "evolution-worker",
          owner: "orchestrator",
          wave: 1,
        }
      ]
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.equal(result.plans[0].owner, "orchestrator", "owner must be preserved from source plan");
  });

  it("synthesizes owner from role when owner is absent", () => {
    const parsed = {
      projectHealth: "good",
      plans: [{ task: "Fix parser", role: "governance-worker", wave: 1 }]
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.equal(result.plans[0].owner, "governance-worker", "owner should fall back to role");
  });

  it("defaults owner to evolution-worker when both owner and role are absent", () => {
    const parsed = {
      projectHealth: "good",
      plans: [{ task: "Fix something", wave: 1 }]
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.equal(result.plans[0].owner, "evolution-worker", "owner must default to evolution-worker");
  });

  it("preserves explicit leverage_rank array from a capability-aware plan", () => {
    const parsed = {
      projectHealth: "good",
      plans: [
        {
          task: "Improve wave dispatch",
          role: "evolution-worker",
          leverage_rank: ["speed", "task-quality"],
          wave: 1,
        }
      ]
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.deepEqual(result.plans[0].leverage_rank, ["speed", "task-quality"],
      "leverage_rank must be preserved from source plan");
  });

  it("defaults leverage_rank to empty array when absent", () => {
    const parsed = {
      projectHealth: "good",
      plans: [{ task: "Fix something", wave: 1 }]
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.deepEqual(result.plans[0].leverage_rank, [],
      "leverage_rank must default to empty array when absent");
  });

  it("synthesizes stub plans for string wave tasks that have no matching task entry", () => {
    // tasks[] has T-001 but waves[] also references T-999 which does not exist.
    // T-999 must NOT be silently dropped.
    const parsed = {
      tasks: [
        { task_id: "T-001", title: "Known task", wave: 1 }
      ],
      waves: [
        { wave: 1, tasks: ["T-001", "T-999"] }
      ]
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.equal(result.plans.length, 2, "unmatched wave task T-999 must produce a stub plan");
    const taskTexts = result.plans.map(p => p.task);
    assert.ok(taskTexts.includes("T-999"), "stub plan task must equal the unmatched task id string");
    assert.equal(result.plans.find(p => p.task === "T-999")?.wave, 1,
      "stub plan must have the correct wave assignment");
    assert.equal(result.plans.find(p => p.task === "T-999")?.role, "evolution-worker",
      "stub plan must be assigned a role");
  });

  it("propagates wave dependsOn to plan waveDepends via buildPlansFromAlternativeShape", () => {
    const parsed = {
      tasks: [
        { task_id: "T-001", title: "Foundation task" }
      ],
      waves: [
        { wave: 1, tasks: ["T-001"] },
        { wave: 2, dependsOn: [1], tasks: ["T-002"] }
      ]
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    const wave2Plan = result.plans.find(p => p.wave === 2);
    assert.ok(wave2Plan, "wave 2 plan must exist");
    assert.deepEqual(wave2Plan.waveDepends, [1],
      "wave 2 plan must carry waveDepends: [1] from the wave dependsOn field");
  });

  it("propagates wave dependsOn to plan waveDepends via buildPlansFromBottlenecksShape", () => {
    const parsed = {
      topBottlenecks: [
        { id: "BN-1", title: "Slow dispatch", severity: "high", evidence: "orchestrator.js:740" }
      ],
      waves: [
        { wave: 1, tasks: ["Fix-1: slow dispatch fix"], workerSlots: 1 },
        { wave: 2, dependsOn: [1], tasks: ["Fix-2: follow-up validation"], workerSlots: 1 }
      ]
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    const wave2Plan = result.plans.find(p => p.wave === 2);
    assert.ok(wave2Plan, "wave 2 plan must exist");
    assert.deepEqual(wave2Plan.waveDepends, [1],
      "wave 2 plan must carry waveDepends: [1] from the wave dependsOn field");
  });

  it("plans with no batch/wave metadata normalize correctly (negative path)", () => {
    // A plain plan with no owner, leverage_rank, or waveDepends — must normalize
    // without throwing and must emit sensible defaults for all packet fields.
    const parsed = {
      projectHealth: "good",
      plans: [{ task: "Basic task" }]
    };
    const result = normalizePrometheusParsedOutput(parsed, { raw: "" });
    assert.equal(result.plans.length, 1);
    assert.equal(typeof result.plans[0].owner, "string");
    assert.ok(result.plans[0].owner.length > 0, "owner must be a non-empty string");
    assert.ok(Array.isArray(result.plans[0].leverage_rank), "leverage_rank must be an array");
    assert.ok(Array.isArray(result.plans[0].waveDepends), "waveDepends must be an array");
    assert.equal(result.plans[0].waveDepends.length, 0,
      "waveDepends must be empty when not provided");
  });
});

