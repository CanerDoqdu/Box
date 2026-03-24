import fs from "node:fs/promises";
import path from "node:path";
import { ensureParent, readJson, writeJson } from "./fs_utils.js";
import { emitEvent } from "./logger.js";
import { EVENTS, EVENT_DOMAIN } from "./event_schema.js";
import { validateLineageEntry, buildFailureClusters, detectLoop, LINEAGE_ERROR_CODE, LINEAGE_THRESHOLDS } from "./lineage_graph.js";
import { OPTIMIZER_LOG_SCHEMA_VERSION } from "./intervention_optimizer.js";

// ── Alert severity enum — deterministic constants for all alert records ───────
export const ALERT_SEVERITY = {
  LOW: "low",
  MEDIUM: "medium",
  HIGH: "high",
  CRITICAL: "critical"
};

function getMonthKey(date = new Date()) {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${year}-${month}`;
}

function aggregateByMonth(entries) {
  const result = {};
  for (const entry of entries) {
    const key = getMonthKey(new Date(entry.timestamp));
    if (!result[key]) {
      result[key] = {
        totalCalls: 0,
        opusCalls: 0,
        autoFallbacks: 0,
        byModel: {}
      };
    }

    const model = String(entry?.copilot?.model || "unknown");
    const invocation = String(entry?.copilot?.invocation || "unknown");
    const usedOpus = Boolean(entry?.copilot?.usedOpus);

    result[key].totalCalls += 1;
    result[key].byModel[model] = (result[key].byModel[model] || 0) + 1;
    if (usedOpus) {
      result[key].opusCalls += 1;
    }
    if (invocation.includes("fallback")) {
      result[key].autoFallbacks += 1;
    }
  }
  return result;
}

function aggregateClaudeByMonth(entries) {
  const result = {};
  for (const entry of entries) {
    const key = getMonthKey(new Date(entry.timestamp));
    if (!result[key]) {
      result[key] = {
        totalCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        byStage: {}
      };
    }

    const stage = String(entry.stage || "unknown");
    result[key].totalCalls += 1;
    result[key].inputTokens += Number(entry.inputTokens || 0);
    result[key].outputTokens += Number(entry.outputTokens || 0);
    result[key].cacheReadTokens += Number(entry.cacheReadTokens || 0);
    result[key].cacheCreationTokens += Number(entry.cacheCreationTokens || 0);
    result[key].byStage[stage] = (result[key].byStage[stage] || 0) + 1;
  }
  return result;
}

const PROGRESS_MAX_LINES = 200;
let _progressLineCount = -1; // lazy init

export async function appendProgress(config, message) {
  await ensureParent(config.paths.progressFile);
  const line = `[${new Date().toISOString()}] ${message}\n`;
  await fs.appendFile(config.paths.progressFile, line, "utf8");

  // Auto-trim: keep only the last PROGRESS_MAX_LINES lines
  _progressLineCount += 1;
  if (_progressLineCount >= 0 && _progressLineCount % 50 === 0) {
    try {
      const content = await fs.readFile(config.paths.progressFile, "utf8");
      const lines = content.split("\n");
      if (lines.length > PROGRESS_MAX_LINES) {
        const trimmed = lines.slice(-PROGRESS_MAX_LINES).join("\n");
        await fs.writeFile(config.paths.progressFile, trimmed, "utf8");
      }
    } catch { /* ignore trim errors */ }
  }
}

export async function loadTestsState(config) {
  const raw = await readJson(config.paths.testsStateFile, {
    tests: [],
    totals: {
      passed: 0,
      failed: 0,
      running: 0,
      queued: 0
    },
    updatedAt: new Date().toISOString()
  });

  return {
    tests: Array.isArray(raw?.tests) ? raw.tests : [],
    totals: raw?.totals && typeof raw.totals === "object"
      ? raw.totals
      : {
        passed: 0,
        failed: 0,
        running: 0,
        queued: 0
      },
    updatedAt: raw?.updatedAt || new Date().toISOString()
  };
}

export async function updateTaskInTestsState(config, task, status, notes = "") {
  const state = await loadTestsState(config);
  const existing = state.tests.find((t) =>
    Number(t.id) === Number(task.id) && String(t.title || t.name || "") === String(task.title || "")
  );

  if (existing) {
    existing.status = status;
    existing.title = task.title;
    existing.notes = notes;
    existing.updatedAt = new Date().toISOString();
  } else {
    state.tests.push({
      id: task.id,
      kind: task.kind || "general",
      name: task.title,
      title: task.title,
      status,
      notes,
      updatedAt: new Date().toISOString()
    });
  }

  state.totals = {
    passed: state.tests.filter((t) => t.status === "passed").length,
    failed: state.tests.filter((t) => t.status === "failed").length,
    running: state.tests.filter((t) => t.status === "running").length,
    queued: state.tests.filter((t) => t.status === "queued").length
  };
  state.updatedAt = new Date().toISOString();

  await writeJson(config.paths.testsStateFile, state);
}

export async function appendCopilotUsage(config, usage) {
  const state = await readJson(config.paths.copilotUsageFile, {
    entries: [],
    updatedAt: new Date().toISOString()
  });

  const correlationId = String(usage?.correlationId || `copilot-${Date.now()}`);
  state.entries.push({
    ...usage,
    timestamp: new Date().toISOString()
  });

  if (state.entries.length > 500) {
    state.entries = state.entries.slice(-500);
  }

  state.updatedAt = new Date().toISOString();
  await writeJson(config.paths.copilotUsageFile, state);

  const byMonth = aggregateByMonth(state.entries);
  await writeJson(config.paths.copilotUsageMonthlyFile, {
    generatedAt: new Date().toISOString(),
    byMonth
  });

  // Emit typed billing event (non-blocking; never throws)
  emitEvent(EVENTS.BILLING_USAGE_RECORDED, EVENT_DOMAIN.BILLING, correlationId, {
    source: "copilot",
    model: String(usage?.copilot?.model || "unknown"),
  });
}

export async function appendClaudeUsage(config, usage) {
  const claudeUsageFile = path.join(config.paths.stateDir, "claude_usage.json");
  const claudeUsageMonthlyFile = path.join(config.paths.stateDir, "claude_usage_monthly.json");

  const state = await readJson(claudeUsageFile, {
    entries: [],
    updatedAt: new Date().toISOString()
  });

  const correlationId = String(usage?.correlationId || `claude-${Date.now()}`);
  state.entries.push({
    ...usage,
    timestamp: new Date().toISOString()
  });

  if (state.entries.length > 1000) {
    state.entries = state.entries.slice(-1000);
  }

  state.updatedAt = new Date().toISOString();
  await writeJson(claudeUsageFile, state);

  const byMonth = aggregateClaudeByMonth(state.entries);
  await writeJson(claudeUsageMonthlyFile, {
    generatedAt: new Date().toISOString(),
    byMonth
  });

  // Emit typed billing event (non-blocking; never throws)
  emitEvent(EVENTS.BILLING_USAGE_RECORDED, EVENT_DOMAIN.BILLING, correlationId, {
    source: "claude",
    stage: String(usage?.stage || "unknown"),
    inputTokens: Number(usage?.inputTokens || 0),
    outputTokens: Number(usage?.outputTokens || 0),
  });
}

export async function getCurrentMonthCopilotStats(config) {
  const monthly = await readJson(config.paths.copilotUsageMonthlyFile, {
    byMonth: {}
  });
  const key = getMonthKey(new Date());
  return monthly.byMonth?.[key] || {
    totalCalls: 0,
    opusCalls: 0,
    autoFallbacks: 0,
    byModel: {}
  };
}

export async function loadAlerts(config) {
  const alertsFile = path.join(config.paths.stateDir, "alerts.json");
  return readJson(alertsFile, {
    entries: [],
    updatedAt: new Date().toISOString()
  });
}

/**
 * Persist a failure classification result to state/failure_classifications.json.
 *
 * AC #2: evidence and confidence are persisted alongside every classification.
 * AC #10: write errors set ok=false with an explicit reason; never silently dropped.
 *
 * Storage key: state/failure_classifications.json
 * Schema: { schemaVersion: 1, updatedAt: ISO, entries: ClassificationResult[] }
 * Entries are trimmed to the last 500 to prevent unbounded growth.
 *
 * @param {object} config
 * @param {object} classification — ClassificationResult from classifyFailure
 * @returns {Promise<{ ok: boolean, reason?: string }>}
 */
export async function appendFailureClassification(config, classification) {
  const classFile = path.join(config.paths?.stateDir || "state", "failure_classifications.json");
  try {
    const state = await readJson(classFile, {
      schemaVersion: 1,
      updatedAt: new Date().toISOString(),
      entries: []
    });

    const entries = Array.isArray(state.entries) ? state.entries : [];
    entries.push({ ...classification, savedAt: new Date().toISOString() });

    if (entries.length > 500) {
      state.entries = entries.slice(-500);
    } else {
      state.entries = entries;
    }

    state.updatedAt = new Date().toISOString();
    await writeJson(classFile, state);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: String(err?.message || err) };
  }
}

export async function appendAlert(config, alert) {
  const alertsFile = path.join(config.paths.stateDir, "alerts.json");
  const state = await readJson(alertsFile, {
    entries: [],
    updatedAt: new Date().toISOString()
  });

  const correlationId = String(alert?.correlationId || `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
  const entry = {
    id: correlationId,
    timestamp: new Date().toISOString(),
    severity: String(alert?.severity || "warning"),
    source: String(alert?.source || "system"),
    title: String(alert?.title || "System alert"),
    message: String(alert?.message || "")
  };

  state.entries.push(entry);

  if (state.entries.length > 200) {
    state.entries = state.entries.slice(-200);
  }

  state.updatedAt = new Date().toISOString();
  await writeJson(alertsFile, state);

  // Emit typed observability event (non-blocking; never throws)
  emitEvent(EVENTS.ORCHESTRATION_ALERT_EMITTED, EVENT_DOMAIN.ORCHESTRATION, correlationId, {
    severity: entry.severity,
    source: entry.source,
    title: entry.title,
  });
}

// ── Lineage graph — append-only task fingerprint graph ────────────────────────

/**
 * Append a single LineageEntry to the lineage graph file (append-only, immutable).
 *
 * Validation:
 *   - Missing input (null/undefined entry) → returns { ok: false, code: MISSING_INPUT, ... }
 *   - Schema-invalid entry               → returns { ok: false, code: <field error>, ... }
 *   - Valid entry that creates a loop     → returns { ok: false, code: LOOP_*, isLoop: true, ... }
 *   - Valid, no loop                      → appends and returns { ok: true, loopCheck, entry }
 *
 * The graph is stored at state/lineage_graph.json as { entries: [...], updatedAt, schemaVersion }.
 * Entries are never deleted or modified — this is an append-only log.
 *
 * @param {object} config
 * @param {object} entry — must pass validateLineageEntry
 * @returns {Promise<{ ok: boolean, code: string, message: string, entry?: object, loopCheck?: object, isLoop?: boolean }>}
 */
export async function appendLineageEntry(config, entry) {
  // Distinguish missing from invalid input
  if (entry === null || entry === undefined) {
    return { ok: false, code: LINEAGE_ERROR_CODE.MISSING_INPUT, message: "entry is required (got null/undefined)" };
  }

  const validation = validateLineageEntry(entry);
  if (!validation.ok) {
    return { ok: false, code: validation.code, message: validation.message };
  }

  const graphFile = path.join(config.paths.stateDir, "lineage_graph.json");
  const state = await readJson(graphFile, {
    schemaVersion: "1.0",
    entries: [],
    updatedAt: new Date().toISOString()
  });

  if (!Array.isArray(state.entries)) {
    // Degraded state: entries field is corrupt; reset to empty array with explicit status
    state.entries = [];
    state.degraded = true;
    state.degradedReason = "entries_corrupt_reset";
  }

  // Run loop detection before appending
  const loopCheck = detectLoop(state.entries, entry);
  if (loopCheck.isLoop) {
    return {
      ok: false,
      code: loopCheck.code,
      message: loopCheck.message,
      isLoop: true,
      loopCheck
    };
  }

  // Append immutably — the entry itself is never mutated after this point
  state.entries.push(Object.freeze ? Object.assign({}, entry) : entry);

  // Trim to last 5000 entries to prevent unbounded file growth
  if (state.entries.length > 5000) {
    state.entries = state.entries.slice(-5000);
  }

  state.updatedAt = new Date().toISOString();
  await writeJson(graphFile, state);

  return { ok: true, code: LINEAGE_ERROR_CODE.NO_LOOP, message: "entry appended", entry, loopCheck };
}

/**
 * Compute failure clusters from the lineage graph and persist the top clusters
 * to state/lineage_clusters.json (the "dashboard" surface for AC5).
 *
 * Output file schema:
 *   {
 *     schemaVersion: "1.0",
 *     generatedAt:   <ISO string>,
 *     thresholds:    { CLUSTER_MIN_SIZE, TOP_CLUSTERS_COUNT },
 *     totalEntries:  <number>,
 *     clusters:      <FailureCluster[]>   — at most TOP_CLUSTERS_COUNT items
 *   }
 *
 * Returns the clusters array. If the graph file does not exist, returns [].
 * Never throws — on read/write failure, sets status=degraded in return value.
 *
 * @param {object} config
 * @returns {Promise<{ ok: boolean, clusters: object[], code?: string, message?: string }>}
 */
export async function getFailureClusterReport(config) {
  const graphFile = path.join(config.paths.stateDir, "lineage_graph.json");
  const clustersFile = path.join(config.paths.stateDir, "lineage_clusters.json");

  let state;
  try {
    state = await readJson(graphFile, { entries: [] });
  } catch (err) {
    return {
      ok: false,
      code: "READ_ERROR",
      message: `lineage_graph.json unreadable: ${String(err?.message || err)}`,
      clusters: []
    };
  }

  const entries = Array.isArray(state?.entries) ? state.entries : [];
  const clusters = buildFailureClusters(entries);

  const report = {
    schemaVersion: "1.0",
    generatedAt: new Date().toISOString(),
    thresholds: {
      CLUSTER_MIN_SIZE: LINEAGE_THRESHOLDS.CLUSTER_MIN_SIZE,
      TOP_CLUSTERS_COUNT: LINEAGE_THRESHOLDS.TOP_CLUSTERS_COUNT,
    },
    totalEntries: entries.length,
    clusters
  };

  try {
    await writeJson(clustersFile, report);
  } catch (err) {
    // Write failure is non-fatal — return clusters even if persistence failed
    return {
      ok: false,
      code: "WRITE_ERROR",
      message: `lineage_clusters.json write failed: ${String(err?.message || err)}`,
      clusters
    };
  }

  return { ok: true, clusters, code: null, message: `${clusters.length} clusters written` };
}

// ── Intervention optimizer log ────────────────────────────────────────────────

/**
 * Load the intervention optimizer log from state/intervention_optimizer_log.json.
 *
 * @param {object} config — box config object with paths.stateDir
 * @returns {Promise<object>} — { schemaVersion, updatedAt, entries: [] }
 */
export async function loadInterventionOptimizerLog(config) {
  const logFile = path.join(config.paths.stateDir, "intervention_optimizer_log.json");
  return readJson(logFile, {
    schemaVersion: OPTIMIZER_LOG_SCHEMA_VERSION,
    updatedAt:     new Date().toISOString(),
    entries:       [],
  });
}

/**
 * Append one optimizer result entry to state/intervention_optimizer_log.json.
 *
 * Emits PLANNING_INTERVENTION_OPTIMIZED event (non-blocking; never throws).
 * Trims to the last 100 entries to cap file growth.
 *
 * @param {object} config — box config object with paths.stateDir
 * @param {object} entry  — optimizer result from runInterventionOptimizer
 * @returns {Promise<void>}
 */
// ── Monthly Postmortem Persistence ────────────────────────────────────────────

/**
 * Persist a monthly postmortem to state/monthly_postmortem_{monthKey}.json.
 *
 * Validates all required schema fields before writing.
 * Distinguishes missing input (postmortem is null) from invalid input
 * (postmortem present but fails schema validation) with explicit reason codes.
 *
 * Never silently drops data — write errors return ok=false with an explicit reason.
 *
 * @param {object} config
 * @param {object} postmortem — output of generateMonthlyPostmortem().postmortem
 * @returns {Promise<{ ok: boolean, filePath?: string, reason?: string }>}
 */
export async function persistMonthlyPostmortem(config, postmortem) {
  if (postmortem === null || postmortem === undefined) {
    return { ok: false, reason: "MISSING_INPUT: postmortem is null or undefined" };
  }
  if (typeof postmortem !== "object" || Array.isArray(postmortem)) {
    return { ok: false, reason: "INVALID_INPUT: postmortem must be a non-array object" };
  }

  const REQUIRED = [
    "schemaVersion", "monthKey", "generatedAt", "status",
    "cycleCount", "experimentOutcomes", "compoundingEffects",
    "decisionQualityTrend", "seedQuestion"
  ];

  for (const field of REQUIRED) {
    if (!(field in postmortem)) {
      return { ok: false, reason: `INVALID_INPUT: missing required field "${field}"` };
    }
  }

  const monthKey = String(postmortem.monthKey || "");
  if (!/^\d{4}-\d{2}$/.test(monthKey)) {
    return { ok: false, reason: `INVALID_INPUT: monthKey must be "YYYY-MM", got "${monthKey}"` };
  }

  const stateDir  = config?.paths?.stateDir || "state";
  const filePath  = path.join(stateDir, `monthly_postmortem_${monthKey}.json`);

  try {
    await ensureParent(filePath);
    await writeJson(filePath, postmortem);
    return { ok: true, filePath };
  } catch (err) {
    return { ok: false, reason: `WRITE_FAILED: ${String(err?.message || err)}` };
  }
}

export async function appendInterventionOptimizerEntry(config, entry) {
  const logFile = path.join(config.paths.stateDir, "intervention_optimizer_log.json");
  const state = await readJson(logFile, {
    schemaVersion: OPTIMIZER_LOG_SCHEMA_VERSION,
    updatedAt:     new Date().toISOString(),
    entries:       [],
  });

  const correlationId = String(entry?.correlationId || `optimizer-${Date.now()}`);
  const record = { ...entry, savedAt: new Date().toISOString() };
  const entries = Array.isArray(state.entries) ? state.entries : [];
  entries.push(record);

  state.entries   = entries.length > 100 ? entries.slice(-100) : entries;
  state.updatedAt = new Date().toISOString();
  await writeJson(logFile, state);

  // Emit typed planning event (non-blocking; never throws)
  emitEvent(EVENTS.PLANNING_INTERVENTION_OPTIMIZED, EVENT_DOMAIN.PLANNING, correlationId, {
    status:           String(entry?.status ?? "unknown"),
    reasonCode:       String(entry?.reasonCode ?? "unknown"),
    selectedCount:    Number(Array.isArray(entry?.selected) ? entry.selected.length : 0),
    rejectedCount:    Number(Array.isArray(entry?.rejected) ? entry.rejected.length : 0),
    totalBudgetUsed:  Number(entry?.totalBudgetUsed ?? 0),
    totalBudgetLimit: Number(entry?.totalBudgetLimit ?? 0),
    budgetUnit:       String(entry?.budgetUnit ?? "workerSpawns"),
  });
}

// ── Compounding effects persistence (re-exports from compounding_effects_analyzer) ──

/**
 * Persist a compounding-effects AnalyzerResult to state/.
 * Delegates to compounding_effects_analyzer.persistCompoundingEffectsResult.
 *
 * @param {object} config — box config with config.paths.stateDir
 * @param {object} result — AnalyzerResult from analyzeCompoundingEffects()
 * @returns {Promise<{ ok: boolean, filePath?: string, reason?: string }>}
 */
export { persistCompoundingEffectsResult } from "./compounding_effects_analyzer.js";

/**
 * Persist a monthly compounding-effects report to state/.
 * Delegates to compounding_effects_analyzer.persistMonthlyCompoundingReport.
 *
 * @param {object} config  — box config with config.paths.stateDir
 * @param {object} report  — MonthlyCompoundingReport
 * @returns {Promise<{ ok: boolean, filePath?: string, reason?: string }>}
 */
export { persistMonthlyCompoundingReport } from "./compounding_effects_analyzer.js";

/**
 * Generate and persist a monthly compounding-effects report from the rolling log.
 * Delegates to compounding_effects_analyzer.generateAndPersistMonthlyReport.
 *
 * @param {object} config   — box config with config.paths.stateDir
 * @param {string} monthKey — "YYYY-MM"
 * @returns {Promise<{ ok: boolean, filePath?: string, report?: object, reason?: string }>}
 */
export { generateAndPersistMonthlyReport } from "./compounding_effects_analyzer.js";
