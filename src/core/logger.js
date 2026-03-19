import path from "node:path";
import { appendFileSync } from "node:fs";

export function info(message, data = undefined) {
  if (data === undefined) {
    console.log(`[box] ${message}`);
    return;
  }
  console.log(`[box] ${message}`, data);
}

export function warn(message, data = undefined) {
  if (data === undefined) {
    console.warn(`[box][warn] ${message}`);
    return;
  }
  console.warn(`[box][warn] ${message}`, data);
}

export function error(message, data = undefined) {
  if (data === undefined) {
    console.error(`[box][error] ${message}`);
    return;
  }
  console.error(`[box][error] ${message}`, data);
}

export function chatLog(stateDir, speaker, message) {
  try {
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    appendFileSync(
      path.join(stateDir, "leadership_live.txt"),
      `[${ts}] ${speaker.padEnd(20)} ${message}\n`,
      "utf8"
    );
  } catch { /* non-critical */ }
}
