/**
 * Worker Runner — Persistent Conversation Sessions
 *
 * Each worker (King David, Esther, Aaron, etc.) has a conversation thread.
 * Moses calls runWorkerConversation() to send a task and get a response.
 *
 * The conversation history is passed as context on every call,
 * making it feel like a persistent session even though Copilot CLI is stateless.
 *
 * Workers use --allow-all-tools so they can:
 *   - Clone the target repo
 *   - Read and edit files
 *   - Run build/test commands
 *   - Create branches and PRs
 */

import path from "node:path";
import { writeFileSync } from "node:fs";
import { spawnAsync } from "./fs_utils.js";
import { getRoleRegistry } from "./role_registry.js";
import { appendProgress } from "./state_tracker.js";
import { buildAgentArgs, nameToSlug } from "./agent_loader.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function truncate(text, max) {
  const s = String(text || "");
  return s.length > max ? `${s.slice(0, max)}...` : s;
}

// ── Find worker config by role name ─────────────────────────────────────────

function findWorkerByName(config, roleName) {
  const registry = getRoleRegistry(config);
  const workers = registry?.workers || {};
  for (const [kind, w] of Object.entries(workers)) {
    if (w.name === roleName) return { kind, ...w };
  }
  return null;
}

// ── Task-aware model resolution ───────────────────────────────────────────────
// Priority: taskKind → role preference → worker's registered model → default

function resolveModel(config, roleName, taskKind) {
  // 1. Task-kind override (e.g. "scan" always uses GPT-5.3-Codex)
  if (taskKind) {
    const byKind = config?.copilot?.preferredModelsByTaskKind?.[taskKind];
    if (Array.isArray(byKind) && byKind.length > 0) return byKind[0];
  }
  // 2. Role-specific preference
  const byRole = config?.copilot?.preferredModelsByRole?.[roleName];
  if (Array.isArray(byRole) && byRole.length > 0) return byRole[0];
  // 3. Worker's registered static model
  const workerConfig = findWorkerByName(config, roleName);
  if (workerConfig?.model) return workerConfig.model;
  // 4. System default
  return config?.copilot?.defaultModel || "Claude Sonnet 4.6";
}

// ── Build conversation-only context (persona is in .agent.md) ───────────────

function buildConversationContext(history, instruction, sessionState = {}, config = {}) {
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

  // Loop detection — inject a visible warning before history if the worker is stuck
  const myMessages = history.filter(m => m.from !== "moses");
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
    parts.push("     - Your best guess at why none of them worked");
    parts.push("");
  }

  if (history.length > 0) {
    parts.push("## CONVERSATION HISTORY");
    const recentHistory = history.slice(-12);
    for (const msg of recentHistory) {
      if (msg.from === "moses") {
        parts.push(`\nMOSES: ${truncate(msg.content, 600)}`);
      } else {
        parts.push(`\nYOU (${msg.from}): ${truncate(msg.content, 800)}`);
      }
    }
    parts.push("");
  }

  parts.push("## NEW INSTRUCTION FROM MOSES");
  parts.push(String(instruction.task || ""));
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

function parseWorkerResponse(stdout, stderr) {
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

  // Summary is the main response text (trim tool output noise)
  const lines = output.split(/\r?\n/).filter(l => l.trim());
  const meaningfulLines = lines.filter(l =>
    !l.startsWith("●") &&
    !l.startsWith("✓") &&
    !l.startsWith("⏺") &&
    !l.includes("tool_call") &&
    l.trim().length > 10
  );
  const summary = meaningfulLines.slice(-10).join(" ").slice(0, 1000) || output.slice(0, 500);

  return {
    status: ["done", "partial", "blocked", "error"].includes(status) ? status : "done",
    prUrl,
    currentBranch,
    filesTouched,
    summary,
    fullOutput: output.slice(0, 5000)
  };
}

// ── Main Worker Conversation ─────────────────────────────────────────────────

export async function runWorkerConversation(config, roleName, instruction, history = [], sessionState = {}) {
  const model = resolveModel(config, roleName, instruction.taskKind);
  const command = config.env?.copilotCliCommand || "copilot";
  const agentSlug = nameToSlug(roleName); // "king-david", "esther", etc.

  // Build conversation-only context (persona is in the .agent.md file)
  const conversationContext = buildConversationContext(history, instruction, sessionState, config);

  await appendProgress(config, `[WORKER:${roleName}] [${instruction.taskKind || "general"}→${model}] ${truncate(instruction.task, 70)}`);

  const updatedHistory = [
    ...history,
    { from: "moses", content: instruction.task, timestamp: new Date().toISOString() }
  ];

  // buildAgentArgs: uses --agent <slug> if .agent.md exists, else --model <fallback>
  const args = buildAgentArgs({ agentSlug, prompt: conversationContext, model });

  const result = await spawnAsync(command, args, {
    env: {
      ...process.env,
      GH_TOKEN: config.env?.githubToken || process.env.GH_TOKEN || "",
      GITHUB_TOKEN: config.env?.githubToken || process.env.GITHUB_TOKEN || "",
      TARGET_REPO: config.env?.targetRepo || "",
      TARGET_BASE_BRANCH: config.env?.targetBaseBranch || "main"
    }
  });

  const stdout = String(result?.stdout || "");
  const stderr = String(result?.stderr || "");

  if (result.status !== 0) {
    await appendProgress(config, `[WORKER:${roleName}] Error exit=${result.status}`);
    const errorMsg = truncate(stderr || stdout || "unknown error", 300);
    updatedHistory.push({
      from: roleName,
      content: `ERROR: ${errorMsg}`,
      timestamp: new Date().toISOString(),
      status: "error"
    });
    return {
      status: "error",
      summary: errorMsg,
      updatedHistory,
      prUrl: null
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

  const parsed = parseWorkerResponse(stdout, stderr);

  await appendProgress(config,
    `[WORKER:${roleName}] Completed status=${parsed.status}${parsed.prUrl ? ` PR=${parsed.prUrl}` : ""}`
  );

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
    updatedHistory
  };
}
