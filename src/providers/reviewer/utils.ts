/**
 * Shared utilities for reviewer providers.
 * Keep this module pure — no side effects, no imports from provider files.
 */

export function safeArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function tryExtractJson(text: string | null | undefined): unknown {
  try {
    return JSON.parse(text as string);
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

export function validatePlan(payload: Record<string, unknown> | null, fallbackTasks: unknown[]): { tasks: unknown[] } {
  const tasks = safeArray((payload as any)?.tasks)
    .map((task: any, idx: number) => ({
      id: Number(task?.id ?? idx + 1),
      title: String(task?.title || "").trim(),
      priority: Number(task?.priority || 3),
      kind: String(task?.kind || "general").trim().toLowerCase()
    }))
    .filter((t) => Number.isFinite(t.id) && t.title.length > 0 && Number.isFinite(t.priority));
  return tasks.length > 0 ? { tasks } : { tasks: fallbackTasks };
}

export function validateDecision(payload: Record<string, unknown> | null, fallback: { approved: boolean; reason: string }): { approved: boolean; reason: string } {
  if (typeof payload?.approved !== "boolean") return fallback;
  return {
    approved: payload.approved,
    reason: String(payload?.reason || fallback?.reason || "review completed")
  };
}

export function validateOpusDecision(payload: Record<string, unknown> | null, fallback: { allowOpus: boolean; reason: string }): { allowOpus: boolean; reason: string } {
  if (typeof payload?.allowOpus !== "boolean") return fallback;
  return {
    allowOpus: payload.allowOpus as boolean,
    reason: String(payload?.reason || fallback?.reason || "no reason provided")
  };
}
