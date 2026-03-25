/**
 * trust_boundary.js — Runtime input validation gate for all leadership provider outputs.
 *
 * Validates provider outputs (planner/reviewer/supervisor JSON contracts) against
 * the canonical schemas in src/schemas/leadership.schema.json before any downstream
 * execution consumes them. This is the trust boundary between untrusted AI output
 * and the BOX orchestration pipeline.
 *
 * ── Schema artifact ──────────────────────────────────────────────────────────
 *   src/schemas/leadership.schema.json (AC1 / Athena missing item #1)
 *   Format: JSON with "contracts" keyed by type ("planner", "reviewer", "supervisor").
 *
 * ── Failure class ────────────────────────────────────────────────────────────
 *   TRUST_BOUNDARY_ERROR = "trust_boundary_violation" (AC2 / Athena missing item #2)
 *   Module location: src/core/trust_boundary.js (this file)
 *
 * ── Retry strategy (AC2) ─────────────────────────────────────────────────────
 *   maxRetries:  3
 *   delayMs:     5000  (5 seconds initial delay)
 *   backoff:     "exponential"
 *   multiplier:  2     (delay × 2 on each retry: 5s, 10s, 20s)
 *   escalation:  after maxRetries exhausted → escalate to "athena_review"
 *
 * ── Critical contract fields per provider type (AC3 / Athena missing item #3) ─
 *   planner   (Prometheus): plans, analysis, projectHealth, executionStrategy, requestBudget
 *   reviewer  (Athena):     approved, corrections, planReviews
 *   supervisor(Jesus):      decision, wakeAthena, callPrometheus, briefForPrometheus, systemHealth
 *
 * ── Error format (AC4) ───────────────────────────────────────────────────────
 *   Each error entry includes: { field, reasonCode, message, payloadPath, sourceFile }
 *
 * ── Missing vs invalid input (AC9) ───────────────────────────────────────────
 *   MISSING_INPUT  — payload is null/undefined (never reached the validator)
 *   INVALID_TYPE   — payload is not a plain object
 *   MISSING_FIELD  — required field is absent from payload
 *   INVALID_FIELD  — field is present but fails type/enum/length constraints
 *   UNKNOWN_CONTRACT_TYPE — contractType not in schema
 *
 * ── No silent fallback (AC10) ────────────────────────────────────────────────
 *   ok=false → status="blocked", explicit reasonCode, non-empty errors array.
 *   Callers MUST check ok before using payload. No auto-approve on failure.
 *
 * ── Risk level: medium-high ──────────────────────────────────────────────────
 *   Rollback path: set config.runtime.trustBoundaryMode = "warn" to downgrade
 *   hard failures to warnings for one release cycle. Default is "enforce".
 *   This rollback path must be explicitly enabled — it is never the default.
 */

import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ── Schema artifact ───────────────────────────────────────────────────────────

/** Canonical path to the leadership contract schema file. */
export const LEADERSHIP_SCHEMA_PATH = path.join(__dirname, "..", "schemas", "leadership.schema.json");

/** Lazy-loaded schema. Loaded once on first call to validateLeadershipContract. */
let _schemaCache = null;

function loadSchema() {
  if (_schemaCache) return _schemaCache;
  const requireFn = createRequire(import.meta.url);
  try {
    _schemaCache = requireFn(LEADERSHIP_SCHEMA_PATH);
  } catch (err) {
    throw new Error(`[trust_boundary] Failed to load schema from ${LEADERSHIP_SCHEMA_PATH}: ${err.message}`, { cause: err });
  }
  return _schemaCache;
}

// ── Failure class ─────────────────────────────────────────────────────────────

/**
 * Trust boundary failure class identifier.
 *
 * Distinct from FAILURE_CLASS in failure_classifier.js — this is specific to
 * schema violations in provider (AI) outputs, not worker task failures.
 *
 * @constant {string}
 */
export const TRUST_BOUNDARY_ERROR = "trust_boundary_violation";

// ── Retry strategy ────────────────────────────────────────────────────────────

/**
 * Default retry strategy for trust boundary violations.
 *
 * maxRetries:  3 attempts total (original + 3 retries)
 * delayMs:     5000ms initial delay
 * backoff:     "exponential" — delay × multiplier on each retry
 * multiplier:  2 (5s → 10s → 20s)
 * escalationTarget: "athena_review" — after exhaustion, escalate for human review
 *
 * @constant {object}
 */
export const TRUST_BOUNDARY_RETRY = Object.freeze({
  maxRetries:        3,
  delayMs:           5000,
  backoff:           "exponential",
  multiplier:        2,
  escalationTarget:  "athena_review"
});

// ── Reason codes ──────────────────────────────────────────────────────────────

/**
 * Reason codes for trust boundary validation results.
 *
 * Distinguishes missing input from invalid input — no silent fallback allowed.
 *
 * @enum {string}
 */
export const TRUST_BOUNDARY_REASON = Object.freeze({
  /** Validation passed — payload is safe for downstream consumption. */
  OK:                    "OK",
  /** Payload is null or undefined — no output received from provider. */
  MISSING_INPUT:         "MISSING_INPUT",
  /** Payload is not a plain object (e.g. string, array, number). */
  INVALID_TYPE:          "INVALID_TYPE",
  /** A required field is absent from the payload. */
  MISSING_FIELD:         "MISSING_FIELD",
  /** A field is present but fails type, enum, or length constraints. */
  INVALID_FIELD:         "INVALID_FIELD",
  /** The contractType argument is not a known schema type. */
  UNKNOWN_CONTRACT_TYPE: "UNKNOWN_CONTRACT_TYPE",
  /** Schema file could not be loaded. */
  SCHEMA_LOAD_ERROR:     "SCHEMA_LOAD_ERROR"
});

// ── Contract type constants ───────────────────────────────────────────────────

/**
 * Canonical contract type identifiers for leadership provider outputs.
 *
 * planner   — Prometheus analysis output (plans, projectHealth, executionStrategy, ...)
 * reviewer  — Athena plan-review output (approved, corrections, planReviews)
 * supervisor — Jesus directive output (decision, wakeAthena, callPrometheus, briefForPrometheus, ...)
 *
 * @enum {string}
 */
export const LEADERSHIP_CONTRACT_TYPE = Object.freeze({
  PLANNER:    "planner",
  REVIEWER:   "reviewer",
  SUPERVISOR: "supervisor"
});

// ── Field validator ───────────────────────────────────────────────────────────

/**
 * Validate a single field value against its field descriptor from the schema.
 *
 * @param {string} field       — field name
 * @param {any}    value       — field value from payload
 * @param {object} descriptor  — field descriptor from schema
 * @param {string} basePath    — JSON payload path prefix (for error anchoring)
 * @returns {{ ok: boolean, errors: object[] }}
 */
function validateField(field, value, descriptor, basePath) {
  const payloadPath = `${basePath}.${field}`;
  const errors = [];

  // ── oneOf support: try each variant, pass if any matches ────────────────
  if (Array.isArray(descriptor.oneOf)) {
    const variantErrors = [];
    for (const variant of descriptor.oneOf) {
      const result = validateField(field, value, variant, basePath);
      if (result.ok) return { ok: true, errors: [] };
      variantErrors.push(...result.errors);
    }
    // None matched — report a combined error
    const types = descriptor.oneOf.map(v => v.type).join(" | ");
    errors.push({
      field,
      reasonCode: TRUST_BOUNDARY_REASON.INVALID_FIELD,
      message: `value does not match any oneOf variant (expected: ${types}), got ${typeof value}`,
      payloadPath
    });
    return { ok: false, errors };
  }

  const { type, enum: enumValues, minLength, minItems, minimum } = descriptor;

  if (type === "boolean") {
    if (typeof value !== "boolean") {
      errors.push({
        field,
        reasonCode: TRUST_BOUNDARY_REASON.INVALID_FIELD,
        message: `expected boolean, got ${typeof value}`,
        payloadPath
      });
    }
  } else if (type === "string") {
    if (typeof value !== "string") {
      errors.push({
        field,
        reasonCode: TRUST_BOUNDARY_REASON.INVALID_FIELD,
        message: `expected string, got ${typeof value}`,
        payloadPath
      });
    } else {
      if (enumValues && !enumValues.includes(value)) {
        errors.push({
          field,
          reasonCode: TRUST_BOUNDARY_REASON.INVALID_FIELD,
          message: `value "${value}" is not one of: ${enumValues.join(", ")}`,
          payloadPath
        });
      }
      if (typeof minLength === "number" && value.length < minLength) {
        errors.push({
          field,
          reasonCode: TRUST_BOUNDARY_REASON.INVALID_FIELD,
          message: `string length ${value.length} is less than minimum ${minLength}`,
          payloadPath
        });
      }
    }
  } else if (type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      errors.push({
        field,
        reasonCode: TRUST_BOUNDARY_REASON.INVALID_FIELD,
        message: `expected finite number, got ${typeof value}`,
        payloadPath
      });
    } else if (typeof minimum === "number" && value < minimum) {
      errors.push({
        field,
        reasonCode: TRUST_BOUNDARY_REASON.INVALID_FIELD,
        message: `number ${value} is less than minimum ${minimum}`,
        payloadPath
      });
    }
  } else if (type === "integer") {
    if (typeof value !== "number" || !Number.isInteger(value)) {
      errors.push({
        field,
        reasonCode: TRUST_BOUNDARY_REASON.INVALID_FIELD,
        message: `expected integer, got ${typeof value === "number" ? "float" : typeof value}`,
        payloadPath
      });
    } else if (typeof minimum === "number" && value < minimum) {
      errors.push({
        field,
        reasonCode: TRUST_BOUNDARY_REASON.INVALID_FIELD,
        message: `integer ${value} is less than minimum ${minimum}`,
        payloadPath
      });
    }
  } else if (type === "array") {
    if (!Array.isArray(value)) {
      errors.push({
        field,
        reasonCode: TRUST_BOUNDARY_REASON.INVALID_FIELD,
        message: `expected array, got ${typeof value}`,
        payloadPath
      });
    } else if (typeof minItems === "number" && value.length < minItems) {
      errors.push({
        field,
        reasonCode: TRUST_BOUNDARY_REASON.INVALID_FIELD,
        message: `array length ${value.length} is less than minimum ${minItems}`,
        payloadPath
      });
    }
  } else if (type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      errors.push({
        field,
        reasonCode: TRUST_BOUNDARY_REASON.INVALID_FIELD,
        message: `expected plain object, got ${Array.isArray(value) ? "array" : typeof value}`,
        payloadPath
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

// ── Plan item validator ───────────────────────────────────────────────────────

/**
 * Validate individual plan items within a planner payload.
 * Each plan must have: role, task, priority, wave, verification.
 *
 * @param {any[]} plans          — plans array from planner payload
 * @param {object} planSchema    — planner contract from schema
 * @returns {object[]}           — array of error objects
 */
function validatePlanItems(plans, planSchema) {
  const errors = [];
  if (!Array.isArray(plans)) return errors;

  const itemRequiredFields = planSchema.planItemRequiredFields || [];
  const itemFieldDescriptors = planSchema.planItemFields || {};

  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i];
    const basePath = `plans[${i}]`;

    if (!plan || typeof plan !== "object" || Array.isArray(plan)) {
      errors.push({
        field: basePath,
        reasonCode: TRUST_BOUNDARY_REASON.INVALID_FIELD,
        message: `plan item at index ${i} is not a plain object`,
        payloadPath: basePath
      });
      continue;
    }

    for (const field of itemRequiredFields) {
      if (!(field in plan)) {
        errors.push({
          field: `${basePath}.${field}`,
          reasonCode: TRUST_BOUNDARY_REASON.MISSING_FIELD,
          message: `required field "${field}" is absent from plan item ${i}`,
          payloadPath: `${basePath}.${field}`
        });
        continue;
      }
      const descriptor = itemFieldDescriptors[field];
      if (descriptor) {
        const result = validateField(field, plan[field], descriptor, basePath);
        errors.push(...result.errors);
      }
    }
  }

  return errors;
}

// ── Main validation function ──────────────────────────────────────────────────

/**
 * Validate a leadership provider output against the canonical contract schema.
 *
 * Fail-closed contract:
 *   - null/undefined payload        → ok=false, status=blocked, reasonCode=MISSING_INPUT
 *   - non-object payload            → ok=false, status=blocked, reasonCode=INVALID_TYPE
 *   - unknown contractType          → ok=false, status=blocked, reasonCode=UNKNOWN_CONTRACT_TYPE
 *   - schema load failure           → ok=false, status=blocked, reasonCode=SCHEMA_LOAD_ERROR
 *   - missing required field        → ok=false, status=blocked, reasonCode=MISSING_FIELD
 *   - field fails type/enum/length  → ok=false, status=blocked, reasonCode=INVALID_FIELD
 *   - all checks pass               → ok=true,  status=ok
 *
 * Error entries include: { field, reasonCode, message, payloadPath, sourceFile }
 * sourceFile is always set to LEADERSHIP_SCHEMA_PATH for machine-readable anchoring.
 *
 * Rollback path:
 *   Pass options.mode = "warn" to downgrade hard failures to warnings (status="warn").
 *   Default is "enforce". Never set mode=warn in production without explicit config opt-in.
 *
 * @param {string} contractType  — one of LEADERSHIP_CONTRACT_TYPE values
 * @param {any}    payload       — parsed provider output (untrusted)
 * @param {object} [options]
 * @param {string} [options.mode="enforce"]  — "enforce" | "warn"
 * @returns {{ ok: boolean, status: "ok"|"blocked"|"warn", reasonCode: string, errors: object[] }}
 */
export function validateLeadershipContract(contractType, payload, options: any = {}) {
  const mode = options.mode === "warn" ? "warn" : "enforce";
  const sourceFile = LEADERSHIP_SCHEMA_PATH;

  // ── Missing input ──────────────────────────────────────────────────────────
  if (payload === null || payload === undefined) {
    const result = {
      ok: false,
      status: mode === "warn" ? "warn" : "blocked",
      reasonCode: TRUST_BOUNDARY_REASON.MISSING_INPUT,
      errors: [{
        field: "(root)",
        reasonCode: TRUST_BOUNDARY_REASON.MISSING_INPUT,
        message: "payload is null or undefined — no output received from provider",
        payloadPath: "(root)",
        sourceFile
      }]
    };
    return result;
  }

  // ── Invalid type ───────────────────────────────────────────────────────────
  if (typeof payload !== "object" || Array.isArray(payload)) {
    return {
      ok: false,
      status: mode === "warn" ? "warn" : "blocked",
      reasonCode: TRUST_BOUNDARY_REASON.INVALID_TYPE,
      errors: [{
        field: "(root)",
        reasonCode: TRUST_BOUNDARY_REASON.INVALID_TYPE,
        message: `payload must be a plain object, got ${Array.isArray(payload) ? "array" : typeof payload}`,
        payloadPath: "(root)",
        sourceFile
      }]
    };
  }

  // ── Load schema ────────────────────────────────────────────────────────────
  let schema;
  try {
    schema = loadSchema();
  } catch (err) {
    return {
      ok: false,
      status: mode === "warn" ? "warn" : "blocked",
      reasonCode: TRUST_BOUNDARY_REASON.SCHEMA_LOAD_ERROR,
      errors: [{
        field: "(schema)",
        reasonCode: TRUST_BOUNDARY_REASON.SCHEMA_LOAD_ERROR,
        message: String(err.message || err),
        payloadPath: "(schema)",
        sourceFile
      }]
    };
  }

  // ── Unknown contract type ──────────────────────────────────────────────────
  const contracts = schema?.contracts || {};
  if (!(contractType in contracts)) {
    const knownTypes = Object.keys(contracts).join(", ");
    return {
      ok: false,
      status: mode === "warn" ? "warn" : "blocked",
      reasonCode: TRUST_BOUNDARY_REASON.UNKNOWN_CONTRACT_TYPE,
      errors: [{
        field: "(contractType)",
        reasonCode: TRUST_BOUNDARY_REASON.UNKNOWN_CONTRACT_TYPE,
        message: `unknown contract type "${contractType}"; known types: ${knownTypes}`,
        payloadPath: "(contractType)",
        sourceFile
      }]
    };
  }

  const contract = contracts[contractType];
  const requiredFields = contract.requiredFields || [];
  const fieldDescriptors = contract.fields || {};
  const errors = [];
  const basePath = `(${contractType})`;

  // ── Check required fields ──────────────────────────────────────────────────
  for (const field of requiredFields) {
    if (!(field in payload)) {
      errors.push({
        field,
        reasonCode: TRUST_BOUNDARY_REASON.MISSING_FIELD,
        message: `required field "${field}" is absent from ${contractType} payload`,
        payloadPath: `${basePath}.${field}`,
        sourceFile
      });
      continue;
    }

    const descriptor = fieldDescriptors[field];
    if (descriptor) {
      const result = validateField(field, payload[field], descriptor, basePath);
      errors.push(...result.errors.map(e => ({ ...e, sourceFile })));
    }
  }

  // ── Validate plan items for planner contracts ──────────────────────────────
  if (contractType === LEADERSHIP_CONTRACT_TYPE.PLANNER && Array.isArray(payload.plans)) {
    const planErrors = validatePlanItems(payload.plans, contract);
    errors.push(...planErrors.map(e => ({ ...e, sourceFile })));
  }

  if (errors.length === 0) {
    return { ok: true, status: "ok", reasonCode: TRUST_BOUNDARY_REASON.OK, errors: [] };
  }

  // Determine the primary reason code from the first error
  const primaryReasonCode = errors[0].reasonCode || TRUST_BOUNDARY_REASON.INVALID_FIELD;

  return {
    ok: false,
    status: mode === "warn" ? "warn" : "blocked",
    reasonCode: primaryReasonCode,
    errors
  };
}

// ── Retry delay calculator ────────────────────────────────────────────────────

/**
 * Calculate the retry delay (ms) for a given attempt number using exponential backoff.
 *
 * attempt 1 → TRUST_BOUNDARY_RETRY.delayMs
 * attempt 2 → delayMs × multiplier
 * attempt 3 → delayMs × multiplier²
 *
 * @param {number} attempt — 1-indexed attempt number
 * @returns {number} delay in milliseconds
 */
export function trustBoundaryRetryDelayMs(attempt) {
  const { delayMs, multiplier } = TRUST_BOUNDARY_RETRY;
  return delayMs * Math.pow(multiplier, Math.max(0, attempt - 1));
}
