import path from "node:path";
import fs from "node:fs/promises";
import { appendFileSync } from "node:fs";

export function aggregateLiveLogPath(stateDir: string): string {
  return path.join(stateDir, "live_agents.log");
}

function prefixLiveLogLines(source: string, text: string): string {
  const message = String(text || "");
  if (!message) return "";
  return message.replace(/^/gm, `[${source}] `);
}

export function appendAggregateLiveLogSync(stateDir: string, source: string, text: string): void {
  const content = prefixLiveLogLines(source, text);
  if (!content) return;
  try {
    appendFileSync(aggregateLiveLogPath(stateDir), content, "utf8");
  } catch { /* best-effort */ }
}

export async function appendAggregateLiveLog(stateDir: string, source: string, text: string): Promise<void> {
  const content = prefixLiveLogLines(source, text);
  if (!content) return;
  try {
    await fs.mkdir(stateDir, { recursive: true });
    await fs.appendFile(aggregateLiveLogPath(stateDir), content, "utf8");
  } catch { /* best-effort */ }
}

export async function initializeAggregateLiveLog(stateDir: string, reason: string): Promise<void> {
  await fs.mkdir(stateDir, { recursive: true });
  await fs.writeFile(
    aggregateLiveLogPath(stateDir),
    `[live_agents]\n[${reason}] Combined live agent log ready...\n`,
    "utf8"
  );
}