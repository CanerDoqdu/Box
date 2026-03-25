export function getRoleRegistry(config) {
  const fallback = {
    ceoSupervisor: { id: "ceo-supervisor", name: "Jesus", model: "GPT-5.3-Codex" },
    planner: { id: "planner", name: "Prometheus", model: "GPT-5.3-Codex" },
    reviewer: { id: "reviewer", name: "Athena", model: "GPT-5.3-Codex" },
    workers: {
      evolution: { id: "worker-evolution", name: "Evolution Worker", model: "GPT-5.3-Codex" }
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
