/**
 * evidence_envelope.ts — Shared evidence contract between evolution executor
 * and Athena postmortem reviewer.
 *
 * Keeping these types in a standalone module avoids the circular import that
 * would result from evolution_executor.ts ↔ athena_reviewer.ts cross-importing.
 */

// ── Verification evidence ──────────────────────────────────────────────────────

/**
 * Slot-level pass/fail evidence derived from local verification command results.
 * "n/a" means the corresponding check was not exercised in this run.
 */
export type VerificationEvidence = {
  build: "pass" | "fail" | "n/a";
  tests: "pass" | "fail" | "n/a";
  lint:  "pass" | "fail" | "n/a";
};

// ── PR checks snapshot ────────────────────────────────────────────────────────

export type PrChecksSnapshot = {
  ok: boolean;
  passed: boolean;
  failed: string[];
  pending: string[];
  total: number;
  error?: string;
};

// ── Canonical evidence envelope ───────────────────────────────────────────────

/**
 * Canonical evidence envelope passed from the evolution executor to Athena's
 * postmortem reviewer.
 *
 * All fields that Athena reads must be declared here.  Adding ad-hoc fields on
 * the caller side is unsafe because Athena's deterministic fast-path gate reads
 * specific keys to decide whether to skip the premium AI call.
 *
 * Fast-path gate conditions (in runAthenaPostmortem):
 *   status === "done"
 *   && verificationPassed === true
 *   && verificationEvidence.build === "pass"
 *   && verificationEvidence.tests === "pass"
 */
export type EvidenceEnvelope = {
  /** Slug name of the worker role (e.g. "evolution-worker"). */
  roleName: string;
  /** BOX_STATUS emitted by the worker: "done" | "partial" | "blocked" | "error". */
  status: string;
  /** PR URL if the worker opened or updated a pull request. */
  prUrl?: string;
  /** Human-readable worker summary, may include a serialised VERIFICATION_REPORT. */
  summary: string;
  /** Files modified by the worker (BOX_FILES_TOUCHED). */
  filesTouched?: string[] | string;
  /** Concatenated stdout of local verification commands (human-readable). */
  verificationOutput?: string;
  /** True iff every non-blocked verification command exited 0. */
  verificationPassed?: boolean;
  /**
   * Slot-level evidence — required for Athena deterministic fast-path.
   * Must be populated by buildVerificationEvidence() before being passed to Athena.
   */
  verificationEvidence: VerificationEvidence;
  /** Remote CI check results read after the worker created/updated its PR. */
  prChecks?: PrChecksSnapshot;
  /** Athena pre-review summary given to the worker before execution. */
  preReviewAssessment?: string | null;
  /** Issues Athena flagged in the pre-review that the worker was asked to address. */
  preReviewIssues?: string[];
};

// ── Envelope structure validation ─────────────────────────────────────────────

const VALID_EVIDENCE_VALUES = new Set(["pass", "fail", "n/a"]);

/**
 * Validate the structure of an EvidenceEnvelope before it is passed to Athena.
 *
 * Required fields: roleName (string), status (string), summary (string),
 * verificationEvidence (object with build/tests/lint slots).
 * Each evidence slot must be "pass" | "fail" | "n/a".
 *
 * @param envelope — value to validate (untrusted)
 * @returns { valid: boolean; errors: string[] }
 */
export function validateEvidenceEnvelope(envelope: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!envelope || typeof envelope !== "object") {
    return { valid: false, errors: ["envelope must be a non-null object"] };
  }

  const e = envelope as Record<string, unknown>;

  if (typeof e.roleName !== "string" || e.roleName.trim() === "") {
    errors.push("roleName must be a non-empty string");
  }
  if (typeof e.status !== "string" || e.status.trim() === "") {
    errors.push("status must be a non-empty string");
  }
  if (typeof e.summary !== "string" || e.summary.trim() === "") {
    errors.push("summary must be a non-empty string");
  }

  const ev = e.verificationEvidence;
  if (!ev || typeof ev !== "object") {
    errors.push("verificationEvidence must be a non-null object");
  } else {
    const evObj = ev as Record<string, unknown>;
    for (const slot of ["build", "tests", "lint"] as const) {
      if (!VALID_EVIDENCE_VALUES.has(evObj[slot] as string)) {
        errors.push(`verificationEvidence.${slot} must be "pass", "fail", or "n/a"; got ${JSON.stringify(evObj[slot])}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

// ── Plan dispatch evidence coupling validation ────────────────────────────────

/**
 * Validate that a plan packet has adequate evidence coupling before it enters
 * the dispatch pipeline.
 *
 * A plan must carry at least one non-empty verification command and at least
 * one acceptance criterion so that automated completion signals can be verified
 * after the worker runs.  Plans that fail this check must be blocked at the
 * governance gate, not silently dispatched with unverifiable outcomes.
 *
 * @param plan — plan object as produced by Prometheus normalization (untrusted)
 * @returns { valid: boolean; errors: string[] }
 */
export function validatePlanEvidenceCoupling(plan: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (!plan || typeof plan !== "object") {
    return { valid: false, errors: ["plan must be a non-null object"] };
  }

  const p = plan as Record<string, unknown>;

  // verification_commands: must be a non-empty array with ≥1 non-empty string.
  const cmds = p.verification_commands;
  if (!Array.isArray(cmds) || cmds.length === 0) {
    errors.push("plan.verification_commands must be a non-empty array");
  } else {
    const nonEmpty = cmds.filter(c => typeof c === "string" && String(c).trim().length > 0);
    if (nonEmpty.length === 0) {
      errors.push("plan.verification_commands must contain at least one non-empty command string");
    }
  }

  // acceptance_criteria: must be a non-empty string or non-empty array of strings.
  const ac = p.acceptance_criteria;
  const acValid =
    (typeof ac === "string" && ac.trim().length > 0) ||
    (Array.isArray(ac) && ac.length > 0 &&
      ac.some(a => typeof a === "string" && String(a).trim().length > 0));
  if (!acValid) {
    errors.push("plan.acceptance_criteria must be a non-empty string or array");
  }

  return { valid: errors.length === 0, errors };
}
