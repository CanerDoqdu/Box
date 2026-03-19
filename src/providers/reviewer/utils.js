/**
 * Shared utilities for reviewer providers.
 * Keep this module pure — no side effects, no imports from provider files.
 */

export function safeArray(value) {
  return Array.isArray(value) ? value : [];
}

export function tryExtractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\{[\s\S]*\}/);
    if (!match) {
      return null;
    }
    try {
      return JSON.parse(match[0]);
    } catch {
      return null;
    }
  }
}

export function validatePlan(payload, fallbackTasks) {
  const tasks = safeArray(payload?.tasks)
    .map((task, idx) => ({
      id: Number(task?.id ?? idx + 1),
      title: String(task?.title || "").trim(),
      priority: Number(task?.priority || 3),
      kind: String(task?.kind || "general").trim().toLowerCase()
    }))
    .filter((t) => Number.isFinite(t.id) && t.title.length > 0 && Number.isFinite(t.priority));
  return tasks.length > 0 ? { tasks } : { tasks: fallbackTasks };
}

export function validateDecision(payload, fallback) {
  if (typeof payload?.approved !== "boolean") return fallback;
  return {
    approved: payload.approved,
    reason: String(payload?.reason || fallback?.reason || "review completed")
  };
}

export function validateOpusDecision(payload, fallback) {
  if (typeof payload?.allowOpus !== "boolean") return fallback;
  return {
    allowOpus: payload.allowOpus,
    reason: String(payload?.reason || fallback?.reason || "no reason provided")
  };
}
