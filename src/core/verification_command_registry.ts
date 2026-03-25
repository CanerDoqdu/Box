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
]);

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
