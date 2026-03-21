/**
 * Pipeline Progress Tracker
 *
 * Writes state/pipeline_progress.json at every major stage of the
 * Jesus → Prometheus → Athena → Workers pipeline so the dashboard can
 * render a real-time progress bar with human-readable descriptions.
 *
 * Schema contract (pipeline_progress.json):
 * {
 *   stage:       string  — one of PIPELINE_STAGE_ENUM values
 *   stageLabel:  string  — human-readable label for the stage
 *   percent:     number  — 0–100 inclusive
 *   detail:      string  — current detail text
 *   steps:       Array<{ id: string, label: string, pct: number, status: "done"|"active"|"pending" }>
 *   updatedAt:   string  — ISO 8601 timestamp of last update
 *   startedAt:   string|null — ISO 8601 timestamp when cycle started; null when idle
 *   completedAt: string|undefined — ISO 8601 timestamp; present only on cycle_complete
 * }
 */

import path from "node:path";
import { writeJson, readJson } from "./fs_utils.js";

/**
 * Explicit enumeration of all valid stage IDs.
 * Covers every step of the Jesus → Prometheus → Athena → Workers pipeline.
 */
export const PIPELINE_STAGE_ENUM = Object.freeze([
  "idle",
  "jesus_awakening",
  "jesus_reading",
  "jesus_thinking",
  "jesus_decided",
  "prometheus_starting",
  "prometheus_reading_repo",
  "prometheus_analyzing",
  "prometheus_audit",
  "prometheus_done",
  "athena_reviewing",
  "athena_approved",
  "workers_dispatching",
  "workers_running",
  "workers_finishing",
  "cycle_complete",
]);

/** Reason codes for updatePipelineProgress validation errors. */
export const PROGRESS_ERROR_CODE = Object.freeze({
  MISSING_STEP_ID: "MISSING_STEP_ID",
  INVALID_STEP_ID: "INVALID_STEP_ID",
});

/** Ordered pipeline steps with weight-based percentages. */
const STEPS = [
  { id: "idle",                    label: "Idle",                               pct: 0   },
  { id: "jesus_awakening",         label: "Jesus Awakening",                    pct: 5   },
  { id: "jesus_reading",           label: "Jesus Reading System State",         pct: 8   },
  { id: "jesus_thinking",          label: "Jesus Analyzing (AI)",               pct: 12  },
  { id: "jesus_decided",           label: "Jesus Decided",                      pct: 18  },
  { id: "prometheus_starting",     label: "Prometheus Awakening",               pct: 22  },
  { id: "prometheus_reading_repo", label: "Prometheus Reading Repository",      pct: 32  },
  { id: "prometheus_analyzing",    label: "Prometheus Deep Analysis (AI)",      pct: 45  },
  { id: "prometheus_audit",        label: "Prometheus Read Audit",              pct: 55  },
  { id: "prometheus_done",         label: "Prometheus Analysis Complete",       pct: 60  },
  { id: "athena_reviewing",        label: "Athena Reviewing Plan",              pct: 65  },
  { id: "athena_approved",         label: "Athena Plan Approved",               pct: 72  },
  { id: "workers_dispatching",     label: "Dispatching Workers",                pct: 78  },
  { id: "workers_running",         label: "Workers Running",                    pct: 85  },
  { id: "workers_finishing",       label: "Workers Finishing",                  pct: 95  },
  { id: "cycle_complete",          label: "Cycle Complete",                     pct: 100 },
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
 * Validation:
 *   - Missing stepId (null/undefined/empty string) → throws with code MISSING_STEP_ID
 *   - Unknown stepId (not in PIPELINE_STAGE_ENUM)  → throws with code INVALID_STEP_ID
 *
 * @param {object}  config      BOX config
 * @param {string}  stepId      One of the PIPELINE_STAGE_ENUM values
 * @param {string}  [detail]    Human-readable detail of what is happening right now
 * @param {object}  [extra]     Optional extra fields (e.g. { thinkingSnippet, workersDone, workersTotal })
 */
export async function updatePipelineProgress(config, stepId, detail, extra) {
  if (stepId === null || stepId === undefined || String(stepId).trim() === "") {
    const err = new Error(`updatePipelineProgress: stepId is required`);
    err.code = PROGRESS_ERROR_CODE.MISSING_STEP_ID;
    throw err;
  }
  const stepIndex = STEPS.findIndex(s => s.id === stepId);
  if (stepIndex < 0) {
    const err = new Error(`updatePipelineProgress: unknown stepId '${stepId}' — must be one of: ${PIPELINE_STAGE_ENUM.join(", ")}`);
    err.code = PROGRESS_ERROR_CODE.INVALID_STEP_ID;
    throw err;
  }

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

/**
 * Canonical schema for pipeline_progress.json.
 * Published for tests and dashboard consumers to validate against.
 */
export const PIPELINE_PROGRESS_SCHEMA = Object.freeze({
  required: ["stage", "stageLabel", "percent", "detail", "steps", "updatedAt", "startedAt"],
  stageEnum: PIPELINE_STAGE_ENUM,
  percentRange: [0, 100],
  stepStatusEnum: Object.freeze(["done", "active", "pending"]),
  /** completedAt is present only when stage === "cycle_complete" */
  conditionalFields: Object.freeze({ completedAt: "cycle_complete" }),
});
