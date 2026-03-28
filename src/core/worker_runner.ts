/**
 * Worker Runner — Single-Prompt Worker Sessions
 *
 * Each worker (King David, Esther, Aaron, etc.) has a conversation thread.
 * The orchestrator dispatches tasks via runWorkerConversation().
 *
 * The conversation history is passed as context on every call,
 * making it feel like a persistent session even though Copilot CLI is stateless.
 *
 * Workers use single-prompt mode (--agent only, no autopilot/allow-all):
 *   - 1 worker call = 1 premium request, tool calls within session are FREE
 *   - Worker uses tools to read/edit files, run commands, create PRs
 *   - Session management and status tracking are handled by the runner
 */

import path from "node:path";
import fs from "node:fs/promises";
import { writeFileSync, readFileSync, existsSync } from "node:fs";
import { spawnAsync } from "./fs_utils.js";
import { getRoleRegistry } from "./role_registry.js";
import { appendProgress, appendLineageEntry, appendFailureClassification } from "./state_tracker.js";
import { buildAgentArgs, nameToSlug } from "./agent_loader.js";
import { buildVerificationChecklist } from "./verification_profiles.js";
import { getVerificationCommands } from "./verification_command_registry.js";
import { parseVerificationReport, parseResponsiveMatrix, validateWorkerContract, decideRework, checkPostMergeArtifact, collectArtifactGaps, isArtifactGateRequired, extractMergedSha } from "./verification_gate.js";
import { enforceModelPolicy, routeModelWithUncertainty, classifyComplexityTier, COMPLEXITY_TIER } from "./model_policy.js";
import { deriveRoutingAdjustments, buildPromptHardConstraints } from "./learning_policy_compiler.js";
import { loadPolicy, getProtectedPathMatches, getRolePathViolations } from "./policy_engine.js";
import { appendEscalation, BLOCKING_REASON_CLASS, NEXT_ACTION } from "./escalation_queue.js";
import { buildTaskFingerprint, buildLineageId, LINEAGE_ENTRY_STATUS } from "./lineage_graph.js";
import { classifyFailure } from "./failure_classifier.js";
import { resolveRetryAction, persistRetryMetric } from "./retry_strategy.js";

type WorkerRunnerConfig = {
  env?: Record<string, string | undefined>;
  paths?: {
    stateDir?: string;
  };
  [key: string]: unknown;
};

type PremiumUsageMeta = {
  outcome?: string;
  taskId?: string | number | null;
};

type WorkerRegistryEntry = {
  name?: string;
  model?: string;
  kind?: string;
  [key: string]: unknown;
};

type TaskHints = {
  estimatedLines?: number;
  estimatedDurationMinutes?: number;
  complexity?: string;
};

type RoutingAdjustment = {
  policyId: string;
  modelOverride: string;
  reason: string;
  severity: string;
};

type PromptHardConstraint = {
  policyId: string;
  constraint: string;
  blocking: boolean;
  severity: string;
};

type PromptControls = {
  tier?: string;
  hardConstraints?: PromptHardConstraint[];
};

type WorkerActivityEntry = {
  at?: string;
  status?: string;
  task?: string;
  files?: string[];
  pr?: string;
};

type WorkerSessionState = {
  currentBranch?: string | null;
  createdPRs?: string[];
  filesTouched?: string[];
  activityLog?: WorkerActivityEntry[];
  [key: string]: unknown;
};

type SpawnAsyncResult = {
  status: number;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
  aborted?: boolean;
};

type VerificationEvidence = {
  profile: string;
  hasReport: boolean;
  report: unknown;
  responsiveMatrix: unknown;
  prUrl: string | null;
  gaps: string[];
  passed: boolean;
  attempt: number;
  validatedAt: string;
  roleName: string;
  taskSnippet: string;
};

type ParsedWorkerResponse = ReturnType<typeof parseWorkerResponse> & {
  verificationEvidence?: VerificationEvidence | null;
};

// ── Premium usage tracking ──────────────────────────────────────────────────

function logPremiumUsage(config, roleName, model, taskKind, durationMs, { outcome, taskId }: PremiumUsageMeta = {}) {
  const logPath = path.join(config.paths?.stateDir || "state", "premium_usage_log.json");
  let entries = [];
  try {
    if (existsSync(logPath)) {
      entries = JSON.parse(readFileSync(logPath, "utf8"));
      if (!Array.isArray(entries)) entries = [];
    }
  } catch { entries = []; }
  entries.push({
    worker: roleName,
    model,
    taskKind: taskKind || "general",
    startedAt: new Date(Date.now() - durationMs).toISOString(),
    completedAt: new Date().toISOString(),
    durationMs,
    outcome: outcome || "unknown",
    taskId: taskId || null
  });
  // Keep last 500 entries to prevent unbounded growth
  if (entries.length > 500) entries = entries.slice(-500);
  try { writeFileSync(logPath, JSON.stringify(entries, null, 2), "utf8"); } catch { /* non-critical */ }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncate(text, max) {
  const s = String(text || "");
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

/**
 * Compute a recent ROI proxy from the premium usage log for the given task kind.
 * Returns a value in [0, 1]: ratio of "done" outcomes in the last 10 matching entries.
 * Returns 0 when there is no history (fail-open — caller treats 0 as "no signal").
 */
function computeRecentROI(config, taskKind: string): number {
  try {
    const logPath = path.join(config.paths?.stateDir || "state", "premium_usage_log.json");
    if (!existsSync(logPath)) return 0;
    const entries = JSON.parse(readFileSync(logPath, "utf8"));
    if (!Array.isArray(entries)) return 0;
    const relevant = entries
      .filter((e) => !taskKind || e.taskKind === taskKind)
      .slice(-10);
    if (relevant.length === 0) return 0;
    const successCount = relevant.filter((e) => e.outcome === "done").length;
    return successCount / relevant.length;
  } catch {
    return 0; // fail-open: absence of history must never block dispatch
  }
}

/**
 * Load compiled lesson-based policies from state/learned_policies.json.
 * Fail-open: returns [] on any read or parse error.
 */
function loadLearnedPolicies(config): any[] {
  try {
    const pPath = path.join(config.paths?.stateDir || "state", "learned_policies.json");
    if (!existsSync(pPath)) return [];
    const data = JSON.parse(readFileSync(pPath, "utf8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return []; // non-critical; missing policy file must never block dispatch
  }
}

function getLiveLogPath(config, roleName) {
  const stateDir = config.paths?.stateDir || "state";
  const safeRole = String(roleName || "worker").replace(/[^a-z0-9_-]+/gi, "_");
  return path.join(stateDir, `live_worker_${safeRole}.log`);
}

async function appendLiveWorkerLog(logPath, text) {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, text, "utf8");
}

// ── Find worker config by role name ─────────────────────────────────────────

function findWorkerByName(config, roleName) {
  const registry = getRoleRegistry(config);
  const workers = registry?.workers || {};
  for (const [kind, worker] of Object.entries(workers) as Array<[string, WorkerRegistryEntry]>) {
    if (worker?.name === roleName) return { kind, ...worker };
  }
  return null;
}

// ── Task-aware model resolution ───────────────────────────────────────────────
// Priority: taskKind → role preference → worker model → uncertainty-aware routing → default
// Policy adjustments from compiled lessons may override the candidate after selection.

function resolveModel(config, roleName, taskKind, taskHints: TaskHints = {}, routingAdjustments: RoutingAdjustment[] = []) {
  const defaultModel = config?.copilot?.defaultModel || "Claude Sonnet 4.6";
  const strongModel = config?.copilot?.strongModel || defaultModel;
  const efficientModel = config?.copilot?.efficientModel || defaultModel;

  let candidate;
  // 1. Task-kind override (e.g. "scan" always uses GPT-5.3-Codex)
  if (taskKind) {
    const byKind = config?.copilot?.preferredModelsByTaskKind?.[taskKind];
    if (Array.isArray(byKind) && byKind.length > 0) candidate = byKind[0];
  }
  // 2. Role-specific preference
  if (!candidate) {
    const byRole = config?.copilot?.preferredModelsByRole?.[roleName];
    if (Array.isArray(byRole) && byRole.length > 0) candidate = byRole[0];
  }
  // 3. Worker's registered static model
  if (!candidate) {
    const workerConfig = findWorkerByName(config, roleName);
    if (workerConfig?.model) candidate = workerConfig.model;
  }
  // 4. Uncertainty-aware routing: factor in task complexity tier + historical ROI
  //    to auto-select the right model when no explicit config override exists.
  if (!candidate) {
    const recentROI = computeRecentROI(config, taskKind);
    const uncertaintyRoute = routeModelWithUncertainty(
      taskHints,
      { defaultModel, strongModel, efficientModel },
      { recentROI }
    );
    candidate = uncertaintyRoute.model;
    if (uncertaintyRoute.uncertainty !== "low") {
      try {
        appendProgress(config,
          `[UNCERTAINTY_ROUTE] ${roleName}: tier=${uncertaintyRoute.tier} uncertainty=${uncertaintyRoute.uncertainty} recentROI=${recentROI.toFixed(2)} → ${candidate}`
        );
      } catch { /* non-critical */ }
    }
  }

  // 5. Apply routing adjustments derived from compiled lesson policies.
  //    Recurring failure classes (e.g. syntax errors, import errors) override the
  //    complexity-based selection since model capability was NOT the root cause.
  for (const adj of routingAdjustments) {
    if (adj.modelOverride === "force-sonnet") {
      const previous = candidate;
      candidate = defaultModel;
      try {
        appendProgress(config,
          `[POLICY_ROUTE] ${roleName}: ${previous} → ${defaultModel} (policy=${adj.policyId}: ${adj.reason})`
        );
      } catch { /* non-critical */ }
      break; // First critical policy override wins
    }
    if (adj.modelOverride === "block-opus" && /opus/i.test(String(candidate || ""))) {
      candidate = defaultModel;
      try {
        appendProgress(config,
          `[POLICY_ROUTE] ${roleName}: Opus blocked → ${defaultModel} (policy=${adj.policyId}: ${adj.reason})`
        );
      } catch { /* non-critical */ }
      break;
    }
  }

  // 6. Enforce model policy — ban fast/30x, gate Opus to large tasks
  const policy = enforceModelPolicy(candidate || defaultModel, taskHints, defaultModel);
  if (policy.downgraded) {
    try { appendProgress(config, `[MODEL_POLICY] ${roleName}: ${policy.reason}`); } catch { /* non-critical */ }
  }
  return policy.model;
}

// ── Build conversation-only context (persona is in .agent.md) ───────────────

function buildConversationContext(history, instruction, sessionState: WorkerSessionState = {}, config: WorkerRunnerConfig = {}, workerKind = null, promptControls: PromptControls = {}) {
  const parts = [];

  // Persistent worker state — always injected first so workers always know where they stand
  const targetRepo = config.env?.targetRepo || "(not set)";
  const branch = sessionState.currentBranch || null;
  const prs = Array.isArray(sessionState.createdPRs) ? sessionState.createdPRs : [];
  const filesTouchedAll = Array.isArray(sessionState.filesTouched) ? sessionState.filesTouched : [];
  const activityLog = Array.isArray(sessionState.activityLog) ? sessionState.activityLog : [];

  parts.push("## YOUR PERSISTENT STATE");
  parts.push(`Target Repo: ${targetRepo}`);
  if (branch) parts.push(`Current Branch: ${branch}`);
  if (prs.length > 0) parts.push(`PRs You Created: ${prs.slice(-5).join(", ")}`);
  if (filesTouchedAll.length > 0) {
    const shown = filesTouchedAll.slice(-10);
    const more = filesTouchedAll.length - shown.length;
    parts.push(`Files You've Worked On: ${shown.join(", ")}${more > 0 ? ` (+${more} more)` : ""}`);
  }
  parts.push("");

  if (activityLog.length > 0) {
    parts.push("## YOUR ACTIVITY LOG");
    activityLog.slice(-5).forEach(entry => {
      const date = entry.at ? entry.at.slice(0, 16).replace("T", " ") : "?";
      const files = Array.isArray(entry.files) && entry.files.length > 0
        ? ` | ${entry.files.slice(0, 4).join(", ")}` : "";
      const pr = entry.pr ? ` → PR ${entry.pr.split("/").pop()}` : "";
      parts.push(`[${date}] ${String(entry.status || "").toUpperCase().padEnd(8)} ${String(entry.task || "").slice(0, 80)}${pr}${files}`);
    });
    parts.push("");
  }

  // Inject knowledge memory lessons relevant to this worker
  try {
    const kmPath = path.join(config.paths?.stateDir || "state", "knowledge_memory.json");
    if (existsSync(kmPath)) {
      const km = JSON.parse(readFileSync(kmPath, "utf8"));
      const promptHints = Array.isArray(km.promptHints)
        ? km.promptHints.filter(h => {
            const target = String(h.targetAgent || "").toLowerCase();
            return target === "all" || target === "workers" || target === String(workerKind || "").toLowerCase();
          })
        : [];
      const recentLessons = Array.isArray(km.lessons) ? km.lessons.slice(-5) : [];

      if (promptHints.length > 0 || recentLessons.length > 0) {
        parts.push("## SYSTEM LEARNINGS (from previous cycles)");
        for (const hint of promptHints) {
          parts.push(`- [HINT] ${hint.hint} (reason: ${hint.reason})`);
        }
        for (const lesson of recentLessons) {
          if (lesson.severity === "critical" || lesson.severity === "warning") {
            parts.push(`- [${lesson.severity.toUpperCase()}] ${lesson.lesson}`);
          }
        }
        parts.push("");
      }
    }
  } catch { /* knowledge memory not available yet — no-op */ }

  // Loop detection — inject a visible warning before history if the worker is stuck
  const myMessages = history.filter(m => {
    const from = String(m?.from || "").toLowerCase();
    return from !== "athena" && from !== "prometheus";
  });
  const recentOwn = myMessages.slice(-3);
  const allFailed = recentOwn.length >= 2 && recentOwn.every(m =>
    m.status === "error" || m.status === "blocked" ||
    String(m.content || "").toLowerCase().startsWith("error")
  );
  const repeatedContent = recentOwn.length >= 2 &&
    recentOwn.every(m => truncate(m.content, 120) === truncate(recentOwn[0].content, 120));

  if (repeatedContent) {
    parts.push("## ⚠️ LOOP DETECTED — YOU ARE REPEATING THE SAME OUTPUT");
    parts.push("Your last responses are identical. You are in a loop.");
    parts.push("MANDATORY: Stop completely. Do NOT repeat the same action.");
    parts.push("Step 1: Re-read the task from scratch — assume your previous understanding was wrong.");
    parts.push("Step 2: Pick a completely different implementation strategy.");
    parts.push("Step 3: If you genuinely cannot proceed differently, output BOX_STATUS=blocked with a root-cause analysis.");
    parts.push("");
  } else if (allFailed) {
    parts.push("## ⚠️ REPEATED FAILURE — CHANGE YOUR APPROACH");
    parts.push(`You have failed ${recentOwn.length} times in a row on this task. Your current approach is not working.`);
    parts.push("MANDATORY before continuing:");
    parts.push("  1. Identify WHY each previous attempt failed (permissions? missing deps? wrong file? wrong assumption?)");
    parts.push("  2. Form a NEW hypothesis about the root cause.");
    parts.push("  3. Apply a fundamentally different fix strategy.");
    parts.push("  4. If after this attempt it still fails, output BOX_STATUS=blocked with:");
    parts.push("     - All approaches you tried");
    parts.push("     - The exact error each time");
    parts.push("     - Evidence-based root cause analysis for why none of them worked");
    parts.push("");
  }

  if (history.length > 0) {
    parts.push("## CONVERSATION HISTORY");
    const recentHistory = history.slice(-12);
    for (const msg of recentHistory) {
      const from = String(msg?.from || "").toLowerCase();
      if (from === "athena" || from === "prometheus") {
        parts.push(`\nINSTRUCTION: ${truncate(msg.content, 600)}`);
      } else {
        parts.push(`\nYOU (${msg.from}): ${truncate(msg.content, 800)}`);
      }
    }
    parts.push("");
  }

  parts.push("## NEW INSTRUCTION");
  parts.push("Treat this instruction as an execution brief: objective, constraints, and success criteria.");
  parts.push("You own the method. If a better implementation order or safer approach exists, use it and explain why in your summary.");
  parts.push("Do not follow literal step ordering if repository reality suggests a stronger senior-level approach.");
  parts.push("\n## EXECUTION INTEGRITY PROTOCOL");
  parts.push("1) Verify access before acting. Validate: target repo path, required files, required tools, and required remote/API access.");
  parts.push("2) Never guess. Do not use assumed/projected facts when evidence is missing. If you need data, fetch it.");
  parts.push("3) If anything is inaccessible, do not improvise. Report the exact blocker with evidence.");
  parts.push("4) If you choose an alternative path, include impact analysis: correctness risk, scope impact, rollback, and whether it is a permanent fix or temporary workaround.");
  parts.push("5) Prefer permanent deterministic fixes over temporary bypasses.");
  parts.push("6) PR ownership is yours end-to-end: create/update your PR for your task, monitor GitHub checks, fix failures you see, and when checks are green merge it yourself.");
  parts.push("7) If checks remain pending, keep watching until green or report the exact failing/pending checks.");

  parts.push("\n## INDEPENDENT THINKING — VERIFY YOUR ORDERS");
  parts.push("You are a senior engineer, not a blind executor. Before implementing your instructions:");
  parts.push("1) EVALUATE the plan: Does this instruction make technical sense for the codebase? Is it the right approach?");
  parts.push("2) CHECK for conflicts: Will this change break something that's already working? Does it conflict with other workers' work?");
  parts.push("3) VALIDATE scope: Is the instruction appropriately scoped for this project type? (Don't add enterprise security to a portfolio site, don't skip auth on a SaaS app)");
  parts.push("4) CHALLENGE if wrong: If the instruction contains a technical error, an incorrect assumption, or a suboptimal approach:");
  parts.push("   - State what's wrong and why");
  parts.push("   - Propose the correct approach");
  parts.push("   - Implement the CORRECT version, not the flawed instruction");
  parts.push("   - Document your reasoning in the summary");
  parts.push("5) ENHANCE if possible: If you see an obviously better way to achieve the goal that the plan didn't consider, do it the better way.");
  parts.push("6) NEVER blindly execute instructions that would:");
  parts.push("   - Break existing passing tests");
  parts.push("   - Remove functionality that's currently working");
  parts.push("   - Add unnecessary complexity for the project type");
  parts.push("   - Introduce security vulnerabilities");
  parts.push("You own the quality of YOUR output. Execute at a senior engineering level — methodology is yours.");
  parts.push("\n## WORK QUALITY MANDATE");
  parts.push("Each premium request costs real money. You MUST deliver complete, correct, production-quality work in this single request.");
  parts.push("- Write exactly as much code as the task requires — no more, no less.");
  parts.push("- Prefer focused, targeted changes that solve the problem cleanly over large rewrites.");
  parts.push("- Complete your ENTIRE assigned task in one shot — do not leave partial work for a follow-up request.");
  parts.push("- If your task involves multiple files, fix ALL of them before reporting done.");
  parts.push("- Senior production standard: correct logic, proper error handling, edge cases handled, tests where relevant.");

  // Canonical verification commands from the central registry
  const verifCmds = getVerificationCommands(config);
  parts.push("\n## CANONICAL VERIFICATION COMMANDS");
  parts.push(`Use these exact commands for verification (do NOT invent shell globs):`);
  parts.push(`  Test:  ${verifCmds.test}`);
  parts.push(`  Lint:  ${verifCmds.lint}`);
  parts.push(`  Build: ${verifCmds.build}`);

  // Prompt tier budget — informs the worker how much reasoning depth is expected.
  // T3 (architectural): deep think required, critic mandatory, multi-pass.
  // T2 (medium): two-pass, moderate reasoning.
  // T1 (routine): lean, direct implementation — no extra passes needed.
  const tier = promptControls.tier;
  if (tier === COMPLEXITY_TIER.T3) {
    parts.push("\n## PROMPT TIER BUDGET — T3 (ARCHITECTURAL)");
    parts.push("This task is classified as T3: deep architectural reasoning required.");
    parts.push("- Mandatory: multi-pass reasoning (design → implement → verify → critique).");
    parts.push("- Perform a critic step before finalising: challenge your own solution.");
    parts.push("- Verify all edge cases explicitly before reporting done.");
    parts.push("- Budget: up to 5 continuation passes if needed.");
  } else if (tier === COMPLEXITY_TIER.T2) {
    parts.push("\n## PROMPT TIER BUDGET — T2 (MEDIUM)");
    parts.push("This task is classified as T2: two-pass reasoning expected.");
    parts.push("- Implement first, then verify the result before reporting done.");
    parts.push("- Budget: up to 3 continuation passes if needed.");
  }
  // T1: no tier section — keep the prompt lean for routine patches.

  // Role-based verification — inject requirements specific to this worker's kind
  if (workerKind) {
    parts.push("");
    parts.push(buildVerificationChecklist(workerKind));
  } else {
    // Fallback for unknown roles — basic verification
    parts.push("\n## SELF-VERIFICATION PROTOCOL");
    parts.push("Before reporting done, verify your work: run build, run tests, check edge cases.");
    parts.push("Include VERIFICATION_REPORT: BUILD=<pass|fail|n/a>; TESTS=<pass|fail|n/a>; RESPONSIVE=<pass|fail|n/a>; API=<pass|fail|n/a>; EDGE_CASES=<pass|fail|n/a>; SECURITY=<pass|fail|n/a>");
  }

  // Hard constraints from compiled lesson policies — injected prominently so the
  // model cannot silently violate them. Blocking constraints cause immediate rework
  // if violated. Violation is detected via the verification gate at post-task review.
  const hardConstraints = Array.isArray(promptControls.hardConstraints) ? promptControls.hardConstraints : [];
  if (hardConstraints.length > 0) {
    parts.push("\n## HARD CONSTRAINTS (enforced from prior cycle lessons — violations trigger rework)");
    for (const hc of hardConstraints) {
      const blockLabel = hc.blocking ? " [BLOCKING]" : "";
      parts.push(`${hc.constraint}${blockLabel}`);
    }
  }

  parts.push("\n## OUTPUT FORMAT");
  parts.push("Think deeply and work naturally. Write your full reasoning, analysis, and implementation details.");
  parts.push("At the END of your response, include these optional machine-readable markers (if applicable):");
  parts.push("BOX_STATUS=<done|partial|blocked|error>");
  parts.push("BOX_PR_URL=<url>   (if you created/updated a PR)");
  parts.push("BOX_BRANCH=<name>  (if you created/switched a branch)");
  parts.push("BOX_FILES_TOUCHED=<comma-separated list>  (files you edited/created)");
  parts.push("BOX_ACCESS=repo:<ok|blocked>;files:<ok|blocked>;tools:<ok|blocked>;api:<ok|blocked>  (if you encountered access issues)");
  parts.push("If BOX_STATUS is omitted, it defaults to done.");
  parts.push("PR POLICY: If your task changes code, open or update your PR and carry it to merge when checks are green.");
  parts.push("");
  parts.push("## DONE-PATH ARTIFACT REQUIREMENTS (MANDATORY for BOX_STATUS=done on merge tasks)");
  parts.push("When reporting BOX_STATUS=done after merging code, you MUST include BOTH of the following:");
  parts.push("1. BOX_MERGED_SHA=<7-40 char hex commit SHA from the merged state>");
  parts.push("   Example: BOX_MERGED_SHA=abc1234");
  parts.push("   Run: git rev-parse HEAD   (after merge is confirmed)");
  parts.push("2. A raw npm test output block wrapped in explicit markers:");
  parts.push("   ===NPM TEST OUTPUT START===");
  parts.push("   <paste full stdout from 'npm test' run on the merged branch>");
  parts.push("   ===NPM TEST OUTPUT END===");
  parts.push("Omitting either artifact will cause the verification gate to reject your done status.");
  parts.push(String(instruction.task || ""));

  // Warn when the task text provides no specific test file targets so the worker
  // knows it must supply concrete test evidence in its VERIFICATION_REPORT.
  const taskText = String(instruction.task || "");
  const hasSpecificTestTarget = /\.(test|spec)\.(ts|js|tsx|jsx)/i.test(taskText) ||
    /\/tests?\/[^\s]+/.test(taskText) ||
    /[—\-–]\s*test[:\s]/i.test(taskText);
  if (!hasSpecificTestTarget) {
    parts.push("");
    parts.push("## ⚠️ VERIFICATION TARGET REQUIRED");
    parts.push("No specific test file target was detected in this task's verification commands.");
    parts.push("You MUST provide specific test evidence in your VERIFICATION_REPORT:");
    parts.push("  - Run or create a specific test file (e.g. tests/core/<module>.test.ts)");
    parts.push("  - Reference it explicitly: 'node --test tests/core/<module>.test.ts'");
    parts.push("  - Generic 'npm test passed' alone is NOT accepted as verification evidence.");
  }

  if (instruction.context) {
    parts.push("");
    parts.push("Additional context:");
    parts.push(String(instruction.context));
  }
  if (instruction.isFollowUp && instruction.previousResult) {
    parts.push("");
    parts.push(`Your previous result: ${truncate(instruction.previousResult, 400)}`);
  }

  return parts.join("\n");
}

// ── Parse worker response ────────────────────────────────────────────────────
// Exported for unit testing of marker extraction and access-guard normalization.
export function parseWorkerResponse(stdout, stderr) {
  const output = String(stdout || "");
  const combined = `${output}\n${String(stderr || "")}`;

  // Extract status marker
  const statusMatch = combined.match(/BOX_STATUS=(\w+)/i);
  const status = statusMatch ? statusMatch[1].toLowerCase() : "done";

  // Extract PR URL
  const prMatch = combined.match(/BOX_PR_URL=(https?:\/\/\S+)/i);
  const prUrl = prMatch ? prMatch[1] : null;

  // Extract branch name — workers output BOX_BRANCH=feature/... when they create/switch a branch
  const branchMatch = combined.match(/BOX_BRANCH=(\S+)/i);
  const currentBranch = branchMatch ? branchMatch[1] : null;

  // Extract files edited/created — workers output BOX_FILES_TOUCHED=src/a.js,src/b.js
  const filesMatch = combined.match(/BOX_FILES_TOUCHED=([^\n\r]+)/i);
  const filesTouched = filesMatch
    ? filesMatch[1].split(",").map(f => f.trim()).filter(Boolean)
    : [];

  const accessHeaderMatch = combined.match(/BOX_ACCESS=([^\n\r]+)/i);
  const accessHeader = accessHeaderMatch ? accessHeaderMatch[1].trim() : null;
  const hasBlockedAccess = accessHeader ? /\bblocked\b/i.test(accessHeader) : false;

  // Guardrail: if access protocol reports blocked but status is not blocked,
  // force status to blocked for safe deterministic follow-up routing.
  let normalizedStatus = ["done", "partial", "blocked", "error"].includes(status) ? status : "done";
  if (hasBlockedAccess && normalizedStatus !== "blocked") {
    normalizedStatus = "blocked";
  }

  // Summary: preserve full natural-language output (no truncation)
  const lines = output.split(/\r?\n/).filter(l => l.trim());
  const meaningfulLines = lines.filter(l =>
    !l.startsWith("●") &&
    !l.startsWith("✓") &&
    !l.startsWith("⏺") &&
    !l.includes("tool_call") &&
    l.trim().length > 5
  );
  const summary = meaningfulLines.join("\n") || output;

  // Extract verification evidence from worker output
  const verificationReport = parseVerificationReport(output);
  const responsiveMatrix = parseResponsiveMatrix(output);

  // Extract explicit merged SHA marker (BOX_MERGED_SHA=<sha>).
  // Stored for audit and lineage — also surfaced in the done-path artifact check.
  const mergedSha = extractMergedSha(output);

  return {
    status: normalizedStatus,
    prUrl,
    currentBranch,
    filesTouched,
    summary,
    fullOutput: output,
    verificationReport,
    responsiveMatrix,
    mergedSha,
  };
}

// ── Main Worker Conversation ─────────────────────────────────────────────────

export async function runWorkerConversation(config, roleName, instruction, history = [], sessionState: WorkerSessionState = {}) {
  const taskHints: TaskHints = {
    estimatedLines: Number(instruction.estimatedLines || 0),
    estimatedDurationMinutes: Number(instruction.estimatedDurationMinutes || 0),
    complexity: String(instruction.complexity || instruction.estimatedComplexity || "")
  };

  // ── Task 2: Load compiled lesson policies and derive dispatch controls ──────
  // learned_policies.json is written by the orchestrator after each cycle from
  // postmortem lessons. Routing adjustments and prompt hard constraints are
  // derived here — fail-open so a missing/corrupt file never blocks dispatch.
  const learnedPolicies = loadLearnedPolicies(config);
  const routingAdjustments: RoutingAdjustment[] = deriveRoutingAdjustments(learnedPolicies);
  const hardConstraints: PromptHardConstraint[] = buildPromptHardConstraints(learnedPolicies);

  // ── Task 1: Uncertainty-aware model selection ─────────────────────────────
  // resolveModel now uses routeModelWithUncertainty (backed by historical ROI)
  // and applies policy routing adjustments from recurring failure lessons.
  const model = resolveModel(config, roleName, instruction.taskKind, taskHints, routingAdjustments);

  // Classify complexity tier for prompt budget injection
  const { tier } = classifyComplexityTier(taskHints);

  const command = config.env?.copilotCliCommand || "copilot";
  const agentSlug = nameToSlug(roleName); // "king-david", "esther", etc.

  // Resolve worker kind for role-based verification
  const workerConfig = findWorkerByName(config, roleName);
  const workerKind = workerConfig?.kind || null;

  // Build conversation-only context with prompt tier budget and hard constraints injected
  const conversationContext = buildConversationContext(
    history, instruction, sessionState, config, workerKind,
    { tier, hardConstraints }
  );

  await appendProgress(config, `[WORKER:${roleName}] [${instruction.taskKind || "general"}→${model}] ${truncate(instruction.task, 70)}`);

  const updatedHistory = [
    ...history,
    { from: "prometheus", content: instruction.task, timestamp: new Date().toISOString() }
  ];

  // Single-prompt mode: no autopilot continuations.
  // All implementation workers dispatched by the daemon need full tool access.
  const taskKindLower = String(instruction.taskKind || "").toLowerCase();
  const isImplementationTask = !taskKindLower || taskKindLower === "implementation";
  const allowAllTools = isImplementationTask || String(roleName || "").toLowerCase() === "evolution-worker";
  const args = buildAgentArgs({
    agentSlug,
    prompt: conversationContext,
    model,
    allowAll: allowAllTools,
    noAskUser: allowAllTools,
    maxContinues: undefined
  });

  // Compute timeout: config.runtime.workerTimeoutMinutes → ms.
  // 0 or negative means no timeout for worker execution.
  const workerTimeoutMinutes = Number(config?.runtime?.workerTimeoutMinutes || 0);
  const workerTimeoutMs = workerTimeoutMinutes > 0 ? workerTimeoutMinutes * 60 * 1000 : null;
  const liveLogPath = getLiveLogPath(config, roleName);

  await appendLiveWorkerLog(
    liveLogPath,
    [
      "",
      `${"=".repeat(80)}`,
      `[${new Date().toISOString()}] START role=${roleName} model=${model}`,
      `TASK: ${instruction.task}`,
      `${"-".repeat(80)}`,
      ""
    ].join("\n")
  );

  const startMs = Date.now();

  // Circuit breaker: detect consecutive transient API errors from the Copilot CLI
  // and abort the process early instead of waiting for 45-minute timeout.
  const TRANSIENT_ERROR_THRESHOLD = 10;
  let transientErrorCount = 0;
  const abortController = new AbortController();

  const result = await spawnAsync(command, args, {
    env: {
      ...process.env,
      GH_TOKEN: config.env?.githubToken || process.env.GH_TOKEN || "",
      GITHUB_TOKEN: config.env?.githubToken || process.env.GITHUB_TOKEN || "",
      TARGET_REPO: config.env?.targetRepo || "",
      TARGET_BASE_BRANCH: config.env?.targetBaseBranch || "main"
    },
    timeoutMs: workerTimeoutMs,
    signal: abortController.signal,
    onStdout: (chunk) => {
      const text = String(chunk);
      appendLiveWorkerLog(liveLogPath, text).catch(() => {});
      if (/transient API error/i.test(text)) {
        transientErrorCount++;
        if (transientErrorCount >= TRANSIENT_ERROR_THRESHOLD) {
          abortController.abort(
            `[BOX] Transient API error circuit breaker: ${transientErrorCount} consecutive errors — aborting to avoid waste`
          );
        }
      } else if (text.trim().length > 20) {
        // Reset counter on meaningful (non-error) output
        transientErrorCount = 0;
      }
    },
    onStderr: (chunk) => {
      const text = String(chunk);
      appendLiveWorkerLog(liveLogPath, `[stderr] ${text}`).catch(() => {});
      if (/transient API error/i.test(text)) {
        transientErrorCount++;
        if (transientErrorCount >= TRANSIENT_ERROR_THRESHOLD) {
          abortController.abort(
            `[BOX] Transient API error circuit breaker: ${transientErrorCount} consecutive errors — aborting to avoid waste`
          );
        }
      }
    }
  }) as SpawnAsyncResult;

  const stdout = String(result?.stdout || "");
  const stderr = String(result?.stderr || "");

  if (result.status !== 0) {
    const isTransient = result.aborted === true && /transient API error circuit breaker/i.test(stderr);
    const label = isTransient ? `TransientAPIError` : result.timedOut ? `Timeout` : `Error exit=${result.status}`;
    await appendLiveWorkerLog(
      liveLogPath,
      `\n[${new Date().toISOString()}] END status=error exit=${result.status}${result.timedOut ? " timeout=true" : ""}${isTransient ? " transient=true" : ""}\n`
    );
    await appendProgress(config, `[WORKER:${roleName}] ${label}`);
    const errorMsg = truncate(stderr || stdout || "unknown error", 300);

    // Persist structured escalation for worker errors/timeouts (non-critical write)
    appendEscalation(config, {
      role: roleName,
      task: instruction.task,
      blockingReasonClass: BLOCKING_REASON_CLASS.WORKER_ERROR,
      attempts: Number(instruction.reworkAttempt || 0),
      nextAction: NEXT_ACTION.RETRY,
      summary: label + ": " + errorMsg
    }).catch(() => { /* non-fatal */ });

    // Classify and persist failure (non-critical — never blocks the return)
    {
      const cfResult = classifyFailure({
        workerStatus: "error",
        blockingReasonClass: BLOCKING_REASON_CLASS.WORKER_ERROR,
        errorMessage: errorMsg,
        logLines: result.timedOut ? ["Process timed out"] : [],
        taskId: instruction.taskId || null,
      });
      if (cfResult.ok) {
        appendFailureClassification(config, cfResult.classification).catch(() => { /* non-fatal */ });
      }
    }

    // Resolve adaptive retry decision for error path
    let errorRetryDecision = null;
    try {
      const exitClassification = classifyFailure({
        workerStatus: "error",
        blockingReasonClass: BLOCKING_REASON_CLASS.WORKER_ERROR,
        errorMessage: errorMsg,
        logLines: result.timedOut ? ["Process timed out"] : [],
        taskId: instruction.taskId || null,
      });
      if (exitClassification.ok) {
        const rd = resolveRetryAction(
          exitClassification.classification.primaryClass,
          Number(instruction.reworkAttempt || 0),
          config,
          instruction.taskId || null
        );
        if (rd.ok) {
          errorRetryDecision = rd.decision;
          persistRetryMetric(config, rd.decision);
        }
      }
    } catch { /* non-fatal */ }

    updatedHistory.push({
      from: roleName,
      content: `ERROR: ${errorMsg}`,
      timestamp: new Date().toISOString(),
      status: "error"
    });
    return {
      status: isTransient ? "transient_error" : "error",
      summary: errorMsg,
      updatedHistory,
      prUrl: null,
      failureClassification: null,
      retryDecision: errorRetryDecision
    };
  }

  // Save raw output for debugging
  try {
    writeFileSync(
      path.join(config.paths?.stateDir || "state", `debug_worker_${roleName.replace(/\s+/g, "_")}.txt`),
      `TASK: ${instruction.task}\n\nOUTPUT:\n${stdout}`,
      "utf8"
    );
  } catch { /* non-critical */ }

  const parsed: ParsedWorkerResponse = parseWorkerResponse(stdout, stderr);

  // If access was reported as blocked, persist a structured escalation (non-critical)
  if (parsed.status === "blocked" && /BOX_ACCESS=[^\n]*blocked/i.test(stdout)) {
    appendEscalation(config, {
      role: roleName,
      task: instruction.task,
      blockingReasonClass: BLOCKING_REASON_CLASS.ACCESS_BLOCKED,
      attempts: Number(instruction.reworkAttempt || 0),
      nextAction: NEXT_ACTION.RETRY,
      summary: "Worker reported BOX_ACCESS blocked"
    }).catch(() => { /* non-fatal */ });
  }

  // Policy gate: protected path changes require reviewer approval,
  // so workers cannot auto-finish these changes as fully done.
  try {
    const policy = await loadPolicy(config);
    if (policy?.requireReviewerApprovalForProtectedPaths) {
      const protectedTouched = getProtectedPathMatches(policy, parsed.filesTouched);
      if (protectedTouched.length > 0 && parsed.status === "done") {
        parsed.status = "partial";
        parsed.summary = `Reviewer approval required for protected paths: ${protectedTouched.join(", ")}\n${parsed.summary}`;
      }
    }

    const pathViolations = getRolePathViolations(policy, roleName, parsed.filesTouched);
    if (pathViolations.hasViolation) {
      const deniedPreview = pathViolations.deniedMatches.slice(0, 3).join(", ");
      const outsidePreview = pathViolations.outsideAllowed.slice(0, 3).join(", ");
      const violationSummary = [
        pathViolations.deniedMatches.length > 0 ? `denied paths: ${deniedPreview}${pathViolations.deniedMatches.length > 3 ? " ..." : ""}` : "",
        pathViolations.outsideAllowed.length > 0 ? `outside allowed paths: ${outsidePreview}${pathViolations.outsideAllowed.length > 3 ? " ..." : ""}` : ""
      ].filter(Boolean).join(" | ");

      parsed.status = "blocked";
      parsed.summary = `Role path policy violation for ${roleName}: ${violationSummary}\n${parsed.summary}`;

      // Persist structured escalation for policy violations (non-critical)
      appendEscalation(config, {
        role: roleName,
        task: instruction.task,
        blockingReasonClass: BLOCKING_REASON_CLASS.POLICY_VIOLATION,
        attempts: Number(instruction.reworkAttempt || 0),
        nextAction: NEXT_ACTION.ESCALATE_TO_HUMAN,
        summary: `Role path policy violation: ${violationSummary}`,
        prUrl: parsed.prUrl
      }).catch(() => { /* non-fatal */ });
    }
  } catch {
    // Non-fatal: if policy cannot be read, keep existing worker result.
  }

  // Track premium request usage per worker (always log, even for failed verification attempts)
  logPremiumUsage(config, roleName, model, instruction.taskKind, Date.now() - startMs, {
    outcome: parsed.status,
    taskId: instruction.taskId || instruction.task || null
  });

  // ── Unconditional artifact hard-block ──────────────────────────────────────
  // For any worker+task combination that requires a post-merge artifact
  // (determined by role kind AND task kind), the gate is NON-BYPASSABLE —
  // it runs regardless of config.runtime.requireTaskContract.
  // Non-merge task kinds (scan, doc, observation, diagnosis) are exempt even
  // for done-capable roles, eliminating false completion loss on read-only tasks.
  if (parsed.status === "done" && isArtifactGateRequired(workerKind ?? "unknown", instruction.taskKind)) {
    const artifact = checkPostMergeArtifact(parsed.fullOutput || parsed.summary || "");
    if (!artifact.hasArtifact) {
      const artifactGaps = collectArtifactGaps(artifact);
      parsed.status = "blocked";
      parsed.summary = `[ARTIFACT GATE] done hard-blocked — ${artifactGaps.join("; ")}\n${parsed.summary}`;
    }
  }

  // ── Verification gate — evidence-based done acceptance ──────────────────────
  // Feature-flagged via config.runtime.requireTaskContract (default: true).
  // Rework threshold: config.runtime.maxReworkAttempts (default: 2, per Athena AC#2 concern).
  // Evidence snapshot schema includes profile, report fields, gaps, attempt, and timestamp (AC#4).
  const requireTaskContract = config?.runtime?.requireTaskContract !== false;
  if (requireTaskContract && parsed.status === "done") {
    const maxReworkAttempts = Number(config?.runtime?.maxReworkAttempts ?? 2);
    // reworkAttempt is set by buildReworkInstruction on re-dispatches; 0 on the first call
    const currentAttempt = Number(instruction.reworkAttempt || 0);

    // Artifact check is mandatory for all done-capable workers, even when workerKind is unknown.
    // Unknown workerKind falls back to the DEFAULT_PROFILE (build required, others optional).
    // Task kind is passed through so non-merge tasks (scan, doc, etc.) skip the artifact gate.
    const effectiveKind = workerKind ?? "unknown";
    const validationResult = validateWorkerContract(effectiveKind, {
      status: parsed.status,
      fullOutput: parsed.fullOutput,
      summary: parsed.summary
    }, { taskKind: instruction.taskKind });

    // Evidence snapshot for audit (AC#4 defined schema)
    const verificationEvidence: VerificationEvidence = {
      profile: String(validationResult.evidence?.profile || effectiveKind),
      hasReport: Boolean(validationResult.evidence?.hasReport),
      report: validationResult.evidence?.report || {},
      responsiveMatrix: validationResult.evidence?.responsiveMatrix || {},
      prUrl: (validationResult.evidence?.prUrl as string | null) ?? null,
      gaps: validationResult.gaps,
      passed: validationResult.passed,
      attempt: currentAttempt,
      validatedAt: new Date().toISOString(),
      roleName: String(roleName),
      taskSnippet: String(instruction.task || "").slice(0, 100)
    };

    // Persist evidence snapshot for audit trail (non-critical, keep last 200 entries)
    try {
      const auditPath = path.join(config.paths?.stateDir || "state", "verification_audit.json");
      let audit = [];
      try {
        if (existsSync(auditPath)) {
          audit = JSON.parse(readFileSync(auditPath, "utf8"));
          if (!Array.isArray(audit)) audit = [];
        }
      } catch { audit = []; }
      audit.push(verificationEvidence);
      if (audit.length > 200) audit = audit.slice(-200);
      writeFileSync(auditPath, JSON.stringify(audit, null, 2), "utf8");
    } catch { /* non-critical */ }

    const reworkDecision = decideRework(validationResult, instruction.task, currentAttempt, maxReworkAttempts);

    if (reworkDecision.shouldEscalate) {
      // Max rework attempts exhausted — block the task instead of looping
      parsed.status = "blocked";
      parsed.summary = `[VERIFICATION GATE] Escalated after ${currentAttempt} failed attempt(s). ${reworkDecision.escalationReason}\n${parsed.summary}`;

      // Persist structured escalation payload (non-critical write)
      appendEscalation(config, {
        role: roleName,
        task: instruction.task,
        blockingReasonClass: BLOCKING_REASON_CLASS.MAX_REWORK_EXHAUSTED,
        attempts: currentAttempt,
        nextAction: NEXT_ACTION.ESCALATE_TO_HUMAN,
        summary: reworkDecision.escalationReason || validationResult.gaps.slice(0, 3).join("; "),
        prUrl: parsed.prUrl
      }).catch(() => { /* non-fatal */ });
    } else if (reworkDecision.shouldRework) {
      // Push the failed attempt into history so the worker sees context on rework
      updatedHistory.push({
        from: roleName,
        content: `[VERIFICATION FAILED — attempt ${currentAttempt + 1}/${maxReworkAttempts}] ${truncate(parsed.summary, 400)}`,
        fullOutput: parsed.fullOutput,
        prUrl: parsed.prUrl,
        timestamp: new Date().toISOString(),
        status: "verification_failed",
        verificationEvidence
      });
      await appendProgress(config,
        `[WORKER:${roleName}] Verification failed (attempt ${currentAttempt + 1}/${maxReworkAttempts}) — gaps: ${validationResult.gaps.slice(0, 2).join("; ")}`
      );
      // Re-dispatch with rework instruction; recursive depth is bounded by maxReworkAttempts
      return runWorkerConversation(config, roleName, reworkDecision.instruction, updatedHistory, sessionState);
    }

    parsed.verificationEvidence = verificationEvidence;
  }

  await appendLiveWorkerLog(
    liveLogPath,
    `\n[${new Date().toISOString()}] END status=${parsed.status}${parsed.prUrl ? ` pr=${parsed.prUrl}` : ""}\n`
  );

  await appendProgress(config,
    `[WORKER:${roleName}] Completed status=${parsed.status}${parsed.prUrl ? ` PR=${parsed.prUrl}` : ""}`
  );

  // ── Optional lineage graph recording (non-blocking; rollback via config.runtime.lineageGraphEnabled=false) ──
  // Only records when instruction.taskId is provided. Safe to skip — lineage is observability,
  // not execution state. On any failure, warn and continue.
  if (config?.runtime?.lineageGraphEnabled !== false && instruction.taskId) {
    try {
      const fp = buildTaskFingerprint(instruction.taskKind || "general", instruction.task || "");
      const attempt = Number(instruction.reworkAttempt || 0) + 1;
      const taskId = Number(instruction.taskId);
      const parentId = instruction.parentLineageId || null;
      const rootId = Number(instruction.lineageRootId || taskId);
      const depth = Number(instruction.lineageDepth || instruction.reworkAttempt || 0);
      const splitAncestry = Array.isArray(instruction.splitAncestry) ? instruction.splitAncestry : [];

      // Map worker result status to lineage entry status
      const statusMap = { done: LINEAGE_ENTRY_STATUS.PASSED, blocked: LINEAGE_ENTRY_STATUS.BLOCKED, error: LINEAGE_ENTRY_STATUS.FAILED };
      const entryStatus = statusMap[parsed.status] || LINEAGE_ENTRY_STATUS.FAILED;

      const lineageEntry = {
        id: buildLineageId(fp, taskId, attempt),
        taskId,
        semanticKey: String(instruction.semanticKey || `${instruction.taskKind || "general"}::${fp.slice(0, 16)}`),
        fingerprint: fp,
        parentId,
        rootId,
        depth,
        status: entryStatus,
        timestamp: new Date().toISOString(),
        failureReason: (entryStatus === LINEAGE_ENTRY_STATUS.FAILED || entryStatus === LINEAGE_ENTRY_STATUS.BLOCKED)
          ? truncate(parsed.summary || "unknown failure", 200)
          : null,
        splitAncestry
      };

      await appendLineageEntry(config, lineageEntry);
    } catch (lineageErr) {
      // Lineage recording failures are non-fatal — log but never block execution
      await appendProgress(config, `[LINEAGE] recording failed (non-fatal): ${String(lineageErr?.message || lineageErr)}`).catch(() => {});
    }
  }

  // Classify failure for error/blocked/partial statuses (non-critical)
  let failureClassification = null;
  let retryDecision = null;
  if (parsed.status === "error" || parsed.status === "blocked" || parsed.status === "partial") {
    // Derive blockingReasonClass from the escalation that was persisted (best-effort)
    let derivedRc = null;
    if (parsed.status === "blocked") {
      // Check common markers in summary text
      if (/policy violation|path policy/i.test(parsed.summary)) {
        derivedRc = BLOCKING_REASON_CLASS.POLICY_VIOLATION;
      } else if (/BOX_ACCESS.*blocked/i.test(parsed.fullOutput || "")) {
        derivedRc = BLOCKING_REASON_CLASS.ACCESS_BLOCKED;
      } else if (/rework.*exhausted|max rework/i.test(parsed.summary)) {
        derivedRc = BLOCKING_REASON_CLASS.MAX_REWORK_EXHAUSTED;
      } else if (/verification gate/i.test(parsed.summary)) {
        derivedRc = BLOCKING_REASON_CLASS.VERIFICATION_GATE;
      }
    }

    const cfResult = classifyFailure({
      workerStatus: parsed.status,
      blockingReasonClass: derivedRc,
      errorMessage: parsed.summary,
      taskId: instruction.taskId || null,
    });
    if (cfResult.ok) {
      failureClassification = cfResult.classification;
      appendFailureClassification(config, cfResult.classification).catch(() => { /* non-fatal */ });

      // Resolve adaptive retry decision based on failure class (non-critical)
      try {
        const rd = resolveRetryAction(
          cfResult.classification.primaryClass,
          Number(instruction.reworkAttempt || 0),
          config,
          instruction.taskId || null
        );
        if (rd.ok) {
          retryDecision = rd.decision;
          persistRetryMetric(config, rd.decision);
        }
      } catch { /* non-fatal — retry resolution must never block worker results */ }
    }
  }

  // Add worker's response to history
  updatedHistory.push({
    from: roleName,
    content: parsed.summary,
    fullOutput: parsed.fullOutput,
    prUrl: parsed.prUrl,
    timestamp: new Date().toISOString(),
    status: parsed.status
  });

  return {
    status: parsed.status,
    summary: parsed.summary,
    prUrl: parsed.prUrl,
    currentBranch: parsed.currentBranch,
    filesTouched: parsed.filesTouched,
    updatedHistory,
    workerKind,
    verificationReport: parsed.verificationReport,
    responsiveMatrix: parsed.responsiveMatrix,
    verificationEvidence: parsed.verificationEvidence || null,
    fullOutput: parsed.fullOutput,
    failureClassification,
    retryDecision
  };
}
