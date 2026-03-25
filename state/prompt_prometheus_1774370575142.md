TARGET REPO: CanerDoqdu/Box
REPO PATH: C:\Users\caner\Desktop\Box

## OPERATOR OBJECTIVE
This is your first analysis of the CanerDoqdu/Box repository. There is no prior analysis to build on. Perform a comprehensive cold-start scan.

## What Was Recently Merged (last 48h)
- PR #31 — T-018: Task fingerprint lineage graph with loop detection and failure clustering
- PR #54 — T-039: Governance review board packet generator
- PR #55 — T-040: Year-end governance freeze window with deterministic gates
- PR #53 — T-038: Compounding-effects analyzer with second-order impact vectors
- PR #52 — T-037: Quarterly resilience drill harness
- PR #50 — T-035: Governance canary for policy changes
- PR #51 — T-036: Trust-boundary linter for provider inputs
- PR #49 — T-034: Multi-level rollback engine
- PR #48 — T-033: Automate guardrail actions for catastrophe classes

## What Prometheus Must Establish
1. **Full architectural map** — What are the top-level modules, their responsibilities, and inter-module dependencies? Focus on src/, tests/, scripts/, state/, docker/.
2. **Integration cohesion audit** — The 9 recently merged features span governance, resilience, and trust layers. Do they compose correctly? Are there policy conflicts, duplicate logic, dead code paths, or missing wiring between the rollback engine, guardrail automation, governance canary, and freeze window features?
3. **Test coverage posture** — What is covered? What critical flows (rollback, guardrail trigger, canary activation, freeze window gating) lack negative-path or integration tests?
4. **Foundation quality** — T-018 (fingerprint lineage) and T-036 (trust-boundary linter) are infrastructure others depend on. Are they solid? Any gaps in their contracts or validation logic?
5. **Highest-leverage next items** — Given the post-burst state, what is the single most important thing to evolve next? Prioritize: filling dangerous gaps > improving observability > adding new surface area.

## Anti-goals
- Do NOT propose new features before validating existing ones compose correctly
- Do NOT produce shallow file listings — go deep on behavior and contracts
- Do NOT duplicate analysis already captured in recently merged PRs

## Expected Deliverable
A projectHealth assessment, 3–5 keyFindings with evidence, and a ranked plan of concrete work items (with file paths, task kinds, and rationale). The plan should be actionable by the Evolution Worker immediately.

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
1. [critical] Prometheus assigned 'athena' as an implementer role (Plan 3) despite Athena being exclusively a reviewer/gatekeeper. This indicates Prometheus has no enforced constraint preventing governance roles from being used as code-execution workers. (affects: prometheus — role assignment logic)
2. [critical] Prometheus assigned 'prometheus' as an implementer role (Plan 6) without justification. Prometheus is the planner; it cannot also be a runtime code worker unless the system explicitly documents that dual capacity. No such documentation exists. (affects: prometheus — role assignment logic)
3. [high] Pre-mortems for Plans 3, 5, and 6 were emitted as numeric stub objects (count fields only) with no named failure paths, no per-path mitigations, no observable detection signals, and no containment guardrails. Prometheus treated pre-mortem as a metadata field rather than a substantive risk analysis. (affects: prometheus — pre-mortem generation)
4. [medium] Plan 8 declared a wave dependency on Plan 6 with no causal justification. Parser replay confidence gating and model routing ROI are logically independent subsystems. Prometheus injected implicit ordering without stating deployment rationale. (affects: prometheus — dependency graph construction)
5. [critical] The 14-cycle recurring defect (node --test tests/**/*.test.js Windows glob false-FAIL) was not included as a plan item despite every postmortem from the last 14 cycles mandating it as a blocking task. Prometheus produced a plan with no harness-fix task, violating the explicit Athena gate requirement documented in system health signals. (affects: prometheus — carry-forward defect ingestion)

### BEHAVIOR PATCHES (you MUST follow these)
1. [prometheus] Role whitelist enforcement: plans may only assign roles from the set ['evolution-worker', 'orchestrator']. The roles 'athena', 'prometheus', 'jesus', 'moses' are governance/leadership roles and MUST NOT appear as task implementer roles in any plan packet. If a task requires planner or reviewer changes, it must be assigned to 'evolution-worker' with explicit scope. — rationale: Athena flagged Plans 3 and 6 as role violations. Athena cannot review code it is also implementing. Prometheus cannot plan and simultaneously execute. These dual-role assignments break the governance separation that the entire system is built on.
2. [prometheus] Pre-mortem completeness gate: every plan packet with risk level 'high' or 'critical' MUST include a pre-mortem object with at minimum: (1) named failure paths as an array of strings describing specific failure scenarios, (2) per-path mitigations keyed to each failure path, (3) observable detection signals (log patterns, metric thresholds, or state file checks), and (4) containment guardrails. Numeric-only fields or empty arrays are not acceptable. Prometheus must self-validate pre-mortem completeness before emitting a plan. — rationale: Athena rejected Plans 3, 5, and 6 for numeric stub pre-mortems. This is a pattern of treating pre-mortem as boilerplate rather than as substantive failure analysis.
3. [prometheus] Dependency justification requirement: any inter-wave or inter-plan dependency MUST include a 'dependencyRationale' field with a one-sentence causal explanation. If two tasks touch unrelated subsystems and the dependency is purely about file conflict sequencing, that must be stated explicitly. Dependencies implied by logic that is not stated will be flagged by Athena as unjustified. — rationale: Plan 8's dependency on Plan 6 was declared without justification. Parser replay and model routing ROI are independent; the dependency implied deployment ordering without stating why.
4. [prometheus] Carry-forward defect inclusion: before emitting any plan, Prometheus MUST scan the most recent postmortems for 'followUpTask' or 'lessonLearned' entries that are flagged as BLOCKING or MANDATORY. These must appear as plan items or be explicitly documented as out-of-scope with justification. The harness-fix task (replace node --test glob with npm test) has been marked BLOCKING for 14 consecutive cycles and MUST be included in the re-plan. — rationale: System health signals show 14 consecutive postmortems demanding the harness-fix task. Prometheus produced a plan with zero carry-forward defect coverage, violating the explicit Athena gate requirement.

### PLAN CONSTRAINTS (mandatory for this re-plan)
- Must include: ["A dedicated 'evolution-worker' task to fix the local verification harness: replace 'node --test tests/**/*.test.js' glob pattern with 'npm test' or explicit path enumeration. This is a BLOCKING defect (14 cycles unresolved). Wave 1, highest priority.","All tasks previously assigned to role 'athena' (Plan 3: trust-boundary reason-code propagation) must be reassigned to role 'evolution-worker' with identical scope and file targets.","All tasks previously assigned to role 'prometheus' (Plan 6: parser replay confidence gate) must be reassigned to role 'evolution-worker' with identical scope and file targets, OR justified with explicit documentation that prometheus is a valid runtime code worker in this system's role schema.","Pre-mortems for all high/critical risk plans (Plans 3, 5, 6 in the original, plus any new high-risk plans) must include: failurePaths (named array), mitigations (per-path keyed object), detectionSignals (observable checks), and containmentGuardrails (fallback behavior).","Plan 8 (model routing ROI) dependency chain must include a 'dependencyRationale' field. If parser replay and model routing ROI are logically independent, Plan 8's dependency on Plan 6 must be removed and Plan 8 may execute in an earlier wave."]
- Must NOT repeat: ["Assigning 'athena' or 'prometheus' as implementer roles in any plan packet.","Emitting pre-mortems as numeric count stubs without named failure paths and mitigations.","Declaring inter-wave dependencies between logically independent subsystems without causal justification.","Producing a plan with no carry-forward defect task when postmortems flag BLOCKING open defects."]
- Verification standard: Every plan must specify a verification command using 'npm test' (not node --test glob patterns) or explicit file path enumeration. Verification must name the exact test file and test description string that will pass on success. High-risk plans must additionally specify a negative-path test that will fail if the implementation is absent.
- Wave strategy: Wave 1 must include the harness-fix task as its first priority. Integration and governance tasks may proceed in parallel in Wave 1 only after role reassignments are confirmed. Wave 2 tasks that previously depended on 'athena' or 'prometheus' role plans may be promoted to Wave 1 if their file conflicts are resolved by the role reassignment.

### VERIFICATION UPGRADES REQUIRED
1. pre-mortem completeness: Prometheus emitted pre-mortems as numeric objects (e.g., {riskCount: 3, mitigationCount: 2}) with no substantive content. Athena could not verify risk coverage from these fields. → required: Pre-mortems must be structured objects with: failurePaths[] (named scenario strings), mitigations{} (keyed by failure path name), detectionSignals[] (log patterns or metric checks), containmentGuardrails[] (fallback behaviors). Athena must reject any plan with a pre-mortem missing any of these four keys.
2. role validation: Prometheus emitted plans with 'athena' and 'prometheus' as implementer roles. The system has no enforced role whitelist at plan emission time. → required: Orchestrator must validate that all plan roles belong to the execution role whitelist ['evolution-worker', 'orchestrator'] before passing plans to Athena. Plans with disallowed roles must be rejected at intake before Athena review, with an explicit ROLE_VIOLATION error code returned to Prometheus.
3. dependency justification: Plan 8's dependency on Plan 6 was asserted without a stated rationale. Athena could not determine if the dependency was causal or incidental. → required: Every inter-wave dependency entry must include a 'reason' field (already present for file_conflict gates) AND a 'rationale' string explaining the causal or ordering reason. Pure file-conflict sequencing must be labeled 'file_conflict' with shared files listed. Logical or deployment ordering must be labeled 'logical_dependency' with a causal sentence.
4. carry-forward defect coverage: A blocking harness defect (node --test Windows glob false-FAIL) has been recorded in 14 consecutive postmortems. Prometheus produced a plan with zero reference to it. → required: Prometheus must ingest the last 5 postmortems before plan generation and extract any 'followUpTask' or 'followUpNeeded' entries. All entries flagged BLOCKING must appear in the plan as explicit tasks. Athena must include a carry-forward defect coverage check in its review: if a BLOCKING defect from postmortems is absent from the plan without documented justification, the plan must be rejected.

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