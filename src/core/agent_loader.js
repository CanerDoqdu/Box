/**
 * Agent Loader — Integrates .github/agents/*.agent.md with Copilot CLI
 *
 * Each AI role has a dedicated .agent.md file in .github/agents/.
 * These are standard VS Code Copilot custom agent files with YAML frontmatter.
 *
 * When calling the Copilot CLI, we pass --agent <slug> to load the agent's
 * persona, tools, and model preferences from that file.
 * The runtime data (GitHub state, sessions, etc.) is passed via -p <context>.
 *
 * Edit an agent's behavior by editing their .agent.md file — no code changes needed.
 */

import { existsSync, appendFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { isModelBanned } from "./model_policy.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const AGENTS_DIR = path.join(__dirname, "..", "..", ".github", "agents");

function logBannedModelAttempt(model, reason) {
  try {
    const stateDir = path.join(__dirname, "..", "..", "state");
    const line = `[${new Date().toISOString()}] BANNED_MODEL_BLOCKED: model="${model}" reason="${reason}"\n`;
    appendFileSync(path.join(stateDir, "progress.txt"), line, "utf8");
  } catch { /* non-critical */ }
}

// ── Convert agent name to .agent.md file slug ────────────────────────────────
// "King David" → "king-david", "Trump" → "trump"

export function nameToSlug(name) {
  return String(name || "").trim().toLowerCase().replace(/\s+/g, "-");
}

// ── Check if .agent.md file exists for a slug ────────────────────────────────

export function agentFileExists(slug) {
  return existsSync(path.join(AGENTS_DIR, `${slug}.agent.md`));
}

// ── Map model name to Copilot CLI model slug ──────────────────────────────────

export function toCopilotModelSlug(name) {
  const map = {
    "claude sonnet 4.6": "claude-sonnet-4.6",
    "claude sonnet 4.5": "claude-sonnet-4.5",
    "claude sonnet 4": "claude-sonnet-4",
    "claude haiku 4.5": "claude-haiku-4.5",
    "claude opus 4.6": "claude-opus-4.6",
    // claude-opus-4.6-fast is BANNED — 30x rate, never use
    "claude opus 4.5": "claude-opus-4.5",
    "gemini 3 pro preview": "gemini-3-pro-preview",
    "gpt-5.4": "gpt-5.4",
    "gpt 5.4": "gpt-5.4",
    "gpt-5.3-codex": "gpt-5.3-codex",
    "gpt 5.3 codex": "gpt-5.3-codex",
    "gpt-5.2-codex": "gpt-5.2-codex",
    "gpt 5.2 codex": "gpt-5.2-codex",
    "gpt-5.2": "gpt-5.2",
    "gpt 5.2": "gpt-5.2",
    "gpt 5.1 codex max": "gpt-5.1-codex-max",
    "gpt 5.1 codex": "gpt-5.1-codex",
    "gpt 5.1 codex mini": "gpt-5.1-codex-mini",
    "gpt 5.1": "gpt-5.1",
    "gpt 5 mini": "gpt-5-mini",
    "gpt 4.1": "gpt-4.1"
  };
  const key = String(name || "").trim().toLowerCase();
  if (map[key]) return map[key];
  return key
    .replace(/[^a-z0-9.\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

// ── Build CLI args array for a Copilot agent call ────────────────────────────
//
// Usage:
//   const args = buildAgentArgs({ agentSlug: "jesus", prompt: contextText, model: "claude-sonnet-4.6" });
//   spawnSync(copilotCommand, args, ...)
//
// If an .agent.md file exists for the slug, --agent <slug> is added and the
// agent's frontmatter model is used (unless overridden by model arg).
// If no agent file exists, falls back to plain --model + -p call.

// Windows limits total CLI argument length to ~32KB (CreateProcessW).
// When the prompt exceeds PROMPT_FILE_THRESHOLD we write it to a temp file
// and tell the agent to read that file instead.
const PROMPT_FILE_THRESHOLD = 20_000;
const PROMPT_TEMP_DIR = path.join(__dirname, "..", "..", "state");

export function buildAgentArgs({ agentSlug, prompt, model, allowAll = true }) {
  const args = [];
  let promptFile = null;

  if (allowAll) {
    args.push("--allow-all-tools");
    args.push("--no-ask-user");
  }

  if (agentSlug && agentFileExists(agentSlug)) {
    args.push("--agent", agentSlug);
  } else if (model) {
    // No agent file — fall back to explicit model
    const banCheck = isModelBanned(model);
    if (banCheck.banned) {
      // HARD BLOCK: never pass a banned model to Copilot CLI
      const safe = toCopilotModelSlug("Claude Sonnet 4.6");
      if (safe) args.push("--model", safe);
      logBannedModelAttempt(model, banCheck.reason);
    } else {
      const slug = toCopilotModelSlug(model);
      if (slug) args.push("--model", slug);
    }
  }

  const promptText = String(prompt);

  if (promptText.length > PROMPT_FILE_THRESHOLD) {
    // Write to temp file to avoid ENAMETOOLONG on Windows
    const tmpName = `_prompt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.md`;
    promptFile = path.join(PROMPT_TEMP_DIR, tmpName);
    try {
      writeFileSync(promptFile, promptText, "utf8");
      args.push("-p", [
        `IMPORTANT: Your complete instructions and context are in the file: ${promptFile}`,
        `You MUST use the read_file tool to read that file BEFORE doing anything else.`,
        `The file contains your full task description, context data, and expected output format.`,
        `Do NOT attempt to answer without first reading the file contents.`
      ].join("\n"));
    } catch {
      // Fallback: pass prompt directly (may hit ENAMETOOLONG on large prompts)
      promptFile = null;
      args.push("-p", promptText);
    }
  } else {
    args.push("-p", promptText);
  }

  return { args, promptFile };
}

/** Remove temp prompt file created by buildAgentArgs. Safe to call with null. */
export function cleanupPromptFile(filePath) {
  if (!filePath) return;
  try { unlinkSync(filePath); } catch { /* already gone */ }
}

// ── Parse agent output: extract thinking + structured JSON ───────────────────
//
// Agents write freely, then end with one of two marker formats:
//
//   English (preferred):      Legacy Turkish (backward compat):
//   ===DECISION===            ===KARAR===
//   { json }                  { json }
//   ===END===                 ===SON===
//
// The section BEFORE the marker is the agent's visible thinking.
// The section INSIDE is parsed as structured JSON.
// Falls back to finding any JSON anywhere in the output.

export function parseAgentOutput(raw) {
  const text = String(raw || "");

  // Try ===DECISION=== / ===END=== markers (English format)
  const decisionMatch = text.match(/===DECISION===\s*([\s\S]*?)===END===/);
  if (decisionMatch) {
    const splitIdx = text.indexOf("===DECISION===");
    const thinking = text.slice(0, splitIdx).trim();
    const jsonStr = decisionMatch[1].trim();
    const parsed = tryParseJson(jsonStr);
    return { thinking, parsed, ok: !!parsed };
  }

  // Try ===KARAR=== / ===SON=== markers (legacy Turkish format — backward compat)
  const kararMatch = text.match(/===KARAR===\s*([\s\S]*?)===SON===/);
  if (kararMatch) {
    const splitIdx = text.indexOf("===KARAR===");
    const thinking = text.slice(0, splitIdx).trim();
    const jsonStr = kararMatch[1].trim();
    const parsed = tryParseJson(jsonStr);
    return { thinking, parsed, ok: !!parsed };
  }

  // Try ```json fenced blocks
  const fenceMatch = text.match(/```json\s*([\s\S]*?)```/);
  if (fenceMatch) {
    const splitIdx = text.indexOf("```json");
    const thinking = text.slice(0, splitIdx).trim();
    const parsed = tryParseJson(fenceMatch[1].trim());
    return { thinking, parsed, ok: !!parsed };
  }

  // Fall back: find JSON object anywhere, everything before it is thinking
  const jsonStart = text.search(/\{/);
  const thinking = jsonStart > 20 ? text.slice(0, jsonStart).trim() : "";
  const parsed = tryParseJson(text);
  return { thinking, parsed, ok: !!parsed };
}

// ── Internal JSON parser (handles raw, fenced, deep-nested) ──────────────────

function tryParseJson(text) {
  const s = String(text || "");
  try { return JSON.parse(s); } catch {}
  const fenceMatch = s.match(/```json\s*([\s\S]*?)```/);
  if (fenceMatch) { try { return JSON.parse(fenceMatch[1].trim()); } catch {} }
  const anyFence = s.match(/```\s*([\s\S]*?)```/);
  if (anyFence) { try { return JSON.parse(anyFence[1].trim()); } catch {} }
  // Find last top-level JSON object
  let lastCandidate = null;
  let i = 0;
  while (i < s.length) {
    if (s[i] !== "{") { i++; continue; }
    let depth = 0, inString = false, escape = false;
    const start = i;
    for (; i < s.length; i++) {
      const ch = s[i];
      if (escape) { escape = false; continue; }
      if (ch === "\\") { escape = true; continue; }
      if (ch === '"') { inString = !inString; continue; }
      if (inString) continue;
      if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { lastCandidate = s.slice(start, i + 1); i++; break; } }
    }
  }
  if (lastCandidate) { try { return JSON.parse(lastCandidate); } catch {} }
  return null;
}

// ── Log agent thinking to a visible file ─────────────────────────────────────

export function logAgentThinking(stateDir, agentName, thinking) {
  if (!thinking || thinking.length < 10) return;
  try {
    const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
    const separator = `\n${"─".repeat(60)}\n[${ts}] ${agentName} — DÜŞÜNCE\n${"─".repeat(60)}\n`;
    appendFileSync(
      path.join(stateDir, "leadership_thinking.txt"),
      `${separator}${thinking}\n`,
      "utf8"
    );
  } catch { /* non-critical */ }
}
