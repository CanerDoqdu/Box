/**
 * verification_command_registry.js — Single source of truth for verification commands.
 *
 * All verification commands used across the system (CI, worker dispatch, tests)
 * are defined here. No other file should hardcode verification command strings.
 *
 * Usage:
 *   import { getVerificationCommands } from "./verification_command_registry.js";
 *   const cmds = getVerificationCommands(config);
 */

/**
 * Default verification commands.
 * These are used when box.config.json does not override them.
 */
const DEFAULTS = Object.freeze({
  /** Primary test command — must match package.json "test" script. */
  test: "npm test",
  /** Lint command. */
  lint: "npm run lint",
  /** Build command (optional — some projects don't have a build step). */
  build: "npm run build",
});

/**
 * Get the canonical verification commands for the current project.
 * Reads overrides from config.verificationCommands if provided.
 *
 * @param {object} [config]
 * @returns {{ test: string, lint: string, build: string }}
 */
export function getVerificationCommands(config) {
  const overrides = config?.verificationCommands || {};
  return {
    test: overrides.test || DEFAULTS.test,
    lint: overrides.lint || DEFAULTS.lint,
    build: overrides.build || DEFAULTS.build,
  };
}

/**
 * Get the test command specifically — most commonly needed.
 *
 * @param {object} [config]
 * @returns {string}
 */
export function getTestCommand(config) {
  return getVerificationCommands(config).test;
}

/**
 * All default commands exported for tests.
 */
export { DEFAULTS as VERIFICATION_DEFAULTS };

/**
 * Forbidden verification command patterns (Packet 4).
 * These patterns are known to fail on Windows (glob non-expansion) or
 * waste premium requests. Plans containing these must be rejected.
 *
 * @type {Array<{ pattern: RegExp, reason: string }>}
 */
export const FORBIDDEN_VERIFICATION_PATTERNS = Object.freeze([
  {
    pattern: /node\s+--test\s+tests\/?\*\*/i,
    reason: "Glob patterns are not expanded on Windows — use 'npm test' instead"
  },
  {
    pattern: /node\s+--test\s+[^\s]*\*/i,
    reason: "Wildcard glob in node --test fails on Windows — use 'npm test' instead"
  },
  {
    pattern: /^bash\s+/i,
    reason: "bash is not available on Windows — use 'npm test' instead"
  },
  {
    pattern: /^sh\s+/i,
    reason: "sh is not available on Windows — use 'npm test' instead"
  },
]);

/**
 * Rewrite rules for non-portable or unsafe verification commands.
 * Applied before worker dispatch — converts problematic patterns to
 * their canonical, portable equivalents.
 *
 * Covers:
 *   - Shell-glob node --test invocations (fail on Windows)
 *   - Bash/sh script invocations (not available on Windows)
 *   - BOX daemon/start commands (would wake the full agent stack)
 *
 * @type {ReadonlyArray<{ match: RegExp; replacement: string }>}
 */
export const VERIFICATION_CMD_REWRITE_RULES: ReadonlyArray<{ match: RegExp; replacement: string }> = Object.freeze([
  // Shell-glob patterns: not expanded on Windows — rewrite to portable test runner
  { match: /node\s+--test\s+[^\s]*\*/i, replacement: DEFAULTS.test },
  // Bash/sh scripts are not available on Windows
  { match: /^bash\s+/i, replacement: DEFAULTS.test },
  { match: /^sh\s+/i, replacement: DEFAULTS.test },
  // BOX daemon/start commands that would launch the full agent stack
  { match: /^node\s+src\/cli\.js\s+once$/i, replacement: DEFAULTS.test },
  { match: /^npm\s+run\s+box:once$/i, replacement: DEFAULTS.test },
  { match: /^node\s+src\/cli\.js\s+start$/i, replacement: DEFAULTS.test },
  { match: /^node\s+src\/cli\.js\s+doctor$/i, replacement: DEFAULTS.test },
  // Dashboard is a daemon — rewrite to headless test runner
  { match: /^node\s+src\/dashboard\/live_dashboard\.js$/i, replacement: "node --test" },
]);

/**
 * Rewrite a single verification command to its canonical, portable equivalent.
 * Returns the command unchanged when no rewrite rule matches.
 *
 * @param {string} cmd — raw verification command
 * @returns {string} canonical command safe to run on all platforms
 */
export function rewriteVerificationCommand(cmd: string): string {
  const text = String(cmd || "").trim();
  const rule = VERIFICATION_CMD_REWRITE_RULES.find(r => r.match.test(text));
  return rule ? rule.replacement : text;
}

/**
 * Normalize an array of verification commands by applying all rewrite rules to each.
 * This is the canonical batch entry point — all callers that need to sanitize a
 * plan's verification_commands before dispatch should use this.
 *
 * Deduplicates and filters empty strings so the result is a minimal, portable
 * command list ready for worker dispatch.
 *
 * @param {string[]} commands — raw verification command strings
 * @returns {string[]} canonical, portable, deduped command list
 */
export function normalizeCommandBatch(commands: string[]): string[] {
  if (!Array.isArray(commands)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const cmd of commands) {
    const rewritten = rewriteVerificationCommand(String(cmd || "").trim());
    if (rewritten && !seen.has(rewritten)) {
      seen.add(rewritten);
      result.push(rewritten);
    }
  }
  return result;
}

/**
 * Check if a verification command string contains forbidden patterns.
 *
 * @param {string} command — verification command string
 * @returns {{ forbidden: boolean, violations: Array<{ matched: string, reason: string }> }}
 */
export function checkForbiddenCommands(command) {
  const text = String(command || "");
  const violations = [];
  for (const { pattern, reason } of FORBIDDEN_VERIFICATION_PATTERNS) {
    if (pattern.test(text)) {
      violations.push({ matched: pattern.source, reason });
    }
  }
  return { forbidden: violations.length > 0, violations };
}
