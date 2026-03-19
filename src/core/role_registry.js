export function getRoleRegistry(config) {
  const fallback = {
    ceoSupervisor: { id: "ceo-supervisor", name: "Jesus", model: "GPT-5.3-Codex" },
    leadWorker: { id: "lead-worker", name: "Moses", model: "GPT-5.3-Codex" },
    workers: {
      backend: { id: "worker-backend", name: "King David", model: "GPT-5.3-Codex" },
      frontend: { id: "worker-frontend", name: "Esther", model: "GPT-5.3-Codex" },
      api: { id: "worker-api", name: "Aaron", model: "GPT-5.3-Codex" },
      integration: { id: "worker-integration", name: "Joseph", model: "GPT-5.3-Codex" },
      test: { id: "worker-test", name: "Samuel", model: "GPT-5.3-Codex" },
      qa: { id: "worker-qa", name: "Isaiah", model: "GPT-5.3-Codex" },
      devops: { id: "worker-devops", name: "Noah", model: "GPT-5.3-Codex" },
      security: { id: "worker-security", name: "Elijah", model: "GPT-5.3-Codex" }
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
