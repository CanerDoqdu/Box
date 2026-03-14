/**
 * Moses — Lead Worker Manager (Conversation-Based)
 *
 * Moses receives Jesus's directive and (optionally) Trump's plans.
 * Moses manages PERSISTENT CONVERSATIONS with each worker.
 *
 * The conversation thread:
 *   Moses: "King David, fix the login bug in auth.js. Here's the context: ..."
 *   King David: "Done. I found the issue in auth.js line 45. PR #42 created."
 *   Moses: "Good. Now write tests for that fix."
 *   King David: "Tests written. All passing. PR updated."
 *   Moses: "Task complete. Moving to next."
 *
 * Session history is persisted in state/sessions/{roleName}.json.
 * Each call to Moses within a cycle processes all active workers.
 */

import path from "node:path";
import { readJson, writeJson, spawnAsync } from "./fs_utils.js";
import { appendProgress } from "./state_tracker.js";
import { getRoleRegistry } from "./role_registry.js";
import { runWorkerConversation } from "./worker_runner.js";
import { buildAgentArgs, parseAgentOutput, logAgentThinking } from "./agent_loader.js";
import { chatLog } from "./logger.js";

async function callCopilotAgent(command, agentSlug, contextPrompt) {
  const args = buildAgentArgs({ agentSlug, prompt: contextPrompt });
  const result = await spawnAsync(command, args, { env: process.env });
  const stdout = String(result?.stdout || "");
  const stderr = String(result?.stderr || "");
  if (result.status !== 0) {
    return { ok: false, raw: stdout || stderr, parsed: null, thinking: "", error: `exited ${result.status}` };
  }
  return parseAgentOutput(stdout || stderr);
}

// ── Per-worker file paths ──────────────────────────────────────────────────────────────────
function workerFilePath(stateDir, roleName) {
  return path.join(stateDir, `worker_${roleName.toLowerCase().replace(/\s+/g, "_")}.json`);
}

// ── Load / Save Sessions ────────────────────────────────────────────────────────────────────

async function loadSessions(stateDir) {
  // Start from aggregate, then overlay with individual per-worker files (source of truth)
  const sessions = await readJson(path.join(stateDir, "worker_sessions.json"), {});
  const knownRoles = [
    "King David", "Esther", "Aaron", "Joseph",
    "Samuel", "Isaiah", "Noah", "Elijah", "Issachar", "Ezra"
  ];
  for (const roleName of knownRoles) {
    const perWorker = await readJson(workerFilePath(stateDir, roleName), null);
    if (perWorker) sessions[roleName] = perWorker;
  }
  return sessions;
}

async function saveSessions(stateDir, sessions) {
  // Write each worker's dedicated file in parallel
  await Promise.all(
    Object.entries(sessions).map(([roleName, session]) =>
      writeJson(workerFilePath(stateDir, roleName), session)
    )
  );
  // Also maintain aggregate for dashboard
  await writeJson(path.join(stateDir, "worker_sessions.json"), sessions);
}

// ── Moses AI Decision ────────────────────────────────────────────────────────

async function mosesDecideNextActions(config, jesusDirective, trumpPlans, sessions, currentResults) {
  const stateDir = config.paths?.stateDir || "state";
  const registry = getRoleRegistry(config);
  const mosesName = registry?.leadWorker?.name || "Moses";
  const command = config.env?.copilotCliCommand || "copilot";

  const workersList = Object.entries(registry?.workers || {})
    .map(([kind, w]) => `  - "${w.name}" (kind: ${kind})`)
    .join("\n");

  const trumpPlansSummary = trumpPlans?.plans
    ? trumpPlans.plans.slice(0, 10).map((p, i) =>
        `  ${i + 1}. [P${p.priority}] ${p.role}: ${p.task}`
      ).join("\n")
    : "  No Trump analysis available";

  const sessionSummary = Object.entries(sessions)
    .map(([role, s]) => `  ${role}: status=${s.status} messages=${s.history?.length || 0} lastTask="${s.lastTask || "none"}"`)
    .join("\n") || "  No active sessions";

  const workerResults = currentResults.length > 0
    ? currentResults.map(r => `  ${r.role}: ${r.status} — ${String(r.summary || "").slice(0, 200)}`).join("\n")
    : "  No results yet";

  // English context: include Jesus's FULL thinking so Moses understands WHY, not just what
  const jesusFullThinking = jesusDirective?.thinking || "";
  const contextPrompt = `TARGET REPO: ${config.env?.targetRepo || "unknown"}

## JESUS'S COMPLETE STRATEGIC ANALYSIS
${jesusFullThinking ? jesusFullThinking : "(No detailed thinking available — use briefForMoses below)"}

## JESUS'S DIRECTIVE FOR MOSES
Decision: ${jesusDirective?.decision || "tactical"}
System Health: ${jesusDirective?.systemHealth || "unknown"}
Brief: ${jesusDirective?.briefForMoses || "Continue with standard tasks"}
Priorities: ${(jesusDirective?.priorities || []).join(", ") || "none specified"}

Jesus's work items:
${(jesusDirective?.workItems || []).map((w, i) => `  ${i+1}. [${w.taskKind || "task"}] P${w.priority || "?"}: ${w.task}`).join("\n") || "  none"}

## TRUMP'S PLANS
${trumpPlans?.analysis ? `Analysis: ${String(trumpPlans.analysis).slice(0, 500)}` : "No Trump analysis available"}
Plans:
${trumpPlansSummary}

## CURRENT WORKER SESSIONS
${sessionSummary}

## WORKER RESULTS THIS CYCLE
${workerResults}

## AVAILABLE WORKERS
${workersList}`;

  chatLog(stateDir, mosesName, "Deciding worker tasks...");
  const aiResult = await callCopilotAgent(command, "moses", contextPrompt);

  if (!aiResult.ok || !aiResult.parsed) {
    chatLog(stateDir, mosesName, `AI decision failed: ${aiResult.error || "no JSON"}`);
    // Fallback: map Jesus's workItems to instructions using taskKind → worker capability matching
    const kindToRole = {
      implementation: "King David", refactor: "King David",
      test: "Samuel", qa: "Isaiah",
      security: "Elijah", devops: "Noah",
      docs: "Ezra", analysis: "Issachar",
      scan: "Issachar", api: "Aaron",
      integration: "Joseph"
    };
    const fallbackInstructions = (jesusDirective?.workItems || []).slice(0, config.maxParallelWorkers || 10).map(w => ({
      role: kindToRole[w.taskKind] || "King David",
      action: "assign_new",
      task: w.task,
      context: `${w.context || ""} Target repo: ${config.env?.targetRepo}`,
      taskKind: w.taskKind,
      isFollowUp: false
    }));
    return {
      workerInstructions: fallbackInstructions,
      summary: "Fallback: using Jesus suggestions directly",
      completedTasks: [],
      statusReport: "Moses AI unavailable — using fallback"
    };
  }

  logAgentThinking(stateDir, mosesName, aiResult.thinking);
  return aiResult.parsed;
}

// ── Main Moses Cycle ─────────────────────────────────────────────────────────

export async function runMosesCycle(config, jesusDirective, trumpPlans) {
  const stateDir = config.paths?.stateDir || "state";
  const registry = getRoleRegistry(config);
  const mosesName = registry?.leadWorker?.name || "Moses";
  const maxWorkers = Number(config.maxParallelWorkers || 10);

  await appendProgress(config, `[MOSES] ${mosesName} awakening — managing worker conversations`);
  chatLog(stateDir, mosesName, "Awakening — reading Jesus directive and worker sessions...");

  const sessions = await loadSessions(stateDir);

  // Moses decides what each worker should do
  const mosesPlan = await mosesDecideNextActions(config, jesusDirective, trumpPlans, sessions, []);

  chatLog(stateDir, mosesName, `Plan: ${mosesPlan.summary || "no summary"}`);
  await appendProgress(config, `[MOSES] Plan ready: ${mosesPlan.summary}`);

  const instructions = Array.isArray(mosesPlan.workerInstructions)
    ? mosesPlan.workerInstructions.filter(i => i.action !== "skip" && i.action !== "complete")
    : [];

  // Moses dispatches all workers it plans — no artificial cap
  // Moses's own reasoning determines parallelism
  const activeInstructions = instructions;
  const workerResults = [];

  // Initialize all sessions before parallel dispatch
  for (const instruction of activeInstructions) {
    const roleName = instruction.role;
    if (!roleName) continue;
    if (!sessions[roleName]) {
      sessions[roleName] = {
        role: roleName,
        status: "idle",
        history: [],
        lastTask: null,
        startedAt: null,
        lastActiveAt: null,
        currentBranch: null,
        createdPRs: [],
        completedTasks: [],
        filesTouched: [],
        activityLog: []
      };
    }
    sessions[roleName].status = "working";
    sessions[roleName].lastTask = instruction.task;
    sessions[roleName].lastActiveAt = new Date().toISOString();
    if (!sessions[roleName].startedAt) sessions[roleName].startedAt = new Date().toISOString();
    chatLog(stateDir, mosesName, `Assigning to ${roleName}: ${String(instruction.task).slice(0, 120)}`);
    await appendProgress(config, `[MOSES] → ${roleName}: ${String(instruction.task).slice(0, 100)}`);
  }
  await saveSessions(stateDir, sessions);

  // Run all workers in parallel — maximum throughput
  const parallelResults = await Promise.all(
    activeInstructions
      .filter(i => i.role)
      .map(async (instruction) => {
        const roleName = instruction.role;
        try {
          const result = await runWorkerConversation(
            config, roleName, instruction,
            sessions[roleName].history,
            sessions[roleName]
          );
          return { roleName, result, error: null, instruction };
        } catch (err) {
          return { roleName, result: null, error: err, instruction };
        }
      })
  );

  // Collect results and update sessions atomically after all workers finish
  for (const { roleName, result, error, instruction: workerInstruction } of parallelResults) {
    if (error) {
      sessions[roleName].status = "error";
      workerResults.push({ role: roleName, status: "error", summary: String(error?.message || error) });
      chatLog(stateDir, mosesName, `${roleName} error: ${String(error?.message || error).slice(0, 200)}`);
      await appendProgress(config, `[MOSES] ${roleName} error: ${String(error?.message || error).slice(0, 100)}`);
    } else {
      sessions[roleName].history = result.updatedHistory;
      sessions[roleName].status = result.status === "done" ? "idle" : "working";
      sessions[roleName].lastActiveAt = new Date().toISOString();
      if (result.prUrl) {
        if (!Array.isArray(sessions[roleName].createdPRs)) sessions[roleName].createdPRs = [];
        if (!sessions[roleName].createdPRs.includes(result.prUrl)) {
          sessions[roleName].createdPRs.push(result.prUrl);
        }
      }
      if (result.currentBranch) {
        sessions[roleName].currentBranch = result.currentBranch;
      }
      // Permanent activity log — never trimmed, cross-cycle memory
      if (!Array.isArray(sessions[roleName].activityLog)) sessions[roleName].activityLog = [];
      sessions[roleName].activityLog.push({
        at: new Date().toISOString(),
        task: String(workerInstruction?.task || "").slice(0, 200),
        status: result.status,
        pr: result.prUrl || null,
        branch: result.currentBranch || null,
        files: result.filesTouched || []
      });
      if (sessions[roleName].activityLog.length > 50) {
        sessions[roleName].activityLog = sessions[roleName].activityLog.slice(-50);
      }
      // Accumulate all unique files this worker has ever touched
      if (Array.isArray(result.filesTouched) && result.filesTouched.length > 0) {
        const seenFiles = new Set(sessions[roleName].filesTouched || []);
        for (const f of result.filesTouched) seenFiles.add(f);
        sessions[roleName].filesTouched = [...seenFiles];
      }
      workerResults.push({ role: roleName, status: result.status, summary: result.summary });
      chatLog(stateDir, mosesName, `${roleName} responded: ${result.status} — ${String(result.summary).slice(0, 150)}`);
      await appendProgress(config, `[MOSES] ← ${roleName} result: ${result.status} | ${String(result.summary).slice(0, 80)}`);
    }
  }
  await saveSessions(stateDir, sessions);

  // If workers reported results, Moses does a follow-up decision for next tasks
  if (workerResults.length > 0) {
    chatLog(stateDir, mosesName, "Workers reported results — deciding follow-up tasks...");
    const followUpPlan = await mosesDecideNextActions(config, jesusDirective, trumpPlans, sessions, workerResults);

    const followUps = Array.isArray(followUpPlan.workerInstructions)
      ? followUpPlan.workerInstructions.filter(i => i.isFollowUp && i.action !== "skip" && i.action !== "complete")
      : [];

    const validFollowUps = followUps.slice(0, maxWorkers).filter(i => i.role && sessions[i.role]);
    for (const instruction of validFollowUps) {
      sessions[instruction.role].status = "working";
      sessions[instruction.role].lastTask = instruction.task;
      chatLog(stateDir, mosesName, `Follow-up for ${instruction.role}: ${String(instruction.task).slice(0, 100)}`);
      await appendProgress(config, `[MOSES] Follow-up → ${instruction.role}: ${String(instruction.task).slice(0, 80)}`);
    }
    await saveSessions(stateDir, sessions);

    const followParallel = await Promise.all(
      validFollowUps.map(async (instruction) => {
        const roleName = instruction.role;
        try {
          const result = await runWorkerConversation(
            config, roleName, instruction,
            sessions[roleName].history,
            sessions[roleName]
          );
          return { roleName, result, error: null, instruction };
        } catch (err) {
          return { roleName, result: null, error: err, instruction };
        }
      })
    );

    for (const { roleName, result, error, instruction: workerInstruction } of followParallel) {
      if (error) {
        sessions[roleName].status = "error";
        await appendProgress(config, `[MOSES] ${roleName} follow-up error: ${String(error?.message || error).slice(0, 80)}`);
      } else {
        sessions[roleName].history = result.updatedHistory;
        sessions[roleName].status = result.status === "done" ? "idle" : "working";
        sessions[roleName].lastActiveAt = new Date().toISOString();
        if (result.currentBranch && !sessions[roleName].createdPRs?.includes(result.prUrl)) {
          sessions[roleName].currentBranch = result.currentBranch;
        }
        if (result.prUrl && !sessions[roleName].createdPRs?.includes(result.prUrl)) {
          sessions[roleName].createdPRs = [...(sessions[roleName].createdPRs || []), result.prUrl];
        }
        if (!Array.isArray(sessions[roleName].activityLog)) sessions[roleName].activityLog = [];
        sessions[roleName].activityLog.push({
          at: new Date().toISOString(),
          task: String(workerInstruction?.task || "").slice(0, 200),
          status: result.status,
          pr: result.prUrl || null,
          branch: result.currentBranch || null,
          files: result.filesTouched || []
        });
        if (sessions[roleName].activityLog.length > 50) {
          sessions[roleName].activityLog = sessions[roleName].activityLog.slice(-50);
        }
        if (Array.isArray(result.filesTouched) && result.filesTouched.length > 0) {
          const seenFiles = new Set(sessions[roleName].filesTouched || []);
          for (const f of result.filesTouched) seenFiles.add(f);
          sessions[roleName].filesTouched = [...seenFiles];
        }
        chatLog(stateDir, mosesName, `${roleName} follow-up: ${result.status} — ${String(result.summary).slice(0, 120)}`);
        await appendProgress(config, `[MOSES] ← ${roleName} follow-up: ${result.status}`);
      }
    }
    await saveSessions(stateDir, sessions);
  }

  // Save final coordination report
  const coordination = {
    summary: mosesPlan.summary,
    statusReport: mosesPlan.statusReport,
    completedTasks: mosesPlan.completedTasks || [],
    workerResults,
    activeSessions: Object.keys(sessions).length,
    coordinatedAt: new Date().toISOString(),
    jesusDecision: jesusDirective?.decision,
    hadTrumpPlans: !!trumpPlans
  };

  await writeJson(path.join(stateDir, "moses_coordination.json"), coordination);

  await appendProgress(config, `[MOSES] Coordination complete — ${workerResults.length} workers active`);
  chatLog(stateDir, mosesName, `Coordination done — ${workerResults.length} workers dispatched`);
}
