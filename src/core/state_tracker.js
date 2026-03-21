import fs from "node:fs/promises";
import path from "node:path";
import { ensureParent, readJson, writeJson } from "./fs_utils.js";

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
}

export async function appendClaudeUsage(config, usage) {
  const claudeUsageFile = path.join(config.paths.stateDir, "claude_usage.json");
  const claudeUsageMonthlyFile = path.join(config.paths.stateDir, "claude_usage_monthly.json");

  const state = await readJson(claudeUsageFile, {
    entries: [],
    updatedAt: new Date().toISOString()
  });

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

export async function appendAlert(config, alert) {
  const alertsFile = path.join(config.paths.stateDir, "alerts.json");
  const state = await readJson(alertsFile, {
    entries: [],
    updatedAt: new Date().toISOString()
  });

  state.entries.push({
    id: `${Date.now()}-${Math.random().toString(16).slice(2, 8)}`,
    timestamp: new Date().toISOString(),
    severity: String(alert?.severity || "warning"),
    source: String(alert?.source || "system"),
    title: String(alert?.title || "System alert"),
    message: String(alert?.message || "")
  });

  if (state.entries.length > 200) {
    state.entries = state.entries.slice(-200);
  }

  state.updatedAt = new Date().toISOString();
  await writeJson(alertsFile, state);
}
