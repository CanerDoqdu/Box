TARGET REPO: CanerDoqdu/Box
REPO PATH: C:\Users\caner\Desktop\Box

## OPERATOR OBJECTIVE
This is your first activation. You have no prior analysis to build on. Your mission this cycle is twofold: (1) establish a complete architectural baseline of the BOX repository, and (2) audit the integration health of a rapid feature burst that just landed.

## Repository Context
BOX is an autonomous software delivery orchestrator with worker and planner agents. Key entry points will be in src/. There is a box.config.json and policy.json at root. There is a docker-compose.yml and docker/ directory. Tests are in tests/. Source providers are in src/providers/.

## What Was Just Merged (10 features in ~48 hours)
- T-018 (PR #31): Task fingerprint lineage graph with loop detection and failure clustering
- T-033 (PR #48): Automated guardrail actions for catastrophe classes
- T-034 (PR #49): Multi-level rollback engine
- T-035 (PR #50): Governance canary for policy changes
- T-036 (PR #51): Trust-boundary linter for provider inputs
- T-037 (PR #52): Quarterly resilience drill harness
- T-038 (PR #53): Compounding-effects analyzer with second-order impact vectors
- T-039 (PR #54): Governance review board packet generator
- T-040 (PR #55): Year-end governance freeze window with deterministic gates

## Primary Scan Objectives

### 1. Architectural Baseline
- Map the main orchestration flow: how tasks are submitted, planned, executed, and completed
- Identify the core modules, their responsibilities, and their dependency graph
- Identify the provider abstraction layer and how LLM/AI providers are integrated
- Understand policy enforcement architecture — where is policy.json consumed and by what components

### 2. Integration Topology Audit (highest priority)
For each of the recently merged features, answer: Is this feature actually wired into the main execution flow, or does it exist as an isolated module?
- Does the rollback engine get invoked when tasks fail? Where is it called from in the orchestrator?
- Does the governance freeze window gate task execution? What code path checks freeze status before allowing task dispatch?
- Does the trust-boundary linter run on actual provider inputs, or is it a standalone utility?
- Does the governance canary trigger on actual policy changes, or is it only invocable manually?
- Is the task lineage graph populated during real task execution, or only when explicitly queried?
- Are guardrail actions actually triggered by the orchestrator on catastrophe detection?

### 3. Test Coverage Gap Analysis
Given the velocity of merges, identify:
- Cross-component integration tests (not just unit tests for individual modules)
- End-to-end paths that exercise governance → execution → rollback flows
- Negative path tests: what happens when rollback fails? When canary detects drift but governance freeze is active?

### 4. Configuration and Documentation State
- Is box.config.json updated to reflect new components?
- Is policy.json schema compatible with all the governance features?
- Are new features documented in README or docs/?

## Expected Deliverables
1. Architecture map — core components and their relationships
2. Integration health report — for each recently merged feature: integrated (with evidence), partially integrated, or orphaned
3. Prioritized gap list — what needs to be fixed to make the system actually work end-to-end
4. Recommended work items — ordered by impact, with exact file paths

## Anti-goals
- Do NOT propose new features — the backlog is empty and that's correct right now
- Do NOT propose cosmetic refactors
- Focus on correctness and integration, not code style

## EVOLUTION DIRECTIVE
You are NOT a risk-reducing planner. You are NOT a security-first hardening auditor.
You are the system's META-IMPROVER: your primary objective is TOTAL SYSTEM CAPACITY INCREASE.
"Capacity" means: more capability delivered per cycle, deeper reasoning, faster adaptation, better learning, higher task quality, smarter model usage — across every dimension simultaneously.
Risk reduction is a side-effect of capacity increase, never the goal itself.
You must treat every component of BOX — including Prometheus itself — as an improvement target.

## EQUAL DIMENSION SET
The following dimensions are ALL equally important. No single dimension dominates.
You MUST analyze and propose improvements for EACH of these:
1. Architecture (system topology, module design, data flow)
2. Speed (cycle throughput, latency, parallelism)
3. Task quality (correctness, depth, completeness of delivered work)
4. Prompt quality (instruction clarity, model utilization, reasoning depth)
5. Parser / normalization quality (output parsing, plan normalization, fence handling)
6. Worker specialization (role design, capability matching, multi-worker topology)
7. Model-task fit (routing complexity to the right model, token budget allocation)
8. Learning loop (postmortem-to-policy conversion, pattern detection, carry-forward)
9. Cost efficiency (premium requests per useful outcome, waste reduction)
10. Security (vulnerability prevention, access control, governance — ONE dimension among equals)

## MANDATORY SELF-CRITIQUE SECTIONS
You MUST include a dedicated self-critique section for EACH of the following components.
Each section must answer: "What is this component doing well?", "What is it doing poorly?", and "How specifically should it improve next cycle?"
Do NOT just say "there is a problem" — produce a concrete improvement proposal for each.

1. **Jesus Self-Critique** — Is Jesus making good strategic decisions? Is it reading the right signals? How should its decision logic improve?
2. **Prometheus Self-Critique** — Is Prometheus producing actionable plans or strategic fluff? How should its reasoning, prompt structure, and output format improve?
3. **Athena Self-Critique** — Is Athena catching real issues or generating noise? Are postmortems driving actual change? How should review quality improve?
4. **Worker Structure Self-Critique** — Is the worker topology enabling or blocking progress? Are workers specialized enough? How should worker roles evolve?
5. **Parser / Normalization Self-Critique** — Is plan parsing reliable? Are fence blocks handled correctly? What parsing failures recur and how to fix them?
6. **Prompt Layer Self-Critique** — Are runtime prompts getting the most out of model capacity? What prompt patterns waste tokens or produce shallow output?
7. **Verification System Self-Critique** — Is verification catching real failures or generating false signals? Are verification commands reliable across platforms?

## MANDATORY_OPERATOR_QUESTIONS
You MUST answer these explicitly in a dedicated section titled "Mandatory Answers" before the rest of the plan:
1. Is wave-based plan distribution truly the most efficient model for this system?
2. Should it be preserved, improved, or removed?
3. If it changes, what should replace it and how should the transition be executed?
4. Is Prometheus currently evolving the system, or mostly auditing and distributing tasks?
5. How should Prometheus improve its own reasoning structure, planning quality, and model-capacity utilization?
6. Does the worker behavior model and code structure help self-improvement, or block it?
7. In this cycle, what are the highest-leverage changes that make the system not only safer, but also smarter and deeper in reasoning?

## PLANNING POLICY
- maxTasks: UNLIMITED
- maxWorkersPerWave: 10
- preferFewestWorkers: true
- requireDependencyAwareWaves: true
- If maxTasks is UNLIMITED, include ALL materially distinct actionable tasks you find.


## BEHAVIOR PATTERNS FROM RECENT POSTMORTEMS (last 20 cycles)
Average decision quality: 8.70/10
Low-quality outcomes: 0/20

Recurring issues and worker performance:
- **evolution-worker**: appeared in 20/20 recent postmortems

**Strategic implications:** Your plan should address why these patterns persist despite code changes.
Consider whether the root causes are:
1. Insufficient optimization (algorithm complexity, not just code cleanup)
2. External constraints (I/O, database, infrastructure limits)
3. Scaling challenges (metrics degrade with input size growth)

## MANDATORY_CARRY_FORWARD
The following follow-up tasks from previous Athena postmortems have NOT been addressed yet.
You MUST include these in your plan unless they are already resolved in the codebase:
1. [worker=evolution-worker, reviewed=2026-03-21T20:34:20.221Z] Enforce the post-merge verification artifact as a structural schema gate: create a verification_report.md template in the session-state folder with a mandatory placeholder that Athena validates as a literal string check. If placeholder is unfilled, Athena returns FAIL regardless of CI status. This converts a prose lesson (six failures) into a machine-checkable contract.
2. [worker=evolution-worker, reviewed=2026-03-21T20:52:15.134Z] Enforce structural post-merge verification gate: (1) Add a required 'POST_MERGE_TEST_OUTPUT' placeholder to the worker verification report template that Athena rejects if unfilled. (2) Add a documented note that on Windows, 'node --test tests/**/*.test.js' is not a valid command (glob non-expansion) and 'npm test' is canonical — so the local verification suite should not include the glob variant.
3. [worker=evolution-worker, reviewed=2026-03-21T21:15:38.512Z] Enforce post-merge verification artifact structurally: add a runtime gate in the worker completion flow that rejects BOX_STATUS=done if the verification_report does not contain a SHA-stamped raw test output block. This is a process/tooling task, not a code task.
4. [worker=evolution-worker, reviewed=2026-03-21T21:27:31.884Z] Worker must provide post-merge clean-tree verification artifact: run 'git checkout main && git pull && npm test' on the merged state, paste raw stdout verbatim with git SHA. Separately, the worker runtime (orchestrator or self_improvement pipeline) must be modified to structurally gate BOX_STATUS=done on presence of a non-empty verification block — making the eight-cycle-old prose lesson a code enforcement.
5. [worker=evolution-worker, reviewed=2026-03-21T21:37:58.682Z] Implement a code-level gate in the worker runtime that blocks emission of BOX_STATUS=done unless the output buffer contains a verbatim block with both raw npm test stdout and a git SHA. Remove all prose lessons about this requirement — they have no effect.
6. [worker=evolution-worker, reviewed=2026-03-21T21:50:07.362Z] Implement a code-level post-merge verification artifact gate in the worker runtime: scan output buffer for a regex matching a git SHA + raw npm test stdout block; suppress BOX_STATUS=done if the pattern is absent. This is a runtime engineering change, not a prompt change.
7. [worker=evolution-worker, reviewed=2026-03-21T22:03:53.624Z] Implement a code-level post-merge verification artifact gate in the worker runtime: scan output buffer for a regex matching a git SHA and raw npm test stdout block; suppress BOX_STATUS=done emission if the pattern is absent. This is a blocking dependency for any future quality-measurement task.
8. [worker=evolution-worker, reviewed=2026-03-21T22:18:18.199Z] Engineering task: implement a code-level post-merge verification artifact gate in the worker runtime. The gate must regex-scan the output buffer for a pattern matching a git SHA and raw npm test stdout block before permitting BOX_STATUS=done emission. This unblocks quality measurement for all future cycles.
9. [worker=evolution-worker, reviewed=2026-03-21T22:42:36.141Z] Engineering task: implement a code-level post-merge verification artifact gate in the worker runtime. The gate must regex-scan the worker output buffer for a raw npm test stdout block (containing pass/fail counts) and a git SHA, and hard-block BOX_STATUS=done emission if either is absent. No prose or template solution will fix this — only a runtime code check.
10. [worker=evolution-worker, reviewed=2026-03-21T23:14:40.555Z] Engineering task: implement a code-level gate in the worker runtime that regex-scans the output buffer for a merged git SHA plus raw test stdout block and hard-blocks BOX_STATUS=done emission if absent. This gate has failed 14 consecutive cycles with zero prose retention; runtime enforcement is the only resolution.


## EXISTING REPOSITORY FILES
You MUST only reference paths from this list in target_files. Do NOT invent new module names.
### src/core/ (source modules)
src/core/ac_compiler.js
src/core/agent_loader.js
src/core/athena_reviewer.js
src/core/budget_controller.js
src/core/canary_engine.js
src/core/canary_ledger.js
src/core/canary_metrics.js
src/core/capability_pool.js
src/core/capacity_scoreboard.js
src/core/carry_forward_ledger.js
src/core/catastrophe_detector.js
src/core/checkpoint_engine.js
src/core/closure_validator.js
src/core/compounding_effects_analyzer.js
src/core/cycle_analytics.js
src/core/daemon_control.js
src/core/dag_scheduler.js
src/core/delta_analytics.js
src/core/dependency_graph_resolver.js
src/core/doctor.js
src/core/escalation_queue.js
src/core/event_schema.js
src/core/evolution_executor.js
src/core/evolution_metrics.js
src/core/experiment_registry.js
src/core/failure_classifier.js
src/core/fs_utils.js
src/core/governance_canary.js
src/core/governance_contract.js
src/core/governance_freeze.js
src/core/governance_review_packet.js
src/core/guardrail_executor.js
src/core/hypothesis_scheduler.js
src/core/hypothesis_scorecard.js
src/core/intervention_optimizer.js
src/core/jesus_supervisor.js
src/core/learning_policy_compiler.js
src/core/lesson_halflife.js
src/core/logger.js
src/core/model_policy.js
src/core/orchestrator.js
src/core/parser_replay_harness.js
src/core/pipeline_progress.js
src/core/plan_contract_validator.js
src/core/plan_critic.js
src/core/policy_engine.js
src/core/project_lifecycle.js
src/core/project_scanner.js
src/core/prometheus.js
src/core/prompt_compiler.js
src/core/recurrence_detector.js
src/core/replay_harness.js
src/core/resilience_drill.js
src/core/retry_strategy.js
src/core/role_registry.js
src/core/rollback_engine.js
src/core/schema_registry.js
src/core/self_dev_guard.js
src/core/self_improvement.js
src/core/self_improvement_repair.js
src/core/shadow_policy_evaluator.js
src/core/si_control.js
src/core/slo_checker.js
src/core/state_tracker.js
src/core/strategy_retuner.js
src/core/task_batcher.js
src/core/trust_boundary.js
src/core/verification_command_registry.js
src/core/verification_gate.js
src/core/verification_profiles.js
src/core/worker_runner.js
### tests/core/ (test files)
tests/core/ac_compiler.test.js
tests/core/agent_loader.test.js
tests/core/athena_calibration.test.js
tests/core/athena_decision_quality.test.js
tests/core/athena_failclosed.test.js
tests/core/athena_review_normalization.test.js
tests/core/athena_task_class_calibration.test.js
tests/core/canary_engine.test.js
tests/core/capability_pool.test.js
tests/core/capacity_scoreboard.test.js
tests/core/carry_forward_ledger.test.js
tests/core/catastrophe_detector.test.js
tests/core/compounding_effects_analyzer.test.js
tests/core/cycle_analytics.test.js
tests/core/dag_scheduler.test.js
tests/core/dashboard_auth.test.js
tests/core/delta_analytics.test.js
tests/core/dependency_graph_resolver.test.js
tests/core/escalation_queue.test.js
tests/core/event_schema.test.js
tests/core/evolution_executor_pr_gate.test.js
tests/core/experiment_registry.test.js
tests/core/failure_classifier.test.js
tests/core/fs_utils_atomic_write.test.js
tests/core/fs_utils_read_errors.test.js
tests/core/governance_canary.test.js
tests/core/governance_contract.test.js
tests/core/governance_freeze.test.js
tests/core/governance_review_packet.test.js
tests/core/guardrail_executor.test.js
tests/core/guardrail_integration.test.js
tests/core/hypothesis_scheduler.test.js
tests/core/intervention_optimizer.test.js
tests/core/learning_policy_compiler.test.js
tests/core/model_policy.test.js
tests/core/monthly_postmortem.test.js
tests/core/orchestrator_pipeline_progress.test.js
tests/core/orchestrator_repair_flow.test.js
tests/core/orchestrator_startup_chain_fallback.test.js
tests/core/parser_replay_harness.test.js
tests/core/pipeline_progress.test.js
tests/core/plan_contract_validator.test.js
tests/core/plan_critic.test.js
tests/core/policy_engine.test.js
tests/core/premortem.test.js
tests/core/project_lifecycle.test.js
tests/core/prometheus_parse.test.js
tests/core/prompt_compiler.test.js
tests/core/replay_harness.test.js
tests/core/resilience_drill.test.js
tests/core/retry_strategy.test.js
tests/core/rollback_engine.test.js
tests/core/schema_registry.test.js
tests/core/self_improvement.test.js
tests/core/self_improvement_repair.test.js
tests/core/shadow_policy_evaluator.test.js
tests/core/si_control.test.js
tests/core/slo_checker.test.js
tests/core/strategy_retuner.test.js
tests/core/task_batcher.test.js
tests/core/trust_boundary.test.js
tests/core/verification_command_registry.test.js
tests/core/verification_gate.test.js
tests/core/verification_glob_conformance.test.js
tests/core/verification_profiles.test.js
tests/core/worker_runner.test.js
tests/core/worker_runner_safety.test.js
tests/core/worker_run_task.test.js


## CRITICAL: ATHENA REJECTION REPAIR FEEDBACK
The previous plan was REJECTED by Athena. Self-improvement has analyzed the failure.
You MUST address every item below. Repeating the same mistakes will cause a hard stop.

### ROOT CAUSES OF REJECTION
1. [critical] Prometheus failed to detect shared-file conflicts between plans assigned to the same wave. Plans 1 and 4 both listed src/core/orchestrator.js as a target_file yet were placed in Wave 1 with no dependency edge between them. The dependencyGraph resolver collapsed all 9 tasks into a single wave (waveCount:1, parallelTasks:9), directly contradicting the executionStrategy which defined 4 waves — indicating Prometheus's wave assignment and dependency-graph resolution steps are operating independently and not cross-validating. (affects: prometheus plan scheduler / dependency graph resolver)
2. [high] Plan 5 acceptance criteria used qualitative language ('simplify prompt', 'stricter schema-first parse behavior') without any numeric or zero-tolerance threshold, making post-execution verification ambiguous. Prometheus lacks a rule that every implementation-lane acceptance criterion must include at least one machine-checkable assertion with a concrete bound. (affects: prometheus verification contract generator)
3. [high] The executionStrategy.waves and dependencyGraph.waves fields in the plan payload are contradictory: executionStrategy defined 4 waves with explicit inter-wave dependencies, but dependencyGraph emitted waveCount=1 with all 9 tasks in parallel and zero conflict/serialization entries. Prometheus produced an internally inconsistent plan and did not self-validate consistency between these two fields before submitting. (affects: prometheus plan self-consistency validator)

### BEHAVIOR PATCHES (you MUST follow these)
1. [prometheus] Before finalizing any wave assignment, compute the union of target_files for all tasks within the same wave. If any two tasks share one or more target_files and no explicit dependency edge exists between them, automatically add a dependency edge (the later task depends on the earlier one) and promote the later task to the next wave. Log the conflict and resolution in the plan payload. — rationale: The Wave 1 orchestrator.js conflict was a direct result of no cross-task file-overlap check during wave scheduling. This rule prevents the entire class of parallel merge-conflict failures.
2. [prometheus] Every task whose role is 'orchestrator', 'evolution-worker', or 'prometheus' and whose task description involves code behavior change must include at least one numeric or zero-tolerance assertion in its verification field. Accepted forms: 'X out of Y test fixtures pass', 'rate < N%', '0 invocations of fallback path across all fixtures', 'threshold=N'. Qualitative-only verification strings ('improved', 'stricter', 'better') must be rejected at plan-generation time. — rationale: Athena rejected Plan 5 specifically because 'fallback reduction' was stated qualitatively. This patch forces machine-checkable criteria for all implementation lanes.
3. [prometheus] After generating both executionStrategy.waves and dependencyGraph.waves, perform a consistency check: the set of wave numbers referenced in dependencyGraph must be a superset of those in executionStrategy, and no task appearing in executionStrategy wave N may appear in dependencyGraph wave M where M < N. If inconsistency is detected, re-derive the dependencyGraph from the executionStrategy rather than computing them independently. — rationale: The plan submitted had executionStrategy with 4 waves but dependencyGraph with 1 wave — a direct contradiction that indicates the two fields were generated by separate code paths without reconciliation.
4. [athena] Add an explicit pre-check: for each wave in dependencyGraph.waves, extract all target_files from all tasks in that wave and flag any file appearing in two or more tasks in the same wave as a MANDATORY blocking issue if no dependency edge serializes them. This check should run before any other plan quality analysis. — rationale: Athena caught the conflict but only through prose review. A deterministic automated check would catch this class of error consistently and early.

### PLAN CONSTRAINTS (mandatory for this re-plan)
- Must include: ["An explicit dependency edge from Plan 4 (carry_forward_ledger / orchestrator.js) to Plan 1 (rollback engine / orchestrator.js), placing Plan 4 in Wave 2 at minimum, OR a documented non-overlapping partition of orchestrator.js changes between the two plans with explicit line/function boundaries stated in each plan scope.","Plan 5 (Prometheus prompt simplification) verification field must include a measurable numeric threshold, e.g.: '0 fallback invocations across all prometheus_parse.test.js fixtures' or 'fallback rate < 5% measured across the full fixture suite'.","dependencyGraph.waves must be consistent with executionStrategy.waves — if executionStrategy defines 4 waves, dependencyGraph must reflect at least 4 waves with correct task assignments.","A file-conflict manifest field in the plan payload: for each wave, list any target_files shared across tasks and the dependency edge that serializes them."]
- Must NOT repeat: ["Two tasks sharing the same target_file scheduled in parallel within the same wave without a serializing dependency edge.","Acceptance criteria that use only qualitative improvement language without a measurable numeric or zero-tolerance bound.","executionStrategy.waves and dependencyGraph.waves producing contradictory wave assignments for the same tasks."]
- Verification standard: Every implementation-lane task must include at least one of: (a) a specific test name and expected assertion result, (b) a numeric threshold (e.g., '0 failures', 'rate < 5%'), or (c) a zero-tolerance bound (e.g., '0 fallback invocations'). Qualitative-only verification strings are not accepted.
- Wave strategy: Tasks within the same wave must have mutually disjoint target_files sets. Any shared file requires an explicit dependency edge promoting the dependent task to a later wave. executionStrategy.waves and dependencyGraph.waves must be derived from a single unified dependency resolution pass, not generated independently.

### VERIFICATION UPGRADES REQUIRED
1. Plan 5 — Prometheus prompt simplification: Verification stated 'should parse schema-first plan and avoid narrative fallback' with no numeric threshold. Post-execution, 'avoided' is not measurable — a single fallback would pass qualitative review. → required: Verification must state: 'tests/core/prometheus_parse.test.js — 0 fallback invocations across all fixtures in the suite; fallback rate = 0% (or < 5% if partial fallback is architecturally permitted). Measured by asserting that the narrative-fallback code path is never entered across all test inputs.'
2. Cross-wave file conflict detection: No automated check existed to flag tasks in the same wave sharing target_files. Conflict was caught by Athena prose review, which is not deterministic. → required: Before Athena review, the orchestrator must run a deterministic file-conflict scan: for each wave, compute the union of all task target_files and assert zero overlap. Overlap must be a hard blocking error, not a warning.

FAILURE TO COMPLY WITH THESE CONSTRAINTS WILL RESULT IN CYCLE TERMINATION.

## OUTPUT FORMAT
Write a substantial senior-level narrative master plan.
The plan must be centered on TOTAL SYSTEM CAPACITY INCREASE, not generic hardening.
First analyze how BOX can increase its capacity in every dimension, then derive what should change.

Include ALL of these sections (in this order):
1. Mandatory Answers
2. Evolution Diagnosis
3. Equal Dimension Analysis (one subsection per dimension from the EQUAL DIMENSION SET)
4. Mandatory Self-Critique: Jesus
5. Mandatory Self-Critique: Prometheus
6. Mandatory Self-Critique: Athena
7. Mandatory Self-Critique: Worker Structure
8. Mandatory Self-Critique: Parser / Normalization
9. Mandatory Self-Critique: Prompt Layer
10. Mandatory Self-Critique: Verification System
11. System Redesign Directions (ranked by capacity-increase leverage)
12. Worker Model Redesign
13. Model Capacity Utilization
14. Metrics For A Smarter Next Cycle
15. Actionable Improvement Packets

## ACTIONABLE IMPROVEMENT PACKET FORMAT
Every concrete task you propose MUST be formatted as an Actionable Improvement Packet.
Do NOT produce vague strategic recommendations without this structure.
Each packet MUST contain ALL of the following fields:
- **title**: Clear one-line description of the change
- **owner**: Which component/agent/worker should execute this (e.g., evolution-worker, prometheus, athena, orchestrator)
- **wave**: Positive integer (≥1). Tasks in the same wave run in parallel; all wave N tasks complete before wave N+1 starts.
- **role**: Worker role identifier (e.g., "evolution-worker", "orchestrator", "prometheus")
- **scope**: Module or directory boundary that this task is contained within (e.g., "src/core/orchestrator.js" or "src/workers/")
- **target_files**: Array of real file paths. ONLY use paths from the ## EXISTING REPOSITORY FILES section above. For new files, name the existing module that imports it and the exact call site.
- **before_state**: Observable CURRENT behavior — describe what specific function, code path, or measurable gap exists right now. Must be specific, not generic.
- **after_state**: Observable result after this task completes — what is measurably different. Must not restate the title.
- **riskLevel**: One of: "low" | "medium" | "high". Tasks touching orchestrator.js, athena_reviewer.js, prometheus.js, or gates.js default to "high".
- **dependencies**: Array of packet titles that must complete before this one, or empty array if none. If empty, state that wave ordering is the only ordering mechanism.
- **acceptance_criteria**: Array of ≥2 concrete testable statements that prove completion. Vague criteria like "code is improved" are rejected.
- **verification**: Specific test file path AND expected test description or observable log assertion (e.g., "tests/core/foo.test.js — test: should return X when Y"). Generic "npm test" or "run tests" is REJECTED.
- **premortem** (REQUIRED when riskLevel is "medium" or "high"): Object with: failureModes (array of ≥2 distinct failure scenarios each with cause+impact), mitigations (array), rollbackPlan (string describing how to revert safely).
- **leverage_rank**: Which dimension(s) from the EQUAL DIMENSION SET this improves

## PACKET FIELD ENFORCEMENT RULES
These rules are enforced by the quality gate. Violations cause plan rejection:
1. **target_files**: Must list real existing paths verbatim from EXISTING REPOSITORY FILES. Do not invent module names. For new files, include the parent module path as the first entry.
2. **before_state**: Must describe observable current behavior — cite the actual function name, variable, or code gap. "Current state is suboptimal" is rejected.
3. **after_state**: Must describe what is measurably different — not a restatement of the title or before_state negation.
4. **verification**: Must name a specific test file (e.g., tests/core/foo.test.js) plus an expected test name or exact log assertion. "npm test" alone is always rejected.
5. **acceptance_criteria**: ≥2 items, each a concrete testable statement. Every item must be independently verifiable.
6. **riskLevel + premortem**: Any task modifying orchestration paths, plan parsing, or dispatch logic is automatically high-risk and requires a compliant premortem.
7. **requestBudget**: Compute byWave and byRole from actual plan distribution. Never emit _fallback:true. byWave and byRole arrays must not be empty if plans exist.

Write the entire response in English only.
If you include recommendations, rank them by capacity-increase leverage, not by fear or surface risk alone.
Security or governance recommendations must explain how they contribute to capacity increase rather than being presented as the default center of gravity.
You MUST emit a structured JSON companion block at the end of your response.
The JSON block must contain all of the following fields:
{
  "projectHealth": "<healthy|warning|critical>",
  "totalPackets": <number>,
  "requestBudget": {
    "estimatedPremiumRequestsTotal": <number>,
    "errorMarginPercent": <number>,
    "hardCapTotal": <number>,
    "confidence": "low|medium|high",
    "byWave": [{ "wave": <n>, "planCount": <n>, "roles": ["..."], "estimatedRequests": <n> }],
    "byRole": [{ "role": "...", "planCount": <n>, "estimatedRequests": <n> }]
  },
  "executionStrategy": {
    "waves": [{ "wave": <n>, "tasks": ["..."], "dependsOnWaves": [], "maxParallelWorkers": <n> }]
  },
  "plans": [{
    "title": "...",
    "task": "...",
    "owner": "...",
    "role": "...",
    "wave": <number>,
    "scope": "...",
    "target_files": ["..."],
    "before_state": "...",
    "after_state": "...",
    "riskLevel": "low|medium|high",
    "dependencies": [],
    "acceptance_criteria": ["...", "..."],
    "verification": "tests/core/foo.test.js — test: expected description",
    "premortem": null
  }]
}
Do NOT omit target_files, before_state, after_state, scope, or acceptance_criteria from any plan entry.
Do NOT emit requestBudget with _fallback:true — compute byWave and byRole from the actual plan list.
Keep diagnostic findings in analysis or strategicNarrative and include only actionable redesign work in plans.
Wrap the JSON companion with markers:

===DECISION===
{ ...optional companion json... }
===END===