/**
 * Pipeline Progress Tracker
 *
 * Writes state/pipeline_progress.json at every major stage of the
 * Jesus → Trump → Moses → Workers pipeline so the dashboard can
 * render a real-time progress bar with human-readable descriptions.
 */

import path from "node:path";
import { writeJson, readJson } from "./fs_utils.js";

/** Ordered pipeline steps with weight-based percentages. */
const STEPS = [
  { id: "idle",               label: "Idle",                          pct: 0   },
  { id: "jesus_awakening",    label: "Jesus Awakening",               pct: 5   },
  { id: "jesus_reading",      label: "Jesus Reading System State",    pct: 8   },
  { id: "jesus_thinking",     label: "Jesus Analyzing (AI)",          pct: 12  },
  { id: "jesus_decided",      label: "Jesus Decided",                 pct: 18  },
  { id: "trump_starting",     label: "Trump Awakening",               pct: 22  },
  { id: "trump_reading_repo", label: "Trump Reading Repository",      pct: 32  },
  { id: "trump_analyzing",    label: "Trump Deep Analysis (AI)",      pct: 45  },
  { id: "trump_audit",        label: "Trump Read Audit",              pct: 55  },
  { id: "trump_done",         label: "Trump Analysis Complete",       pct: 60  },
  { id: "moses_awakening",    label: "Moses Awakening",               pct: 65  },
  { id: "moses_planning",     label: "Moses Planning (AI)",           pct: 72  },
  { id: "moses_dispatching",  label: "Moses Dispatching Workers",     pct: 78  },
  { id: "workers_running",    label: "Workers Running",               pct: 85  },
  { id: "workers_finishing",  label: "Workers Finishing",             pct: 95  },
  { id: "cycle_complete",     label: "Cycle Complete",                pct: 100 },
];

function getStateDir(config) {
  return config?.paths?.stateDir || "state";
}

function progressPath(config) {
  return path.join(getStateDir(config), "pipeline_progress.json");
}

/**
 * Update the pipeline progress.
 *
 * @param {object}  config      BOX config
 * @param {string}  stepId      One of the STEPS[].id values
 * @param {string}  [detail]    Human-readable detail of what is happening right now
 * @param {object}  [extra]     Optional extra fields (e.g. { thinkingSnippet, workersDone, workersTotal })
 */
export async function updatePipelineProgress(config, stepId, detail, extra) {
  const stepIndex = STEPS.findIndex(s => s.id === stepId);
  if (stepIndex < 0) return; // unknown step — ignore silently

  const current = STEPS[stepIndex];

  const steps = STEPS.map((s, i) => ({
    id: s.id,
    label: s.label,
    pct: s.pct,
    status: i < stepIndex ? "done" : i === stepIndex ? "active" : "pending",
  }));

  const payload = {
    stage: current.id,
    stageLabel: current.label,
    percent: current.pct,
    detail: detail || current.label,
    steps,
    updatedAt: new Date().toISOString(),
    ...(extra || {}),
  };

  // Preserve startedAt from the previous state if mid-pipeline
  if (stepId !== "idle" && stepId !== "cycle_complete") {
    try {
      const prev = await readJson(progressPath(config), {});
      payload.startedAt = prev.startedAt || payload.updatedAt;
    } catch {
      payload.startedAt = payload.updatedAt;
    }
  } else if (stepId === "idle") {
    payload.startedAt = null;
  } else {
    // cycle_complete — keep startedAt, set completedAt
    try {
      const prev = await readJson(progressPath(config), {});
      payload.startedAt = prev.startedAt || null;
    } catch { /* ok */ }
    payload.completedAt = payload.updatedAt;
  }

  await writeJson(progressPath(config), payload);
}

/**
 * Read current pipeline progress (for dashboard).
 */
export async function readPipelineProgress(config) {
  return readJson(progressPath(config), {
    stage: "idle",
    stageLabel: "Idle",
    percent: 0,
    detail: "System ready",
    steps: STEPS.map(s => ({ ...s, status: "pending" })),
    updatedAt: null,
    startedAt: null,
  });
}

/** Export STEPS for tests/diagnostics. */
export { STEPS as PIPELINE_STEPS };
