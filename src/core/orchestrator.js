/**
 * BOX Orchestrator — Athena-Gated Loop Architecture
 *
 * Flow per cycle:
 *   Jesus (orchestrator/state analyzer) → Prometheus (full scan + plan)
 *   → Athena (validate plan) → Worker(s) → Athena (postmortem)
 *   → back to Prometheus for next iteration
 *
 * Each agent uses exactly 1 premium request per invocation (single-prompt).
 * No autopilot. No Moses — Jesus orchestrates, Prometheus plans, Athena gates.
 *
 * Startup:
 *   1. Read last checkpoint (worker_sessions.json + prometheus_analysis.json)
 *   2. If workers are active → resume monitoring, ZERO AI calls
 *   3. If no checkpoint → first run → Jesus analyzes state
 *   4. If project interrupted → Jesus decides: continue or re-plan
 */

import path from "node:path";
import { appendProgress, appendAlert, ALERT_SEVERITY } from "./state_tracker.js";
import { readStopRequest, writeDaemonPid, clearDaemonPid, clearStopRequest, readReloadRequest, clearReloadRequest } from "./daemon_control.js";
import { loadConfig } from "../config.js";
import { runJesusCycle } from "./jesus_supervisor.js";
import { runPrometheusAnalysis, buildConcretePremortem } from "./prometheus.js";
import { runAthenaPlanReview, runAthenaPostmortem, PREMORTEM_RISK_LEVEL, checkPlanPremortemGate } from "./athena_reviewer.js";
import { runWorkerConversation } from "./worker_runner.js";
import { runSelfImprovementCycle, shouldTriggerSelfImprovement } from "./self_improvement.js";
import { runRepairAnalysis, runHealthAudit, persistSelfImprovementDecision, escalateRepairFailure, REPAIR_GATE, HEALTH_GATE } from "./self_improvement_repair.js";
import { collectEvolutionMetrics } from "./evolution_metrics.js";
import { capturePreWorkBaseline, runProjectCompletion, isProjectAlreadyCompleted } from "./project_lifecycle.js";
import { warn } from "./logger.js";
import { readJson, readJsonSafe, writeJson, cleanupStaleTempFiles, READ_JSON_REASON } from "./fs_utils.js";
import { updatePipelineProgress, readPipelineProgress } from "./pipeline_progress.js";
import { loadEscalationQueue, sortEscalationQueue } from "./escalation_queue.js";
import { computeCycleSLOs, persistSloMetrics } from "./slo_checker.js";
import { computeCycleAnalytics, persistCycleAnalytics, CYCLE_PHASE } from "./cycle_analytics.js";
import {
  addSchemaVersion,
  migrateData,
  recordMigrationTelemetry,
  STATE_FILE_TYPE,
  MIGRATION_REASON
} from "./schema_registry.js";
import { runCatastropheDetection, GUARDRAIL_ACTION } from "./catastrophe_detector.js";
import { executeGuardrailsForDetections, isGuardrailActive } from "./guardrail_executor.js";
import { evaluateFreezeGate, isFreezeActive } from "./governance_freeze.js";
import { detectRecurrences, buildRecurrenceEscalations } from "./recurrence_detector.js";
import { checkClosureSLA } from "./closure_validator.js";
import { appendCapacityEntry } from "./capacity_scoreboard.js";
import { computeCapabilityDelta } from "./delta_analytics.js";
import { evaluateRetune } from "./strategy_retuner.js";
import { compileLessonsToPolicies } from "./learning_policy_compiler.js";
import { assignWorkersToPlans, enforceLaneDiversity } from "./capability_pool.js";
import { packPlansIntoBatches, buildBatchInstruction, buildCombinedPlan, estimateBatchTokens } from "./task_batcher.js";
import { runDoctor } from "./doctor.js";
import { validateAllPlans } from "./plan_contract_validator.js";
import { isSelfImprovementActive, siLogAsync } from "./si_control.js";
import { shouldApplyGovernanceRule } from "./policy_engine.js";
import { resolveDependencyGraph, GRAPH_STATUS } from "./dependency_graph_resolver.js";
import { executeRollback, ROLLBACK_TRIGGER, ROLLBACK_LEVEL } from "./rollback_engine.js";

/**
 * Orchestrator health status enum.
 * Written to state/orchestrator_health.json whenever status changes.
 */
export const ORCHESTRATOR_STATUS = Object.freeze({
  OPERATIONAL: "operational",
  DEGRADED: "degraded"
});

/** Write orchestrator health record to state/orchestrator_health.json. Exported for downstream use. */
export async function writeOrchestratorHealth(stateDir, status, reason, details = null) {
  await writeJson(path.join(stateDir, "orchestrator_health.json"), {
    orchestratorStatus: status,
    reason,
    details: details || null,
    recordedAt: new Date().toISOString()
  });
}

/**
 * Evaluate pre-dispatch governance gates in precedence order:
 *   1. guardrail (PAUSE_WORKERS) — highest precedence
 *   2. canary breach (shouldApplyGovernanceRule) — blocks if breach active; triggers rollback
 *   3. lineage graph (resolveDependencyGraph) — blocks if cycle detected
 *
 * Returns { blocked: boolean, reason: string, action?: string, rollbackResult?: object, graphResult?: object }
 *
 * Non-fatal: errors in any check are caught; failing checks default to unblocked.
 * Rollback is invoked (non-fatal) when canary breach is active, and the incident is persisted.
 *
 * @param {object} config   - full runtime config
 * @param {Array}  plans    - plan descriptors to dispatch
 * @param {string} cycleId  - stable cycle identifier for canary cohort assignment
 * @returns {Promise<{ blocked: boolean, reason: string, action?: string, rollbackResult?: object, graphResult?: object }>}
 */
export async function evaluatePreDispatchGovernanceGate(config, plans, cycleId) {
  const stateDir = config?.paths?.stateDir || "state";

  // 1. Guardrail gate — PAUSE_WORKERS blocks all dispatch (highest precedence)
  if (config?.systemGuardian?.enabled !== false) {
    try {
      const pauseActive = await isGuardrailActive(config, GUARDRAIL_ACTION.PAUSE_WORKERS);
      if (pauseActive) {
        return { blocked: true, reason: "guardrail:PAUSE_WORKERS" };
      }
    } catch (err) {
      warn(`[orchestrator] PAUSE_WORKERS guardrail check failed (non-fatal): ${String(err?.message || err)}`);
    }
  }

  // 2. Canary breach gate — if breach active, block and trigger rollback
  const cycleIdStr = String(cycleId || `cycle-dispatch-${Date.now()}`);
  let canaryResult;
  try {
    canaryResult = await shouldApplyGovernanceRule(config, cycleIdStr);
  } catch (err) {
    warn(`[orchestrator] shouldApplyGovernanceRule check failed (non-fatal): ${String(err?.message || err)}`);
  }

  if (canaryResult?.reason?.startsWith("BREACH_ACTIVE:")) {
    // Breach active — invoke rollback and persist incident record
    let rollbackResult;
    try {
      rollbackResult = await executeRollback({
        level:    ROLLBACK_LEVEL.CONFIG_ONLY,
        trigger:  ROLLBACK_TRIGGER.CANARY_ROLLBACK,
        config: {
          ...config,
          rollbackEngine: {
            ...(config?.rollbackEngine || {}),
            incidentLogPath: path.join(stateDir, "rollback_incidents.jsonl"),
            lockFilePath:    path.join(stateDir, "rollback_lock.json"),
            baselineRefPath: path.join(stateDir, "project_baseline.json")
          }
        },
        stateDir,
        evidence: { canaryReason: canaryResult.reason, cycleId: cycleIdStr }
      });
    } catch (err) {
      warn(`[orchestrator] executeRollback on canary breach failed (non-fatal): ${String(err?.message || err)}`);
    }
    return {
      blocked:        true,
      reason:         `canary:breach-active:${canaryResult.reason}`,
      action:         "rollback",
      rollbackResult: rollbackResult || null
    };
  }

  // 3. Lineage graph gate — block if dependency cycle detected
  const planList = Array.isArray(plans) ? plans : [];
  const graphTasks = planList.map((p, i) => ({
    id:          String(p.id || p.task || `plan-${i}`),
    dependsOn:   Array.isArray(p.dependsOn) ? p.dependsOn : [],
    filesInScope: Array.isArray(p.filesInScope) ? p.filesInScope
      : Array.isArray(p.targetFiles) ? p.targetFiles
      : Array.isArray(p.target_files) ? p.target_files
      : []
  }));

  let graphResult;
  try {
    graphResult = resolveDependencyGraph(graphTasks);
  } catch (err) {
    warn(`[orchestrator] dependency graph resolution failed (non-fatal): ${String(err?.message || err)}`);
  }

  if (graphResult?.status === GRAPH_STATUS.CYCLE_DETECTED) {
    return {
      blocked:     true,
      reason:      `lineage_graph:cycle_detected`,
      graphResult: graphResult
    };
  }

  return { blocked: false, reason: "all-gates-passed" };
}


/**
 * Safe wrapper for updatePipelineProgress.
 *
 * Pipeline progress is observability state — a write failure must NEVER block
 * orchestration. Errors are logged explicitly (never silently dropped) so
 * the failure is observable via the progress log.
 *
 * Risk: medium — touches orchestrator transitions directly.
 */
async function safeUpdatePipelineProgress(config, stepId, detail, extra) {
  try {
    await updatePipelineProgress(config, stepId, detail, extra);
  } catch (err) {
    warn(`[orchestrator] pipeline progress update failed (step=${stepId}): ${String(err?.message || err)}`);
  }
}

function mergeUniqueStrings(baseList, extraList) {
  const base = Array.isArray(baseList) ? baseList : [];
  const extra = Array.isArray(extraList) ? extraList : [];
  return [...new Set([...base, ...extra].map((v) => String(v || "").trim()).filter(Boolean))];
}

function mergeRepairConstraints(base, incoming) {
  const b = (base && typeof base === "object") ? base : {};
  const i = (incoming && typeof incoming === "object") ? incoming : {};
  return {
    ...b,
    ...i,
    mustInclude: mergeUniqueStrings(b.mustInclude, i.mustInclude),
    mustNotRepeat: mergeUniqueStrings(b.mustNotRepeat, i.mustNotRepeat),
  };
}

function mergeRepairAnalyses(base, incoming) {
  const b = base && typeof base === "object" ? base : {};
  const i = incoming && typeof incoming === "object" ? incoming : {};
  return {
    phase: "repair",
    rootCauses: mergeUniqueStrings((b.rootCauses || []).map((x) => JSON.stringify(x)), (i.rootCauses || []).map((x) => JSON.stringify(x)))
      .map((x) => {
        try { return JSON.parse(x); } catch { return x; }
      }),
    behaviorPatches: mergeUniqueStrings((b.behaviorPatches || []).map((x) => JSON.stringify(x)), (i.behaviorPatches || []).map((x) => JSON.stringify(x)))
      .map((x) => {
        try { return JSON.parse(x); } catch { return x; }
      }),
    repairedPlanConstraints: mergeRepairConstraints(b.repairedPlanConstraints, i.repairedPlanConstraints),
    verificationUpgrades: mergeUniqueStrings((b.verificationUpgrades || []).map((x) => JSON.stringify(x)), (i.verificationUpgrades || []).map((x) => JSON.stringify(x)))
      .map((x) => {
        try { return JSON.parse(x); } catch { return x; }
      }),
    gateDecision: i.gateDecision || b.gateDecision || REPAIR_GATE.REPLAN_ONCE,
    gateReason: String(i.gateReason || b.gateReason || ""),
    systemicFixes: mergeUniqueStrings(b.systemicFixes, i.systemicFixes),
    resumeDirective: String(i.resumeDirective || b.resumeDirective || ""),
  };
}

/**
 * Audit the three critical checkpoint state files using readJsonSafe.
 *
 * Critical vs non-critical classification:
 *   CRITICAL  (handled here): worker_sessions.json, jesus_directive.json, prometheus_analysis.json
 *   NON-CRITICAL (handled by readJson with fallback + box:readError event): all other reads.
 *
 * A missing file (ENOENT) is expected on first run and is NOT an error.
 * An invalid file (corrupt JSON) is always an error — sets orchestratorStatus=degraded.
 *
 * Returns: { sessions, jesusDirective, prometheusAnalysis, degraded: boolean }
 */
async function auditCriticalStateFiles(config, stateDir) {
  const criticalReads = await Promise.all([
    readJsonSafe(path.join(stateDir, "worker_sessions.json")),
    readJsonSafe(path.join(stateDir, "jesus_directive.json")),
    readJsonSafe(path.join(stateDir, "prometheus_analysis.json"))
  ]);
  const [sessionsResult, jesusDirectiveResult, prometheusAnalysisResult] = criticalReads;

  let sessions = {};
  let jesusDirective = null;
  let prometheusAnalysis = null;
  const degradedReasons = [];

  for (const [label, result, defaultFallback, fileType] of [
    ["worker_sessions.json",    sessionsResult,          {}, STATE_FILE_TYPE.WORKER_SESSIONS],
    ["jesus_directive.json",    jesusDirectiveResult,    null, null],
    ["prometheus_analysis.json", prometheusAnalysisResult, null, STATE_FILE_TYPE.PROMETHEUS_ANALYSIS]
  ]) {
    if (result.ok) {
      // Successfully parsed — run schema migration if this file type is versioned
      if (fileType && result.data !== null) {
        const migrated = migrateData(result.data, fileType);
        if (!migrated.ok) {
          // Unknown future version or structural mismatch — fail closed, log telemetry
          await recordMigrationTelemetry(stateDir, {
            fileType,
            filePath: path.join(stateDir, label),
            fromVersion: migrated.fromVersion,
            toVersion: migrated.toVersion,
            success: false,
            reason: migrated.reason
          });
          if (migrated.reason === MIGRATION_REASON.UNKNOWN_FUTURE_VERSION) {
            const detail = `${label}: unknown future schemaVersion (${migrated.fromVersion}) — fail-closed`;
            degradedReasons.push(detail);
            await appendProgress(config,
              `[STARTUP] WARNING: ${label} has unknown future schemaVersion (${migrated.fromVersion}) — treating as degraded to avoid data corruption`
            );
            await appendAlert(config, {
              severity: ALERT_SEVERITY.CRITICAL,
              source: "orchestrator",
              title: `Unknown future schemaVersion in ${label}`,
              message: `reason=${migrated.reason} fromVersion=${migrated.fromVersion}`
            });
          }
          // Use default fallback for this file (do not use unmigratable data)
          if (label === "worker_sessions.json") sessions = defaultFallback;
          if (label === "prometheus_analysis.json") prometheusAnalysis = defaultFallback;
          continue;
        }
        // Record telemetry only for actual migrations performed (not ALREADY_CURRENT)
        if (migrated.reason === MIGRATION_REASON.OK) {
          await recordMigrationTelemetry(stateDir, {
            fileType,
            filePath: path.join(stateDir, label),
            fromVersion: migrated.fromVersion,
            toVersion: migrated.toVersion,
            success: true,
            reason: migrated.reason
          });
        }
        if (label === "worker_sessions.json") sessions = migrated.data;
        if (label === "prometheus_analysis.json") prometheusAnalysis = migrated.data;
        continue;
      }
    } else if (result.reason === READ_JSON_REASON.MISSING) {
      // Expected on first run — use fallback silently
    } else {
      // Invalid JSON in a critical state file — record degraded reason and emit telemetry
      const detail = `${label}: ${result.error?.message || "parse error"}`;
      degradedReasons.push(detail);
      await appendProgress(config,
        `[STARTUP] CRITICAL: corrupt state file ${label} (reason=invalid) — entering degraded mode`
      );
      await appendAlert(config, {
        severity: ALERT_SEVERITY.CRITICAL,
        source: "orchestrator",
        title: `Corrupt critical state file: ${label}`,
        message: `reason=invalid error=${result.error?.message || "parse error"}`
      });
    }
    if (label === "worker_sessions.json") sessions = result.ok ? result.data : defaultFallback;
    if (label === "jesus_directive.json") jesusDirective = result.ok ? result.data : defaultFallback;
    if (label === "prometheus_analysis.json") prometheusAnalysis = result.ok ? result.data : defaultFallback;
  }

  if (degradedReasons.length > 0) {
    await writeOrchestratorHealth(stateDir, ORCHESTRATOR_STATUS.DEGRADED, "corrupt_state_files", degradedReasons);
    await appendProgress(config, `[STARTUP] orchestratorStatus=degraded reasons: ${degradedReasons.join("; ")}`);
  } else {
    await writeOrchestratorHealth(stateDir, ORCHESTRATOR_STATUS.OPERATIONAL, null);
  }

  return { sessions, jesusDirective, prometheusAnalysis, degraded: degradedReasons.length > 0 };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Attempt to start the dashboard server alongside the daemon (non-blocking, non-fatal). */
async function tryStartDashboard() {
  try {
    const { startDashboard } = await import("../dashboard/live_dashboard.js");
    startDashboard();
  } catch (err) {
    warn(`[orchestrator] dashboard auto-start failed (non-fatal): ${String(err?.message || err)}`);
  }
}

export async function runDaemon(config) {
  const liveConfig = Object.assign({}, config);
  const pid = process.pid;
  const stateDir = liveConfig.paths?.stateDir || "state";
  await writeDaemonPid(liveConfig, pid);
  await appendProgress(liveConfig, `[BOX] Daemon started pid=${pid}`);

  await tryStartDashboard();

  process.on("SIGTERM", async () => {
    await appendProgress(liveConfig, "[BOX] SIGTERM received, stopping");
    await clearDaemonPid(liveConfig);
    process.exit(0);
  });

  process.on("SIGINT", async () => {
    await appendProgress(liveConfig, "[BOX] SIGINT received, stopping");
    await clearDaemonPid(liveConfig);
    process.exit(0);
  });

  // ── Checkpoint-based startup: clean up leftover .tmp files, then audit ──
  {
    const cleanupResult = await cleanupStaleTempFiles(stateDir);
    if (cleanupResult.removed.length > 0) {
      await appendProgress(liveConfig, `[STARTUP] Cleaned up ${cleanupResult.removed.length} stale temp file(s): ${cleanupResult.removed.join(", ")}`);
    }
    if (!cleanupResult.ok) {
      warn(`[orchestrator] stale-temp cleanup failed (non-fatal): ${String(cleanupResult.error?.message || cleanupResult.error)}`);
    }
  }

  // ── Checkpoint-based startup: audit critical state files, then resume ──
  const { sessions, jesusDirective, prometheusAnalysis } =
    await auditCriticalStateFiles(liveConfig, stateDir);

  // Reset zombie workers (stale > 2× timeout)
  const workerTimeoutMs = Number(liveConfig.runtime?.workerTimeoutMinutes || 30) * 60 * 1000;
  const staleThresholdMs = workerTimeoutMs * 2;
  const now = Date.now();
  let zombieReset = false;
  const knownRoles = ["Evolution Worker"];
  for (const roleName of knownRoles) {
    const perWorkerPath = path.join(stateDir, `worker_${roleName.toLowerCase().replace(/\s+/g, "_")}.json`);
    const perWorker = await readJson(perWorkerPath, null);
    if (perWorker?.status === "working" && perWorker?.startedAt) {
      const age = now - new Date(perWorker.startedAt).getTime();
      if (age > staleThresholdMs) {
        perWorker.status = "idle";
        perWorker.startedAt = null;
        await writeJson(perWorkerPath, perWorker);
        if (sessions[roleName]) {
          sessions[roleName].status = "idle";
          sessions[roleName].startedAt = null;
        }
        zombieReset = true;
        await appendProgress(liveConfig, `[STARTUP] Reset zombie worker ${roleName} (stale ${Math.round(age / 60000)}min)`);
      }
    }
  }
  if (zombieReset) {
    await writeJson(path.join(stateDir, "worker_sessions.json"), addSchemaVersion(sessions, STATE_FILE_TYPE.WORKER_SESSIONS));
  }

  const activeWorkers = Object.entries(sessions)
    .filter(([, s]) => s?.status === "working")
    .map(([name]) => name);

  const hasCheckpoint = prometheusAnalysis?.analyzedAt || (jesusDirective && jesusDirective.decidedAt);

  if (activeWorkers.length > 0) {
    await appendProgress(liveConfig,
      `[STARTUP] Resuming — ${activeWorkers.length} workers active (${activeWorkers.join(", ")}). Waiting for them.`
    );
  } else if (!hasCheckpoint) {
    await appendProgress(liveConfig, "[STARTUP] No checkpoint found — first run, Jesus activating");
    await capturePreWorkBaseline(liveConfig);
  } else {
    await appendProgress(liveConfig, "[STARTUP] Resuming from checkpoint — entering main loop");
  }

  await mainLoop(liveConfig);
}

export async function runOnce(config) {
  await runSingleCycle(config);
}

export async function runRebase(_config, _opts = {}) {
  return { triggered: false, reason: "not applicable in athena-gated architecture" };
}

// ── Loop intervals ────────────────────────────────────────────────────────────
const WORKERS_DONE_POLL_MS = 30 * 1000;

function roleToWorkerStateFile(role) {
  const slug = String(role || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `worker_${slug}.json`;
}

function getLastWorkerReportedStatus(session, role) {
  const history = Array.isArray(session?.history) ? session.history : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const entry = history[i];
    if (!entry) continue;
    if (role && entry.from && entry.from !== role) continue;
    const status = String(entry.status || "").toLowerCase();
    if (status) return status;
  }
  return "";
}

async function recoverStaleWorkerSessions(config, stateDir, sessions) {
  const recoveredRoles = [];

  for (const [role, session] of Object.entries(sessions || {})) {
    if (session?.status !== "working") continue;

    const reportedStatus = getLastWorkerReportedStatus(session, role);
    if (["done", "partial", "blocked"].includes(reportedStatus)) {
      session.status = "idle";
      recoveredRoles.push(role);
      continue;
    }
  }

  if (recoveredRoles.length === 0) return false;

  await writeJson(path.join(stateDir, "worker_sessions.json"), addSchemaVersion(sessions, STATE_FILE_TYPE.WORKER_SESSIONS));

  for (const role of recoveredRoles) {
    const workerStatePath = path.join(stateDir, roleToWorkerStateFile(role));
    const workerState = await readJson(workerStatePath, null);
    if (workerState && workerState.status === "working") {
      workerState.status = "idle";
      await writeJson(workerStatePath, workerState);
    }
  }

  await appendProgress(
    config,
    `[LOOP] Recovered stale worker states (${recoveredRoles.length}): ${recoveredRoles.join(", ")}`
  );
  warn(`[orchestrator] Recovered stale worker states: ${recoveredRoles.join(", ")}`);
  return true;
}

async function hasActiveWorkersAsync(config) {
  try {
    const stateDir = config.paths?.stateDir || "state";
    const sessions = await readJson(path.join(stateDir, "worker_sessions.json"), {});
    await recoverStaleWorkerSessions(config, stateDir, sessions);
    return Object.values(sessions).some(s => s?.status === "working");
  } catch { return false; }
}

async function waitForWorkersToFinish(config) {
  while (true) {
    const stopReq = await readStopRequest(config);
    if (stopReq?.requestedAt) {
      await appendProgress(config, `[LOOP] Stop requested while waiting workers: reason=${stopReq.reason || "unknown"}`);
      return false;
    }
    const stillActive = await hasActiveWorkersAsync(config);
    if (!stillActive) {
      await appendProgress(config, "[LOOP] All workers done — cycle complete");
      return true;
    }
    await sleep(WORKERS_DONE_POLL_MS);
  }
}

// ── Post-completion cleanup ──────────────────────────────────────────────────

async function postCompletionCleanup(config) {
  const repo = config.env?.targetRepo;
  const token = config.env?.githubToken;
  if (!repo || !token) return;

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "BOX/1.0"
  };
  const base = `https://api.github.com/repos/${repo}`;

  try {
    const prsRes = await fetch(`${base}/pulls?state=open&per_page=50`, { headers });
    if (prsRes.ok) {
      const openPrs = await prsRes.json();
      const mergedRes = await fetch(`${base}/pulls?state=closed&per_page=50&sort=updated&direction=desc`, { headers });
      const closedPrs = mergedRes.ok ? await mergedRes.json() : [];
      const mergedTitles = closedPrs
        .filter(p => p.merged_at)
        .map(p => String(p.title || "").toLowerCase().trim());

      for (const pr of openPrs) {
        const title = String(pr.title || "").toLowerCase().trim();
        const branch = String(pr.head?.ref || "");
        // Only auto-close BOX-owned PRs with an exact title match against a merged PR.
        // Fuzzy/prefix matching is intentionally removed to prevent collateral closures.
        const isBoxBranch = ["box/", "wave", "pr-", "qa/", "scan/"].some(p => branch.startsWith(p));
        const isDuplicate = isBoxBranch && mergedTitles.some(mt => mt === title);
        if (isDuplicate) {
          await fetch(`${base}/pulls/${pr.number}`, {
            method: "PATCH",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ state: "closed" })
          });
          await fetch(`${base}/issues/${pr.number}/comments`, {
            method: "POST",
            headers: { ...headers, "Content-Type": "application/json" },
            body: JSON.stringify({ body: "Duplicate of an already-merged PR. Auto-closed by BOX post-completion cleanup." })
          });
          await appendProgress(config, `[CLEANUP] Closed duplicate PR #${pr.number}: ${pr.title}`);
        }
      }
    }

    const branchesRes = await fetch(`${base}/branches?per_page=100`, { headers });
    if (branchesRes.ok) {
      const branches = await branchesRes.json();
      const openPrBranches = new Set();
      const openPrsRes = await fetch(`${base}/pulls?state=open&per_page=100`, { headers });
      if (openPrsRes.ok) {
        const ops = await openPrsRes.json();
        for (const pr of ops) {
          if (pr.head?.ref) openPrBranches.add(pr.head.ref);
        }
      }

      const boxPrefixes = ["box/", "wave", "pr-", "qa/", "scan/"];
      for (const branch of branches) {
        const name = branch.name;
        if (name === "main" || name === "master" || name === "develop") continue;
        if (!boxPrefixes.some(p => name.startsWith(p))) continue;
        if (openPrBranches.has(name)) continue;

        try {
          const deleteRes = await fetch(`${base}/git/refs/heads/${encodeURIComponent(name)}`, {
            method: "DELETE",
            headers
          });
          if (deleteRes.ok) {
            await appendProgress(config, `[CLEANUP] Deleted stale branch: ${name}`);
          }
        } catch { /* non-fatal */ }
      }
    }

    await fetch(base, {
      method: "PATCH",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ delete_branch_on_merge: true })
    });
  } catch (err) {
    warn(`[orchestrator] post-completion cleanup error: ${String(err?.message || err)}`);
  }
}

// ── Dispatch a single worker from a Prometheus plan item ───────────────────

async function dispatchWorker(config, plan) {
  const roleName = plan.role;
  const task = plan.task;
  const context = plan.context || "";
  const verification = plan.verification || "";

  await appendProgress(config, `[DISPATCH] Sending task to ${roleName}: ${task}`);

  const result = await runWorkerConversation(config, roleName, {
    task,
    context,
    verification,
    taskKind: plan.taskKind || plan.kind || "implementation"
  });

  return {
    roleName,
    status: result?.status || "unknown",
    pr: result?.pr || result?.prUrl || null,
    summary: result?.summary || "",
    filesChanged: result?.filesTouched || "",
    raw: String(result?.raw || "").slice(0, 3000),
    verificationEvidence: result?.verificationEvidence || null
  };
}

// ── Count completed plans from worker state files ─────────────────────────

async function countCompletedPlans(config, plans) {
  const stateDir = config.paths?.stateDir || "state";
  const completed = [];
  const pending = [];

  for (const plan of plans) {
    const role = String(plan.role || "").toLowerCase().replace(/\s+/g, "_");
    const workerFile = path.join(stateDir, `worker_${role}.json`);
    const ws = await readJson(workerFile, null);
    if (!ws) {
      pending.push(plan);
      continue;
    }
    const lastLog = Array.isArray(ws.activityLog) ? ws.activityLog[ws.activityLog.length - 1] : null;
    if (lastLog?.status === "done") {
      completed.push({ plan, workerState: ws, lastLog });
    } else {
      pending.push(plan);
    }
  }

  return { completed, pending };
}

// ── Single full cycle: Jesus → Prometheus → Athena → Workers → Athena ──────

async function runSingleCycle(config, options = {}) {
  const stateDir = config.paths?.stateDir || "state";

  // Clean up any leftover .tmp files from a previous crash before reading state.
  const cleanupResult = await cleanupStaleTempFiles(stateDir);
  if (cleanupResult.removed.length > 0) {
    await appendProgress(config, `[CYCLE] Cleaned up ${cleanupResult.removed.length} stale temp file(s): ${cleanupResult.removed.join(", ")}`);
  }
  if (!cleanupResult.ok) {
    warn(`[orchestrator] stale-temp cleanup failed (non-fatal): ${String(cleanupResult.error?.message || cleanupResult.error)}`);
  }

  // Audit critical state files at cycle start — writes orchestrator_health.json.
  // This ensures runOnce (used in tests and CLI) also surfaces corrupt state.
  await auditCriticalStateFiles(config, stateDir);

  // ── Preflight capability checks ───────────────────────────────────────────
  // Validate system readiness before spending premium requests.
  if (config.runtime?.disablePreflight !== true) {
    try {
      const doctorResult = await runDoctor(config);
      if (!doctorResult.ok) {
        const failedChecks = Object.entries(doctorResult.checks)
          .filter(([, v]) => !v).map(([k]) => k).join(", ");
        await appendProgress(config,
          `[CYCLE][PREFLIGHT] Capability checks failed: ${failedChecks}. Warnings: ${doctorResult.warnings.join("; ")}`
        );
        await appendAlert(config, {
          severity: ALERT_SEVERITY.HIGH,
          source: "orchestrator",
          title: "Preflight capability checks failed",
          message: `Failed: ${failedChecks}. ${doctorResult.warnings.join("; ")}`
        });
        // Non-blocking: log but continue (critical checks would have thrown)
      } else if (doctorResult.warnings.length > 0) {
        await appendProgress(config, `[CYCLE][PREFLIGHT] All checks passed. Warnings: ${doctorResult.warnings.join("; ")}`);
      }
    } catch (err) {
      warn(`[orchestrator] preflight check failed (non-fatal): ${String(err?.message || err)}`);
    }
  }

  // Guardrail gate: if SKIP_CYCLE is active, skip planning to avoid acting on stale state.
  // Gated by systemGuardian.enabled (rollback: set to false to retain detection without enforcement).
  if (config.systemGuardian?.enabled !== false) {
    try {
      const skipActive = await isGuardrailActive(config, GUARDRAIL_ACTION.SKIP_CYCLE);
      if (skipActive) {
        await appendProgress(config,
          "[CYCLE] SKIP_CYCLE guardrail active — skipping this planning cycle (stale state detected)"
        );
        await appendAlert(config, {
          severity: ALERT_SEVERITY.HIGH,
          source: "orchestrator",
          title: "Planning cycle skipped by SKIP_CYCLE guardrail",
          message: "SKIP_CYCLE guardrail is active — catastrophe scenario may still be present. Revert guardrail to resume."
        });
        return;
      }
    } catch (err) {
      // Non-fatal: guardrail check failure must not block the cycle
      warn(`[orchestrator] SKIP_CYCLE guardrail check failed (non-fatal): ${String(err?.message || err)}`);
    }
  }

  // Step 1: Jesus analyzes state and decides what to do (1 request)
  await appendProgress(config, "[CYCLE] ── Step 1: Jesus analyzing system state ──");

  // ── Closure SLA audit: flag stale escalations (advisory) ────────────────
  try {
    const escalationQ = await loadEscalationQueue(config);
    const slaViolations = checkClosureSLA(Array.isArray(escalationQ) ? escalationQ : escalationQ?.entries || []);
    if (slaViolations.length > 0) {
      await appendProgress(config, `[CLOSURE_SLA] ${slaViolations.length} escalation(s) exceed SLA: ${slaViolations.map(v => v.title).join(", ")}`);
    }
  } catch (err) {
    warn(`[orchestrator] Closure SLA check failed (non-fatal): ${String(err?.message || err)}`);
  }
  await safeUpdatePipelineProgress(config, "jesus_awakening", "Jesus starting system state analysis");
  let jesusDecision;
  try {
    await safeUpdatePipelineProgress(config, "jesus_reading", "Jesus reading system state");
    jesusDecision = await runJesusCycle(config);
  } catch (err) {
    const msg = String(err?.message || err);
    await appendProgress(config, `[CYCLE] Jesus failed: ${msg}`);
    warn(`[orchestrator] Jesus cycle error: ${msg}`);
    if (config.runtime?.stopOnError === true) {
      throw new Error(`[JESUS_CYCLE_FAILED] ${msg}`, { cause: err });
    }
    return;
  }

  if (!jesusDecision || jesusDecision.wait === true) {
    await appendProgress(config, "[CYCLE] Jesus says: wait — nothing to do");
    return;
  }

  const mustForceReplan = typeof options.replanReason === "string" && options.replanReason.length > 0;
  if (jesusDecision.callPrometheus === false && !mustForceReplan) {
    await appendProgress(config, "[CYCLE] Jesus decision: callPrometheus=false — skipping Prometheus planning");
    await safeUpdatePipelineProgress(config, "cycle_complete", "Jesus skipped Prometheus planning for this cycle");
    return;
  }

  await safeUpdatePipelineProgress(config, "jesus_decided", "Jesus decision ready", {
    jesusDecision: typeof jesusDecision === "object" ? String(jesusDecision.thinking || "").slice(0, 200) : ""
  });

  // Step 2: Prometheus plans (single-prompt, no autopilot)
  await appendProgress(config, "[CYCLE] ── Step 2: Prometheus scanning & planning ──");
  await safeUpdatePipelineProgress(config, "prometheus_starting", "Prometheus starting repository scan");
  let prometheusAnalysis;
  try {
    await safeUpdatePipelineProgress(config, "prometheus_reading_repo", "Prometheus reading repository");
    prometheusAnalysis = await runPrometheusAnalysis(config, {
      prompt: jesusDecision.briefForPrometheus || jesusDecision.thinking || "Full repository analysis",
      requestedBy: "Jesus",
      bypassCache: options.replanReason === "all_plans_completed",
      bypassReason: options.replanReason || undefined,
    });
  } catch (err) {
    const msg = String(err?.message || err);
    await appendProgress(config, `[CYCLE] Prometheus failed: ${msg}`);
    warn(`[orchestrator] Prometheus analysis error: ${msg}`);
    if (config.runtime?.stopOnError === true) {
      throw new Error(`[PROMETHEUS_CYCLE_FAILED] ${msg}`, { cause: err });
    }
    return;
  }

  if (!prometheusAnalysis || !Array.isArray(prometheusAnalysis.plans) || prometheusAnalysis.plans.length === 0) {
    await appendProgress(config, "[CYCLE] Prometheus produced no plans — cycle complete");
    await safeUpdatePipelineProgress(config, "cycle_complete", "Prometheus produced no plans — nothing to dispatch");
    return;
  }

  // ── Parser confidence hard-stop gate ──────────────────────────────────────
  // Block dispatch when Prometheus output confidence is below threshold.
  const PARSER_CONFIDENCE_THRESHOLD = config.runtime?.parserConfidenceThreshold ?? 0.3;
  const parsedConfidence = prometheusAnalysis.parserConfidence ?? 1.0;
  if (parsedConfidence < PARSER_CONFIDENCE_THRESHOLD) {
    await appendProgress(config,
      `[CYCLE] Parser confidence too low (${parsedConfidence} < ${PARSER_CONFIDENCE_THRESHOLD}) — blocking dispatch`
    );
    await appendAlert(config, {
      severity: ALERT_SEVERITY.HIGH,
      source: "orchestrator",
      title: "Low parser confidence — dispatch blocked",
      message: `parserConfidence=${parsedConfidence} threshold=${PARSER_CONFIDENCE_THRESHOLD}. Plans not dispatched.`
    });
    await safeUpdatePipelineProgress(config, "cycle_complete", `Parser confidence too low (${parsedConfidence}) — dispatch blocked`);
    if (config.runtime?.stopOnError === true) {
      throw new Error(`[PARSER_CONFIDENCE_LOW] parserConfidence=${parsedConfidence} threshold=${PARSER_CONFIDENCE_THRESHOLD}`);
    }
    return;
  }

  await safeUpdatePipelineProgress(config, "prometheus_done", `Prometheus complete — ${prometheusAnalysis.plans.length} plan(s)`, {
    planCount: prometheusAnalysis.plans.length
  });

  // Step 3: Athena validates the plan (1 request)
  await appendProgress(config, "[CYCLE] ── Step 3: Athena reviewing plan ──");
  await safeUpdatePipelineProgress(config, "athena_reviewing", "Athena reviewing Prometheus plan");
  let planReview;
  try {
    planReview = await runAthenaPlanReview(config, prometheusAnalysis);
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 200);
    await appendProgress(config, `[CYCLE] Athena plan review threw exception: ${msg} — blocking cycle (fail-closed)`);
    warn(`[orchestrator] Athena plan review exception: ${msg}`);

    // Rollback: if runtime.athenaFailOpen is enabled, restore legacy permissive behavior.
    if (config.runtime?.athenaFailOpen === true) {
      planReview = { approved: true, reason: { code: "REVIEW_EXCEPTION_FAILOPEN", message: msg }, corrections: [] };
    } else {
      // Fail-closed: exception must block the cycle and record a deterministic blocked state.
      const reason = { code: "REVIEW_EXCEPTION", message: msg };
      await appendAlert(config, {
        severity: ALERT_SEVERITY.CRITICAL,
        source: "orchestrator",
        title: "Athena plan review exception — cycle blocked",
        message: `code=${reason.code} message=${reason.message}`
      });
      await writeJson(path.join(stateDir, "athena_plan_rejection.json"), {
        rejectedAt: new Date().toISOString(),
        reason,
        corrections: [],
        summary: `Plan review exception: ${msg}`
      });
      planReview = { approved: false, reason, corrections: [] };
    }
  }

  // ── Step 3.1: Apply Athena in-place repairs if provided ──────────────────
  if (planReview.approved && Array.isArray(planReview.patchedPlans) && planReview.patchedPlans.length > 0) {
    const fixCount = Array.isArray(planReview.appliedFixes) ? planReview.appliedFixes.length : 0;
    prometheusAnalysis.plans = planReview.patchedPlans;
    await writeJson(path.join(stateDir, "prometheus_analysis.json"), prometheusAnalysis);
    await appendProgress(config, `[CYCLE] Athena applied ${fixCount} in-place fix(es) — using patched plans for dispatch`);
  }

  if (!planReview.approved) {
    const rejectionReason = planReview.reason || { code: "PLAN_REJECTED", message: planReview.summary || "Rejected by Athena" };
    const correctionsList = planReview.corrections || [];
    await appendProgress(config, `[CYCLE] Athena REJECTED plan (review #1) — code=${typeof rejectionReason === "object" ? rejectionReason.code : rejectionReason} corrections: ${correctionsList.join("; ")}`);

    // Save rejection
    const athenaRejection = {
      rejectedAt: new Date().toISOString(),
      reason: rejectionReason,
      corrections: correctionsList,
      summary: planReview.summary || ""
    };
    await writeJson(path.join(stateDir, "athena_plan_rejection.json"), athenaRejection);

    // ── Step 3.5-fast: Deterministic pre-mortem patch ──────────────────────
    // If the ONLY rejection reason is MISSING_PREMORTEM, we can fix the plans
    // programmatically (zero tokens) and re-validate with Athena immediately.
    const rejCode = typeof rejectionReason === "object" ? rejectionReason.code : rejectionReason;
    if (rejCode === "MISSING_PREMORTEM" && Array.isArray(prometheusAnalysis?.plans)) {
      await appendProgress(config, "[CYCLE] ── Step 3.5-fast: deterministic pre-mortem patch ──");
      let patched = 0;
      for (const plan of prometheusAnalysis.plans) {
        if (plan.riskLevel !== PREMORTEM_RISK_LEVEL.HIGH) continue;
        const files = plan.targetFiles || plan.target_files || [];
        const scaffold = buildConcretePremortem(plan.task || plan.title || "", files);
        if (!plan.premortem || typeof plan.premortem !== "object") {
          plan.premortem = scaffold;
          patched++;
        } else {
          // Merge scaffold defaults into partial premortem
          const merged = { ...scaffold, ...plan.premortem, riskLevel: PREMORTEM_RISK_LEVEL.HIGH };
          for (const f of ["failurePaths", "mitigations", "detectionSignals", "guardrails"]) {
            if (!Array.isArray(merged[f]) || merged[f].length === 0) merged[f] = scaffold[f];
          }
          for (const [f, min] of [["scenario", 20], ["rollbackPlan", 10]]) {
            if (typeof merged[f] !== "string" || merged[f].trim().length < min) merged[f] = scaffold[f];
          }
          plan.premortem = merged;
          patched++;
        }
      }

      if (patched > 0) {
        const remaining = checkPlanPremortemGate(prometheusAnalysis.plans);
        if (remaining.length === 0) {
          await appendProgress(config, `[CYCLE] Deterministic patch fixed ${patched} pre-mortem(s) — re-validating with Athena`);
          let patchReview;
          try {
            patchReview = await runAthenaPlanReview(config, prometheusAnalysis);
          } catch (err) {
            const msg3 = String(err?.message || err).slice(0, 200);
            await appendProgress(config, `[CYCLE] Athena re-review after patch failed: ${msg3}`);
            patchReview = { approved: false };
          }
          if (patchReview.approved) {
            await appendProgress(config, `[CYCLE] Athena APPROVED after deterministic pre-mortem patch — skipping SI, continuing to worker dispatch`);
            // Apply Athena in-place repairs if provided alongside the pre-mortem patch approval
            if (Array.isArray(patchReview.patchedPlans) && patchReview.patchedPlans.length > 0) {
              const fixCount = Array.isArray(patchReview.appliedFixes) ? patchReview.appliedFixes.length : 0;
              prometheusAnalysis.plans = patchReview.patchedPlans;
              await writeJson(path.join(stateDir, "prometheus_analysis.json"), prometheusAnalysis);
              await appendProgress(config, `[CYCLE] Athena applied ${fixCount} in-place fix(es) on pre-mortem patched plan`);
            }
            planReview = patchReview;
          } else {
            await appendProgress(config, `[CYCLE] Athena still rejected after pre-mortem patch (other issues) — falling through to SI`);
            planReview = patchReview;
          }
        } else {
          await appendProgress(config, `[CYCLE] Deterministic patch applied ${patched} fixes but ${remaining.length} violation(s) remain — falling through to SI`);
        }
      }
    }
  }

  if (!planReview.approved) {
    const rejectionReason = planReview.reason || { code: "PLAN_REJECTED", message: planReview.summary || "Rejected by Athena" };
    const correctionsList = planReview.corrections || [];
    const athenaRejection = {
      rejectedAt: new Date().toISOString(),
      reason: rejectionReason,
      corrections: correctionsList,
      summary: planReview.summary || ""
    };

    // ── Step 3.5: Self-Improvement Repair ──────────────────────────────────
    const siGateRepair = await isSelfImprovementActive(config);
    await siLogAsync(config, "GATE", "Repair gate check: " + siGateRepair.status + " — " + siGateRepair.reason);

    if (!siGateRepair.active) {
      // SI disabled — fail-closed: escalate directly without repair attempt
      await appendProgress(config, "[CYCLE] Self-Improvement DISABLED (" + siGateRepair.status + ") — skipping repair, escalating directly");
      await siLogAsync(config, "INFO", "Repair skipped (disabled) — escalating rejection to operator");
      await escalateRepairFailure(config, {
        gateDecision: "STOP_AND_ESCALATE",
        gateReason: "Self-Improvement disabled (" + siGateRepair.status + "), cannot repair — escalating",
        rootCauses: [],
      }, { athenaReviewCount: 1, cycleId: "si-disabled-" + Date.now() });
      await safeUpdatePipelineProgress(config, "cycle_complete", "Cycle stopped: SI disabled, Athena rejection escalated");
      if (config.runtime?.stopOnError === true) {
        throw new Error("[SI_DISABLED_ESCALATED] Athena rejected plan but SI is disabled");
      }
      return;
    }

    await appendProgress(config, "[CYCLE] ── Step 3.5: Self-Improvement repair analysis ──");
    await safeUpdatePipelineProgress(config, "self_improvement_repair", "Self-improvement analyzing rejection");
    await siLogAsync(config, "REPAIR", "Starting repair analysis after Athena rejection");

    // Gather system health signals
    let systemHealth = {};
    try {
      const postmortemsRaw = await readJson(path.join(stateDir, "athena_postmortems.json"), null);
      const healthAuditData = await readJson(path.join(stateDir, "health_audit_findings.json"), null);
      systemHealth = {
        recentPostmortems: Array.isArray(postmortemsRaw?.entries) ? postmortemsRaw.entries.slice(-5) : [],
        healthAudit: healthAuditData || {},
      };
    } catch { /* non-fatal */ }

    const maxRepairAttemptsRaw = Number(config.selfImprovement?.maxRepairReplanAttempts ?? 3);
    const maxRepairAttempts = Number.isFinite(maxRepairAttemptsRaw)
      ? Math.max(1, Math.min(8, Math.floor(maxRepairAttemptsRaw)))
      : 3;

    let currentAthenaRejection = athenaRejection;
    let currentPrometheusPlan = prometheusAnalysis;
    let mergedRepairAnalysis = null;
    const repairHistory = [];
    let approvedByRepair = false;

    for (let repairAttempt = 1; repairAttempt <= maxRepairAttempts; repairAttempt++) {
      let repairAnalysis = null;
      try {
        repairAnalysis = await runRepairAnalysis(config, {
          jesusDecision,
          prometheusPlan: currentPrometheusPlan,
          athenaRejection: currentAthenaRejection,
          systemHealth,
          repairHistory,
          priorRepairGuidance: mergedRepairAnalysis,
          attemptNumber: repairAttempt,
          maxAttempts: maxRepairAttempts,
        });
        await siLogAsync(config, "REPAIR", "Repair analysis complete: attempt=" + repairAttempt + " gate=" + (repairAnalysis?.gateDecision || "null"));
      } catch (err) {
        await siLogAsync(config, "WARN", "Repair analysis failed: " + String(err?.message || err).slice(0, 200));
        warn(`[orchestrator] self-improvement repair failed: ${String(err?.message || err)}`);
        await appendProgress(config, `[CYCLE] Self-improvement repair error: ${String(err?.message || err).slice(0, 200)}`);
      }

      if (!repairAnalysis) {
        await appendProgress(config, "[CYCLE] Self-improvement produced no analysis — stopping cycle (fail-closed)");
        await persistSelfImprovementDecision(config, "repair", {
          gateDecision: "STOP_AND_ESCALATE",
          gateReason: "Self-improvement agent returned no output",
          rootCauses: [], behaviorPatches: [], repairedPlanConstraints: {}, verificationUpgrades: [],
        }, { athenaReviewCount: repairAttempt, repairAttempt, maxRepairAttempts });
        if (config.runtime?.stopOnError === true) {
          throw new Error("[SELF_IMPROVEMENT_REPAIR_FAILED] No analysis produced");
        }
        return;
      }

      mergedRepairAnalysis = mergeRepairAnalyses(mergedRepairAnalysis, repairAnalysis);

      await persistSelfImprovementDecision(config, "repair", mergedRepairAnalysis, {
        athenaReviewCount: repairAttempt,
        repairAttempt,
        maxRepairAttempts,
      });
      await appendProgress(config, `[CYCLE] Self-improvement gate: ${repairAnalysis.gateDecision} — ${repairAnalysis.gateReason}`);

      if (repairAnalysis.gateDecision === REPAIR_GATE.STOP_AND_ESCALATE) {
        await appendProgress(config, "[CYCLE] Self-improvement says STOP_AND_ESCALATE — halting cycle");
        await escalateRepairFailure(config, mergedRepairAnalysis, {
          athenaReviewCount: repairAttempt,
          cycleId: `repair-${Date.now()}`,
        });
        await safeUpdatePipelineProgress(config, "cycle_complete", "Cycle stopped: self-improvement escalated after Athena rejection");
        if (config.runtime?.stopOnError === true) {
          throw new Error(`[SELF_IMPROVEMENT_ESCALATED] ${repairAnalysis.gateReason}`);
        }
        return;
      }

      await appendProgress(config, `[CYCLE] ── Step 3.5b: Prometheus re-plan with repair feedback (attempt ${repairAttempt}/${maxRepairAttempts}) ──`);
      await safeUpdatePipelineProgress(config, "prometheus_replan", `Prometheus re-planning with self-improvement feedback (attempt ${repairAttempt}/${maxRepairAttempts})`);

      try { await (await import("node:fs/promises")).unlink(path.join(stateDir, "prometheus_analysis.json")); } catch { /* ok */ }

      let replanAnalysis;
      try {
        replanAnalysis = await runPrometheusAnalysis(config, {
          prompt: jesusDecision.briefForPrometheus || jesusDecision.thinking || "Full repository analysis",
          requestedBy: "self-improvement-repair",
          bypassCache: true,
          bypassReason: "athena_rejection_repair",
          repairFeedback: mergedRepairAnalysis,
        });
      } catch (err) {
        warn(`[orchestrator] Prometheus re-plan failed: ${String(err?.message || err)}`);
        await appendProgress(config, `[CYCLE] Prometheus re-plan failed: ${String(err?.message || err).slice(0, 200)}`);
        return;
      }

      if (!replanAnalysis || !Array.isArray(replanAnalysis.plans) || replanAnalysis.plans.length === 0) {
        await appendProgress(config, `[CYCLE] Prometheus re-plan produced no plans (attempt ${repairAttempt}/${maxRepairAttempts})`);
        repairHistory.push({
          attempt: repairAttempt,
          rejectionReason: { code: "REPLAN_EMPTY", message: "Prometheus re-plan produced no plans" },
          corrections: [],
          gateDecision: repairAnalysis.gateDecision,
        });
        continue;
      }

      await appendProgress(config, `[CYCLE] ── Step 3.5c: Athena review (repair attempt ${repairAttempt}/${maxRepairAttempts}) ──`);
      await safeUpdatePipelineProgress(config, "athena_repair_review", `Athena reviewing repaired output (attempt ${repairAttempt}/${maxRepairAttempts})`);

      let repairReview;
      try {
        repairReview = await runAthenaPlanReview(config, replanAnalysis);
      } catch (err) {
        const msg2 = String(err?.message || err).slice(0, 200);
        await appendProgress(config, `[CYCLE] Athena repair review exception (attempt ${repairAttempt}): ${msg2}`);
        repairReview = { approved: false, reason: { code: "REVIEW_EXCEPTION", message: msg2 }, corrections: [] };
      }

      if (repairReview.approved) {
        await appendProgress(config, `[CYCLE] Athena APPROVED repaired output (attempt ${repairAttempt}) — continuing to worker dispatch`);
        prometheusAnalysis = replanAnalysis;
        // Apply Athena in-place repairs on the repaired plan if provided
        if (Array.isArray(repairReview.patchedPlans) && repairReview.patchedPlans.length > 0) {
          const fixCount = Array.isArray(repairReview.appliedFixes) ? repairReview.appliedFixes.length : 0;
          prometheusAnalysis.plans = repairReview.patchedPlans;
          await appendProgress(config, `[CYCLE] Athena applied ${fixCount} in-place fix(es) on repaired plan`);
        }
        await writeJson(path.join(stateDir, "prometheus_analysis.json"), prometheusAnalysis);
        approvedByRepair = true;
        break;
      }

      const repairRejectionReason = repairReview.reason || { code: "PLAN_REJECTED", message: "Rejected after repair attempt" };
      const repairCorrections = repairReview.corrections || [];
      currentAthenaRejection = {
        rejectedAt: new Date().toISOString(),
        reason: repairRejectionReason,
        corrections: repairCorrections,
        summary: repairReview.summary || "",
      };
      currentPrometheusPlan = replanAnalysis;

      repairHistory.push({
        attempt: repairAttempt,
        rejectionReason: currentAthenaRejection.reason,
        corrections: repairCorrections,
        summary: currentAthenaRejection.summary,
        gateDecision: repairAnalysis.gateDecision,
      });

      await writeJson(path.join(stateDir, "athena_plan_rejection.json"), {
        ...currentAthenaRejection,
        reviewNumber: repairAttempt + 1,
        finalRejection: repairAttempt >= maxRepairAttempts,
      });

      await appendProgress(config, `[CYCLE] Athena rejected repaired plan (attempt ${repairAttempt}/${maxRepairAttempts}) — code=${typeof repairRejectionReason === "object" ? repairRejectionReason.code : repairRejectionReason}`);
    }

    if (!approvedByRepair) {
      const lastEntry = repairHistory[repairHistory.length - 1] || {};
      const lastCorrections = Array.isArray(lastEntry.corrections) ? lastEntry.corrections : [];

      await persistSelfImprovementDecision(config, "repair", {
        ...(mergedRepairAnalysis || {}),
        gateDecision: "STOP_AND_ESCALATE",
        gateReason: `Repair attempts exhausted (${maxRepairAttempts}) without Athena approval`,
      }, {
        athenaReviewCount: maxRepairAttempts + 1,
        repairAttempt: maxRepairAttempts,
        maxRepairAttempts,
      });

      await escalateRepairFailure(config, {
        gateDecision: "STOP_AND_ESCALATE",
        gateReason: `Repair attempts exhausted (${maxRepairAttempts}). Last corrections: ${lastCorrections.join("; ").slice(0, 300)}`,
        rootCauses: mergedRepairAnalysis?.rootCauses || [],
      }, {
        athenaReviewCount: maxRepairAttempts + 1,
        cycleId: `repair-exhausted-${Date.now()}`,
      });

      await safeUpdatePipelineProgress(config, "cycle_complete", `Cycle stopped: repair attempts exhausted (${maxRepairAttempts})`);
      if (config.runtime?.stopOnError === true) {
        throw new Error(`[PLAN_REPAIR_EXHAUSTED] attempts=${maxRepairAttempts}`);
      }
      return;
    }
  }

  await safeUpdatePipelineProgress(config, "athena_approved", "Athena approved the plan");

  // Step 4: Dispatch workers sequentially (1 request per worker)
  const plans = prometheusAnalysis.plans;

  // ── Capability pool: assign workers based on task capability matching ──────
  try {
    const poolResult = assignWorkersToPlans(plans, config);
    if (poolResult.diversityIndex > 0) {
      await appendProgress(config, `[CAPABILITY_POOL] Worker diversity index: ${poolResult.diversityIndex} (0=single-worker, 1=fully diversified)`);
    }
    // Apply pool assignment — update plan.role if a better worker is available (and not fallback-only)
    for (const { plan, selection } of poolResult.assignments) {
      if (!selection.isFallback && selection.role !== plan.role) {
        plan._originalRole = plan.role;
        plan._capabilityLane = selection.lane;
      }
    }
  } catch (err) {
    warn(`[orchestrator] Capability pool assignment failed (non-fatal): ${String(err?.message || err)}`);
  }

  // ── Plan quality gate (Packet 12): skip plans failing contract validation ──
  try {
    const contractReport = validateAllPlans(plans);
    if (contractReport.passRate < 1) {
      await appendProgress(config,
        `[PLAN_QUALITY] Contract pass rate: ${(contractReport.passRate * 100).toFixed(0)}% — ${contractReport.results.filter(r => !r.valid).length} plan(s) have violations`
      );
      for (const r of contractReport.results) {
        if (!r.valid) {
          const critical = r.violations.filter(v => v.severity === "critical");
          if (critical.length > 0) {
            warn(`[orchestrator] Plan for ${r.plan?.role || "unknown"} has ${critical.length} critical contract violation(s) — removing from dispatch`);
            const idx = plans.indexOf(r.plan);
            if (idx !== -1) plans.splice(idx, 1);
          }
        }
      }
      if (plans.length === 0) {
        await appendProgress(config, "[CYCLE] All plans removed by contract quality gate — cycle complete");
        await safeUpdatePipelineProgress(config, "cycle_complete", "All plans failed contract quality gate");
        return;
      }
    }
  } catch (err) {
    warn(`[orchestrator] Plan quality gate failed (non-fatal): ${String(err?.message || err)}`);
  }

  // ── Lane diversity gate (Packet 6) ──
  try {
    const diversityResult = enforceLaneDiversity(plans);
    if (!diversityResult.ok) {
      await appendProgress(config, `[LANE_DIVERSITY] Warning: ${diversityResult.reason}`);
    }
  } catch (err) {
    warn(`[orchestrator] Lane diversity check failed (non-fatal): ${String(err?.message || err)}`);
  }

  await appendProgress(config, `[CYCLE] ── Step 4: Dispatching ${plans.length} workers ──`);

  // Guardrail gate: if PAUSE_WORKERS is active, skip all worker dispatch.
  if (config.systemGuardian?.enabled !== false) {
    try {
      const pauseActive = await isGuardrailActive(config, GUARDRAIL_ACTION.PAUSE_WORKERS);
      if (pauseActive) {
        await appendProgress(config,
          "[CYCLE] PAUSE_WORKERS guardrail active — skipping worker dispatch (catastrophe scenario active)"
        );
        await appendAlert(config, {
          severity: ALERT_SEVERITY.HIGH,
          source: "orchestrator",
          title: "Worker dispatch paused by PAUSE_WORKERS guardrail",
          message: "PAUSE_WORKERS guardrail is active — all worker dispatch suspended. Revert guardrail to resume."
        });
        return;
      }
    } catch (err) {
      warn(`[orchestrator] PAUSE_WORKERS guardrail check failed (non-fatal): ${String(err?.message || err)}`);
    }
  }

  // Governance freeze gate (T-040): check per-plan risk before dispatching.
  // During month-12 freeze, high-risk plans (riskLevel=high|critical) are blocked
  // unless a critical incident override is attached to the plan.
  {
    const freezeStatus = isFreezeActive(config);
    if (freezeStatus.active) {
      await appendProgress(config,
        `[CYCLE] Governance freeze active (reason=${freezeStatus.reason}) — evaluating plan risk levels`
      );
    }

    const filteredPlans = [];
    for (const plan of plans) {
      const gateResult = evaluateFreezeGate(config, {
        riskLevel:       plan.riskLevel || null,
        riskScore:       typeof plan.riskScore === "number" ? plan.riskScore : 0,
        criticalOverride: plan.criticalOverride || null
      });
      if (!gateResult.allowed) {
        await appendProgress(config,
          `[CYCLE] FREEZE BLOCKED plan for ${plan.role}: ${gateResult.reason}`
        );
        warn(`[orchestrator] governance freeze blocked plan for ${plan.role}: ${gateResult.reason}`);
        // No silent fallback: write a machine-readable blocked record
        continue;
      }
      if (gateResult.overrideApproved) {
        await appendProgress(config,
          `[CYCLE] Critical override granted for ${plan.role}: incidentId=${gateResult.overrideApproved.incidentId}`
        );
      }
      filteredPlans.push(plan);
    }

    if (filteredPlans.length < plans.length) {
      const blockedCount = plans.length - filteredPlans.length;
      await appendProgress(config,
        `[CYCLE] Governance freeze blocked ${blockedCount} of ${plans.length} plan(s) — proceeding with ${filteredPlans.length} allowed plan(s)`
      );
      // Reassign plans to only allowed set; if none remain, exit cycle
      plans.splice(0, plans.length, ...filteredPlans);
      if (plans.length === 0) {
        await appendProgress(config, "[CYCLE] All plans blocked by governance freeze — cycle complete");
        await safeUpdatePipelineProgress(config, "cycle_complete", "All plans blocked by governance freeze");
        return;
      }
    }
  }

  // ── Composed governance pre-dispatch gate: canary breach + lineage graph ────
  // Checks canary breach (triggers rollback if active) and dependency graph cycles.
  // Guardrail is already checked above; freeze is checked per-plan above.
  // Non-fatal: gate errors are logged but do not block the cycle unless blocked=true.
  {
    const cycleId = String(Date.now());
    try {
      const gateResult = await evaluatePreDispatchGovernanceGate(config, plans, cycleId);
      if (gateResult.blocked) {
        await appendProgress(config,
          `[CYCLE] Pre-dispatch governance gate blocked dispatch: reason=${gateResult.reason} action=${gateResult.action || "block"}`
        );
        await appendAlert(config, {
          severity: ALERT_SEVERITY.HIGH,
          source: "orchestrator",
          title: "Worker dispatch blocked by governance gate",
          message: `reason=${gateResult.reason}`
        });
        await safeUpdatePipelineProgress(config, "cycle_complete",
          `Dispatch blocked by governance gate: ${gateResult.reason}`
        );
        return;
      }
    } catch (err) {
      warn(`[orchestrator] pre-dispatch governance gate failed (non-fatal): ${String(err?.message || err)}`);
    }
  }

  // ── Token-budget-based batch dispatch ──────────────────────────────────────
  // Instead of 1 worker per task (N workers = N premium requests), we pack
  // all tasks into minimal batches based on token budget. Within a single
  // Copilot CLI session, all tool calls (edits, terminal, etc.) are FREE.
  // Target: 1 batch = 1 worker call = 1 premium request for all tasks.
  const tokenLimit = Number(config.runtime?.workerContextTokenLimit) || 100000;
  const totalTokens = estimateBatchTokens(plans);
  const batches = packPlansIntoBatches(plans, tokenLimit);

  await appendProgress(config,
    `[CYCLE] ── Step 4: Batch dispatch — ${plans.length} task(s), ~${totalTokens} tokens, packed into ${batches.length} batch(es) ──`
  );
  await safeUpdatePipelineProgress(config, "workers_dispatching", `Batch dispatch: ${plans.length} task(s) → ${batches.length} batch(es)`, {
    workersTotal: batches.length,
    workersDone: 0,
    totalTasks: plans.length,
    estimatedTokens: totalTokens
  });

  let batchesDone = 0;

  for (let batchIdx = 0; batchIdx < batches.length; batchIdx++) {
    const batch = batches[batchIdx];

    const stopReq = await readStopRequest(config);
    if (stopReq?.requestedAt) {
      await appendProgress(config, `[CYCLE] Stop requested — halting dispatch`);
      return;
    }

    const batchLabel = `Batch ${batchIdx + 1}/${batches.length} (${batch.length} task(s))`;
    await appendProgress(config, `[CYCLE] ${batchLabel}: dispatching single worker for ${batch.length} task(s)`);
    await safeUpdatePipelineProgress(config, "workers_running", batchLabel, {
      workersTotal: batches.length,
      workersDone: batchesDone,
      currentBatch: batchIdx + 1,
      tasksInBatch: batch.length
    });

    // Build combined instruction and dispatch a single worker for the batch
    const batchInstruction = buildBatchInstruction(batch);
    const batchRole = batch[0]?.role || "evolution-worker";
    let workerResult;
    try {
      workerResult = await dispatchWorker(config, {
        role: batchRole,
        task: batchInstruction.task,
        context: batchInstruction.context,
        verification: batchInstruction.verification,
        taskKind: batchInstruction.taskKind
      });
    } catch (err) {
      const msg = String(err?.message || err).slice(0, 200);
      await appendProgress(config, `[CYCLE] ${batchLabel} worker failed: ${msg}`);
      warn(`[orchestrator] batch worker dispatch error: ${msg}`);
      workerResult = { roleName: batchRole, status: "error", summary: msg };
    }

    // Single Athena postmortem per batch (not per task)
    const combinedPlan = buildCombinedPlan(batch);
    await appendProgress(config, `[CYCLE] ── Step 5: Athena postmortem for ${batchLabel} ──`);
    try {
      await runAthenaPostmortem(config, workerResult, combinedPlan);
    } catch (err) {
      await appendProgress(config, `[CYCLE] Athena postmortem failed for ${batchLabel}: ${String(err?.message || err)}`);
    }

    batchesDone += 1;
    await waitForWorkersToFinish(config);
  }

  await safeUpdatePipelineProgress(config, "workers_finishing", "All batches finishing up", {
    workersTotal: batches.length,
    workersDone: batches.length,
    totalTasks: plans.length
  });

  await appendProgress(config, `[CYCLE] ── All ${batches.length} batch(es) dispatched and reviewed — cycle complete ──`);
  await safeUpdatePipelineProgress(config, "cycle_complete", `Cycle complete — ${plans.length} task(s) in ${batches.length} batch(es)`, {
    workersTotal: batches.length,
    workersDone: batches.length,
    totalTasks: plans.length
  });

  // ── SLO check: compute and persist cycle-level SLO metrics ─────────────────
  // cycle_id = pipeline_progress.startedAt (the canonical cycle identifier).
  // All latency inputs are read from pipeline_progress.json.stageTimestamps.
  // This runs after cycle_complete so all stage timestamps are present.
  try {
    const progress = await readPipelineProgress(config);
    const cycleRecord = computeCycleSLOs(
      config,
      progress.stageTimestamps || {},
      progress.startedAt || null,
      progress.completedAt || new Date().toISOString()
    );
    await persistSloMetrics(config, cycleRecord);

    if (cycleRecord.sloBreaches.length > 0) {
      const breachSummary = cycleRecord.sloBreaches
        .map(b => `${b.metric}=${b.actual}ms threshold=${b.threshold}ms severity=${b.severity}`)
        .join("; ");
      await appendProgress(config, `[SLO] Cycle SLO breaches detected: ${breachSummary}`);

      for (const breach of cycleRecord.sloBreaches) {
        await appendAlert(config, {
          severity: breach.severity === "critical" ? ALERT_SEVERITY.CRITICAL : ALERT_SEVERITY.HIGH,
          source: "slo_checker",
          title: `SLO breach: ${breach.metric}`,
          message: `actual=${breach.actual}ms threshold=${breach.threshold}ms cycleId=${cycleRecord.cycleId || "unknown"} reason=${breach.reason}`
        });
      }

      // Write degraded health when SLO breaches are detected (AC3/AC14 — must call writeOrchestratorHealth, not just appendAlert)
      if (config?.slo?.degradedOnBreach !== false) {
        await writeOrchestratorHealth(stateDir, ORCHESTRATOR_STATUS.DEGRADED, "slo_breach",
          cycleRecord.sloBreaches.map(b => `${b.metric}: actual=${b.actual}ms threshold=${b.threshold}ms severity=${b.severity}`)
        );
      }
    } else {
      await appendProgress(config, `[SLO] Cycle SLO check passed — all metrics within thresholds (cycleId=${cycleRecord.cycleId || "unknown"})`);
    }
  } catch (err) {
    // SLO check is advisory — never block orchestration
    warn(`[orchestrator] SLO check failed (non-fatal): ${String(err?.message || err)}`);
    await appendProgress(config, `[SLO] SLO check failed (non-fatal): ${String(err?.message || err)}`);
  }

  // ── Cycle analytics: compute and persist KPIs, confidence, and causal links ─
  // Advisory — never blocks orchestration. Runs after SLO so sloRecord is available.
  // Risk note (Athena AC19): per-cycle file I/O on hot path, wrapped in try/catch.
  try {
    const progressForAnalytics = await readPipelineProgress(config);
    // Re-read the SLO record that was just persisted to get the computed values.
    // Import here to avoid a circular reference — slo_checker has no dep on cycle_analytics.
    const { readSloMetrics } = await import("./slo_checker.js");
    const sloState = await readSloMetrics(config);
    const sloRecord = sloState?.lastCycle ?? null;

    const analyticsRecord = computeCycleAnalytics(config, {
      sloRecord,
      pipelineProgress: progressForAnalytics,
      workerResults: null,   // worker result details not aggregated at this call site
      planCount: Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans.length : null,
      phase: CYCLE_PHASE.COMPLETED,
    });
    await persistCycleAnalytics(config, analyticsRecord);
    await appendProgress(config, `[ANALYTICS] Cycle analytics written — confidence=${analyticsRecord.confidence.level} sloStatus=${analyticsRecord.kpis.sloStatus} phase=${analyticsRecord.phase}`);
  } catch (err) {
    // Analytics are advisory — never block orchestration
    warn(`[orchestrator] Cycle analytics failed (non-fatal): ${String(err?.message || err)}`);
    await appendProgress(config, `[ANALYTICS] Cycle analytics failed (non-fatal): ${String(err?.message || err)}`);
  }

  // ── Catastrophe detection: scan for systemic failure patterns each cycle ──
  // Advisory — never blocks orchestration. Failure sets explicit status=degraded.
  // Risk level: HIGH — reads orchestration state directly.
  try {
    // Build cycle data from available in-cycle metrics
    const now = Date.now();
    const jesusDirectivePath    = path.join(stateDir, "jesus_directive.json");
    const prometheusAnalysisPath = path.join(stateDir, "prometheus_analysis.json");

    const jesusDirectiveRaw     = await readJson(jesusDirectivePath, null);
    const prometheusAnalysisRaw = await readJson(prometheusAnalysisPath, null);

    const jesusDirectiveAgeMs = jesusDirectiveRaw?.decidedAt
      ? now - new Date(jesusDirectiveRaw.decidedAt).getTime()
      : 0;
    const prometheusAnalysisAgeMs = prometheusAnalysisRaw?.analyzedAt
      ? now - new Date(prometheusAnalysisRaw.analyzedAt).getTime()
      : 0;

    // Read SLO state to determine if this cycle had a breach
    const { readSloMetrics } = await import("./slo_checker.js");
    const sloState = await readSloMetrics(config);
    const hadSloBreachThisCycle = Array.isArray(sloState?.lastCycle?.sloBreaches)
      && sloState.lastCycle.sloBreaches.length > 0;

    const cycleData = {
      retryCount:              0,                          // no per-cycle retry counter yet; 0 is safe
      totalTasks:              Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans.length : 0,
      blockedTasks:            0,                          // blocking is tracked per-worker, not aggregated here
      jesusDirectiveAgeMs:     Math.max(0, jesusDirectiveAgeMs),
      prometheusAnalysisAgeMs: Math.max(0, prometheusAnalysisAgeMs),
      parseFailureCount:       0,                          // accumulated in persistent state across calls
      hadBudgetBreach:         false,                      // budget controller doesn't surface per-cycle breach yet
      hadSloBreach:            hadSloBreachThisCycle,
    };

    const catastropheResult = await runCatastropheDetection(config, cycleData);
    if (catastropheResult.detections.length > 0) {
      await appendProgress(config,
        `[CATASTROPHE] ${catastropheResult.detections.length} scenario(s) detected: ${catastropheResult.detections.map(d => d.scenarioId).join(", ")}`
      );
    } else {
      await appendProgress(config, "[CATASTROPHE] No catastrophe patterns detected this cycle");
    }
    if (!catastropheResult.ok) {
      warn(`[orchestrator] Catastrophe detection degraded: ${catastropheResult.reason || "unknown"}`);
    }

    // Execute guardrail actions for all active detections.
    // Gated by systemGuardian.enabled — set false to retain detection without enforcement (rollback path).
    if (catastropheResult.ok && catastropheResult.detections.length > 0
        && config.systemGuardian?.enabled !== false) {
      const guardResult = await executeGuardrailsForDetections(config, catastropheResult.detections);
      await appendProgress(config,
        `[GUARDRAIL] ${guardResult.results.length} action(s) applied — status=${guardResult.status} withinSla=${guardResult.withinSla} latencyMs=${guardResult.latencyMs}`
      );
      if (!guardResult.ok) {
        warn(`[orchestrator] Guardrail execution returned partial/failed status: ${guardResult.reason || "see results"}`);
      }
    }
  } catch (err) {
    // Advisory — never blocks orchestration
    warn(`[orchestrator] Catastrophe detection error (non-fatal): ${String(err?.message || err)}`);
    await appendProgress(config, `[CATASTROPHE] Detection error (non-fatal): ${String(err?.message || err)}`);
  }

  // ── Recurrence detection: scan postmortems for repeated defect patterns ───
  try {
    const postmortemsRaw = await readJson(path.join(stateDir, "athena_postmortems.json"), null);
    const pmEntries = Array.isArray(postmortemsRaw?.entries) ? postmortemsRaw.entries : [];
    if (pmEntries.length > 0) {
      const recurrences = detectRecurrences(pmEntries);
      if (recurrences.length > 0) {
        const escalations = buildRecurrenceEscalations(recurrences);
        await appendProgress(config, `[RECURRENCE] ${recurrences.length} recurring pattern(s) detected: ${recurrences.map(r => r.pattern).join("; ")}`);
        for (const esc of escalations) {
          await appendAlert(config, {
            severity: esc.severity === "critical" ? ALERT_SEVERITY.CRITICAL : ALERT_SEVERITY.HIGH,
            source: "recurrence_detector",
            title: esc.title,
            message: esc.reason
          });
        }
      }
    }
  } catch (err) {
    warn(`[orchestrator] Recurrence detection failed (non-fatal): ${String(err?.message || err)}`);
  }

  // ── Learning-to-policy compilation: convert lessons into enforced checks ──
  try {
    const postmortemsRaw2 = await readJson(path.join(stateDir, "athena_postmortems.json"), null);
    const pmEntries2 = Array.isArray(postmortemsRaw2?.entries) ? postmortemsRaw2.entries : [];
    if (pmEntries2.length > 0) {
      const policies = compileLessonsToPolicies(pmEntries2);
      if (policies.length > 0) {
        await writeJson(path.join(stateDir, "learned_policies.json"), policies);
        await appendProgress(config, `[POLICY_COMPILER] ${policies.length} lesson-based policies compiled: ${policies.map(p => p.id).join(", ")}`);
      }
    }
  } catch (err) {
    warn(`[orchestrator] Learning policy compilation failed (non-fatal): ${String(err?.message || err)}`);
  }

  // ── Capacity scoreboard: persist KPIs for trend analysis ──────────────────
  try {
    await appendCapacityEntry(config, {
      parserConfidence: prometheusAnalysis?.parserConfidence ?? null,
      planCount: Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans.length : 0,
      projectHealth: prometheusAnalysis?.projectHealth ?? "unknown",
      optimizerStatus: "ok",
      budgetUsed: prometheusAnalysis?.requestBudget?.estimatedPremiumRequestsTotal ?? 0,
      budgetLimit: prometheusAnalysis?.requestBudget?.hardCapTotal ?? 0,
      workersDone: batches.length,
    });
  } catch (err) {
    warn(`[orchestrator] Capacity scoreboard update failed (non-fatal): ${String(err?.message || err)}`);
  }

  // ── Delta analytics + strategy retune (Wave 6) ───────────────────────────
  try {
    const delta = await computeCapabilityDelta(config);
    if (delta.summary.hasEnoughData) {
      await appendProgress(config, `[DELTA] Capability score=${delta.overallScore}/100 improving=[${delta.summary.improving.join(",")}] degrading=[${delta.summary.degrading.join(",")}]`);

      const retune = evaluateRetune(config, delta);
      if (retune.shouldRetune) {
        await appendProgress(config, `[RETUNE] ${retune.actions.length} retune action(s) recommended: ${retune.actions.map(a => a.parameter).join(", ")}`);
        // Write retune recommendations to state for Jesus to consider
        await writeJson(path.join(stateDir, "retune_recommendations.json"), {
          generatedAt: new Date().toISOString(),
          actions: retune.actions,
          deltaReport: delta,
        });
      }
    }
  } catch (err) {
    warn(`[orchestrator] Delta analytics/retune failed (non-fatal): ${String(err?.message || err)}`);
  }
}

async function runSingleCycleWithFailStop(config, options = {}) {
  try {
    await runSingleCycle(config, options);
    return true;
  } catch (err) {
    const msg = String(err?.message || err).slice(0, 500);
    await appendProgress(config, `[BOX] Fatal cycle error — stopping daemon (stopOnError=true): ${msg}`);
    await appendAlert(config, {
      severity: ALERT_SEVERITY.CRITICAL,
      source: "orchestrator",
      title: "Daemon stopped due to cycle error",
      message: msg
    });
    await safeUpdatePipelineProgress(config, "idle", "System stopped after fatal cycle error");
    await clearDaemonPid(config);
    return false;
  }
}

// ── Main loop: Jesus → Prometheus → Athena → Worker → Athena → repeat ──────

async function mainLoop(config) {
  const stateDir = config.paths?.stateDir || "state";
  const RE_EVAL_SLEEP_MS = 2 * 60 * 1000;

  // Phase 1: wait for any active workers from previous session
  await waitForWorkersToFinish(config);

  // Mark system idle before entering the main loop.
  await safeUpdatePipelineProgress(config, "idle", "System idle — awaiting next cycle");

  // Phase 2: main cycle loop
  while (true) {
    const stopReq = await readStopRequest(config);
    if (stopReq?.requestedAt) {
      await appendProgress(config, `[BOX] Stop request detected, shutting down (reason=${stopReq.reason || "unknown"})`);
      await safeUpdatePipelineProgress(config, "idle", "System stopped");
      await clearStopRequest(config);
      await clearDaemonPid(config);
      break;
    }

    // Hot-reload config
    try {
      const reloadReq = await readReloadRequest(config);
      if (reloadReq?.requestedAt) {
        await clearReloadRequest(config);
        const freshConfig = await loadConfig();
        for (const key of Object.keys(freshConfig)) {
          config[key] = freshConfig[key];
        }
        await appendProgress(config, `[BOX] Hot-reload applied — config refreshed (reason=${reloadReq.reason || "cli-reload"})`);
      }
    } catch (err) {
      warn(`[orchestrator] reload error: ${String(err?.message || err)}`);
    }

    // Check escalation (workers can still escalate to Jesus)
    try {
      const escalation = await readJson(path.join(stateDir, "jesus_escalation.json"), null);
      if (escalation?.requestedAt) {
        await appendProgress(config, `[LOOP] Escalation to Jesus: ${escalation.reason || "(no reason)"}`);
        await writeJson(path.join(stateDir, "jesus_escalation.json"), {});
        // Escalation triggers a fresh full cycle
        if (!(await runSingleCycleWithFailStop(config))) break;
        continue;
      }
    } catch { /* escalation file may not exist */ }

    // Check if there's remaining work from a previous Prometheus plan
    const prometheusAnalysis = await readJson(path.join(stateDir, "prometheus_analysis.json"), null);
    const totalPlans = Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans.length : 0;

    // Read and prioritise escalation queue before starting any new planning cycle.
    // Alerts leadership when blocked tasks require attention; does not gate planning.
    try {
      const escalationEntries = await loadEscalationQueue(config);
      const prioritisedEscalations = sortEscalationQueue(escalationEntries);
      if (prioritisedEscalations.length > 0) {
        const top = prioritisedEscalations[0];
        await appendProgress(config,
          `[LOOP] Escalation queue: ${prioritisedEscalations.length} unresolved — top: role=${top.role} class=${top.blockingReasonClass} attempts=${top.attempts}`
        );
        await appendAlert(config, {
          severity: ALERT_SEVERITY.HIGH,
          source: "orchestrator",
          title: `Escalation queue: ${prioritisedEscalations.length} unresolved task(s)`,
          message: prioritisedEscalations.slice(0, 3)
            .map(e => `[${e.blockingReasonClass}] ${e.role}: ${e.taskSnippet}`)
            .join(" | ")
        });
      }
    } catch (err) {
      warn(`[orchestrator] escalation queue read error (non-fatal): ${String(err?.message || err)}`);
    }

    if (totalPlans > 0) {
      const { completed, pending } = await countCompletedPlans(config, prometheusAnalysis.plans);

      if (pending.length > 0) {
        // There's remaining work — run a new full cycle
        // Jesus will see the current state and decide appropriately
        await appendProgress(config, `[LOOP] ${completed.length}/${totalPlans} plans done, ${pending.length} remaining — starting new cycle`);
        if (!(await runSingleCycleWithFailStop(config))) break;
        await sleep(RE_EVAL_SLEEP_MS);
        continue;
      }

      // All plans done — cleanup, project completion, self-improvement
      await appendProgress(config, `[LOOP] All ${totalPlans} plans complete — running post-completion`);
      await postCompletionCleanup(config);

      const alreadyCompleted = await isProjectAlreadyCompleted(config);
      if (!alreadyCompleted) {
        try {
          await runProjectCompletion(config);
        } catch (err) {
          warn(`[orchestrator] project completion error: ${String(err?.message || err)}`);
        }
      }

      // ── Self-Improvement: Health Audit (Phase B) + Legacy cycle ────────────
      const siGateHealth = await isSelfImprovementActive(config);
      await siLogAsync(config, "GATE", "Health audit gate check: " + siGateHealth.status + " — " + siGateHealth.reason);

      if (!siGateHealth.active) {
        await appendProgress(config, "[SELF-IMPROVEMENT] DISABLED (" + siGateHealth.status + ") — skipping health audit + legacy SI");
        await siLogAsync(config, "INFO", "Health audit + legacy SI skipped (disabled)");
      } else {
      try {
        const siStateDir = config.paths?.stateDir || "state";

        // Gather worker results and postmortems for health audit
        const postmortemsRaw = await readJson(path.join(siStateDir, "athena_postmortems.json"), null);
        const recentPostmortems = Array.isArray(postmortemsRaw?.entries)
          ? postmortemsRaw.entries.slice(-10) : [];
        const evolutionProgress = await readJson(path.join(siStateDir, "evolution_progress.json"), null);
        const healthAuditData = await readJson(path.join(siStateDir, "health_audit_findings.json"), null);
        const athenaPlanReview = await readJson(path.join(siStateDir, "athena_plan_review.json"), null);

        const workerResults = {
          totalPlans: totalPlans,
          evolutionProgress: evolutionProgress || {},
          athenaPlanReview: athenaPlanReview || null,
        };
        const healthSignals = {
          healthAudit: healthAuditData || {},
          athenaPlanReview: athenaPlanReview || null,
        };

        await appendProgress(config, "[SELF-IMPROVEMENT] Running post-completion health audit (Phase B)...");
        await siLogAsync(config, "HEALTH", "Starting post-completion health audit");
        const healthResult = await runHealthAudit(config, {
          workerResults,
          postmortems: recentPostmortems,
          systemHealth: healthSignals,
        });

        if (healthResult) {
          await siLogAsync(config, "HEALTH", "Health audit result: " + healthResult.gateDecision + " — " + healthResult.gateReason);
          await persistSelfImprovementDecision(config, "health_audit", healthResult, {
            totalPlans,
            completedAt: new Date().toISOString(),
          });
          await appendProgress(config, `[SELF-IMPROVEMENT] Health audit: ${healthResult.gateDecision} — ${healthResult.gateReason}`);

          if (healthResult.gateDecision === HEALTH_GATE.UNHEALTHY) {
            await appendProgress(config, "[SELF-IMPROVEMENT] UNHEALTHY verdict — escalating");
            await escalateRepairFailure(config, {
              gateDecision: healthResult.gateDecision,
              gateReason: healthResult.gateReason,
              rootCauses: (healthResult.workerHealth?.problemWorkers || []).map(w => ({
                cause: w.issue, severity: w.severity, affectedComponent: w.worker
              })),
            }, { cycleId: `health-${Date.now()}` });
          }
        } else {
          await appendProgress(config, "[SELF-IMPROVEMENT] Health audit returned no result — skipping");
        }

        // Also run legacy self-improvement cycle if quality gate passes
        const siGate = await shouldTriggerSelfImprovement(config, siStateDir);
        if (siGate.shouldRun) {
          await appendProgress(config, `[SELF-IMPROVEMENT] Legacy quality gate passed: ${siGate.reason}`);
          await runSelfImprovementCycle(config);
          await writeJson(path.join(siStateDir, "self_improvement_state.json"), {
            lastRunAt: new Date().toISOString(),
            cyclesSinceLastRun: 0
          });
        } else {
          await appendProgress(config, `[SELF-IMPROVEMENT] Legacy skipped (quality gate): ${siGate.reason}`);
          const siState = await readJson(path.join(siStateDir, "self_improvement_state.json"), {});
          await writeJson(path.join(siStateDir, "self_improvement_state.json"), {
            ...siState,
            cyclesSinceLastRun: (siState.cyclesSinceLastRun || 0) + 1
          });
        }
      } catch (err) {
        await siLogAsync(config, "WARN", "Self-improvement error: " + String(err?.message || err).slice(0, 200));
        warn(`[orchestrator] self-improvement error: ${String(err?.message || err)}`);
      }
      } // end siGateHealth.active

      // ── Evolution metrics: persist proof-of-improvement data ──────────────
      try {
        const evoMetrics = await collectEvolutionMetrics(config);
        await appendProgress(config, `[EVOLUTION_METRICS] Collected — deterministicRate=${evoMetrics.deterministicPostmortem?.rate ?? "N/A"} premiumReqs24h=${evoMetrics.premiumRequestsPerDay}`);
      } catch (err) {
        warn(`[orchestrator] evolution metrics error (non-fatal): ${String(err?.message || err)}`);
      }

      // ── Governance canary: process running policy-rule canary experiments ──
      // Advisory — never blocks orchestration. Processes each running governance
      // canary experiment: assign cycle to cohort, record metrics, evaluate advancement.
      // On breach: status=rolled_back, breachAction=halt_new_assignments (AC4).
      try {
        const { processGovernanceCycle } = await import("./governance_canary.js");
        const cycleId = `governance-${Date.now()}`;
        const govResults = await processGovernanceCycle(config, cycleId, {});
        if (govResults.length > 0) {
          const summary = govResults.map(r => `${r.canaryId}:cohort=${r.cohort}:action=${r.action}`).join(", ");
          await appendProgress(config, `[GOVERNANCE_CANARY] Processed ${govResults.length} experiment(s): ${summary}`);
          const breaches = govResults.filter(r => r.action === "rollback");
          if (breaches.length > 0) {
            await appendProgress(config,
              `[GOVERNANCE_CANARY] BREACH detected — ${breaches.length} experiment(s) rolled back: ${breaches.map(b => `${b.canaryId}:${b.reason}`).join(", ")}`
            );
          }
        }
      } catch (err) {
        // Advisory — never blocks orchestration
        warn(`[orchestrator] governance canary processing error (non-fatal): ${String(err?.message || err)}`);
      }

      // Start a new Prometheus cycle to find new work — bypass cache since all plans completed
      await appendProgress(config, "[LOOP] Post-completion done — triggering Prometheus replan (cache bypass: all plans completed)");
      if (!(await runSingleCycleWithFailStop(config, { replanReason: "all_plans_completed" }))) break;
    } else {
      // No plans at all — first run or fresh start
      if (!(await runSingleCycleWithFailStop(config))) break;
    }

    await safeUpdatePipelineProgress(config, "idle", "Cycle complete — waiting before next iteration");
    await sleep(RE_EVAL_SLEEP_MS);
  }
}
