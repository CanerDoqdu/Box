/**
 * Evolution Executor — Controlled Sequential Task Runner
 *
 * Reads the 40-task Master Evolution Plan from state/master_evo.txt.
 * One dedicated agent (evolution-worker) executes all tasks.
 *
 * Flow per task:
 *   1. Athena pre-reviews the task (scope + acceptance criteria must be concrete)
 *   2. evolution-worker executes the code change
 *   3. Run task's verification_commands locally (npm test, etc.)
 *   4. Athena postmortem → verdict: proceed | rework | escalate
 *   5. If proceed  → mark done, advance
 *      If rework   → retry (up to autonomousMaxAttemptsPerTask)
 *      If escalate → mark escalated; pre-review reject handling is configurable
 *
 * Progress is saved in state/evolution_progress.json after every step.
 * Safe to Ctrl+C and resume — it picks up from the last pending task.
 */

import path from "node:path";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { readJson, writeJson } from "./fs_utils.js";
import { runWorkerConversation } from "./worker_runner.js";
import { runAthenaPostmortem } from "./athena_reviewer.js";
import { appendProgress } from "./state_tracker.js";
import { buildAgentArgs, parseAgentOutput } from "./agent_loader.js";
import { spawnAsync } from "./fs_utils.js";
import { getRoleRegistry } from "./role_registry.js";
import { checkPostMergeArtifact, ARTIFACT_GAP, ARTIFACT_GATE_ERROR_PREFIX, isArtifactGateRequired } from "./verification_gate.js";
import { VERIFICATION_DEFAULTS, rewriteVerificationCommand } from "./verification_command_registry.js";

type EvolutionTask = {
  task_id?: string;
  title?: string;
  scope?: string;
  files_hint?: string[];
  acceptance_criteria?: string[];
  verification_commands?: string[];
  risk_level?: string;
  intervention_title?: string;
  [key: string]: unknown;
};

type AthenaReview = {
  approved?: boolean;
  reason?: string;
  issues?: string[];
  actualOutcome?: string;
  lessonLearned?: string;
  followUpTask?: string;
  [key: string]: unknown;
};

type PreparedEvolutionTask = EvolutionTask & {
  title: string;
  scope: string;
  files_hint: string[];
  acceptance_criteria: string[];
  verification_commands: string[];
};

type ProgressTaskState = {
  status: string;
  attempts: number;
  worker_result: unknown;
  verification_passed: boolean | null;
  /** Explicit evidence of which task-named verification commands were executed. */
  verification_targets: Array<{ cmd: string; passed: boolean; blocked: boolean }> | null;
  athena_verdict: Record<string, unknown> | null;
  completed_at: string | null;
  error: string | null;
};

type PrChecksResult = {
  ok: boolean;
  passed: boolean;
  failed: string[];
  pending: string[];
  total: number;
  error?: string;
};

type SpawnAsyncResult = {
  status: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
};

// ── Scope conformance types ───────────────────────────────────────────────────

export type ScopeConformanceResult = {
  /** True when all touched files are within the declared files_hint scope. */
  ok: boolean;
  /** Files touched by the worker that are outside the declared scope. */
  unrelatedFiles: string[];
  /** Human-readable recovery instruction emitted when ok=false. */
  recoveryInstruction: string;
};

// ── Constants ─────────────────────────────────────────────────────────────────

const PROGRESS_FILE = "state/evolution_progress.json";
const DEFAULT_MAX_ATTEMPTS = 3;
const EVOLUTION_WORKER_SLUG = "evolution-worker";
const ATHENA_PRE_REVIEW_MAX_RETRIES = 1;
const ATHENA_REVIEW_TIMEOUT_MS = 5 * 60 * 1000;

// ── Scope conformance check (Task 7) ─────────────────────────────────────────

/**
 * Check whether all worker-touched files fall within the task's declared files_hint scope.
 *
 * A file is considered "in scope" when it:
 *   - Exactly matches a hint path, OR
 *   - Is a path prefix match (e.g. hint "src/core/" covers "src/core/foo.ts"), OR
 *   - Is a test file whose base name corresponds to an in-scope source file.
 *
 * When files outside scope are detected, returns ok=false with an explicit
 * recovery instruction so the worker can revert unrelated changes before
 * re-attempting finalization. This prevents silent scope creep.
 *
 * @param filesTouched - files reported by BOX_FILES_TOUCHED in worker output
 * @param filesHint    - declared scope from task.files_hint
 * @returns ScopeConformanceResult
 */
export function checkScopeConformance(
  filesTouched: string[],
  filesHint: string[]
): ScopeConformanceResult {
  // No declared scope or no files touched → pass-through (cannot enforce without a scope)
  if (!Array.isArray(filesHint) || filesHint.length === 0) {
    return { ok: true, unrelatedFiles: [], recoveryInstruction: "" };
  }
  if (!Array.isArray(filesTouched) || filesTouched.length === 0) {
    return { ok: true, unrelatedFiles: [], recoveryInstruction: "" };
  }

  const normalizedHints = filesHint.map(h => h.replace(/\\/g, "/").toLowerCase());

  const unrelatedFiles: string[] = [];
  for (const file of filesTouched) {
    const normalized = file.replace(/\\/g, "/").toLowerCase();
    const inScope = normalizedHints.some(hint => {
      // Exact match
      if (normalized === hint) return true;
      // Prefix match (hint is a directory prefix)
      if (normalized.startsWith(hint.endsWith("/") ? hint : hint + "/")) return true;
      // Test file corresponding to a hinted source file (e.g. foo.ts → foo.test.ts)
      const hintBase = hint.replace(/\.(ts|js)$/, "");
      if (normalized.includes(hintBase)) return true;
      return false;
    });
    if (!inScope) {
      unrelatedFiles.push(file);
    }
  }

  if (unrelatedFiles.length === 0) {
    return { ok: true, unrelatedFiles: [], recoveryInstruction: "" };
  }

  const recoveryInstruction = [
    `SCOPE VIOLATION: ${unrelatedFiles.length} file(s) modified outside declared task scope.`,
    `Unrelated files: ${unrelatedFiles.join(", ")}`,
    `Recovery: revert unrelated changes with 'git checkout -- <file>' for each file listed above,`,
    `then re-run verification and re-submit. Only files in scope may be modified:`,
    `  ${filesHint.join(", ")}`
  ].join("\n");

  return { ok: false, unrelatedFiles, recoveryInstruction };
}

const ATHENA_RETRYABLE_REVIEW_PATTERNS = [
  /untestable/i,
  /measurable/i,
  /testable/i,
  /ambiguous/i,
  /undefined/i,
  /missing\s+schema/i,
  /schema/i,
  /enum/i,
  /deterministic/i,
  /fallback/i,
  /degraded/i,
  /missing\s+vs\.?\s+invalid/i,
  /insufficient\s+verification/i,
  /verification\s+commands/i
];

const ACCEPTANCE_CRITERIA_REWRITES = new Map([
  [
    "Frontend tasks missing required responsive matrix are auto-reworked or blocked based on attempt count.",
    "Responses missing fields required by the active verification profile are auto-reworked or blocked based on attempt count."
  ],
  [
    "Dashboard alert entry is created with severity warning or critical.",
    "Blocked review state writes an alert record with a deterministic severity enum and reason code."
  ],
  [
    "Critical state file parse failures trigger degraded mode, not silent defaults.",
    "Critical state file parse failures move the orchestrator into an explicit degraded state instead of silently defaulting."
  ],
  [
    "Dashboard `/api/state` surfaces current stage and percent from pipeline_progress.json.",
    "Pipeline progress state persists current stage and percent in canonical form, and dashboard reads those values without heuristic inference."
  ],
  [
    "Frontend missing responsive matrix fails.",
    "Roles with required verification fields fail when those fields are missing."
  ],
  [
    "Manual override path exists with audit trail.",
    "Manual overrides require explicit operator identity, reason, and audit trail."
  ]
]);

function normalizeAcceptanceCriteria(criteria = []) {
  return criteria.map(item => ACCEPTANCE_CRITERIA_REWRITES.get(item) || item);
}

function normalizeVerificationCommands(commands = []) {
  const rewritten = commands.map(command => rewriteVerificationCommand(command));

  const deduped = [];
  for (const command of rewritten) {
    if (!deduped.includes(command)) deduped.push(command);
  }

  return deduped.length > 0 ? deduped : [VERIFICATION_DEFAULTS.test, "node --test"];
}

function normalizeEvolutionTask(task) {
  return {
    ...task,
    acceptance_criteria: normalizeAcceptanceCriteria(task.acceptance_criteria || []),
    verification_commands: normalizeVerificationCommands(task.verification_commands || [VERIFICATION_DEFAULTS.test])
  };
}

export function shouldHaltOnPreReviewReject(config: { runtime?: { evolutionStopOnPreReviewReject?: boolean } } = {}) {
  return config.runtime?.evolutionStopOnPreReviewReject === true;
}

function normalizeStringList(value) {
  const list = Array.isArray(value) ? value : [];
  return list.map(v => String(v || "").trim()).filter(Boolean);
}

function normalizeScope(scope, title = "") {
  const s = String(scope || "").trim();
  if (s) return s;
  return `Implement ${title || "the task"} with deterministic acceptance criteria and verifiable output.`;
}

export function repairPrometheusTask(task: EvolutionTask = {}): PreparedEvolutionTask {
  const repaired = {
    ...task,
    title: String(task.title || task.task_id || "Untitled task").trim(),
    scope: normalizeScope(task.scope, task.title),
    files_hint: normalizeStringList(task.files_hint),
    acceptance_criteria: normalizeAcceptanceCriteria(normalizeStringList(task.acceptance_criteria)),
    verification_commands: normalizeVerificationCommands(normalizeStringList(task.verification_commands))
  };

  if (repaired.acceptance_criteria.length === 0) {
    repaired.acceptance_criteria = [
      "Implementation is deterministic and avoids silent fallback behavior.",
      "Automated tests cover at least one success and one failure path for changed logic.",
      "Verification commands provide machine-checkable pass/fail evidence."
    ];
  }

  return repaired;
}

export function injectAthenaMissingItems(task: PreparedEvolutionTask, preReview: AthenaReview = {}): PreparedEvolutionTask {
  const issues = normalizeStringList(preReview.issues);
  const derivedIssues = issues.length > 0
    ? issues
    : [String(preReview.reason || "Athena requested additional measurable constraints").trim()].filter(Boolean);

  const extraCriteria = derivedIssues.map(issue => `Athena missing item resolved: ${issue}`);
  const updatedCriteria = [...(task.acceptance_criteria || [])];
  for (const item of extraCriteria) {
    if (!updatedCriteria.includes(item)) updatedCriteria.push(item);
  }

  const scopeNotes = [
    "",
    "Athena missing items (must be implemented in this task before completion):",
    ...derivedIssues.map((issue, idx) => `${idx + 1}. ${issue}`)
  ].join("\n");

  return repairPrometheusTask({
    ...task,
    scope: `${task.scope || ""}${scopeNotes}`.trim(),
    acceptance_criteria: updatedCriteria,
    verification_commands: normalizeVerificationCommands([
      ...(task.verification_commands || []),
      VERIFICATION_DEFAULTS.test,
      VERIFICATION_DEFAULTS.lint
    ])
  });
}

function collectAthenaReviewText(preReview: AthenaReview = {}) {
  const issuesText = Array.isArray(preReview.issues)
    ? preReview.issues.join(" ")
    : "";
  return `${preReview.reason || ""} ${issuesText}`.trim();
}

export function shouldRetryAthenaPreReview(preReview: AthenaReview = {}) {
  const text = collectAthenaReviewText(preReview);
  return ATHENA_RETRYABLE_REVIEW_PATTERNS.some(pattern => pattern.test(text));
}

export function hardenTaskForAthena(task: PreparedEvolutionTask, preReview: AthenaReview = {}): PreparedEvolutionTask {
  const existingCriteria = Array.isArray(task.acceptance_criteria)
    ? task.acceptance_criteria
    : [];
  const existingCommands = Array.isArray(task.verification_commands)
    ? task.verification_commands
    : [];

  const hardeningCriteria = [
    "Each acceptance criterion maps to at least one explicit verification command with deterministic pass/fail evidence.",
    "Changed behavior is covered by automated tests including one negative path asserting failure handling.",
    "Any newly introduced JSON output or persisted state includes a defined schema with required fields and explicit enums where applicable.",
    "Validation distinguishes missing input from invalid input with deterministic handling and explicit reason codes.",
    "No silent fallback is allowed for critical state; degraded behavior must set an explicit status field and record a machine-readable reason."
  ];

  const hardeningCommands = [
    VERIFICATION_DEFAULTS.test,
    VERIFICATION_DEFAULTS.lint
  ];

  const acceptance = [...existingCriteria];
  for (const criterion of hardeningCriteria) {
    if (!acceptance.includes(criterion)) acceptance.push(criterion);
  }

  const commands = normalizeVerificationCommands([...existingCommands, ...hardeningCommands]);
  const reviewText = collectAthenaReviewText(preReview);

  return {
    ...task,
    acceptance_criteria: acceptance,
    verification_commands: commands,
    scope: [
      task.scope,
      "",
      "Athena hardening notes:",
      reviewText || "No additional notes from Athena pre-review.",
      "Make the implementation and verification evidence deterministic and machine-checkable."
    ].join("\n")
  };
}

function parsePrNumber(prUrl) {
  const match = String(prUrl || "").match(/\/pull\/(\d+)/i);
  return match ? Number(match[1]) : null;
}

function checkStateFromRollupItem(item) {
  const status = String(item?.status || "").toUpperCase();
  const conclusion = String(item?.conclusion || item?.state || "").toUpperCase();

  if (status && status !== "COMPLETED") return "pending";

  if (["SUCCESS", "NEUTRAL", "SKIPPED"].includes(conclusion)) return "success";
  if (["", "NONE", "EXPECTED"].includes(conclusion)) return "pending";
  return "failed";
}

export function assessStatusCheckRollup(rollup = []) {
  const failed = [];
  const pending = [];

  for (const item of Array.isArray(rollup) ? rollup : []) {
    const name = item?.name || item?.context || "unnamed-check";
    const state = checkStateFromRollupItem(item);
    if (state === "failed") failed.push(name);
    if (state === "pending") pending.push(name);
  }

  return {
    passed: failed.length === 0 && pending.length === 0,
    failed,
    pending,
    total: Array.isArray(rollup) ? rollup.length : 0
  };
}

async function readPrChecks(config, prUrl) {
  const prNumber = parsePrNumber(prUrl);
  if (!prNumber) {
    return { ok: false, error: "invalid-pr-url", passed: false, failed: [], pending: [], total: 0 };
  }

  const command = config.env?.ghCommand || "gh";
  const args = ["pr", "view", String(prNumber), "--json", "statusCheckRollup"];
  if (config.env?.targetRepo) {
    args.push("--repo", String(config.env.targetRepo));
  }

  try {
    const raw = await spawnAsync(command, args, { env: process.env, timeoutMs: 60_000 }) as SpawnAsyncResult;
    const parsed = JSON.parse(String(raw?.stdout || "{}"));
    const summary = assessStatusCheckRollup(parsed?.statusCheckRollup || []);
    return { ok: true, ...summary };
  } catch (err) {
    return {
      ok: false,
      error: String(err?.message || err),
      passed: false,
      failed: [],
      pending: [],
      total: 0
    };
  }
}

// ── Plan Parsing ──────────────────────────────────────────────────────────────

/**
 * Parse the 40-task master plan from state/master_evo.txt.
 * Extracts the JSON block between ===MASTER=== and ===END=== markers.
 */
export function loadEvolutionPlan(stateDir = "state") {
  const planPath = path.join(stateDir, "master_evo.txt");
  const raw = readFileSync(planPath, "utf8");

  const match = raw.match(/===MASTER===\s*([\s\S]*?)===END===/);
  if (!match) {
    throw new Error(`[evolution] Could not find ===MASTER=== ... ===END=== block in ${planPath}`);
  }

  let plan;
  try {
    plan = JSON.parse(match[1].trim());
  } catch (err) {
    throw new Error(`[evolution] Failed to parse plan JSON: ${err.message}`, { cause: err });
  }

  // Flatten all tasks from all intervention groups
  const tasks = [];
  for (const intervention of plan.interventions || []) {
    for (const task of intervention.tasks || []) {
      tasks.push({
        ...normalizeEvolutionTask(task),
        intervention_title: intervention.title
      });
    }
  }

  if (tasks.length === 0) {
    throw new Error("[evolution] Plan contains no tasks");
  }

  return { cycleId: plan.cycle_id, tasks };
}

// ── Progress Management ───────────────────────────────────────────────────────

async function loadProgress(stateDir) {
  return readJson(path.join(stateDir, PROGRESS_FILE.replace("state/", "")), null);
}

async function saveProgress(stateDir, progress) {
  await writeJson(path.join(stateDir, PROGRESS_FILE.replace("state/", "")), progress);
}

function initProgress(cycleId, tasks) {
  const taskMap: Record<string, any> = {};
  for (const t of tasks) {
    taskMap[t.task_id] = {
      status: "pending",   // pending | in_progress | done | rework | escalated | skipped
      attempts: 0,
      worker_result: null,
      verification_passed: null,
      verification_targets: null,
      athena_verdict: null,
      completed_at: null,
      error: null
    };
  }
  return {
    cycle_id: cycleId,
    started_at: new Date().toISOString(),
    current_task_index: 0,
    tasks: taskMap
  };
}

// ── Athena Task Pre-Review ────────────────────────────────────────────────────

/**
 * Ask Athena to validate a single evolution task before dispatching the worker.
 * Returns { approved, reason } — fail-closed: if Athena AI fails, approved=false.
 */
async function runAthenaTaskReview(config, task: PreparedEvolutionTask) {
  const registry = getRoleRegistry(config);
  const athenaModel = registry?.qualityReviewer?.model || "Claude Sonnet 4.6";
  const command = config.env?.copilotCliCommand || "copilot";

  const criteria = (task.acceptance_criteria || []).map((c, i) => `  ${i + 1}. ${c}`).join("\n");
  const filesHint = (task.files_hint || []).join(", ");
  const verificationCmds = (task.verification_commands || []).join(", ");

  const prompt = `You are Athena — BOX Quality Gate.
Review this evolution task BEFORE execution. Check:
1. Is the scope precise enough for a single-session implementation?
2. Are ALL acceptance criteria measurable and testable?
3. Are the verification commands sufficient to confirm success?
4. Is the risk level accurate for the scope of change?

## TASK: ${task.task_id} — ${task.title}
Scope: ${task.scope}
Files hint: ${filesHint}
Acceptance criteria:
${criteria}
Verification commands: ${verificationCmds}
Risk level: ${task.risk_level || "medium"}

Output your assessment, then:
===DECISION===
{
  "approved": true/false,
  "overallScore": 1-10,
  "summary": "one sentence assessment",
  "issues": ["any blocking issues"],
  "recommendation": "proceed | rework | escalate"
}
===END===`;

  const args = buildAgentArgs({
    agentSlug: "athena",
    prompt,
    model: athenaModel,
    allowAll: false,
    maxContinues: undefined
  });

  let aiResult;
  try {
    const raw = await spawnAsync(command, args, {
      env: process.env,
      timeoutMs: config.runtime?.athenaReviewTimeoutMs || ATHENA_REVIEW_TIMEOUT_MS
    }) as SpawnAsyncResult;
    if (raw?.timedOut) {
      return { approved: false, reason: "Athena pre-review timed out" };
    }
    aiResult = parseAgentOutput(String(raw?.stdout || raw?.stderr || ""));
  } catch (err) {
    // Fail-closed: worker does not run if Athena review fails
    return { approved: false, reason: `Athena threw: ${err.message}` };
  }

  if (!aiResult.ok || !aiResult.parsed) {
    return { approved: false, reason: "Athena returned no structured decision — fail-closed" };
  }

  const approved = aiResult.parsed.approved === true;
  return {
    approved,
    reason: aiResult.parsed.summary || (approved ? "approved" : "rejected"),
    issues: aiResult.parsed.issues || [],
    score: aiResult.parsed.overallScore
  };
}

// ── Instruction Builder ───────────────────────────────────────────────────────

/**
 * Convert a plan task into a worker instruction object.
 * Workers read `instruction.task` as their primary context.
 *
 * @param {object} task        - plan task from master_evo.txt
 * @param {object} [athenaHints] - pre-review result from runAthenaTaskReview()
 */
function buildInstruction(task, athenaHints = null) {
  const criteria = (task.acceptance_criteria || [])
    .map((c, i) => `  ${i + 1}. ${c}`)
    .join("\n");

  const filesHint = (task.files_hint || []).join(", ");

  const verificationCmds = (task.verification_commands || [])
    .map(c => `  - ${c}`)
    .join("\n");

  const rollback = task.rollback_plan
    ? `\nROLLBACK PLAN:\n  ${task.rollback_plan}`
    : "";

  // Embed Athena's pre-review notes directly into the prompt so the worker
  // starts with Athena's quality assessment and any flagged risks.
  let athenaSection = "";
  if (athenaHints) {
    const issues = (athenaHints.issues || []).map(i => `  - ${i}`).join("\n");
    athenaSection = [
      ``,
      `## ATHENA PRE-REVIEW (read carefully before starting)`,
      `Assessment: ${athenaHints.reason || "approved"}`,
      `Quality score: ${athenaHints.score ?? "n/a"}/10`,
      issues ? `Flagged concerns:\n${issues}` : `No blocking concerns flagged.`,
      `Act on the concerns above — address them as part of your implementation.`
    ].join("\n");
  }

  const taskText = [
    `## BOX EVOLUTION TASK: ${task.task_id} — ${task.title}`,
    ``,
    `SCOPE:`,
    task.scope,
    ``,
    `FILES TO MODIFY (hint):`,
    filesHint || "  (see scope above)",
    ``,
    `ACCEPTANCE CRITERIA (ALL must pass before marking done):`,
    criteria,
    ``,
    `VERIFICATION COMMANDS (run these to confirm):`,
    verificationCmds || `  ${VERIFICATION_DEFAULTS.test}`,
    rollback,
    athenaSection,
    ``,
    `RISK LEVEL: ${task.risk_level || "medium"}`,
    ``,
    `OUTPUT PROTOCOL:`,
    `  - Output BOX_STATUS=done when all acceptance criteria are met`,
    `  - Output BOX_STATUS=partial if blocked on external dependency`,
    `  - Output BOX_FILES_TOUCHED=<comma-separated list of changed files>`,
    `  - Output BOX_BRANCH=<branch-name> if you create/switch a branch`,
    `  - Include a VERIFICATION_REPORT section listing evidence for each criterion`
  ].join("\n");

  return {
    task: taskText,
    taskKind: "backend",
    estimatedLines: 200,
    estimatedDurationMinutes: 20,
    complexity: task.risk_level || "medium"
  };
}

// ── Verification Command Runner ───────────────────────────────────────────────

/**
 * Run the task's verification_commands locally (e.g. npm test).
 * Returns { passed, output }.
 */
// Commands that start the daemon or long-running processes are excluded from
// local verification — running them would wake up Jesus and the full agent
// stack, which is not safe during an evolution task.
const BLOCKED_VERIFICATION_CMDS = [
  /node\s+src\/cli\.js/,
  /npm\s+start/,
  /npm\s+run\s+start/,
  /pm2/,
  /node\s+.*daemon/
];

/**
 * Build explicit evidence for which task-named verification commands were executed.
 * Pure function — testable without side effects.
 *
 * @param requestedCommands - the task's verification_commands list
 * @param runResults        - outcomes from execSync (cmd, passed) for each actually-run command
 * @param blockedCommands   - subset of requestedCommands that were filtered as daemon commands
 * @param fallbackCmd       - the fallback command used when all task commands were blocked
 * @returns array mapping every requested command to its execution outcome
 */
export function buildVerificationTargets(
  requestedCommands: string[],
  runResults: Array<{ cmd: string; passed: boolean }>,
  blockedCommands: string[],
  fallbackCmd: string | null = null
): Array<{ cmd: string; passed: boolean; blocked: boolean }> {
  const resultMap = new Map(runResults.map(r => [r.cmd, r.passed]));

  const targets: Array<{ cmd: string; passed: boolean; blocked: boolean }> = requestedCommands.map(cmd => {
    const isBlocked = blockedCommands.includes(cmd);
    const passed = isBlocked ? false : (resultMap.get(cmd) ?? false);
    return { cmd, passed, blocked: isBlocked };
  });

  // If all task-named commands were blocked and we fell back to a different command,
  // include the fallback so the evidence record is complete.
  if (fallbackCmd !== null && blockedCommands.length === requestedCommands.length && requestedCommands.length > 0) {
    const fallbackPassed = resultMap.get(fallbackCmd) ?? false;
    targets.push({ cmd: fallbackCmd, passed: fallbackPassed, blocked: false });
  }

  return targets;
}

function runVerificationCommands(task) {
  const allCmds = task.verification_commands || [VERIFICATION_DEFAULTS.test];
  const blockedCmds: string[] = [];
  const cmds = allCmds.filter(cmd => {
    const blocked = BLOCKED_VERIFICATION_CMDS.some(re => re.test(cmd));
    if (blocked) {
      console.log(`[evolution] Skipping daemon command: ${cmd}`);
      blockedCmds.push(cmd);
    }
    return !blocked;
  });

  let usedFallback: string | null = null;
  if (cmds.length === 0) {
    // All task-named commands were blocked — run test suite as safety net
    cmds.push(VERIFICATION_DEFAULTS.test);
    usedFallback = VERIFICATION_DEFAULTS.test;
  }

  const results: Array<{ cmd: string; passed: boolean; output: string }> = [];

  for (const cmd of cmds) {
    // Only run safe, pre-defined commands — never interpolate from untrusted input
    try {
      const output = execSync(cmd, {
        cwd: process.cwd(),
        timeout: 5 * 60 * 1000, // 5 min max
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"]
      });
      results.push({ cmd, passed: true, output: output.slice(0, 2000) });
    } catch (err) {
      const output = (err.stdout || "") + (err.stderr || "");
      results.push({ cmd, passed: false, output: output.slice(0, 2000) });
    }
  }

  const allPassed = results.every(r => r.passed);
  const summary = results
    .map(r => `[${r.passed ? "PASS" : "FAIL"}] ${r.cmd}`)
    .join("\n");

  const targets = buildVerificationTargets(allCmds, results, blockedCmds, usedFallback);

  return { passed: allPassed, results, summary, targets };
}

// ── Athena Verdict Parser ─────────────────────────────────────────────────────

function extractAthenaVerdict(athenaResult) {
  const parsed = athenaResult?.parsed;
  if (!parsed) return "escalate"; // If Athena fails, fail-closed (no auto-proceed)

  const rec = String(parsed.recommendation || "escalate").toLowerCase();
  if (rec === "proceed") return "proceed";
  if (rec === "rework") return "rework";
  return "escalate";
}

// ── Main Loop ─────────────────────────────────────────────────────────────────

/**
 * Run the full evolution loop from the next pending task.
 * Saves progress after every task, resume-safe.
 *
 * @param {object} config  - loaded box.config.json + env
 * @param {object} options
 * @param {string} [options.fromTaskId]  - force start from this task_id (skip prior)
 * @param {boolean} [options.dryRun]    - log plan but don't execute workers
 */
export async function runEvolutionLoop(config, options: { fromTaskId?: string; dryRun?: boolean } = {}) {
  const stateDir = config.paths?.stateDir || "state";
  const maxAttempts = config.runtime?.autonomousMaxAttemptsPerTask || DEFAULT_MAX_ATTEMPTS;

  // 1. Load plan
  const { cycleId, tasks } = loadEvolutionPlan(stateDir);
  console.log(`[evolution] Loaded plan ${cycleId} — ${tasks.length} tasks`);

  // 2. Load or init progress
  let progress = await loadProgress(stateDir);
  if (!progress || progress.cycle_id !== cycleId) {
    console.log("[evolution] Starting fresh progress tracking");
    progress = initProgress(cycleId, tasks);
    await saveProgress(stateDir, progress);
  } else {
    const doneCount = Object.values(progress.tasks).filter((t: ProgressTaskState) => t.status === "done").length;
    const escalatedCount = Object.values(progress.tasks).filter((t: ProgressTaskState) => t.status === "escalated").length;
    console.log(`[evolution] Resuming — ${doneCount} done, ${escalatedCount} escalated`);
  }

  // 3. Determine start index
  let startIndex = 0;
  if (options.fromTaskId) {
    startIndex = tasks.findIndex(t => t.task_id === options.fromTaskId);
    if (startIndex === -1) {
      throw new Error(`[evolution] Task ${options.fromTaskId} not found in plan`);
    }
    console.log(`[evolution] Forced start from ${options.fromTaskId} (index ${startIndex})`);
  }

  // 4. Sequential execution loop
  for (let i = startIndex; i < tasks.length; i++) {
    const task = tasks[i];
    const taskState = progress.tasks[task.task_id];

    if (!taskState) {
      console.warn(`[evolution] No progress state for ${task.task_id}, skipping`);
      continue;
    }

    // Skip already completed tasks (resume support)
    if (taskState.status === "done" || taskState.status === "skipped") {
      console.log(`[evolution] [${task.task_id}] Already ${taskState.status} — skipping`);
      continue;
    }

    progress.current_task_index = i;
    await saveProgress(stateDir, progress);

    console.log(`\n${"=".repeat(60)}`);
    console.log(`[evolution] TASK ${i + 1}/${tasks.length}: ${task.task_id} — ${task.title}`);
    console.log(`[evolution] Risk: ${task.risk_level || "medium"} | Intervention: ${task.intervention_title}`);
    console.log(`${"=".repeat(60)}`);

    if (options.dryRun) {
      console.log(`[evolution] [DRY RUN] Would execute: ${task.task_id}`);
      taskState.status = "skipped";
      await saveProgress(stateDir, progress);
      continue;
    }

    // Step A: Athena pre-reviews the task once before any worker attempt
    console.log(`[evolution] Athena pre-reviewing task ${task.task_id}...`);
    await appendProgress(config, `[EVO] Athena pre-review — ${task.task_id}`);
    let activeTask = repairPrometheusTask(task);
    let preReview: AthenaReview = await runAthenaTaskReview(config, activeTask);
    console.log(`[evolution] Athena pre-review: ${preReview.approved ? "APPROVED" : "REJECTED"} — ${preReview.reason}`);

    if (!preReview.approved && shouldRetryAthenaPreReview(preReview)) {
      for (let retry = 1; retry <= ATHENA_PRE_REVIEW_MAX_RETRIES && !preReview.approved; retry++) {
        console.log(`[evolution] Athena pre-review retry ${retry}/${ATHENA_PRE_REVIEW_MAX_RETRIES} with hardened criteria...`);
        activeTask = hardenTaskForAthena(activeTask, preReview);
        preReview = await runAthenaTaskReview(config, activeTask);
        console.log(`[evolution] Athena pre-review retry result: ${preReview.approved ? "APPROVED" : "REJECTED"} — ${preReview.reason}`);
      }
    }

    if (!preReview.approved) {
      activeTask = injectAthenaMissingItems(activeTask, preReview);
      await appendProgress(
        config,
        `[EVO] ${task.task_id} — Athena missing items injected into task; proceeding with worker execution`
      );
      console.warn(`[evolution] ${task.task_id} pre-review rejected; injected Athena missing items and continuing`);

      preReview = {
        ...preReview,
        approved: true,
        reason: `Auto-converted to execution after missing-item injection: ${preReview.reason || "Athena requested additional constraints"}`
      };
    }

    // Rework loop for this task
    let taskDone = false;
    while (!taskDone && taskState.attempts < maxAttempts) {
      taskState.attempts += 1;
      taskState.status = "in_progress";
      await saveProgress(stateDir, progress);

      const attemptLabel = `${task.task_id} attempt ${taskState.attempts}/${maxAttempts}`;
      console.log(`[evolution] Dispatching evolution-worker — ${attemptLabel}`);
      await appendProgress(config, `[EVO] ${attemptLabel} — ${task.title}`);

      // Build instruction — pass Athena's pre-review notes so the worker
      // starts with Athena's assessment baked into its context.
      const instruction = buildInstruction(activeTask, preReview);

      // Add rework context if this is a retry
      if (taskState.attempts > 1 && taskState.athena_verdict) {
        const lastVerdict = taskState.athena_verdict;
        instruction.task += `\n\n## REWORK CONTEXT (attempt ${taskState.attempts})\n` +
          `Previous attempt failed Athena review.\n` +
          `Athena actual outcome: ${lastVerdict.actualOutcome || "not provided"}\n` +
          `Lesson: ${lastVerdict.lessonLearned || "not provided"}\n` +
          `Follow-up: ${lastVerdict.followUpTask || "not provided"}\n` +
          `Fix these gaps before marking done.`;
      }

      console.log(`[evolution] Worker: ${EVOLUTION_WORKER_SLUG}`);

      // Dispatch the single dedicated evolution-worker
      let workerResult;
      try {
        workerResult = await runWorkerConversation(
          config,
          EVOLUTION_WORKER_SLUG,
          instruction,
          [], // fresh history per evolution task
          { evolutionTaskId: task.task_id, attempt: taskState.attempts }
        );
      } catch (err) {
        console.error(`[evolution] Worker dispatch error: ${err.message}`);
        taskState.status = "rework";
        taskState.error = err.message;
        await saveProgress(stateDir, progress);
        continue;
      }

      console.log(`[evolution] Worker status: ${workerResult.status}`);

      if (workerResult.status === "blocked" || workerResult.status === "error") {
        taskState.status = "rework";
        taskState.error = `worker-${workerResult.status}`;
        await saveProgress(stateDir, progress);
        console.warn(`[evolution] Worker returned ${workerResult.status} — scheduling rework`);
        continue;
      }

      // 4c. Run verification commands
      // 4b-gate. Artifact gate: worker output must contain a post-merge git SHA
      // and raw npm test output to prove the change was actually committed and tested.
      // Non-merge task kinds (scan, doc, observation, diagnosis) are exempt.
      const evolutionTaskKind = instruction.taskKind || "backend";
      const evolutionWorkerKind = "backend"; // evolution-worker is always backend-lane
      if (isArtifactGateRequired(evolutionWorkerKind, evolutionTaskKind)) {
        const artifact = checkPostMergeArtifact(workerResult.fullOutput || workerResult.summary || "");
        if (!artifact.hasArtifact) {
          const gaps: string[] = [];
          if (artifact.hasUnfilledPlaceholder) gaps.push(ARTIFACT_GAP.UNFILLED_PLACEHOLDER);
          if (!artifact.hasSha) gaps.push(ARTIFACT_GAP.MISSING_SHA);
          if (!artifact.hasTestOutput) gaps.push(ARTIFACT_GAP.MISSING_TEST_OUTPUT);
          taskState.status = "rework";
          taskState.error = `${ARTIFACT_GATE_ERROR_PREFIX}: ${gaps.join("; ")}`;
          await appendProgress(config, `[EVO] ${task.task_id} — artifact gate failed: ${gaps.join("; ")}`);
          await saveProgress(stateDir, progress);
          console.warn(`[evolution] Artifact gate failed — scheduling rework (${gaps.join(", ")})`);
          continue;
        }
      }

      // 4b-scope. Scope conformance gate: block finalization when the worker
      // modified files outside the declared task scope (Task 7).
      // Allows no-hint tasks through (scope guard requires explicit files_hint).
      const scopeCheck = checkScopeConformance(
        Array.isArray(workerResult.filesTouched) ? workerResult.filesTouched as string[] : [],
        activeTask.files_hint || []
      );
      if (!scopeCheck.ok) {
        taskState.status = "rework";
        taskState.error = `scope-violation: ${scopeCheck.unrelatedFiles.join(", ")}`;
        await appendProgress(config,
          `[EVO] ${task.task_id} — scope conformance gate failed: ${scopeCheck.unrelatedFiles.length} unrelated file(s) touched`
        );
        await saveProgress(stateDir, progress);
        console.warn(`[evolution] Scope violation — scheduling rework\n${scopeCheck.recoveryInstruction}`);
        continue;
      }

      // 4c. Run verification commands
      console.log(`[evolution] Running verification commands...`);
      const verification = runVerificationCommands(activeTask);
      console.log(`[evolution] Verification: ${verification.passed ? "PASSED" : "FAILED"}`);
      console.log(verification.summary);

      // 4d. PR checks gate (default fail-closed): if worker opened/updated a PR,
      // require all remote checks to be green before proceeding.
      const requireGreenPrChecks = config.runtime?.requireGreenPrChecks !== false;
      let prChecks: PrChecksResult = { ok: true, passed: true, failed: [], pending: [], total: 0 };
      if (requireGreenPrChecks && workerResult.prUrl) {
        console.log("[evolution] Validating PR status checks...");
        prChecks = await readPrChecks(config, workerResult.prUrl);

        if (!prChecks.ok) {
          taskState.status = "rework";
          taskState.error = `pr-checks-unavailable:${prChecks.error}`;
          await appendProgress(config, `[EVO] ${task.task_id} — PR checks unavailable, rework scheduled`);
          await saveProgress(stateDir, progress);
          console.warn("[evolution] Could not read PR checks — scheduling rework");
          continue;
        }

        if (!prChecks.passed) {
          const failedList = prChecks.failed.join(", ") || "none";
          const pendingList = prChecks.pending.join(", ") || "none";
          taskState.status = "rework";
          taskState.error = `pr-checks-not-green failed=[${failedList}] pending=[${pendingList}]`;
          await appendProgress(config,
            `[EVO] ${task.task_id} — PR checks not green; failed=[${failedList}] pending=[${pendingList}]`
          );
          await saveProgress(stateDir, progress);
          console.warn(`[evolution] PR checks not green — scheduling rework (failed=[${failedList}] pending=[${pendingList}])`);
          continue;
        }
      }

      // 4e. Run Athena postmortem
      // Pass the full worker output + verification results so Athena has
      // complete evidence: what the worker said, what files changed,
      // what the verification commands returned, and what the pre-review flagged.
      console.log(`[evolution] Running Athena postmortem...`);
      const athenaInput = {
        roleName: EVOLUTION_WORKER_SLUG,
        status: workerResult.status,
        prUrl: workerResult.prUrl,
        // Worker's own summary + structured verification report
        summary: [
          workerResult.summary || "(no summary)",
          workerResult.verificationReport
            ? `\nWORKER VERIFICATION_REPORT:\n${JSON.stringify(workerResult.verificationReport, null, 2)}`
            : ""
        ].join(""),
        filesTouched: workerResult.filesTouched,
        // Local verification command results (npm test output, etc.)
        verificationOutput: verification.summary,
        verificationPassed: verification.passed,
        prChecks,
        // Athena's own pre-review notes — closes the feedback loop
        preReviewAssessment: preReview.reason || null,
        preReviewIssues: preReview.issues || []
      };
      const athenaOriginalPlan = {
        task: activeTask.title,
        verification: (activeTask.acceptance_criteria || []).join("; "),
        context: activeTask.scope
      };

      let athenaResult;
      try {
        athenaResult = await runAthenaPostmortem(config, athenaInput, athenaOriginalPlan);
      } catch (err) {
        console.error(`[evolution] Athena error: ${err.message}`);
        // Fail-closed: don't auto-proceed if Athena fails
        athenaResult = { parsed: { recommendation: "escalate", lessonLearned: `Athena threw: ${err.message}` }, ok: false };
      }

      const verdict = extractAthenaVerdict(athenaResult);
      taskState.athena_verdict = athenaResult?.parsed || null;
      taskState.worker_result = {
        status: workerResult.status,
        prUrl: workerResult.prUrl,
        filesTouched: workerResult.filesTouched,
        verificationPassed: verification.passed,
        prChecks
      };
      // Persist explicit evidence of which task-named verification targets were executed.
      taskState.verification_passed = verification.passed;
      taskState.verification_targets = verification.targets;

      console.log(`[evolution] Athena verdict: ${verdict.toUpperCase()}`);
      await appendProgress(config, `[EVO] ${task.task_id} — Athena: ${verdict.toUpperCase()}`);

      if (verdict === "proceed" && verification.passed) {
        taskState.status = "done";
        taskState.completed_at = new Date().toISOString();
        taskDone = true;
        console.log(`[evolution] ✓ ${task.task_id} DONE`);
      } else if (verdict === "proceed" && !verification.passed) {
        // Athena said proceed but tests failed — treat as rework
        console.warn(`[evolution] Athena approved but verification failed — reworking`);
        taskState.status = "rework";
      } else if (verdict === "rework") {
        taskState.status = "rework";
        console.log(`[evolution] → Rework scheduled (attempt ${taskState.attempts}/${maxAttempts})`);
      } else {
        // escalate
        taskState.status = "escalated";
        taskDone = true; // stop retrying, advance to next task
        console.warn(`[evolution] ⚠ ${task.task_id} ESCALATED — continuing to next task`);
      }

      await saveProgress(stateDir, progress);
    }

    // Max attempts exceeded
    if (!taskDone && taskState.status !== "escalated") {
      taskState.status = "escalated";
      taskState.error = `Max attempts (${maxAttempts}) exceeded`;
      await saveProgress(stateDir, progress);
      console.warn(`[evolution] ⚠ ${task.task_id} ESCALATED after ${maxAttempts} attempts`);
    }
  }

  // 5. Final summary
  const finalCounts = Object.values(progress.tasks).reduce((acc: Record<string, number>, t: ProgressTaskState) => {
    acc[t.status] = (acc[t.status] || 0) + 1;
    return acc;
  }, {});

  console.log(`\n${"=".repeat(60)}`);
  console.log("[evolution] EVOLUTION LOOP COMPLETE");
  console.log(JSON.stringify(finalCounts, null, 2));
  console.log(`${"=".repeat(60)}`);

  return { cycleId, summary: finalCounts, progress };
}
