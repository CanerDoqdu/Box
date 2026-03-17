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
import { appendAlert, appendProgress } from "./state_tracker.js";
import { getRoleRegistry } from "./role_registry.js";
import { runWorkerConversation } from "./worker_runner.js";
import { buildAgentArgs, parseAgentOutput, logAgentThinking } from "./agent_loader.js";
import { chatLog } from "./logger.js";
import { validateWorkerContract, decideRework } from "./verification_gate.js";

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

function getTrumpExecutionStrategy(config, trumpPlans) {
  const planner = config?.planner || {};
  const strategy = trumpPlans?.executionStrategy || {};
  const configuredCap = Math.max(1, Number(planner.defaultMaxWorkersPerWave || config?.maxParallelWorkers || 10));
  const strategyCap = Number(strategy.maxWorkersPerWave || 0);
  const dispatchCap = planner.enforceTrumpExecutionStrategy === false
    ? Math.max(1, Number(config?.maxParallelWorkers || configuredCap))
    : Math.max(1, Math.min(
        Number(config?.maxParallelWorkers || configuredCap),
        strategyCap > 0 ? strategyCap : Number(config?.maxParallelWorkers || configuredCap)
      ));

  return {
    dispatchCap,
    allowSameCycleFollowUps: strategy.allowSameCycleFollowUps === undefined
      ? Boolean(planner.allowSameCycleFollowUps)
      : Boolean(strategy.allowSameCycleFollowUps),
    waves: Array.isArray(strategy.waves) ? strategy.waves : []
  };
}

function formatTrumpExecutionStrategy(trumpPlans, config) {
  const strategy = getTrumpExecutionStrategy(config, trumpPlans);
  if (strategy.waves.length === 0) {
    return `No explicit Trump wave plan. Dispatch cap=${strategy.dispatchCap}. Same-cycle follow-ups allowed=${strategy.allowSameCycleFollowUps ? "yes" : "no"}.`;
  }

  const waveLines = strategy.waves.slice(0, 6).map((wave, index) => {
    const workers = Array.isArray(wave.workers) ? wave.workers.join(", ") : "none";
    const dependsOn = Array.isArray(wave.dependsOn) && wave.dependsOn.length > 0 ? wave.dependsOn.join(", ") : "none";
    return `  ${index + 1}. ${wave.id || `wave-${index + 1}`} | workers=${workers} | dependsOn=${dependsOn} | exit=${wave.exitCriteria || "not specified"}`;
  }).join("\n");

  return `Dispatch cap=${strategy.dispatchCap}. Same-cycle follow-ups allowed=${strategy.allowSameCycleFollowUps ? "yes" : "no"}.\n${waveLines}`;
}

function validateTrumpContract(trumpPlans) {
  if (!trumpPlans || typeof trumpPlans !== "object") {
    return { ok: false, missing: ["trumpPlans"] };
  }

  const missing = [];
  if (!String(trumpPlans.analysis || "").trim()) missing.push("analysis");
  if (!String(trumpPlans.strategicNarrative || "").trim()) missing.push("strategicNarrative");
  if (!String(trumpPlans.projectHealth || "").trim()) missing.push("projectHealth");

  const plans = Array.isArray(trumpPlans.plans) ? trumpPlans.plans : [];
  if (plans.length === 0) missing.push("plans[]");

  const strategy = trumpPlans.executionStrategy || {};
  const waves = Array.isArray(strategy.waves) ? strategy.waves : [];
  if (waves.length === 0) missing.push("executionStrategy.waves[]");

  const requestBudget = trumpPlans.requestBudget || {};
  const totalEstimated = Number(requestBudget.estimatedPremiumRequestsTotal);
  if (!Number.isFinite(totalEstimated) || totalEstimated <= 0) {
    missing.push("requestBudget.estimatedPremiumRequestsTotal");
  }
  if (!Array.isArray(requestBudget.byWave) || requestBudget.byWave.length === 0) {
    missing.push("requestBudget.byWave[]");
  }
  if (!Array.isArray(requestBudget.byRole) || requestBudget.byRole.length === 0) {
    missing.push("requestBudget.byRole[]");
  }

  return {
    ok: missing.length === 0,
    missing
  };
}

function toSessionStatusAfterResult(resultStatus) {
  const normalized = String(resultStatus || "").toLowerCase();
  if (normalized === "error") return "error";
  // A worker call is synchronous from Moses' perspective. Once a result is
  // returned (done/partial/blocked), that worker is no longer actively running.
  return "idle";
}

function normalizeTaskId(value) {
  return String(value || "").trim().toLowerCase();
}

function mergeCompletedTasks(...taskLists) {
  const seen = new Set();
  const merged = [];
  for (const list of taskLists) {
    if (!Array.isArray(list)) continue;
    for (const raw of list) {
      const id = String(raw || "").trim();
      if (!id) continue;
      const key = normalizeTaskId(id);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(id);
    }
  }
  return merged;
}

function isReportOnlyTask(taskText) {
  const text = String(taskText || "").toLowerCase();
  if (!text) return false;
  return (
    text.includes("report the result") ||
    text.includes("if you already") ||
    text.includes("state whether") ||
    text.includes("confirm") ||
    text.includes("re-validate")
  );
}

function getLastWorkerMessage(session, roleName) {
  const history = Array.isArray(session?.history) ? session.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (!entry || entry.from === "moses") continue;
    if (roleName && entry.from && entry.from !== roleName) continue;
    return entry;
  }
  return null;
}

function hasRecentDoneEvidence(session, roleName, nowMs, maxAgeMinutes = 180) {
  const lastMsg = getLastWorkerMessage(session, roleName);
  if (!lastMsg) return false;
  if (String(lastMsg.status || "").toLowerCase() !== "done") return false;
  const ts = lastMsg.timestamp ? new Date(lastMsg.timestamp).getTime() : 0;
  if (!Number.isFinite(ts) || ts <= 0) return false;
  return (nowMs - ts) <= (maxAgeMinutes * 60 * 1000);
}

function autoCompleteEligibleWaves(executionStrategy, completedTasks, activeInstructions, workerResults) {
  const waves = Array.isArray(executionStrategy?.waves) ? executionStrategy.waves : [];
  if (waves.length === 0) return [];

  const doneNormalized = new Set(
    completedTasks.map((item) => normalizeTaskId(item)).filter(Boolean)
  );
  const completedThisCycle = [];

  const activeRoles = new Set(
    (activeInstructions || []).map((item) => String(item?.role || "").trim()).filter(Boolean)
  );
  const doneRoles = new Set(
    (workerResults || [])
      .filter((item) => String(item?.status || "").toLowerCase() === "done")
      .map((item) => String(item?.role || "").trim())
      .filter(Boolean)
  );

  for (const wave of waves) {
    const waveId = String(wave?.id || "").trim();
    const waveKey = normalizeTaskId(waveId);
    if (!waveId || doneNormalized.has(waveKey)) continue;

    const deps = Array.isArray(wave?.dependsOn) ? wave.dependsOn : [];
    const depsMet = deps.every((dep) => doneNormalized.has(normalizeTaskId(dep)));
    if (!depsMet) continue;

    const requiredWorkers = Array.isArray(wave?.workers)
      ? wave.workers.map((item) => String(item || "").trim()).filter(Boolean)
      : [];
    if (requiredWorkers.length === 0) continue;

    // Only auto-complete when this wave was actively dispatched this cycle.
    const wasDispatched = requiredWorkers.some((role) => activeRoles.has(role));
    if (!wasDispatched) continue;

    const allDone = requiredWorkers.every((role) => doneRoles.has(role));
    if (!allDone) continue;

    doneNormalized.add(waveKey);
    completedThisCycle.push(waveId);
  }

  return completedThisCycle;
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
  const trumpExecutionStrategy = formatTrumpExecutionStrategy(trumpPlans, config);

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

## TRUMP EXECUTION STRATEGY
${trumpExecutionStrategy}

Honor Trump's dependency order. Prefer large coherent assignments, do not wake downstream workers early, and avoid same-cycle follow-up chatter unless absolutely necessary.
Hardening policy: bundle same-area micro-fixes into a single hardening batch PR whenever safe. Avoid opening tiny single-purpose PRs when they can be combined without increasing risk.
Dispatch policy: avoid report-only re-dispatch if the worker already produced a recent done result with concrete evidence.

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
  const previousCoordination = await readJson(path.join(stateDir, "moses_coordination.json"), {});
  const previousCompletedTasks = Array.isArray(previousCoordination?.completedTasks)
    ? previousCoordination.completedTasks
    : [];

  const trumpContract = validateTrumpContract(trumpPlans);
  let activeTrumpPlans = trumpPlans;
  if (trumpPlans && !trumpContract.ok) {
    const missingFields = trumpContract.missing.join(", ");
    const message = `Trump plan rejected due to missing contract fields: ${missingFields}`;
    await appendProgress(config, `[MOSES][REJECT] ${message}`);
    chatLog(stateDir, mosesName, message);
    try {
      await appendAlert(config, {
        severity: "error",
        source: "moses",
        title: "Trump plan rejected",
        message
      });
    } catch {
      // Non-fatal alert path.
    }
    activeTrumpPlans = null;
  }

  const executionStrategy = getTrumpExecutionStrategy(config, activeTrumpPlans);

  await appendProgress(config, `[MOSES] ${mosesName} awakening — managing worker conversations`);
  chatLog(stateDir, mosesName, "Awakening — reading Jesus directive and worker sessions...");

  const sessions = await loadSessions(stateDir);

  // Moses decides what each worker should do
  const mosesPlan = await mosesDecideNextActions(config, jesusDirective, activeTrumpPlans, sessions, []);
  let completedTasks = mergeCompletedTasks(previousCompletedTasks, mosesPlan.completedTasks || []);

  chatLog(stateDir, mosesName, `Plan: ${mosesPlan.summary || "no summary"}`);
  await appendProgress(config, `[MOSES] Plan ready: ${mosesPlan.summary}`);

  const instructions = Array.isArray(mosesPlan.workerInstructions)
    ? mosesPlan.workerInstructions.filter(i => i.action !== "skip" && i.action !== "complete")
    : [];

  // Moses dispatches all workers it plans — no artificial cap
  // Moses's own reasoning determines parallelism
  const activeInstructions = instructions.slice(0, executionStrategy.dispatchCap);
  const workerResults = [];

  if (instructions.length > activeInstructions.length) {
    await appendProgress(config, `[MOSES] Dispatch capped ${activeInstructions.length}/${instructions.length} by Trump execution strategy`);
    chatLog(stateDir, mosesName, `Dispatch capped to ${activeInstructions.length}/${instructions.length} by Trump execution strategy`);
  }

  // ── Duplicate dispatch guard ───────────────────────────────────────────────
  // If a worker is already status="working" from a previous cycle (e.g. daemon
  // restart), skip re-dispatching the same worker to avoid wasting a premium request.
  const skippedDuplicates = [];
  const skippedReportOnly = [];
  const nowMs = Date.now();
  const filteredInstructions = activeInstructions.filter((instruction) => {
    const roleName = instruction.role;
    if (!roleName) return false;
    const existing = sessions[roleName];
    if (existing?.status === "working") {
      skippedDuplicates.push(roleName);
      return false;
    }
    if (isReportOnlyTask(instruction.task) && hasRecentDoneEvidence(existing, roleName, nowMs)) {
      skippedReportOnly.push(roleName);
      return false;
    }
    return true;
  });

  if (skippedDuplicates.length > 0) {
    const msg = `Skipped ${skippedDuplicates.length} already-working workers: ${skippedDuplicates.join(", ")}`;
    await appendProgress(config, `[MOSES][DEDUP] ${msg}`);
    chatLog(stateDir, mosesName, msg);
  }

  if (skippedReportOnly.length > 0) {
    const msg = `Skipped ${skippedReportOnly.length} report-only redispatches with recent done evidence: ${skippedReportOnly.join(", ")}`;
    await appendProgress(config, `[MOSES][DEDUP] ${msg}`);
    chatLog(stateDir, mosesName, msg);
  }

  // Initialize all sessions before parallel dispatch
  for (const instruction of filteredInstructions) {
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

  // Save initial coordination state so dashboard shows dispatch is in progress
  await writeJson(path.join(stateDir, "moses_coordination.json"), {
    summary: mosesPlan.summary,
    statusReport: "dispatching workers",
    completedTasks,
    executionStrategy: activeTrumpPlans?.executionStrategy || null,
    appliedDispatchCap: executionStrategy.dispatchCap,
    workerResults: [],
    activeSessions: filteredInstructions.length + skippedDuplicates.length,
    coordinatedAt: new Date().toISOString(),
    jesusDecision: jesusDirective?.decision,
    hadTrumpPlans: !!activeTrumpPlans
  });

  // Run all workers in parallel — update sessions INCREMENTALLY as each completes
  const _parallelResults = await Promise.all(
    filteredInstructions
      .filter(i => i.role)
      .map(async (instruction) => {
        const roleName = instruction.role;
        try {
          let result = await runWorkerConversation(
            config, roleName, instruction,
            sessions[roleName].history,
            sessions[roleName]
          );

          // ── Verification gate: validate worker output against role profile ──
          const maxReworkAttempts = Number(config?.runtime?.autonomousMaxAttemptsPerTask || 3) - 1;
          let reworkCount = 0;
          while (result.status === "done" && result.workerKind && reworkCount < maxReworkAttempts) {
            const validation = validateWorkerContract(result.workerKind, result);
            if (validation.passed) {
              chatLog(stateDir, mosesName, `${roleName} verification PASSED: ${validation.reason}`);
              await appendProgress(config, `[MOSES][VERIFY] ${roleName} ✓ ${validation.reason}`);
              break;
            }
            // Verification failed — decide rework or escalate
            const reworkDecision = decideRework(validation, instruction.task, reworkCount, maxReworkAttempts);
            if (reworkDecision.shouldEscalate) {
              chatLog(stateDir, mosesName, `${roleName} verification FAILED, max rework exceeded: ${reworkDecision.escalationReason}`);
              await appendProgress(config, `[MOSES][VERIFY] ${roleName} ✗ escalated: ${String(reworkDecision.escalationReason).slice(0, 100)}`);
              result.status = "partial";
              break;
            }
            if (reworkDecision.shouldRework) {
              reworkCount++;
              chatLog(stateDir, mosesName, `${roleName} verification FAILED (attempt ${reworkCount}/${maxReworkAttempts}): ${validation.gaps.join("; ")}`);
              await appendProgress(config, `[MOSES][REWORK] ${roleName} attempt ${reworkCount}: ${validation.gaps.length} gap(s)`);
              // Re-dispatch with rework instruction
              result = await runWorkerConversation(
                config, roleName, reworkDecision.instruction,
                result.updatedHistory,
                sessions[roleName]
              );
            } else {
              break;
            }
          }

          // Update session immediately when THIS worker finishes
          sessions[roleName].history = result.updatedHistory;
          sessions[roleName].status = toSessionStatusAfterResult(result.status);
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
          if (!Array.isArray(sessions[roleName].activityLog)) sessions[roleName].activityLog = [];
          sessions[roleName].activityLog.push({
            at: new Date().toISOString(),
            task: String(instruction?.task || "").slice(0, 200),
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
          // Save to disk immediately so dashboard sees real-time status
          await saveSessions(stateDir, sessions);
          // Update coordination state with partial results for live dashboard
          workerResults.push({ role: roleName, status: result.status, summary: result.summary });
          await writeJson(path.join(stateDir, "moses_coordination.json"), {
            summary: mosesPlan.summary,
            statusReport: `${workerResults.length}/${filteredInstructions.length} workers completed`,
            completedTasks,
            executionStrategy: activeTrumpPlans?.executionStrategy || null,
            appliedDispatchCap: executionStrategy.dispatchCap,
            workerResults: [...workerResults],
            activeSessions: filteredInstructions.length - workerResults.length,
            coordinatedAt: new Date().toISOString(),
            jesusDecision: jesusDirective?.decision,
            hadTrumpPlans: !!activeTrumpPlans
          });
          chatLog(stateDir, mosesName, `${roleName} responded: ${result.status} — ${String(result.summary).slice(0, 150)}`);
          await appendProgress(config, `[MOSES] ← ${roleName} result: ${result.status} | ${String(result.summary).slice(0, 80)}`);
          return { roleName, result, error: null, instruction };
        } catch (err) {
          sessions[roleName].status = "error";
          await saveSessions(stateDir, sessions);
          workerResults.push({ role: roleName, status: "error", summary: String(err?.message || err) });
          await writeJson(path.join(stateDir, "moses_coordination.json"), {
            summary: mosesPlan.summary,
            statusReport: `${workerResults.length}/${filteredInstructions.length} workers completed`,
            completedTasks,
            executionStrategy: activeTrumpPlans?.executionStrategy || null,
            appliedDispatchCap: executionStrategy.dispatchCap,
            workerResults: [...workerResults],
            activeSessions: filteredInstructions.length - workerResults.length,
            coordinatedAt: new Date().toISOString(),
            jesusDecision: jesusDirective?.decision,
            hadTrumpPlans: !!activeTrumpPlans
          });
          chatLog(stateDir, mosesName, `${roleName} error: ${String(err?.message || err).slice(0, 200)}`);
          await appendProgress(config, `[MOSES] ${roleName} error: ${String(err?.message || err).slice(0, 100)}`);
          return { roleName, result: null, error: err, instruction };
        }
      })
  );

  // If workers reported results, Moses does a follow-up decision for next tasks
  if (workerResults.length > 0) {
    const newlyCompletedWaves = autoCompleteEligibleWaves(
      executionStrategy,
      completedTasks,
      filteredInstructions,
      workerResults
    );
    if (newlyCompletedWaves.length > 0) {
      completedTasks = mergeCompletedTasks(completedTasks, newlyCompletedWaves);
      await appendProgress(
        config,
        `[MOSES] Auto-completed waves: ${newlyCompletedWaves.join(", ")}`
      );
    }

    chatLog(stateDir, mosesName, "Workers reported results — deciding follow-up tasks...");
    const followUpPlan = await mosesDecideNextActions(config, jesusDirective, activeTrumpPlans, sessions, workerResults);
    completedTasks = mergeCompletedTasks(completedTasks, followUpPlan.completedTasks || []);

    const followUps = Array.isArray(followUpPlan.workerInstructions)
      ? followUpPlan.workerInstructions.filter(i => i.isFollowUp && i.action !== "skip" && i.action !== "complete")
      : [];

    const followUpCap = Math.min(maxWorkers, executionStrategy.dispatchCap);
    const validFollowUps = executionStrategy.allowSameCycleFollowUps
      ? followUps.slice(0, followUpCap).filter(i => i.role && sessions[i.role])
      : [];
    if (!executionStrategy.allowSameCycleFollowUps && followUps.length > 0) {
      await appendProgress(config, `[MOSES] Same-cycle follow-ups deferred by Trump execution strategy (${followUps.length} deferred)`);
      chatLog(stateDir, mosesName, `Deferred ${followUps.length} same-cycle follow-ups by Trump execution strategy`);
    }
    for (const instruction of validFollowUps) {
      sessions[instruction.role].status = "working";
      sessions[instruction.role].lastTask = instruction.task;
      chatLog(stateDir, mosesName, `Follow-up for ${instruction.role}: ${String(instruction.task).slice(0, 100)}`);
      await appendProgress(config, `[MOSES] Follow-up → ${instruction.role}: ${String(instruction.task).slice(0, 80)}`);
    }
    await saveSessions(stateDir, sessions);

    const _followParallel = await Promise.all(
      validFollowUps.map(async (instruction) => {
        const roleName = instruction.role;
        try {
          const result = await runWorkerConversation(
            config, roleName, instruction,
            sessions[roleName].history,
            sessions[roleName]
          );
          // Update session immediately when THIS follow-up worker finishes
          sessions[roleName].history = result.updatedHistory;
          sessions[roleName].status = toSessionStatusAfterResult(result.status);
          sessions[roleName].lastActiveAt = new Date().toISOString();
          if (result.currentBranch) {
            sessions[roleName].currentBranch = result.currentBranch;
          }
          if (result.prUrl && !sessions[roleName].createdPRs?.includes(result.prUrl)) {
            sessions[roleName].createdPRs = [...(sessions[roleName].createdPRs || []), result.prUrl];
          }
          if (!Array.isArray(sessions[roleName].activityLog)) sessions[roleName].activityLog = [];
          sessions[roleName].activityLog.push({
            at: new Date().toISOString(),
            task: String(instruction?.task || "").slice(0, 200),
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
          await saveSessions(stateDir, sessions);
          chatLog(stateDir, mosesName, `${roleName} follow-up: ${result.status} — ${String(result.summary).slice(0, 120)}`);
          await appendProgress(config, `[MOSES] ← ${roleName} follow-up: ${result.status}`);
          return { roleName, result, error: null, instruction };
        } catch (err) {
          sessions[roleName].status = "error";
          await saveSessions(stateDir, sessions);
          await appendProgress(config, `[MOSES] ${roleName} follow-up error: ${String(err?.message || err).slice(0, 80)}`);
          return { roleName, result: null, error: err, instruction };
        }
      })
    );
  }

  // Save final coordination report
  const coordination = {
    summary: mosesPlan.summary,
    statusReport: mosesPlan.statusReport,
    completedTasks,
    executionStrategy: activeTrumpPlans?.executionStrategy || null,
    appliedDispatchCap: executionStrategy.dispatchCap,
    workerResults,
    activeSessions: Object.keys(sessions).length,
    coordinatedAt: new Date().toISOString(),
    jesusDecision: jesusDirective?.decision,
    hadTrumpPlans: !!activeTrumpPlans
  };

  await writeJson(path.join(stateDir, "moses_coordination.json"), coordination);

  await appendProgress(config, `[MOSES] Coordination complete — ${workerResults.length} workers active`);
  chatLog(stateDir, mosesName, `Coordination done — ${workerResults.length} workers dispatched`);
}
