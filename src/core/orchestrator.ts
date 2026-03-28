/**
 * BOX Orchestrator — Athena-Gated Loop Architecture
 *
 * Flow per cycle:
 *   Jesus (orchestrator/state analyzer) → Prometheus (full scan + plan)
 *   → Athena (validate plan) → Worker(s)
 *   → back to Prometheus for next iteration
 *
 * Each agent uses exactly 1 premium request per invocation (single-prompt).
 * No autopilot. Jesus orchestrates, Prometheus plans, Athena gates.
 *
 * Startup:
 *   1. Read last checkpoint (worker_sessions.json + prometheus_analysis.json)
 *   2. If workers are active → resume monitoring, ZERO AI calls
 *   3. If no checkpoint → first run → Jesus analyzes state
 *   4. If project interrupted → Jesus decides: continue or re-plan
 */

import path from "node:path";
import fs from "node:fs/promises";
import { appendProgress, appendAlert, ALERT_SEVERITY } from "./state_tracker.js";
import { readStopRequest, writeDaemonPid, clearDaemonPid, clearStopRequest, readReloadRequest, clearReloadRequest } from "./daemon_control.js";
import { loadConfig } from "../config.js";
import { runJesusCycle } from "./jesus_supervisor.js";
import { runPrometheusAnalysis } from "./prometheus.js";
import { runAthenaPlanReview } from "./athena_reviewer.js";
import { runWorkerConversation } from "./worker_runner.js";
import { runSelfImprovementCycle, shouldTriggerSelfImprovement } from "./self_improvement.js";
import { collectEvolutionMetrics } from "./evolution_metrics.js";
import { capturePreWorkBaseline, runProjectCompletion, isProjectAlreadyCompleted } from "./project_lifecycle.js";
import { warn, emitEvent } from "./logger.js";
import { EVENTS, EVENT_DOMAIN } from "./event_schema.js";
import { readJson, readJsonSafe, writeJson, cleanupStaleTempFiles, READ_JSON_REASON } from "./fs_utils.js";
import { updatePipelineProgress, readPipelineProgress } from "./pipeline_progress.js";
import { loadEscalationQueue, sortEscalationQueue } from "./escalation_queue.js";
import { computeCycleSLOs, persistSloMetrics } from "./slo_checker.js";
import { computeCycleAnalytics, persistCycleAnalytics, computeCycleHealth, persistCycleHealth, CYCLE_PHASE } from "./cycle_analytics.js";
import { computeBaselineRecoveryState, persistBaselineMetrics, PARSER_CONFIDENCE_RECOVERY_THRESHOLD } from "./parser_baseline_recovery.js";
import { computeDispatchStrictness, loadReplayRegressionState, DISPATCH_STRICTNESS } from "./parser_replay_harness.js";
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
import { runDoctor } from "./doctor.js";
import { validateAllPlans } from "./plan_contract_validator.js";
import { resolveDependencyGraph, GRAPH_STATUS } from "./dependency_graph_resolver.js";
import { isGovernanceCanaryBreachActive } from "./governance_canary.js";
import { executeRollback, ROLLBACK_LEVEL, ROLLBACK_TRIGGER } from "./rollback_engine.js";
import { initializeAggregateLiveLog } from "./live_log.js";
import { buildRoleExecutionBatches } from "./worker_batch_planner.js";
import { agentFileExists, nameToSlug } from "./agent_loader.js";
import { getRoleRegistry } from "./role_registry.js";
import {
  checkArchitectureDrift,
  rankStaleRefsAsRemediationCandidates,
  type ArchitectureDriftReport,
} from "./architecture_drift.js";
import { detectLaneConflicts } from "./capability_pool.js";
import {
  loadLedgerMeta,
  addDebtEntries,
  saveLedgerFull,
  shouldBlockOnDebt,
  autoCloseVerifiedDebt,
} from "./carry_forward_ledger.js";
import { reconcileBudgetEligibility } from "./budget_controller.js";
import {
  runInterventionOptimizer,
  buildInterventionsFromPlan,
  buildBudgetFromConfig,
  persistOptimizerLog,
  OPTIMIZER_STATUS,
} from "./intervention_optimizer.js";
import { validatePlanEvidenceCoupling } from "./evidence_envelope.js";

/**
 * Orchestrator health status enum.
 * Written to state/orchestrator_health.json whenever status changes.
 */
export const ORCHESTRATOR_STATUS = Object.freeze({
  OPERATIONAL: "operational",
  DEGRADED: "degraded"
});

/**
 * Health divergence state enum.
 * Describes how operational health (orchestrator) and planner health (Prometheus) relate.
 *
 *   none                       — both agree on a healthy state; no warning needed
 *   planner_warning            — orchestrator is operational but planner reports needs-work
 *   planner_critical           — orchestrator is operational but planner reports critical
 *   operational_degraded_planner_ok — orchestrator is degraded but planner reports good
 *   both_degraded              — orchestrator is degraded AND planner reports needs-work/critical
 *   unknown                    — insufficient data to determine divergence
 */
export const HEALTH_DIVERGENCE_STATE = Object.freeze({
  NONE:                          "none",
  PLANNER_WARNING:               "planner_warning",
  PLANNER_CRITICAL:              "planner_critical",
  OPERATIONAL_DEGRADED_PLANNER_OK: "operational_degraded_planner_ok",
  BOTH_DEGRADED:                 "both_degraded",
  UNKNOWN:                       "unknown",
});

/**
 * Resolved pipeline status values produced by the health divergence mapping.
 * These represent the single authoritative status a consumer should act on
 * when operational and planner health must be reconciled.
 */
export const PIPELINE_HEALTH_STATUS = Object.freeze({
  HEALTHY:  "healthy",
  WARNING:  "warning",
  CRITICAL: "critical",
  UNKNOWN:  "unknown",
});

/**
 * Compare operational health (orchestrator status) with planner health (Prometheus
 * projectHealth) and return a deterministic divergence record.
 *
 * Exported so tests and downstream consumers can verify the mapping logic.
 *
 * @param {string} operationalStatus — "operational" | "degraded" | unknown string
 * @param {string} plannerHealth     — "good" | "needs-work" | "critical" | unknown string
 * @returns {{ divergenceState, pipelineStatus, operationalStatus, plannerHealth, isWarning }}
 */
export function computeHealthDivergence(operationalStatus, plannerHealth) {
  const opStatus = String(operationalStatus || "").toLowerCase().trim();
  const phStatus = String(plannerHealth || "").toLowerCase().trim();

  const isOperational = opStatus === ORCHESTRATOR_STATUS.OPERATIONAL;
  const isDegraded    = opStatus === ORCHESTRATOR_STATUS.DEGRADED;
  const isGood        = phStatus === "good";
  const isNeedsWork   = phStatus === "needs-work";
  const isCritical    = phStatus === "critical";

  if (!opStatus || !phStatus || (!isOperational && !isDegraded) || (!isGood && !isNeedsWork && !isCritical)) {
    return {
      divergenceState: HEALTH_DIVERGENCE_STATE.UNKNOWN,
      pipelineStatus:  PIPELINE_HEALTH_STATUS.UNKNOWN,
      operationalStatus: opStatus || "unknown",
      plannerHealth:     phStatus || "unknown",
      isWarning: false,
    };
  }

  if (isDegraded && (isNeedsWork || isCritical)) {
    return {
      divergenceState: HEALTH_DIVERGENCE_STATE.BOTH_DEGRADED,
      pipelineStatus:  PIPELINE_HEALTH_STATUS.CRITICAL,
      operationalStatus: opStatus,
      plannerHealth:     phStatus,
      isWarning: true,
    };
  }

  if (isDegraded && isGood) {
    return {
      divergenceState: HEALTH_DIVERGENCE_STATE.OPERATIONAL_DEGRADED_PLANNER_OK,
      pipelineStatus:  PIPELINE_HEALTH_STATUS.WARNING,
      operationalStatus: opStatus,
      plannerHealth:     phStatus,
      isWarning: true,
    };
  }

  if (isOperational && isCritical) {
    return {
      divergenceState: HEALTH_DIVERGENCE_STATE.PLANNER_CRITICAL,
      pipelineStatus:  PIPELINE_HEALTH_STATUS.CRITICAL,
      operationalStatus: opStatus,
      plannerHealth:     phStatus,
      isWarning: true,
    };
  }

  if (isOperational && isNeedsWork) {
    return {
      divergenceState: HEALTH_DIVERGENCE_STATE.PLANNER_WARNING,
      pipelineStatus:  PIPELINE_HEALTH_STATUS.WARNING,
      operationalStatus: opStatus,
      plannerHealth:     phStatus,
      isWarning: true,
    };
  }

  // operational + good → fully healthy
  return {
    divergenceState: HEALTH_DIVERGENCE_STATE.NONE,
    pipelineStatus:  PIPELINE_HEALTH_STATUS.HEALTHY,
    operationalStatus: opStatus,
    plannerHealth:     phStatus,
    isWarning: false,
  };
}

/** Max automatic retries when a worker hits transient API errors (circuit breaker). */
const MAX_TRANSIENT_RETRIES = 3;

type WorkerSessionRecord = {
  status?: string;
  [key: string]: unknown;
};

type GithubPullRequestSummary = {
  number?: number;
  title?: string;
  merged_at?: string | null;
  head?: {
    ref?: string;
  };
};

type GithubBranchSummary = {
  name?: string;
};

type CriticalReadResult = {
  ok: boolean;
  reason?: string;
  data?: unknown;
  error?: {
    message?: string;
  } | null;
};

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
 * Evaluate pre-dispatch governance gates without starting worker execution.
 * Exported for integration tests and any callers that need the dispatch decision
 * surface without running a full orchestration cycle.
 */
export async function evaluatePreDispatchGovernanceGate(config, plans = [], cycleId = "", driftReport: ArchitectureDriftReport | null = null) {
  const stateDir = config?.paths?.stateDir || "state";

  // ── Budget reconciliation — resolved upfront so every dispatch decision
  // carries a uniform BudgetEligibilityContract regardless of which gate fires.
  const budgetEligibility = await reconcileBudgetEligibility(config);
  if (budgetEligibility.configured && budgetEligibility.reason?.startsWith("budget_read_error")) {
    warn(`[orchestrator] budget gate failed (non-fatal): ${budgetEligibility.reason}`);
  }

  // ── Budget eligibility gate (hard gate — first check) ────────────────────
  // Fires immediately after reconciliation, before all other gates so that
  // budget exhaustion short-circuits every subsequent operation (including
  // expensive canary rollback and ledger reads) with a uniform block signal.
  if (!budgetEligibility.eligible) {
    return {
      blocked: true,
      reason: budgetEligibility.reason,
      action: undefined,
      graphResult: null,
      cycleId,
      budgetEligibility,
    };
  }

  if (config?.systemGuardian?.enabled !== false) {
    try {
      const pauseActive = await isGuardrailActive(config, GUARDRAIL_ACTION.PAUSE_WORKERS);
      if (pauseActive) {
        return {
          blocked: true,
          reason: "guardrail_pause_workers_active",
          action: undefined,
          graphResult: null,
          cycleId,
          budgetEligibility
        };
      }
    } catch (err) {
      warn(`[orchestrator] pre-dispatch guardrail check failed: ${String(err?.message || err)}`);
    }
  }

  const freezeStatus = isFreezeActive(config);
  if (freezeStatus.active) {
    return {
      blocked: true,
      reason: `governance_freeze_active:${freezeStatus.reason}`,
      action: undefined,
      graphResult: null,
      cycleId,
      budgetEligibility
    };
  }

  const graphInput = Array.isArray(plans)
    ? plans.map((plan, index) => ({
        id: String(plan?.id || plan?.task || plan?.role || `plan-${index + 1}`),
        dependsOn: Array.isArray(plan?.dependsOn) ? plan.dependsOn : [],
        filesInScope: Array.isArray(plan?.filesInScope) ? plan.filesInScope : []
      }))
    : [];

  const graphResult = resolveDependencyGraph(graphInput);
  if (graphResult.status === GRAPH_STATUS.CYCLE_DETECTED) {
    return {
      blocked: true,
      reason: `lineage_cycle_detected:${graphResult.reasonCode}`,
      action: undefined,
      graphResult,
      cycleId,
      budgetEligibility
    };
  }

  const canaryBreach = await isGovernanceCanaryBreachActive(config);
  if (canaryBreach.breachActive) {
    const rollbackConfig = {
      ...config,
      rollbackEngine: {
        ...(config?.rollbackEngine || {}),
        incidentLogPath: config?.rollbackEngine?.incidentLogPath || path.join(stateDir, "rollback_incidents.jsonl"),
        lockFilePath: config?.rollbackEngine?.lockFilePath || path.join(stateDir, "rollback_lock.json")
      }
    };

    const rollbackResult = await executeRollback({
      level: ROLLBACK_LEVEL.CONFIG_ONLY,
      trigger: ROLLBACK_TRIGGER.CANARY_ROLLBACK,
      evidence: {
        controlValue: config?.rollbackEngine?.controlValue || {},
        cycleId,
        breachReason: canaryBreach.reason || "GOVERNANCE_CANARY_BREACH"
      },
      config: rollbackConfig,
      stateDir
    });

    return {
      blocked: true,
      reason: `governance_canary_breach:${canaryBreach.reason || "GOVERNANCE_CANARY_BREACH"}`,
      action: "rollback",
      graphResult,
      rollbackResult,
      cycleId,
      budgetEligibility
    };
  }

  // ── Carry-forward debt gate ───────────────────────────────────────────────
  // Block dispatch when the count of critical overdue debt entries meets or
  // exceeds the configured limit (default: 3).  Fail-open on any ledger read
  // error so a corrupt/missing ledger never prevents legitimate work.
  try {
    const { entries: debtLedger, cycleCounter } = await loadLedgerMeta(config);
    const debtGate = shouldBlockOnDebt(debtLedger, cycleCounter, {
      maxCriticalOverdue: config?.carryForward?.maxCriticalOverdue,
    });
    if (debtGate.shouldBlock) {
      return {
        blocked: true,
        reason: `critical_debt_overdue:${debtGate.reason}`,
        action: undefined,
        graphResult,
        cycleId,
        budgetEligibility,
      };
    }
  } catch (err) {
    warn(`[orchestrator] carry-forward debt gate failed (non-fatal): ${String(err?.message || err)}`);
  }

  // ── Mandatory drift debt gate ─────────────────────────────────────────────
  // Block dispatch when high-priority architecture drift debt remains unresolved
  // after plan normalization. "Mandatory" drift debt = stale references to
  // src/core/ files (priority=high, confidence=0.50) that have not been remediated.
  // These indicate that the architecture doc is pointing to ghost paths in active
  // infrastructure, which can cause workers to build against non-existent files.
  //
  // Fail-open: any error processing the drift report is treated as no signal so
  // a transient scan failure never prevents legitimate work.
  // Disabled when config.runtime.disableDriftDebtGate === true.
  if (driftReport && config?.runtime?.disableDriftDebtGate !== true) {
    try {
      const driftCandidates = rankStaleRefsAsRemediationCandidates(driftReport);
      const mandatoryDebt = driftCandidates.filter(c => c.priority === "high");
      if (mandatoryDebt.length > 0) {
        const firstHint = mandatoryDebt[0].suggestedTask;
        return {
          blocked: true,
          reason: `mandatory_drift_debt_unresolved:${mandatoryDebt.length} high-priority drift debt task(s) remain — ${firstHint}`,
          action: undefined,
          graphResult,
          cycleId,
          budgetEligibility,
        };
      }
    } catch (driftDebtErr) {
      warn(`[orchestrator] mandatory drift debt gate failed (non-fatal): ${String(driftDebtErr?.message || driftDebtErr)}`);
    }
  }

  // ── Plan evidence coupling gate ───────────────────────────────────────────
  // Each plan entering dispatch must carry at least one verification command
  // and at least one acceptance criterion — this ensures automated completion
  // signals exist before work begins.  Plans that are missing these fields are
  // either AI output gaps or legacy plans from before the coupling requirement;
  // either way, dispatching them would produce unverifiable outcomes.
  if (Array.isArray(plans) && plans.length > 0) {
    const invalidPlans: string[] = [];
    for (const plan of plans) {
      const coupling = validatePlanEvidenceCoupling(plan);
      if (!coupling.valid) {
        const planId = String((plan as any)?.task_id || (plan as any)?.id || (plan as any)?.task || "unknown");
        invalidPlans.push(`${planId}: ${coupling.errors.join("; ")}`);
      }
    }
    if (invalidPlans.length > 0) {
      return {
        blocked: true,
        reason: `plan_evidence_coupling_invalid:${invalidPlans[0]}`,
        action: undefined,
        graphResult,
        cycleId,
        budgetEligibility,
      };
    }
  }

  return {
    blocked: false,
    reason: null,
    action: undefined,
    graphResult,
    cycleId,
    budgetEligibility
  };
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
async function safeUpdatePipelineProgress(config, stepId, detail, extra?) {
  try {
    await updatePipelineProgress(config, stepId, detail, extra);
  } catch (err) {
    warn(`[orchestrator] pipeline progress update failed (step=${stepId}): ${String(err?.message || err)}`);
  }
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

  let sessions: Record<string, any> = {};
  let jesusDirective = null;
  let prometheusAnalysis = null;
  const degradedReasons = [];

  for (const [label, result, defaultFallback, fileType] of ([
    ["worker_sessions.json",    sessionsResult,          {}, STATE_FILE_TYPE.WORKER_SESSIONS],
    ["jesus_directive.json",    jesusDirectiveResult,    null, null],
    ["prometheus_analysis.json", prometheusAnalysisResult, null, STATE_FILE_TYPE.PROMETHEUS_ANALYSIS]
  ] as Array<[string, CriticalReadResult, unknown, string | null]>)) {
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
  const knownRoles = Object.values(getRoleRegistry(liveConfig).workers).map((w: any) => w.name);
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

// Stub: checks dispatch_checkpoint.json for an in-flight dispatching state.
// Reserved for future recovery path — prefixed _wasDispatchInterrupted to satisfy
// no-unused-vars until the dispatch recovery flow calls it.
async function _wasDispatchInterrupted(_stateDir: string): Promise<boolean> {
  return false;
}

const DISPATCH_CHECKPOINT_FILE = "dispatch_checkpoint.json";

function getDispatchCheckpointPath(stateDir) {
  return path.join(stateDir, DISPATCH_CHECKPOINT_FILE);
}

async function readDispatchCheckpoint(config) {
  const stateDir = config.paths?.stateDir || "state";
  return readJson(getDispatchCheckpointPath(stateDir), null);
}

async function writeDispatchCheckpoint(config, checkpoint) {
  const stateDir = config.paths?.stateDir || "state";
  await writeJson(getDispatchCheckpointPath(stateDir), checkpoint);
}

function isDispatchCheckpointResumable(checkpoint) {
  if (!checkpoint || checkpoint.status !== "dispatching") return false;
  const totalPlans = Number(checkpoint.totalPlans || 0);
  const completedPlans = Number(checkpoint.completedPlans || 0);
  return totalPlans > 0 && completedPlans < totalPlans;
}

function isDispatchCheckpointCompleteForTotal(checkpoint, totalPlans) {
  if (!checkpoint || checkpoint.status !== "complete") return false;
  if (Number(checkpoint.totalPlans || 0) !== Number(totalPlans || 0)) return false;
  return Number(checkpoint.completedPlans || 0) >= Number(totalPlans || 0);
}

async function beginDispatchCheckpoint(config, plans) {
  const nowIso = new Date().toISOString();
  const checkpoint = {
    schemaVersion: 1,
    status: "dispatching",
    createdAt: nowIso,
    updatedAt: nowIso,
    totalPlans: Array.isArray(plans) ? plans.length : 0,
    completedPlans: 0
  };
  await writeDispatchCheckpoint(config, checkpoint);
  return checkpoint;
}

async function updateDispatchCheckpointProgress(config, checkpoint, completedPlans) {
  if (!checkpoint) return;
  checkpoint.completedPlans = Math.max(0, Math.min(Number(completedPlans || 0), Number(checkpoint.totalPlans || 0)));
  checkpoint.updatedAt = new Date().toISOString();
  await writeDispatchCheckpoint(config, checkpoint);
}

async function completeDispatchCheckpoint(config, checkpoint) {
  if (!checkpoint) return;
  checkpoint.status = "complete";
  checkpoint.completedPlans = Number(checkpoint.totalPlans || 0);
  checkpoint.updatedAt = new Date().toISOString();
  await writeDispatchCheckpoint(config, checkpoint);
}

function isDispatchOutcomeSuccessful(workerResult) {
  const status = String(workerResult?.status || "").toLowerCase();
  return status === "done" || status === "partial";
}

async function tryResumeDispatchFromCheckpoint(config, options: { force?: boolean } = {}) {
  const stateDir = config.paths?.stateDir || "state";
  const force = options?.force === true;
  const activeWorkers = await hasActiveWorkersAsync(config);
  if (activeWorkers) return false;

  const athenaReview = await readJson(path.join(stateDir, "athena_plan_review.json"), null);
  const prometheusAnalysis = await readJson(path.join(stateDir, "prometheus_analysis.json"), null);
  const plans = Array.isArray(athenaReview?.patchedPlans) && athenaReview.patchedPlans.length > 0
    ? athenaReview.patchedPlans
    : (Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans : []);
  if (!athenaReview?.approved || plans.length === 0) return false;
  const workerBatches = buildRoleExecutionBatches(plans, config);
  if (workerBatches.length === 0) return false;

  let checkpoint = await readDispatchCheckpoint(config);
  const checkpointMatchesTotal = Number(checkpoint?.totalPlans || 0) === workerBatches.length;

  if (!force && isDispatchCheckpointCompleteForTotal(checkpoint, workerBatches.length)) {
    return false;
  }

  if (!isDispatchCheckpointResumable(checkpoint)) {
    if (!force && checkpoint && checkpoint.status === "complete" && checkpointMatchesTotal) {
      return false;
    }
    checkpoint = await beginDispatchCheckpoint(config, workerBatches);
  }

  const startIndex = Math.max(0, Math.min(Number(checkpoint.completedPlans || 0), workerBatches.length));
  if (startIndex >= workerBatches.length) {
    await completeDispatchCheckpoint(config, checkpoint);
    return false;
  }

  // Pre-dispatch governance gate — same checks as runSingleCycle to prevent
  // resuming into a frozen/canary-breached/guardrail-paused state.
  const resumeCycleId = `resume-${Date.now()}`;
  try {
    const gateDecision = await evaluatePreDispatchGovernanceGate(config, plans, resumeCycleId);
    emitEvent(EVENTS.GOVERNANCE_GATE_EVALUATED, EVENT_DOMAIN.GOVERNANCE, resumeCycleId, {
      blocked: gateDecision.blocked,
      reason: gateDecision.reason || null,
      inputSnapshot: { planCount: plans.length, resumedFromCheckpoint: true, startIndex }
    });
    if (gateDecision.blocked) {
      const reasonMsg = gateDecision.reason || "pre_dispatch_gate_blocked";
      await appendProgress(config,
        `[RESUME] Pre-dispatch governance gate blocked resumed dispatch — reason=${reasonMsg}`
      );
      await appendAlert(config, {
        severity: ALERT_SEVERITY.HIGH,
        source: "orchestrator",
        title: "Resumed worker dispatch blocked by pre-dispatch governance gate",
        message: `reason=${reasonMsg} action=${gateDecision.action || "none"} cycleId=${resumeCycleId}`
      });
      return true;
    }
  } catch (err) {
    warn(`[orchestrator] Pre-dispatch governance gate failed during resume (non-fatal): ${String(err?.message || err)}`);
    emitEvent(EVENTS.ORCHESTRATION_HEALTH_DEGRADED, EVENT_DOMAIN.ORCHESTRATION, resumeCycleId, {
      reason: "governance_gate_exception",
      error: String(err?.message || err),
      context: "resume_dispatch"
    });
  }

  await appendProgress(config,
    force
      ? `[RESUME] Force-resuming dispatch checkpoint: batch ${startIndex + 1}/${workerBatches.length}`
      : checkpointMatchesTotal
        ? `[RESUME] Resuming dispatch checkpoint: batch ${startIndex + 1}/${workerBatches.length}`
        : `[RESUME] Existing approved plan detected — dispatching from batch ${startIndex + 1}/${workerBatches.length} without replanning`
  );

  await safeUpdatePipelineProgress(config, "workers_dispatching", `Resuming dispatch from batch ${startIndex + 1}/${workerBatches.length}`, {
    workersTotal: workerBatches.length,
    workersDone: startIndex,
    resumedFromCheckpoint: true,
    forcedResume: force
  });

  // ── Strict wave boundary tracking (resume path) ──────────────────────────
  // Mirror the same wave-boundary gate used in the primary dispatch path.
  // Initialise from the wave of the last completed batch if we are resuming
  // mid-run, so the first crossing event accurately reflects the transition.
  let resumeCurrentWave: number | null = startIndex > 0
    ? (typeof (workerBatches[startIndex - 1] as any)?.wave === "number"
       ? (workerBatches[startIndex - 1] as any).wave : null)
    : null;

  for (let index = startIndex; index < workerBatches.length; index += 1) {
    const stopReq = await readStopRequest(config);
    if (stopReq?.requestedAt) {
      await appendProgress(config, `[RESUME] Stop requested — checkpoint preserved at batch ${index + 1}/${workerBatches.length}`);
      return true;
    }

    const batch = workerBatches[index];

    // ── Wave boundary gate (resume) ────────────────────────────────────────
    const resumeBatchWave = typeof (batch as any).wave === "number" ? (batch as any).wave : null;
    if (resumeBatchWave !== null && resumeBatchWave !== resumeCurrentWave) {
      if (resumeCurrentWave !== null) {
        await appendProgress(config,
          `[WAVE_BOUNDARY] Wave ${resumeCurrentWave} complete — all batches succeeded. Crossing to wave ${resumeBatchWave}.`
        );
      }
      resumeCurrentWave = resumeBatchWave;
      await appendProgress(config,
        `[WAVE_BOUNDARY] Starting wave ${resumeBatchWave} — batch ${index + 1}/${workerBatches.length}`
      );
    }

    await safeUpdatePipelineProgress(config, "workers_running", `Resumed worker batch ${index + 1}/${workerBatches.length}: ${batch.role}`, {
      workersTotal: workerBatches.length,
      workersDone: index,
      currentWorker: batch.role,
      resumedFromCheckpoint: true,
      forcedResume: force
    });

    let workerResult;
    let transientRetries = 0;
    for (;;) {
      try {
        workerResult = await dispatchWorker(config, batch);
      } catch (err) {
        const msg = String(err?.message || err).slice(0, 200);
        await appendProgress(config, `[RESUME] Worker ${batch.role} failed: ${msg}`);
        warn(`[orchestrator] resumed worker dispatch error: ${msg}`);
        workerResult = { roleName: batch.role, status: "error", summary: msg };
      }

      // Auto-retry on transient API errors with escalating cooldown
      const isTransient = String(workerResult?.status || "") === "transient_error";
      if (isTransient && transientRetries < MAX_TRANSIENT_RETRIES) {
        transientRetries++;
        const cooldownMs = transientRetries * 3 * 60 * 1000; // 3min, 6min, 9min
        await appendProgress(config,
          `[RESUME] Transient API error — retry ${transientRetries}/${MAX_TRANSIENT_RETRIES}, cooling down ${Math.round(cooldownMs / 1000)}s`
        );
        await sleep(cooldownMs);
        continue;
      }
      break;
    }

    if (!isDispatchOutcomeSuccessful(workerResult)) {
      await appendProgress(config,
        `[RESUME] Worker batch ${index + 1}/${workerBatches.length} ended with status=${workerResult?.status || "unknown"}; checkpoint not advanced so it can be retried`
      );
      return true;
    }

    await waitForWorkersToFinish(config);
    await updateDispatchCheckpointProgress(config, checkpoint, index + 1);

    // Inter-batch rate-limit cooldown to avoid transient API errors
    const resumeDelay = Number(config?.runtime?.interBatchDelayMs || 90000);
    if (index + 1 < workerBatches.length && resumeDelay > 0) {
      await appendProgress(config, `[RESUME] Inter-batch cooldown ${Math.round(resumeDelay / 1000)}s to avoid rate limits`);
      await sleep(resumeDelay);
    }
  }

  await completeDispatchCheckpoint(config, checkpoint);

  await safeUpdatePipelineProgress(config, "workers_finishing", "All resumed workers finishing up", {
    workersTotal: workerBatches.length,
    workersDone: workerBatches.length,
    resumedFromCheckpoint: true,
    forcedResume: force
  });

  await appendProgress(config, `[RESUME] Resumed dispatch complete — ${workerBatches.length} batch(es) processed`);
  await safeUpdatePipelineProgress(config, "cycle_complete", `Resumed cycle complete — ${workerBatches.length} batch(es)`, {
    workersTotal: workerBatches.length,
    workersDone: workerBatches.length,
    resumedFromCheckpoint: true,
    forcedResume: force
  });

  return true;
}

export async function runOnce(config) {
  const stateDir = config.paths?.stateDir || "state";
  await fs.mkdir(stateDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(stateDir, "live_worker_jesus.log"), "[leadership_live]\n[run_once] Jesus live log ready...\n", "utf8"),
    fs.writeFile(path.join(stateDir, "live_worker_athena.log"), "[leadership_live]\n[run_once] Athena live log ready...\n", "utf8"),
    initializeAggregateLiveLog(stateDir, "run_once")
  ]);

  await runSingleCycle(config);
}

export async function runResumeDispatch(config) {
  const stateDir = config.paths?.stateDir || "state";
  await fs.mkdir(stateDir, { recursive: true });
  await Promise.all([
    fs.writeFile(path.join(stateDir, "live_worker_jesus.log"), "[leadership_live]\n[resume] Jesus live log ready...\n", "utf8"),
    fs.writeFile(path.join(stateDir, "live_worker_athena.log"), "[leadership_live]\n[resume] Athena live log ready...\n", "utf8"),
    initializeAggregateLiveLog(stateDir, "resume")
  ]);

  const resumed = await tryResumeDispatchFromCheckpoint(config, { force: true });
  if (!resumed) {
    throw new Error("No resumable Step-4 checkpoint found (approved Athena review + plans required)");
  }
}

export async function runRebase(_config, _opts: Record<string, unknown> = {}) {
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

  for (const [role, session] of Object.entries(sessions || {}) as Array<[string, WorkerSessionRecord]>) {
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
    return (Object.values(sessions) as WorkerSessionRecord[]).some(s => s?.status === "working");
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
      const openPrsJson = await prsRes.json();
      const openPrs = Array.isArray(openPrsJson) ? openPrsJson as GithubPullRequestSummary[] : [];
      const mergedRes = await fetch(`${base}/pulls?state=closed&per_page=50&sort=updated&direction=desc`, { headers });
      const closedJson = mergedRes.ok ? await mergedRes.json() : [];
      const closedPrs = Array.isArray(closedJson) ? closedJson as GithubPullRequestSummary[] : [];
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
      const branchesJson = await branchesRes.json();
      const branches = Array.isArray(branchesJson) ? branchesJson as GithubBranchSummary[] : [];
      const openPrBranches = new Set();
      const openPrsRes = await fetch(`${base}/pulls?state=open&per_page=100`, { headers });
      if (openPrsRes.ok) {
        const opsJson = await openPrsRes.json();
        const ops = Array.isArray(opsJson) ? opsJson as GithubPullRequestSummary[] : [];
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

// ── Resolve logical plan role to actual worker agent ────────────────────────

const IMPLEMENTATION_WORKER = "evolution-worker";

// Roles that have agent files but lack implementation tools (read/edit/execute).
// Implementation tasks assigned to these roles must be redirected to evolution-worker.
const ANALYSIS_ONLY_ROLES = new Set(["athena", "prometheus", "jesus"]);

function resolveWorkerRole(logicalRole, taskKind) {
  const role = String(logicalRole || "").toLowerCase().trim();
  const kind = String(taskKind || "").toLowerCase();
  const isImplementation = !kind || kind === "implementation";

  // Analysis-only roles cannot execute implementation tasks — redirect to evolution-worker
  if (isImplementation && ANALYSIS_ONLY_ROLES.has(role)) return IMPLEMENTATION_WORKER;

  // If the role has a dedicated agent file with full tools, use it as-is
  const slug = nameToSlug(role);
  if (slug && agentFileExists(slug)) return logicalRole;

  // Fallback: all implementation tasks without a matching agent go to evolution-worker
  return IMPLEMENTATION_WORKER;
}

// ── Dispatch a single worker from a Prometheus plan item ───────────────────

async function dispatchWorker(config, plan) {
  // Resolve actual worker agent: plan.role is a logical category ("orchestrator", "athena", etc.).
  // Map roles without a dedicated .agent.md to "evolution-worker" for implementation tasks.
  const logicalRole = plan.role;
  const roleName = resolveWorkerRole(logicalRole, plan.taskKind || plan.kind || "implementation");
  const batchPlans = Array.isArray(plan?.plans) ? plan.plans : null;
  const task = batchPlans
    ? `Execute this bundled work package in a single worker session.\n${batchPlans.map((item, i) => `${i + 1}. ${String(item?.task || item?.title || "Untitled task")}`).join("\n")}`
    : plan.task;
  const context = batchPlans
    ? batchPlans.map((item, i) => {
        const taskLine = String(item?.task || item?.title || `Task ${i + 1}`);
        const ctxLine = String(item?.context || item?.scope || "").trim();
        return ctxLine ? `Task ${i + 1}: ${taskLine}\nContext: ${ctxLine}` : `Task ${i + 1}: ${taskLine}`;
      }).join("\n\n")
    : (plan.context || "");
  const verification = batchPlans
    ? batchPlans.map((item, i) => {
        const rule = String(item?.verification || "").trim();
        return rule ? `${i + 1}. ${rule}` : "";
      }).filter(Boolean).join("\n")
    : (plan.verification || "");

  const taskKind = plan.taskKind || plan.kind || "implementation";

  if (batchPlans) {
    const headline = String(batchPlans[0]?.task || batchPlans[0]?.title || "bundled tasks");
    await appendProgress(config, `[DISPATCH] Sending ${batchPlans.length} plan(s) to ${roleName}: ${headline}`);
  } else {
    await appendProgress(config, `[DISPATCH] Sending task to ${roleName}: ${task}`);
  }

  const result = await runWorkerConversation(config, roleName, {
    task,
    context,
    verification,
    taskKind
  });

  return {
    roleName,
    status: result?.status || "unknown",
    pr: result?.prUrl || null,
    summary: result?.summary || "",
    filesChanged: result?.filesTouched || "",
    raw: String(result?.fullOutput || "").slice(0, 3000),
    verificationEvidence: result?.verificationEvidence || null
  };
}

// ── Count completed plans from worker state files ─────────────────────────

async function countCompletedPlans(config, plans) {
  const stateDir = config.paths?.stateDir || "state";

  const checkpoint = await readJson(path.join(stateDir, DISPATCH_CHECKPOINT_FILE), null);
  if (checkpoint && Number(checkpoint.totalPlans || 0) === plans.length) {
    const completedCount = Math.max(0, Math.min(Number(checkpoint.completedPlans || 0), plans.length));
    return {
      completed: plans.slice(0, completedCount).map((plan) => ({ plan, workerState: null, lastLog: null })),
      pending: plans.slice(completedCount)
    };
  }

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

async function runSingleCycle(config) {
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
  await appendProgress(config, "[AGENT] JESUS ACTIVATED");

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
    await appendProgress(config, `[CYCLE] Jesus failed: ${String(err?.message || err)}`);
    warn(`[orchestrator] Jesus cycle error: ${String(err?.message || err)}`);
    return;
  }

  if (!jesusDecision || jesusDecision.wait === true) {
    await appendProgress(config, "[CYCLE] Jesus says: wait — nothing to do");
    return;
  }

  await safeUpdatePipelineProgress(config, "jesus_decided", "Jesus decision ready", {
    jesusDecision: typeof jesusDecision === "object" ? String(jesusDecision.thinking || "").slice(0, 200) : ""
  });

  // Step 2: Prometheus plans (single-prompt, no autopilot)
  await appendProgress(config, "[CYCLE] ── Step 2: Prometheus scanning & planning ──");
  await appendProgress(config, "[AGENT] PROMETHEUS ACTIVATED");
  await safeUpdatePipelineProgress(config, "prometheus_starting", "Prometheus starting repository scan");

  // ── Architecture drift check: run before Prometheus to surface stale refs ──
  let architectureDriftReport = null;
  try {
    const rootDir = config.paths?.repoRoot || process.cwd();
    architectureDriftReport = await checkArchitectureDrift({ rootDir });
    const unresolvedCount = (architectureDriftReport.staleCount || 0) + (architectureDriftReport.deprecatedTokenCount || 0);
    await appendProgress(config,
      `[DRIFT_CHECK] Architecture drift scan complete — staleRefs=${architectureDriftReport.staleCount} deprecatedTokens=${architectureDriftReport.deprecatedTokenCount} scannedDocs=${architectureDriftReport.scannedDocs.length}`
    );
    if (unresolvedCount > 0) {
      await appendProgress(config,
        `[DRIFT_CHECK] ${unresolvedCount} unresolved drift item(s) — injecting summary into Prometheus context`
      );
    }
  } catch (driftErr) {
    warn(`[orchestrator] Architecture drift check failed (non-fatal): ${String(driftErr?.message || driftErr)}`);
  }

  let prometheusAnalysis;
  try {
    await safeUpdatePipelineProgress(config, "prometheus_reading_repo", "Prometheus reading repository");
    prometheusAnalysis = await runPrometheusAnalysis(config, {
      prompt: jesusDecision.briefForPrometheus || jesusDecision.thinking || "Full repository analysis",
      requestedBy: "Jesus",
      driftReport: architectureDriftReport
    });
  } catch (err) {
    await appendProgress(config, `[CYCLE] Prometheus failed: ${String(err?.message || err)}`);
    warn(`[orchestrator] Prometheus analysis error: ${String(err?.message || err)}`);
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
    return;
  }

  // ── Baseline recovery mode ────────────────────────────────────────────────
  // When parserConfidence is below PARSER_CONFIDENCE_RECOVERY_THRESHOLD (0.9)
  // but above the hard-stop, enter advisory "baseline recovery" mode:
  //   - Persist structural/schema component metrics for trend analysis.
  //   - Emit progress + advisory alert so operators can see which components
  //     are dragging confidence below the recovery target.
  // Dispatch is NOT blocked here — the hard-stop gate above handles that.
  let baselineRecoveryRecord = null;
  if (parsedConfidence < PARSER_CONFIDENCE_RECOVERY_THRESHOLD) {
    try {
      const cycleIdForBaseline = (await readPipelineProgress(config))?.startedAt ?? null;
      baselineRecoveryRecord = computeBaselineRecoveryState(prometheusAnalysis, cycleIdForBaseline);
      await persistBaselineMetrics(config, baselineRecoveryRecord);
      const gapSummary = Object.entries(baselineRecoveryRecord.componentGap)
        .filter(([, gap]) => (gap as number) > 0)
        .map(([k, v]) => `${k}=${v}`)
        .join(" ");
      await appendProgress(config,
        `[CYCLE] Baseline recovery mode active — parserConfidence=${parsedConfidence} target=${PARSER_CONFIDENCE_RECOVERY_THRESHOLD}` +
        (gapSummary ? ` componentGaps=[${gapSummary}]` : "")
      );
      await appendAlert(config, {
        severity: ALERT_SEVERITY.MEDIUM,
        source: "orchestrator",
        title: "Baseline recovery mode — parser confidence below target",
        message: `parserConfidence=${parsedConfidence} target=${PARSER_CONFIDENCE_RECOVERY_THRESHOLD}. ` +
          `Component gaps: ${gapSummary || "none"}. ` +
          `Penalties: ${baselineRecoveryRecord.penalties.map(p => p.reason).join(", ") || "none"}.`
      });
    } catch (err) {
      warn(`[orchestrator] Baseline recovery metrics persist failed (non-fatal): ${String(err?.message || err)}`);
    }
  }

  // ── Dispatch strictness gate (replay harness regressions) ────────────────
  // Load the last persisted replay regression state and combine it with the
  // current baseline recovery record to determine how strictly dispatch should
  // behave.  This is fail-open: any error loading state is treated as no signal
  // (NORMAL strictness) so a missing corpus file never blocks legitimate work.
  //
  //   NORMAL   → proceed as usual
  //   ELEVATED → advisory log; dispatch continues
  //   STRICT   → warning alert; dispatch continues (caller may reduce concurrency)
  //   BLOCKED  → hard-stop: dispatch blocked, alert emitted, cycle exits
  try {
    const replayRegressionState = await loadReplayRegressionState(config);
    const strictnessResult = computeDispatchStrictness(replayRegressionState, baselineRecoveryRecord);

    if (strictnessResult.strictness !== DISPATCH_STRICTNESS.NORMAL) {
      await appendProgress(config,
        `[DISPATCH_STRICTNESS] level=${strictnessResult.strictness} regressionRate=${(strictnessResult.regressionRate * 100).toFixed(0)}% recoveryActive=${strictnessResult.recoveryActive} — ${strictnessResult.reason}`
      );
    }

    if (strictnessResult.strictness === DISPATCH_STRICTNESS.BLOCKED) {
      await appendAlert(config, {
        severity: ALERT_SEVERITY.CRITICAL,
        source: "orchestrator",
        title: "Dispatch blocked — replay harness regression rate exceeds threshold",
        message: strictnessResult.reason,
      });
      await safeUpdatePipelineProgress(config, "cycle_complete", `Dispatch blocked: ${strictnessResult.reason}`);
      return;
    }

    if (strictnessResult.strictness === DISPATCH_STRICTNESS.STRICT) {
      await appendAlert(config, {
        severity: ALERT_SEVERITY.HIGH,
        source: "orchestrator",
        title: "Strict dispatch mode — replay harness regressions detected",
        message: strictnessResult.reason,
      });
    } else if (strictnessResult.strictness === DISPATCH_STRICTNESS.ELEVATED) {
      await appendAlert(config, {
        severity: ALERT_SEVERITY.MEDIUM,
        source: "orchestrator",
        title: "Elevated dispatch mode — parser regressions or recovery active",
        message: strictnessResult.reason,
      });
    }
  } catch (err) {
    warn(`[orchestrator] Dispatch strictness gate failed (non-fatal): ${String(err?.message || err)}`);
  }

  await safeUpdatePipelineProgress(config, "prometheus_done", `Prometheus complete — ${prometheusAnalysis.plans.length} plan(s)`, {
    planCount: prometheusAnalysis.plans.length
  });

  // Step 3: Athena validates the plan (1 request)
  await appendProgress(config, "[CYCLE] ── Step 3: Athena reviewing plan ──");
  await appendProgress(config, "[AGENT] ATHENA ACTIVATED");
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

  if (!planReview.approved) {
    const rejectionReason = planReview.reason || { code: "PLAN_REJECTED", message: planReview.summary || "Rejected by Athena" };
    const correctionsList = planReview.corrections || [];
    await appendProgress(config, `[CYCLE] Athena REJECTED plan — code=${typeof rejectionReason === "object" ? rejectionReason.code : rejectionReason} corrections: ${correctionsList.join("; ")}`);
    emitEvent(EVENTS.PLANNING_PLAN_REJECTED, EVENT_DOMAIN.PLANNING, `plan-reject-${Date.now()}`, {
      code: typeof rejectionReason === "object" ? (rejectionReason as Record<string, unknown>).code : String(rejectionReason),
      corrections: correctionsList,
      summary: planReview.summary || ""
    });
    // Save rejection for Prometheus to read on next cycle
    await writeJson(path.join(stateDir, "athena_plan_rejection.json"), {
      rejectedAt: new Date().toISOString(),
      reason: rejectionReason,
      corrections: correctionsList,
      summary: planReview.summary || ""
    });
    return;
  }

  await safeUpdatePipelineProgress(config, "athena_approved", "Athena approved the plan");

  // Step 4: Dispatch workers sequentially (1 request per worker)
  const plans = Array.isArray(planReview.patchedPlans) && planReview.patchedPlans.length > 0
    ? planReview.patchedPlans
    : prometheusAnalysis.plans;

  // Funnel tracking: capture approved count before quality/freeze gates reduce plans.
  const funnelApprovedCount: number = plans.length;

  // ── Capability pool: assign workers based on task capability matching ──────
  let capabilityPoolResult = null;
  try {
    const poolResult = assignWorkersToPlans(plans, config);
    capabilityPoolResult = poolResult;
    if (poolResult.diversityIndex > 0) {
      await appendProgress(config, `[CAPABILITY_POOL] Worker diversity index: ${poolResult.diversityIndex} (0=single-worker, 1=fully diversified)`);
    }
    // Apply pool assignment — update plan.role to the capability-assigned role when it improves on the default.
    // _originalRole preserves the Prometheus-suggested role for audit; _capabilityLane tracks the lane.
    for (const { plan, selection } of poolResult.assignments) {
      if (!selection.isFallback && selection.role !== plan.role) {
        plan._originalRole = plan.role;
        plan.role = selection.role;
        plan._capabilityLane = selection.lane;
      } else {
        // Always stamp lane even for fallback selections so batch planner can use it.
        plan._capabilityLane = plan._capabilityLane || selection.lane;
      }
    }

    // ── Lane conflict detection ──────────────────────────────────────────────
    // Warn when plans within the same lane target overlapping files — these
    // should ideally run in separate waves to avoid concurrent write conflicts.
    const conflicts = detectLaneConflicts(poolResult.assignments);
    if (conflicts.length > 0) {
      await appendProgress(config,
        `[CAPABILITY_POOL] ${conflicts.length} lane conflict(s) detected — conflicting plans will be separated into distinct batches`
      );
      for (const c of conflicts) {
        warn(`[orchestrator] Lane conflict: lane="${c.lane}" plans="${c.plan1Task}" ↔ "${c.plan2Task}" share files: ${c.sharedFiles.join(", ")}`);
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
      // Collect indices with critical violations; sort descending to preserve splice indices
      const toRemove = contractReport.results
        .filter(r => !r.valid && r.violations.some(v => v.severity === "critical"))
        .map(r => r.planIndex)
        .sort((a, b) => b - a);
      for (const idx of toRemove) {
        const plan = plans[idx];
        warn(`[orchestrator] Plan "${String(plan?.task || "unknown").slice(0, 60)}" has critical contract violation(s) — removing from dispatch`);
        plans.splice(idx, 1);
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

  // ── Lane diversity gate (Packet 6) — hard admission control ──
  // Blocks dispatch when the active plan set spans fewer lanes than the
  // configured minimum. Only enforced when plans.length >= minLanes so
  // single-plan batches are not penalised for inherent monoculture.
  // Errors in the gate itself are fail-closed: they block dispatch.
  {
    const diversityMinLanes: number = config?.workerPool?.minLanes || 2;
    if (plans.length >= diversityMinLanes) {
      let diversityBlocked = false;
      let diversityMsg = "";
      try {
        const diversityPool = capabilityPoolResult || { activeLaneCount: 0, assignments: [] };
        const diversityResult = enforceLaneDiversity(diversityPool, { minLanes: diversityMinLanes });
        if (!diversityResult.meetsMinimum) {
          diversityBlocked = true;
          diversityMsg = diversityResult.warning;
        }
      } catch (err) {
        diversityBlocked = true;
        diversityMsg = `Lane diversity gate threw: ${String(err?.message || err)}`;
      }
      if (diversityBlocked) {
        await appendProgress(config, `[LANE_DIVERSITY] Hard gate: dispatch blocked — ${diversityMsg}`);
        await appendAlert(config, {
          severity: ALERT_SEVERITY.HIGH,
          source: "orchestrator",
          title: "Lane diversity gate blocked dispatch",
          message: diversityMsg,
        });
        warn(`[orchestrator] Lane diversity gate blocked dispatch: ${diversityMsg}`);
        return;
      }
    }
  }

  await appendProgress(config, `[CYCLE] ── Step 4: Dispatching ${plans.length} workers ──`);

  // Pre-dispatch governance gate: single decision source for guardrail pause,
  // governance freeze, dependency cycle detection, and governance canary breach.
  // Replaces the inline PAUSE_WORKERS check and adds canary + cycle guards.
  {
    const cycleId = `cycle-${Date.now()}`;
    try {
      const gateDecision = await evaluatePreDispatchGovernanceGate(config, plans, cycleId, architectureDriftReport);
      emitEvent(EVENTS.GOVERNANCE_GATE_EVALUATED, EVENT_DOMAIN.GOVERNANCE, cycleId, {
        blocked: gateDecision.blocked,
        reason: gateDecision.reason || null,
        inputSnapshot: { planCount: plans.length, cycleId }
      });
      if (gateDecision.blocked) {
        const reasonMsg = gateDecision.reason || "pre_dispatch_gate_blocked";
        await appendProgress(config,
          `[CYCLE] Pre-dispatch governance gate blocked dispatch — reason=${reasonMsg}`
        );
        await appendAlert(config, {
          severity: ALERT_SEVERITY.HIGH,
          source: "orchestrator",
          title: "Worker dispatch blocked by pre-dispatch governance gate",
          message: `reason=${reasonMsg} action=${gateDecision.action || "none"} cycleId=${cycleId}`
        });
        return;
      }
    } catch (err) {
      warn(`[orchestrator] Pre-dispatch governance gate failed (non-fatal): ${String(err?.message || err)}`);
      emitEvent(EVENTS.ORCHESTRATION_HEALTH_DEGRADED, EVENT_DOMAIN.ORCHESTRATION, cycleId, {
        reason: "governance_gate_exception",
        error: String(err?.message || err),
        context: "cycle_dispatch"
      });
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

  // Funnel tracking: capture dispatched count after all quality/freeze gates.
  const funnelDispatchedCount: number = plans.length;

  // ── Optimizer budget admission gate ──────────────────────────────────────
  // The intervention optimizer ranks plans by expected value and enforces all
  // three budget constraints (total, per-wave, per-role) simultaneously.
  // Its selected[] output is the authoritative set of plans admitted to dispatch.
  // Fail-open when the optimizer cannot run (invalid budget config, empty input,
  // or any exception) so a missing budget configuration never halts work.
  if (config?.runtime?.disableOptimizerAdmission !== true) {
    try {
      const interventions = buildInterventionsFromPlan(plans, config);
      const budgetInput = buildBudgetFromConfig(prometheusAnalysis?.requestBudget, config);
      const optimizerResult = runInterventionOptimizer(interventions, budgetInput);

      // Persist for observability regardless of outcome
      await persistOptimizerLog(stateDir, optimizerResult).catch(() => {});

      if (
        optimizerResult.status !== OPTIMIZER_STATUS.INVALID_INPUT &&
        optimizerResult.status !== OPTIMIZER_STATUS.EMPTY_INPUT
      ) {
        const admittedIds = new Set(optimizerResult.selected.map((i: any) => i.id));
        const admittedPlans = plans.filter((plan: any, idx: number) => {
          const interventionId = String(plan?.id ?? `plan-${idx + 1}`);
          return admittedIds.has(interventionId);
        });

        if (admittedPlans.length < plans.length) {
          const rejectedCount = plans.length - admittedPlans.length;
          await appendProgress(config,
            `[OPTIMIZER] Budget admission: ${admittedPlans.length}/${plans.length} plan(s) admitted — ${rejectedCount} rejected (status=${optimizerResult.status} reason=${optimizerResult.reasonCode})`
          );
          plans.splice(0, plans.length, ...admittedPlans);
          if (plans.length === 0) {
            await appendProgress(config, "[CYCLE] All plans rejected by optimizer budget gate — cycle complete");
            await safeUpdatePipelineProgress(config, "cycle_complete", "All plans rejected by optimizer budget gate");
            return;
          }
        } else {
          await appendProgress(config,
            `[OPTIMIZER] Budget admission: all ${plans.length} plan(s) admitted (status=${optimizerResult.status})`
          );
        }
      }
    } catch (err) {
      warn(`[orchestrator] Optimizer admission gate failed (non-fatal): ${String(err?.message || err)}`);
    }
  }

  const workerBatches = buildRoleExecutionBatches(plans, config, capabilityPoolResult);
  await safeUpdatePipelineProgress(config, "workers_dispatching", `Dispatching ${workerBatches.length} worker batch(es)`, {
    workersTotal: workerBatches.length,
    workersDone: 0
  });

  const dispatchCheckpoint = await beginDispatchCheckpoint(config, workerBatches);
  let workersDone = 0;
  const allWorkerResults: Array<{ roleName: string; status: string }> = [];
  // Collects (taskText, verificationEvidence) from successful workers for
  // carry-forward auto-close matching at end of cycle.
  const resolvedPlanItems: Array<{ taskText: string; verificationEvidence: string }> = [];

  // ── Strict wave boundary tracking ──────────────────────────────────────────
  // Each time the wave number changes, we log an explicit boundary event.
  // Reaching a new wave boundary in the loop guarantees all preceding wave's
  // batches completed successfully (the loop returns early on any failure),
  // giving a hard sequential barrier between waves.
  let currentDispatchWave: number | null = null;

  for (const batch of workerBatches) {
    const stopReq = await readStopRequest(config);
    if (stopReq?.requestedAt) {
      await appendProgress(config, `[CYCLE] Stop requested — halting dispatch`);
      return;
    }

    // ── Wave boundary gate ───────────────────────────────────────────────────
    // Detect wave transitions. Arrival here proves all prior-wave batches done.
    const batchWave = typeof (batch as any).wave === "number" ? (batch as any).wave : null;
    if (batchWave !== null && batchWave !== currentDispatchWave) {
      if (currentDispatchWave !== null) {
        await appendProgress(config,
          `[WAVE_BOUNDARY] Wave ${currentDispatchWave} complete — all batches succeeded. Crossing to wave ${batchWave}.`
        );
      }
      currentDispatchWave = batchWave;
      await appendProgress(config,
        `[WAVE_BOUNDARY] Starting wave ${batchWave} — batch ${workersDone + 1}/${workerBatches.length}`
      );
    }

    await safeUpdatePipelineProgress(config, "workers_running", `Running worker batch ${workersDone + 1}/${workerBatches.length}: ${batch.role}`, {
      workersTotal: workerBatches.length,
      workersDone,
      currentWorker: batch.role
    });
    await appendProgress(config, `[WORKER_BATCH] BATCH ${workersDone + 1}/${workerBatches.length} STARTED role=${batch.role}`);

    let workerResult;
    let transientRetries = 0;
    for (;;) {
      try {
        workerResult = await dispatchWorker(config, batch);
      } catch (err) {
        const msg = String(err?.message || err).slice(0, 200);
        await appendProgress(config, `[CYCLE] Worker ${batch.role} failed: ${msg}`);
        warn(`[orchestrator] worker dispatch error: ${msg}`);
        workerResult = { roleName: batch.role, status: "error", summary: msg };
      }

      // Auto-retry on transient API errors with escalating cooldown
      const isTransient = String(workerResult?.status || "") === "transient_error";
      if (isTransient && transientRetries < MAX_TRANSIENT_RETRIES) {
        transientRetries++;
        const cooldownMs = transientRetries * 3 * 60 * 1000;
        await appendProgress(config,
          `[CYCLE] Transient API error — retry ${transientRetries}/${MAX_TRANSIENT_RETRIES}, cooling down ${Math.round(cooldownMs / 1000)}s`
        );
        await sleep(cooldownMs);
        continue;
      }
      break;
    }

    if (!isDispatchOutcomeSuccessful(workerResult)) {
      await appendProgress(config,
        `[CYCLE] Worker batch ${workersDone + 1}/${workerBatches.length} ended with status=${workerResult?.status || "unknown"}; checkpoint not advanced so it can be retried`
      );
      return;
    }

    workersDone += 1;
    allWorkerResults.push({ roleName: batch.role, status: String(workerResult?.status || "unknown") });

    // Collect plan tasks with verification evidence for carry-forward auto-close.
    // Only plans from successful batches with real evidence qualify.
    if (workerResult?.verificationEvidence) {
      const batchPlansList = Array.isArray((batch as any).plans) ? (batch as any).plans : [];
      for (const plan of batchPlansList) {
        const taskText = String((plan as any)?.task || "").trim();
        if (taskText.length >= 10) {
          resolvedPlanItems.push({
            taskText,
            verificationEvidence: String(workerResult.verificationEvidence),
          });
        }
      }
    }

    await appendProgress(config, `[WORKER_BATCH] BATCH ${workersDone}/${workerBatches.length} DONE role=${batch.role} status=${workerResult?.status || "unknown"}`);
    await updateDispatchCheckpointProgress(config, dispatchCheckpoint, workersDone);
    await waitForWorkersToFinish(config);

    // Inter-batch rate-limit cooldown to avoid transient API errors
    const cycleDelay = Number(config?.runtime?.interBatchDelayMs || 90000);
    if (workersDone < workerBatches.length && cycleDelay > 0) {
      await appendProgress(config, `[CYCLE] Inter-batch cooldown ${Math.round(cycleDelay / 1000)}s to avoid rate limits`);
      await sleep(cycleDelay);
    }
  }

  await completeDispatchCheckpoint(config, dispatchCheckpoint);

  await safeUpdatePipelineProgress(config, "workers_finishing", "All workers finishing up", {
    workersTotal: workerBatches.length,
    workersDone: workerBatches.length
  });

  await appendProgress(config, "[CYCLE] ── All workers dispatched — cycle complete ──");
  await appendProgress(config, `[RUN] RUN DONE — ${workerBatches.length} batch(es) completed`);
  await safeUpdatePipelineProgress(config, "cycle_complete", `Cycle complete — ${workerBatches.length} worker batch(es) processed`, {
    workersTotal: workerBatches.length,
    workersDone: workerBatches.length
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
      workerResults: allWorkerResults.length > 0 ? allWorkerResults : null,
      planCount: Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans.length : null,
      phase: CYCLE_PHASE.COMPLETED,
      parserBaselineRecovery: baselineRecoveryRecord ?? null,
      funnelCounts: {
        generated:  Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans.length : null,
        approved:   funnelApprovedCount,
        dispatched: funnelDispatchedCount,
        completed:  allWorkerResults.filter(r => r.status === "done" || r.status === "success").length,
      },
    });
    await persistCycleAnalytics(config, analyticsRecord);

    // ── Health channel: degrade signals only, separate from KPI semantics ──
    // cycle_health.json changes only when the system genuinely degrades,
    // not when metric definitions change (dual-channel contract).
    const healthRecord = computeCycleHealth(analyticsRecord);
    await persistCycleHealth(config, healthRecord);

    await appendProgress(config, `[ANALYTICS] Cycle analytics written — confidence=${analyticsRecord.confidence.level} sloStatus=${analyticsRecord.kpis.sloStatus} phase=${analyticsRecord.phase} health=${healthRecord.healthScore}`);
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

  // ── Carry-forward debt accumulation: register postmortem follow-ups as debt ──
  // Scans the latest postmortems for follow-up tasks and upserts them into the
  // carry-forward ledger.  Also advances the cycle counter so that SLA deadlines
  // stay anchored to a monotonic sequence across cycles.
  try {
    const postmortemsRaw3 = await readJson(path.join(stateDir, "athena_postmortems.json"), null);
    const pmEntries3 = Array.isArray(postmortemsRaw3?.entries) ? postmortemsRaw3.entries : [];
    const followUpItems = pmEntries3
      .filter(e => e.followUpNeeded && e.followUpTask)
      .map(e => ({
        followUpTask: String(e.followUpTask),
        workerName: e.workerName || undefined,
        severity: e.severity || "warning",
      }));

    const { entries: debtLedger, cycleCounter } = await loadLedgerMeta(config);
    const slaOpts = config?.carryForward?.slaMaxCycles
      ? { slaMaxCycles: config.carryForward.slaMaxCycles }
      : undefined;
    const updatedLedger = followUpItems.length > 0
      ? addDebtEntries(debtLedger, followUpItems, cycleCounter, slaOpts)
      : debtLedger;

    // Auto-close debt items verified by worker evidence this cycle.
    // Only items with a fingerprint match AND non-trivial evidence are closed.
    // Unresolved items remain open and continue to gate future dispatch via
    // shouldBlockOnDebt in evaluatePreDispatchGovernanceGate.
    const closedByEvidence = autoCloseVerifiedDebt(updatedLedger, resolvedPlanItems);
    if (closedByEvidence > 0) {
      await appendProgress(config,
        `[CARRY_FORWARD] ${closedByEvidence} debt item(s) auto-closed by worker verification evidence`
      );
    }

    const newCycleCounter = cycleCounter + 1;
    await saveLedgerFull(config, updatedLedger, newCycleCounter);

    if (followUpItems.length > 0) {
      const added = updatedLedger.length - debtLedger.length;
      await appendProgress(config,
        `[CARRY_FORWARD] ${added} new debt item(s) registered — cycle=${cycleCounter} total_open=${updatedLedger.filter(e => !e.closedAt).length}`
      );
    }
  } catch (err) {
    warn(`[orchestrator] Carry-forward debt accumulation failed (non-fatal): ${String(err?.message || err)}`);
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
      workersDone: workersDone,
    });
  } catch (err) {
    warn(`[orchestrator] Capacity scoreboard update failed (non-fatal): ${String(err?.message || err)}`);
  }

  // ── Health divergence: publish deterministic cycle health resolution ──────
  // Compares operational health (orchestrator_health.json) with planner health
  // (prometheusAnalysis.projectHealth) and resolves any disagreement into an
  // explicit warning state written to state/cycle_health.json.
  // Advisory — never blocks orchestration.
  try {
    const plannerHealth = prometheusAnalysis?.projectHealth ?? "unknown";
    const healthFile = await readJson(path.join(stateDir, "orchestrator_health.json"), null);
    const operationalStatus = healthFile?.orchestratorStatus ?? ORCHESTRATOR_STATUS.OPERATIONAL;
    const divergence = computeHealthDivergence(operationalStatus, plannerHealth);
    await writeJson(path.join(stateDir, "cycle_health.json"), {
      ...divergence,
      recordedAt: new Date().toISOString(),
    });
    if (divergence.isWarning) {
      await appendProgress(config,
        `[HEALTH] Divergence detected — divergenceState=${divergence.divergenceState} pipelineStatus=${divergence.pipelineStatus} operationalStatus=${operationalStatus} plannerHealth=${plannerHealth}`
      );
      await appendAlert(config, {
        severity: divergence.pipelineStatus === PIPELINE_HEALTH_STATUS.CRITICAL ? ALERT_SEVERITY.CRITICAL : ALERT_SEVERITY.HIGH,
        source: "orchestrator",
        title: `Health divergence: ${divergence.divergenceState}`,
        message: `pipelineStatus=${divergence.pipelineStatus} operationalStatus=${operationalStatus} plannerHealth=${plannerHealth}`,
      });
    } else {
      await appendProgress(config,
        `[HEALTH] Cycle health consistent — pipelineStatus=${divergence.pipelineStatus} divergenceState=${divergence.divergenceState}`
      );
    }
  } catch (err) {
    warn(`[orchestrator] Health divergence check failed (non-fatal): ${String(err?.message || err)}`);
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
        await runSingleCycle(config);
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
        await runSingleCycle(config);
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

      try {
        const stateDir = config.paths?.stateDir || "state";
        const siGate = await shouldTriggerSelfImprovement(config, stateDir);
        if (siGate.shouldRun) {
          await appendProgress(config, `[SELF-IMPROVEMENT] Quality gate passed: ${siGate.reason}`);
          await runSelfImprovementCycle(config);
          // Reset cycle counter
          await writeJson(path.join(stateDir, "self_improvement_state.json"), {
            lastRunAt: new Date().toISOString(),
            cyclesSinceLastRun: 0
          });
        } else {
          await appendProgress(config, `[SELF-IMPROVEMENT] Skipped (quality gate): ${siGate.reason}`);
          // Increment cycle counter
          const siState = await readJson(path.join(stateDir, "self_improvement_state.json"), {});
          await writeJson(path.join(stateDir, "self_improvement_state.json"), {
            ...siState,
            cyclesSinceLastRun: (siState.cyclesSinceLastRun || 0) + 1
          });
        }
      } catch (err) {
        warn(`[orchestrator] self-improvement error: ${String(err?.message || err)}`);
      }

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

      // Start a new Prometheus cycle to find new work
      await appendProgress(config, "[LOOP] Post-completion done — running Prometheus for next iteration");
      await runSingleCycle(config);
    } else {
      // No plans at all — first run or fresh start
      await runSingleCycle(config);
    }

    await safeUpdatePipelineProgress(config, "idle", "Cycle complete — waiting before next iteration");
    await sleep(RE_EVAL_SLEEP_MS);
  }
}
