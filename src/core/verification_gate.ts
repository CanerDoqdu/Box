/**
 * Verification Gate — Contract validator + auto-rework controller
 *
 * After a worker reports "done", this module validates the response
 * against the role's verification profile. If required evidence is
 * missing or failed, it produces a rework instruction for Athena to
 * re-dispatch the worker with specific gap feedback.
 *
 * Anti-loop: max rework attempts are configurable (default 2).
 * After exhausting retries, the task escalates instead of looping.
 */

import { getVerificationProfile } from "./verification_profiles.js";

// ── Post-merge verification artifact patterns (Packet 1) ───────────────────
// Worker output must contain a git SHA and raw npm test stdout block for
// BOX_STATUS=done to be accepted on merge-oriented tasks.

/** Regex matching a 7-40 character hex git SHA in output. */
const GIT_SHA_PATTERN = /\b[0-9a-f]{7,40}\b/i;

/**
 * Regex matching an explicit BOX_MERGED_SHA marker.
 * Workers that include this explicit marker provide stronger evidence than
 * pattern-detected hex strings, since it unambiguously identifies the post-merge
 * commit SHA rather than any incidental hex value in the output.
 */
const BOX_MERGED_SHA_PATTERN = /BOX_MERGED_SHA\s*=\s*([0-9a-f]{7,40})/i;

/** Regex matching raw npm test output block (pass/fail counts). */
const NPM_TEST_OUTPUT_PATTERN = /(?:passing|failing|tests?\s+\d|✓|✗|#\s+tests\s+\d|test result|suites?\s+\d|\d+\s+pass)/i;

/**
 * Regex matching an explicit NPM test output block delimited by
 * ===NPM TEST OUTPUT START=== / ===NPM TEST OUTPUT END=== markers.
 * Workers that include this explicit block provide stronger evidence than
 * scattered pattern matches across the full output.
 */
const NPM_TEST_BLOCK_PATTERN = /={3,}\s*NPM TEST OUTPUT\s*(?:START\s*)?={3,}[\s\S]*?={3,}\s*(?:NPM TEST OUTPUT\s*)?(?:END\s*)?={3,}/i;

/** Placeholder literal that must be replaced in verification reports. */
export const POST_MERGE_PLACEHOLDER = "POST_MERGE_TEST_OUTPUT";

/**
 * Canonical artifact-gate gap reason strings.
 * Shared by worker_runner and evolution_executor so failure reasons are identical
 * regardless of which finalization path triggers the artifact check.
 */
export const ARTIFACT_GAP = Object.freeze({
  UNFILLED_PLACEHOLDER: "POST_MERGE_TEST_OUTPUT placeholder is still unfilled — replace it with actual test output",
  MISSING_SHA:          "Post-merge git SHA missing — run 'git rev-parse HEAD' on merged state and include the SHA",
  MISSING_TEST_OUTPUT:  "Post-merge raw npm test output missing — run 'npm test' on merged state and paste raw stdout",
});

/** Prefix used in taskState.error when the artifact gate fails. */
export const ARTIFACT_GATE_ERROR_PREFIX = "artifact-gate";

/**
 * Check if worker output contains the required post-merge verification artifact.
 * The artifact is: a git SHA + raw npm test stdout block.
 *
 * Explicit markers are preferred over pattern detection:
 *   - BOX_MERGED_SHA=<sha>  takes precedence over any 7-40 hex string in the output.
 *   - ===NPM TEST OUTPUT START=== ... ===NPM TEST OUTPUT END=== block is preferred over
 *     scattered npm output patterns; falls back to the legacy pattern for compatibility.
 *
 * @param {string} output — full worker output text
 * @returns {{ hasArtifact: boolean, hasSha: boolean, hasTestOutput: boolean, hasUnfilledPlaceholder: boolean, mergedSha: string | null, hasExplicitShaMarker: boolean, hasExplicitTestBlock: boolean }}
 */
export function checkPostMergeArtifact(output) {
  const text = String(output || "");

  // Prefer explicit BOX_MERGED_SHA=<sha> marker; fall back to loose hex detection.
  const explicitShaMatch = BOX_MERGED_SHA_PATTERN.exec(text);
  const hasExplicitShaMarker = explicitShaMatch !== null;
  const mergedSha: string | null = explicitShaMatch ? explicitShaMatch[1] : null;
  const hasSha = hasExplicitShaMarker || GIT_SHA_PATTERN.test(text);

  // Prefer explicit NPM test output block; fall back to legacy pattern.
  const hasExplicitTestBlock = NPM_TEST_BLOCK_PATTERN.test(text);
  const hasTestOutput = hasExplicitTestBlock || NPM_TEST_OUTPUT_PATTERN.test(text);

  const hasUnfilledPlaceholder = text.includes(POST_MERGE_PLACEHOLDER);

  return {
    hasArtifact: hasSha && hasTestOutput && !hasUnfilledPlaceholder,
    hasSha,
    hasTestOutput,
    hasUnfilledPlaceholder,
    mergedSha,
    hasExplicitShaMarker,
    hasExplicitTestBlock,
  };
}

/**
 * Extract the merged commit SHA from worker output.
 *
 * Returns the value from the explicit BOX_MERGED_SHA=<sha> marker when present.
 * Falls back to null when the explicit marker is absent (loose SHA detection is
 * intentionally NOT used here — loose detection is for the hasArtifact check only).
 *
 * @param {string} output — full worker output text
 * @returns {string | null} — 7-40 char hex SHA, or null when not explicitly declared
 */
export function extractMergedSha(output: string): string | null {
  const match = BOX_MERGED_SHA_PATTERN.exec(String(output || ""));
  return match ? match[1] : null;
}

/**
 * Canonical artifact gap collector — shared contract used by worker_runner,
 * evolution_executor, and validateWorkerContract so all finalization paths
 * produce identical gap reason strings from a single source of truth.
 *
 * @param {{ hasSha: boolean, hasTestOutput: boolean, hasUnfilledPlaceholder: boolean }} artifact
 *   — result of checkPostMergeArtifact()
 * @returns {string[]} ordered list of gap reason strings (empty when artifact is complete)
 */
export function collectArtifactGaps(artifact: { hasSha: boolean; hasTestOutput: boolean; hasUnfilledPlaceholder: boolean }): string[] {
  const gaps: string[] = [];
  if (artifact.hasUnfilledPlaceholder) gaps.push(ARTIFACT_GAP.UNFILLED_PLACEHOLDER);
  if (!artifact.hasSha)               gaps.push(ARTIFACT_GAP.MISSING_SHA);
  if (!artifact.hasTestOutput)         gaps.push(ARTIFACT_GAP.MISSING_TEST_OUTPUT);
  return gaps;
}

/**
 * Apply config-based gate overrides to a verification profile.
 * Gates config can upgrade optional evidence fields to required.
 *
 * Mapping:
 *   requireBuild: true        → build "optional"    → "required"
 *   requireTests: true        → tests "optional"    → "required"
 *   requireSecurityScan: true → security "optional" → "required"
 *
 * Exempt fields are never upgraded — exempt means not applicable for the role.
 *
 * @param {object} profile — profile from getVerificationProfile()
 * @param {object} gatesConfig — config.gates from box.config.json
 * @returns {object} — new profile with evidence overrides applied (original is not mutated)
 */
export function applyConfigOverrides(profile, gatesConfig) {
  if (!gatesConfig) return profile;

  const evidence = { ...profile.evidence };

  // Map config gate flags to their corresponding evidence field names
  const fieldMap = {
    requireBuild: "build",
    requireTests: "tests",
    requireSecurityScan: "security"
  };

  for (const [configKey, evidenceField] of Object.entries(fieldMap)) {
    if (gatesConfig[configKey] === true && evidence[evidenceField] === "optional") {
      evidence[evidenceField] = "required";
    }
  }

  return { ...profile, evidence };
}

/**
 * Parse VERIFICATION_REPORT from worker output.
 * Expected format: VERIFICATION_REPORT: BUILD=pass; TESTS=fail; RESPONSIVE=n/a; ...
 */
export function parseVerificationReport(output) {
  const text = String(output || "");
  const match = text.match(/VERIFICATION_REPORT:\s*([^\n\r]+)/i);
  if (!match) return null;

  const report: Record<string, string> = {};
  const pairs = match[1].split(";").map(s => s.trim()).filter(Boolean);
  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx < 0) continue;
    const key = pair.slice(0, eqIdx).trim().toLowerCase().replace(/[_\s]+/g, "");
    const value = pair.slice(eqIdx + 1).trim().toLowerCase();
    // Normalize key names
    const keyMap = {
      build: "build",
      tests: "tests",
      test: "tests",
      responsive: "responsive",
      responsivematrix: "responsive",
      api: "api",
      edgecases: "edgeCases",
      edge_cases: "edgeCases",
      security: "security"
    };
    const normalizedKey = keyMap[key];
    if (normalizedKey) {
      report[normalizedKey] = value; // "pass", "fail", "n/a"
    }
  }
  return report;
}

/**
 * Parse BOX_PR_URL from worker output.
 */
export function parsePrUrl(output) {
  const text = String(output || "");
  const match = text.match(/BOX_PR_URL\s*=\s*(https:\/\/github\.com\/[^\s]+)/i);
  return match ? match[1].trim() : null;
}

/**
 * Parse RESPONSIVE_MATRIX from worker output.
 * Expected format: RESPONSIVE_MATRIX: 320x568=pass, 360x640=fail, ...
 */
export function parseResponsiveMatrix(output) {
  const text = String(output || "");
  const match = text.match(/RESPONSIVE_MATRIX:\s*([^\n\r]+)/i);
  if (!match) return null;

  const matrix: Record<string, string> = {};
  const pairs = match[1].split(",").map(s => s.trim()).filter(Boolean);
  for (const pair of pairs) {
    const eqIdx = pair.indexOf("=");
    if (eqIdx < 0) continue;
    const viewport = pair.slice(0, eqIdx).trim();
    const result = pair.slice(eqIdx + 1).trim().toLowerCase();
    if (viewport && result) matrix[viewport] = result;
  }
  return Object.keys(matrix).length > 0 ? matrix : null;
}

/**
 * Task kinds that are non-merge by nature — they do not involve committing
 * or merging code, so the post-merge artifact gate (git SHA + npm test output)
 * does not apply.  Implementation and rework kinds are NOT in this set.
 */
export const NON_MERGE_TASK_KINDS = Object.freeze(new Set([
  "scan",
  "doc",
  "observation",
  "diagnosis",
]));

/**
 * Determine whether the post-merge artifact gate should run for a given
 * worker kind + task kind combination.
 *
 * Returns false (gate skipped) when:
 *   - The worker role is fully exempt (all evidence fields = "exempt"), OR
 *   - The task kind is a non-merge task (scan, doc, observation, diagnosis).
 *
 * @param {string} workerKind — role kind (e.g. "backend", "scanA")
 * @param {string|null|undefined} taskKind — instruction task kind
 * @returns {boolean} — true when the artifact gate must run
 */
export function isArtifactGateRequired(workerKind: string, taskKind?: string | null): boolean {
  // Exempt roles (scan/doc workers) never need artifacts
  const profile = getVerificationProfile(workerKind);
  const allExempt = Object.values(profile.evidence).every(v => v === "exempt");
  if (allExempt) return false;

  // Non-merge task kinds never produce a git SHA or test output
  if (taskKind && NON_MERGE_TASK_KINDS.has(String(taskKind).toLowerCase())) return false;

  return true;
}

/** Options for {@link validateWorkerContract}. */
export interface ValidateWorkerContractOptions {
  /** Config.gates object to upgrade optional evidence fields to required. */
  gatesConfig?: Record<string, unknown>;
  /**
   * The task kind from the instruction (e.g. "backend", "scan", "doc").
   * Non-merge task kinds (scan, doc, observation, diagnosis) are exempt from
   * the artifact gate even when the worker role is done-capable.
   */
  taskKind?: string | null;
}

/**
 * Validate a worker's output against its role's verification profile.
 *
 * @param {string} workerKind — the role kind from box.config.json (e.g. "frontend", "backend")
 * @param {object} parsedResponse — output from parseWorkerResponse() in worker_runner.js
 * @param {ValidateWorkerContractOptions} [options] — optional overrides
 * @returns {{ passed: boolean, gaps: string[], evidence: object }}
 */
export function validateWorkerContract(workerKind: string, parsedResponse: Record<string, unknown>, options: ValidateWorkerContractOptions = {}) {
  const baseProfile = getVerificationProfile(workerKind);
  const profile = options.gatesConfig ? applyConfigOverrides(baseProfile, options.gatesConfig) : baseProfile;
  const output = parsedResponse?.fullOutput || parsedResponse?.summary || "";
  const report = parseVerificationReport(output);
  const responsiveMatrix = parseResponsiveMatrix(output);
  const prUrl = parsePrUrl(output);

  const gaps: string[] = [];
  const evidence: Record<string, unknown> = {
    hasReport: !!report,
    report: report || {},
    responsiveMatrix: responsiveMatrix || {},
    prUrl: prUrl || null,
    profile: profile.kind
  };

  // If worker reported skipped (already-merged), pass immediately
  const status = String(parsedResponse?.status || "done").toLowerCase();
  if (status === "skipped") {
    return { passed: true, gaps: [], evidence, reason: "status=skipped, worker reported task already done" };
  }

  // If worker reported a non-done status, skip verification
  if (status !== "done") {
    return { passed: true, gaps: [], evidence, reason: `status=${status}, verification skipped` };
  }

  // Scan/doc roles are exempt from verification
  const allExempt = Object.values(profile.evidence).every(v => v === "exempt");
  if (allExempt) {
    return { passed: true, gaps: [], evidence, reason: "role exempt from verification" };
  }

  // Roles with at least one required evidence field are "done-capable lanes"
  const hasRequiredFields = Object.values(profile.evidence).some(v => v === "required");

  // ── Post-merge verification artifact gate ───────────────────────────────
  // Done-capable lanes (roles with at least one required evidence field) must
  // include a git SHA + raw test output when reporting done, UNLESS the task
  // kind is a non-merge kind (scan, doc, observation, diagnosis) — those tasks
  // do not produce a merged commit and are exempt from artifact requirements.
  // This gate is NON-BYPASSABLE — no caller option can disable it.
  const requireArtifact = hasRequiredFields
    && isArtifactGateRequired(workerKind, options.taskKind);
  if (requireArtifact) {
    const artifact = checkPostMergeArtifact(output);
    evidence.postMergeArtifact = artifact;
    for (const gap of collectArtifactGaps(artifact)) gaps.push(gap);
  }

  // No verification report at all — gap for any role with required fields
  if (!report && hasRequiredFields) {
    gaps.push("VERIFICATION_REPORT missing — worker did not provide any verification evidence");
    return { passed: false, gaps, evidence, reason: "no verification report" };
  }

  // Check each required field (except prUrl — handled separately below)
  for (const [field, requirement] of Object.entries(profile.evidence)) {
    if (requirement !== "required") continue;
    if (field === "prUrl") continue;

    const value = report?.[field];
    if (!value || value === "n/a") {
      gaps.push(`${field.toUpperCase()} is required but was ${value || "missing"}`);
    } else if (value === "fail") {
      gaps.push(`${field.toUpperCase()} reported as FAIL — worker must fix before done`);
    }
  }

  // Responsive viewport count check for frontend roles
  if (profile.responsiveRequired && responsiveMatrix) {
    const passCount = Object.values(responsiveMatrix).filter(v => v === "pass").length;
    if (passCount < profile.minViewports) {
      gaps.push(`RESPONSIVE: only ${passCount}/${profile.minViewports} viewports passed (need ≥${profile.minViewports})`);
    }
  } else if (profile.responsiveRequired && !responsiveMatrix) {
    gaps.push("RESPONSIVE_MATRIX missing — frontend role must verify responsive viewports");
  }

  // PR URL check — generic for all implementation roles that require it
  if (profile.evidence.prUrl === "required") {
    if (!prUrl) {
      gaps.push("BOX_PR_URL missing — worker must push a branch and open a real GitHub PR. Prose claims of completion are not accepted.");
    }
  }

  return {
    passed: gaps.length === 0,
    gaps,
    evidence,
    reason: gaps.length === 0 ? "all required evidence present and passing" : `${gaps.length} verification gap(s)`
  };
}

/**
 * Build a rework instruction when verification gaps are detected.
 *
 * @param {string} originalTask — the task the worker was originally assigned
 * @param {string[]} gaps — array of gap descriptions
 * @param {number} attempt — current rework attempt number (1-based)
 * @param {number} maxAttempts — maximum rework attempts allowed
 * @returns {object} — instruction object for Athena to re-dispatch
 */
export function buildReworkInstruction(originalTask, gaps, attempt, maxAttempts) {
  const gapList = gaps.map((g, i) => `  ${i + 1}. ${g}`).join("\n");

  const task = `## AUTO-REWORK — VERIFICATION GAPS DETECTED (attempt ${attempt}/${maxAttempts})

Your previous completion was REJECTED by the verification gate because the following evidence was missing or failed:

${gapList}

## WHAT YOU MUST DO

1. Go back to your work and fix each gap listed above.
2. Re-run verification for each gap (build, tests, responsive checks, etc.)
3. Include a complete VERIFICATION_REPORT in your response.
4. Do NOT repeat the same approach if it already failed — try a different strategy.

## ORIGINAL TASK (for reference)
${originalTask}

${attempt >= maxAttempts ? "⚠️ THIS IS YOUR FINAL ATTEMPT. If you cannot resolve all gaps, report BOX_STATUS=blocked with a root-cause analysis of why each gap cannot be resolved." : ""}`;

  return {
    task,
    context: `Rework attempt ${attempt}/${maxAttempts}. Gaps: ${gaps.join("; ")}`,
    isFollowUp: true,
    isRework: true,
    reworkAttempt: attempt,
    maxReworkAttempts: maxAttempts,
    taskKind: "rework"
  };
}

/**
 * Determine if auto-rework should be triggered.
 *
 * @param {object} validationResult — output from validateWorkerContract()
 * @param {number} currentAttempt — how many times this worker has been re-dispatched for this task
 * @param {number} maxAttempts — configurable max rework attempts (default from config)
 * @returns {{ shouldRework: boolean, instruction: object|null, shouldEscalate: boolean }}
 */
export function decideRework(validationResult, originalTask, currentAttempt, maxAttempts = 2) {
  if (validationResult.passed) {
    return { shouldRework: false, instruction: null, shouldEscalate: false };
  }

  const nextAttempt = currentAttempt + 1;

  if (nextAttempt > maxAttempts) {
    // Max retries exhausted — escalate to Athena, don't loop
    return {
      shouldRework: false,
      instruction: null,
      shouldEscalate: true,
      escalationReason: `Worker failed verification ${currentAttempt} times. Gaps: ${validationResult.gaps.join("; ")}`
    };
  }

  const instruction = buildReworkInstruction(
    originalTask,
    validationResult.gaps,
    nextAttempt,
    maxAttempts
  );

  return {
    shouldRework: true,
    instruction,
    shouldEscalate: false
  };
}
