/**
 * Canonical lane-to-worker name mapping.
 * Each capability lane has a dedicated worker identity.
 * "implementation" maps to the base evolution-worker.
 * All other lanes get specialized workers that share the same agent tooling.
 */
export const LANE_WORKER_NAMES: Readonly<Record<string, string>> = Object.freeze({
  implementation:  "Evolution Worker",
  quality:         "quality-worker",
  governance:      "governance-worker",
  infrastructure:  "infrastructure-worker",
  integration:     "integration-worker",
  observation:     "observation-worker",
});

export function getRoleRegistry(config) {
  const fallback = {
    ceoSupervisor: { id: "ceo-supervisor", name: "Jesus", model: "GPT-5.3-Codex" },
    planner: { id: "planner", name: "Prometheus", model: "GPT-5.3-Codex" },
    reviewer: { id: "reviewer", name: "Athena", model: "GPT-5.3-Codex" },
    workers: {
      evolution:      { id: "worker-evolution",      name: "Evolution Worker",      model: "GPT-5.3-Codex", lane: "implementation" },
      quality:        { id: "worker-quality",         name: "quality-worker",        model: "GPT-5.3-Codex", lane: "quality" },
      governance:     { id: "worker-governance",      name: "governance-worker",     model: "GPT-5.3-Codex", lane: "governance" },
      infrastructure: { id: "worker-infrastructure",  name: "infrastructure-worker", model: "GPT-5.3-Codex", lane: "infrastructure" },
      integration:    { id: "worker-integration",     name: "integration-worker",    model: "GPT-5.3-Codex", lane: "integration" },
      observation:    { id: "worker-observation",     name: "observation-worker",    model: "GPT-5.3-Codex", lane: "observation" },
    }
  };

  return {
    ...fallback,
    ...(config?.roleRegistry || {}),
    workers: {
      ...fallback.workers,
      ...(config?.roleRegistry?.workers || {})
    }
  };
}
