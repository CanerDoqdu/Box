/**
 * Model Policy — Enforces banned/allowed model rules system-wide.
 *
 * ABSOLUTE RULES:
 *   - Claude Opus 4.6 Fast Mode (30x rate) = FORBIDDEN ALWAYS
 *   - Claude Opus 4.6 Fast / Preview = FORBIDDEN ALWAYS
 *   - Any model with "fast" in name = FORBIDDEN ALWAYS
 *   - Claude Opus 4.5/4.6 (regular) = allowed ONLY for large tasks
 *   - 3x rate models = allowed for long-duration tasks
 *
 * This module is imported by worker_runner.js and agent_loader.js
 * to enforce model selection before any AI call.
 */

// ── Banned model patterns (case-insensitive) ─────────────────────────────────
// These patterns match against the resolved model slug BEFORE any CLI call.
// If a model matches ANY pattern, it is rejected unconditionally.

const BANNED_PATTERNS = [
  /fast/i,                    // Any model with "fast" in name — 30x rate risk
  /preview/i,                 // Preview/experimental models — unstable behavior
  /30x/i,                     // Explicit 30x rate reference
  /opus.*fast/i,              // Claude Opus fast mode specifically
  /fast.*opus/i,              // Reverse order match
];

// ── Opus-tier models (expensive, only for large tasks) ───────────────────────
// These are allowed ONLY when estimated task scope justifies the cost.

const OPUS_PATTERNS = [
  /opus/i,                    // Any Opus model
];

// ── Large-task threshold ─────────────────────────────────────────────────────
// Tasks must meet at least ONE criterion to use Opus:
// - estimatedLines >= 3000
// - estimatedDurationMinutes >= 120 (2 hours)
// - taskComplexity === "critical" or "massive"

const OPUS_MIN_ESTIMATED_LINES = 3000;
const OPUS_MIN_DURATION_MINUTES = 120;
const OPUS_ALLOWED_COMPLEXITIES = new Set(["critical", "massive", "high"]);

/**
 * Check if a model is absolutely banned.
 * @param {string} modelName - Model name or slug
 * @returns {{ banned: boolean, reason: string }}
 */
export function isModelBanned(modelName) {
  const name = String(modelName || "").trim();
  if (!name) return { banned: false, reason: "" };

  for (const pattern of BANNED_PATTERNS) {
    if (pattern.test(name)) {
      return {
        banned: true,
        reason: `MODEL BANNED: "${name}" matches forbidden pattern ${pattern}. Fast/preview/30x models are absolutely forbidden in BOX.`
      };
    }
  }
  return { banned: false, reason: "" };
}

/**
 * Check if a model is Opus-tier (expensive).
 * @param {string} modelName
 * @returns {boolean}
 */
export function isOpusTier(modelName) {
  const name = String(modelName || "").trim();
  return OPUS_PATTERNS.some(p => p.test(name));
}

/**
 * Check if task scope justifies Opus usage.
 * @param {{ estimatedLines?: number, estimatedDurationMinutes?: number, complexity?: string }} taskHints
 * @returns {{ allowed: boolean, reason: string }}
 */
export function isOpusJustified(taskHints = {}) {
  const lines = Number(taskHints.estimatedLines || 0);
  const duration = Number(taskHints.estimatedDurationMinutes || 0);
  const complexity = String(taskHints.complexity || "").toLowerCase();

  if (lines >= OPUS_MIN_ESTIMATED_LINES) {
    return { allowed: true, reason: `Task scope ${lines} lines >= ${OPUS_MIN_ESTIMATED_LINES} threshold` };
  }
  if (duration >= OPUS_MIN_DURATION_MINUTES) {
    return { allowed: true, reason: `Task duration ${duration}m >= ${OPUS_MIN_DURATION_MINUTES}m threshold` };
  }
  if (OPUS_ALLOWED_COMPLEXITIES.has(complexity)) {
    return { allowed: true, reason: `Task complexity "${complexity}" qualifies for Opus` };
  }

  return {
    allowed: false,
    reason: `Task does not meet Opus thresholds (lines=${lines}<${OPUS_MIN_ESTIMATED_LINES}, duration=${duration}m<${OPUS_MIN_DURATION_MINUTES}m, complexity="${complexity}")`
  };
}

/**
 * Routing reason codes for observability.
 * @enum {string}
 */
export const ROUTING_REASON = Object.freeze({
  ALLOWED:           "ALLOWED",
  BANNED:            "BANNED",
  OPUS_DOWNGRADED:   "OPUS_DOWNGRADED",
  EMPTY_MODEL:       "EMPTY_MODEL",
});

/**
 * Complexity tier taxonomy (T1/T2/T3).
 * Maps task complexity to model selection and token budget strategy.
 *
 * @enum {string}
 */
export const COMPLEXITY_TIER = Object.freeze({
  /** T1: routine patch — short context, quick execution. */
  T1: "T1",
  /** T2: medium — two-pass reasoning, moderate context. */
  T2: "T2",
  /** T3: architectural — deep think budget, critic mandatory. */
  T3: "T3",
});

/**
 * Classify a task into a complexity tier based on task hints.
 *
 * @param {{ estimatedLines?: number, estimatedDurationMinutes?: number, complexity?: string }} taskHints
 * @returns {{ tier: string, reason: string, maxContinuations: number }}
 */
export function classifyComplexityTier(taskHints = {}) {
  const lines = Number(taskHints.estimatedLines || 0);
  const duration = Number(taskHints.estimatedDurationMinutes || 0);
  const complexity = String(taskHints.complexity || "").toLowerCase();

  // T3: architectural — needs deep reasoning
  if (OPUS_ALLOWED_COMPLEXITIES.has(complexity) || lines >= 3000 || duration >= 120) {
    return { tier: COMPLEXITY_TIER.T3, reason: `complexity=${complexity} lines=${lines} duration=${duration}`, maxContinuations: 5 };
  }

  // T2: medium — two-pass, moderate scope
  if (lines >= 500 || duration >= 30 || complexity === "medium") {
    return { tier: COMPLEXITY_TIER.T2, reason: `complexity=${complexity} lines=${lines} duration=${duration}`, maxContinuations: 3 };
  }

  // T1: routine — quick patch
  return { tier: COMPLEXITY_TIER.T1, reason: `complexity=${complexity} lines=${lines} duration=${duration}`, maxContinuations: 1 };
}

/**
 * Route model selection by task complexity and uncertainty (Packet 7).
 * Returns the recommended model based on complexity tier classification.
 *
 * @param {{ estimatedLines?: number, estimatedDurationMinutes?: number, complexity?: string }} taskHints
 * @param {{ defaultModel?: string, strongModel?: string, efficientModel?: string }} modelOptions
 * @returns {{ model: string, tier: string, reason: string }}
 */
export function routeModelByComplexity(taskHints = {}, modelOptions = {}) {
  const defaultModel = modelOptions.defaultModel || "Claude Sonnet 4.6";
  const strongModel = modelOptions.strongModel || defaultModel;
  const efficientModel = modelOptions.efficientModel || defaultModel;

  const { tier, reason } = classifyComplexityTier(taskHints);

  if (tier === COMPLEXITY_TIER.T3) {
    return { model: strongModel, tier, reason: `T3 (deep reasoning): ${reason}` };
  }
  if (tier === COMPLEXITY_TIER.T1) {
    return { model: efficientModel, tier, reason: `T1 (routine): ${reason}` };
  }
  return { model: defaultModel, tier, reason: `T2 (medium): ${reason}` };
}

/**
 * Enforce model policy: ban forbidden models, gate Opus to large tasks.
 * Returns the safe model to use — either the requested model (if allowed)
 * or a downgraded fallback.
 *
 * @param {string} requestedModel - Model requested by worker/config
 * @param {{ estimatedLines?: number, estimatedDurationMinutes?: number, complexity?: string, expectedQualityGain?: number }} taskHints
 * @param {string} fallbackModel - Safe fallback model
 * @returns {{ model: string, downgraded: boolean, reason: string, routingReasonCode: string }}
 */
export function enforceModelPolicy(requestedModel, taskHints = {}, fallbackModel = "Claude Sonnet 4.6") {
  const name = String(requestedModel || "").trim();

  // Step 1: Absolute ban check
  const banCheck = isModelBanned(name);
  if (banCheck.banned) {
    return {
      model: fallbackModel,
      downgraded: true,
      reason: banCheck.reason,
      routingReasonCode: ROUTING_REASON.BANNED
    };
  }

  // Step 2: Opus tier gate
  if (isOpusTier(name)) {
    const justification = isOpusJustified(taskHints);
    if (!justification.allowed) {
      return {
        model: fallbackModel,
        downgraded: true,
        reason: `Opus downgraded to ${fallbackModel}: ${justification.reason}`,
        routingReasonCode: ROUTING_REASON.OPUS_DOWNGRADED
      };
    }
  }

  // Step 3: Model is allowed
  return {
    model: name || fallbackModel,
    downgraded: false,
    reason: "",
    routingReasonCode: name ? ROUTING_REASON.ALLOWED : ROUTING_REASON.EMPTY_MODEL
  };
}
