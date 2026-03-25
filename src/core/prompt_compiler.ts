/**
 * prompt_compiler.js — Assembles agent prompts from reusable sections.
 *
 * Instead of monolithic prompt strings scattered across modules, this compiler
 * builds prompts from named sections that can be shared, tested, and versioned.
 *
 * Usage:
 *   const prompt = compilePrompt([
 *     section("role", "You are Athena — BOX Quality Gate."),
 *     section("context", `TARGET REPO: ${repo}`),
 *     section("mission", missionText),
 *     section("format", outputFormat),
 *   ]);
 */

/**
 * Create a named prompt section.
 *
 * @param {string} name — section identifier for debugging/tracing
 * @param {string} content — the text content of this section
 * @returns {{ name: string, content: string }}
 */
export function section(name, content) {
  return { name, content: String(content || "").trim() };
}

/**
 * Compile an array of prompt sections into a single prompt string.
 * Empty sections are omitted. Each section is separated by a double newline.
 *
 * With section-level caps (Packet 8): each section can have a maxTokens limit.
 * If a section exceeds its cap, it is truncated from the end.
 *
 * @param {Array<{ name: string, content: string, maxTokens?: number }>} sections
 * @param {{ separator?: string, includeHeaders?: boolean, tokenBudget?: number }} opts
 * @returns {string}
 */
export function compilePrompt(sections, opts: any = {}) {
  const sep = opts.separator || "\n\n";
  const includeHeaders = opts.includeHeaders || false;
  const budget = opts.tokenBudget || 0;

  let pieces = sections
    .filter(s => s && s.content && s.content.length > 0)
    .map(s => {
      let content = s.content;
      // Section-level cap: truncate if section exceeds its own maxTokens
      if (s.maxTokens && s.maxTokens > 0) {
        const sectionTokens = estimateTokens(content);
        if (sectionTokens > s.maxTokens) {
          const maxChars = s.maxTokens * 4;
          content = content.slice(0, maxChars) + "\n[...truncated to section budget]";
        }
      }
      return includeHeaders ? `## ${s.name}\n${content}` : content;
    });

  // If a global token budget is specified, truncate sections from the end to fit
  if (budget > 0) {
    let totalTokens = 0;
    const kept = [];
    for (const piece of pieces) {
      const t = estimateTokens(piece);
      if (totalTokens + t > budget) break;
      kept.push(piece);
      totalTokens += t;
    }
    pieces = kept;
  }

  return pieces.join(sep);
}

/**
 * Common reusable sections.
 */
export const COMMON_SECTIONS = Object.freeze({
  singlePromptMode: section(
    "single-prompt-mode",
    "EXECUTION MODE: Single-prompt, single-turn. You get ONE shot — no follow-ups, no continues. Make it count."
  ),
  jsonOutputMarkers: section(
    "json-output-markers",
    "Wrap your structured JSON output with:\n===DECISION===\n{ ... }\n===END==="
  ),
  noVagueGoals: section(
    "no-vague-goals",
    "Every goal must be measurable and specific. Do NOT use vague verbs like 'improve', 'optimize', or 'enhance' without a concrete metric."
  ),
});

/**
 * Estimate token count for a text string.
 * Uses the ~4 chars per token heuristic (accurate ±10% for English/code).
 *
 * @param {string} text
 * @returns {number}
 */
export function estimateTokens(text) {
  if (!text) return 0;
  return Math.ceil(String(text).length / 4);
}

/**
 * Estimate per-section and total token usage for an array of sections.
 *
 * @param {Array<{ name: string, content: string }>} sections
 * @returns {{ total: number, sections: Array<{ name: string, tokens: number }> }}
 */
export function estimatePromptTokens(sections) {
  const result = [];
  let total = 0;
  for (const s of (sections || [])) {
    if (!s || !s.content) continue;
    const t = estimateTokens(s.content);
    result.push({ name: s.name, tokens: t });
    total += t;
  }
  return { total, sections: result };
}

// ─── Packet 18 — Prompt Compiler Tiering by Task Complexity ────────────

/**
 * Complexity tiers matching model_policy.js classifications.
 * Each tier defines: max total tokens, section budgets, and anti-fluff strictness.
 */
export const PROMPT_TIERS = Object.freeze({
  T1: { label: "trivial", maxTokens: 800, antiFluff: false },
  T2: { label: "moderate", maxTokens: 2000, antiFluff: true },
  T3: { label: "complex", maxTokens: 4000, antiFluff: true },
});

/**
 * Vague verbs that add no measurable value to prompts.
 * Used by the anti-fluff filter in T2/T3 prompts.
 */
const FLUFF_PATTERNS = [
  /\b(significantly|drastically|greatly|massively)\s+(improve|enhance|optimize|boost)\b/gi,
  /\bstrive\s+to\b/gi,
  /\bas\s+(?:much|needed|appropriate)\s+as\s+possible\b/gi,
  /\btry\s+(?:to\s+)?(?:improve|enhance|optimize)\b/gi,
];

/**
 * Strip anti-fluff patterns from text.
 * Replaces vague verb phrases with empty string and collapses whitespace.
 *
 * @param {string} text
 * @returns {string}
 */
export function stripFluff(text) {
  if (!text) return "";
  let cleaned = text;
  for (const pat of FLUFF_PATTERNS) {
    cleaned = cleaned.replace(pat, "");
  }
  return cleaned.replace(/\s{2,}/g, " ").trim();
}

/**
 * Compile a tiered prompt — applies complexity-based token budget and anti-fluff.
 *
 * @param {Array<{ name: string, content: string, maxTokens?: number }>} sections
 * @param {{ tier?: "T1"|"T2"|"T3", separator?: string, includeHeaders?: boolean }} opts
 * @returns {string}
 */
export function compileTieredPrompt(sections, opts: any = {}) {
  const tier = PROMPT_TIERS[opts.tier] || PROMPT_TIERS.T2;

  let processed = sections;
  if (tier.antiFluff) {
    processed = sections.map(s => ({
      ...s,
      content: stripFluff(s.content),
    }));
  }

  return compilePrompt(processed, {
    separator: opts.separator,
    includeHeaders: opts.includeHeaders,
    tokenBudget: tier.maxTokens,
  });
}
