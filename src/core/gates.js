/**
 * @deprecated
 * This module is superseded by `verification_gate.js` which is the single source of truth
 * for post-worker result validation. `validateWorkerContract` in verification_gate.js is wired
 * into the Moses coordinator loop and handles all required-evidence checks.
 *
 * `evaluateGates` remains exported for backward compatibility but is not called by any runtime
 * path. The fields it checks (buildOk, testsOk, lintOk, securityOk) are not populated by the
 * worker response parser — verification is done via VERIFICATION_REPORT text markers instead.
 *
 * Do not add new logic here. Extend verification_gate.js or verification_profiles.js instead.
 */
export function evaluateGates(config, workerResult, task = {}) {
  const gates = config.gates;
  const failures = [];

  if (gates.requireBuild && !workerResult.buildOk) {
    failures.push("build gate failed");
  }

  if (gates.requireTests && !workerResult.testsOk) {
    failures.push("test gate failed");
  }

  if (gates.requireLint && !workerResult.lintOk) {
    failures.push("lint gate failed");
  }

  if (gates.requireSecurityScan && !workerResult.securityOk) {
    failures.push("security gate failed");
  }

  if (typeof workerResult.coveragePercent === "number" && workerResult.coveragePercent < gates.minCoveragePercent) {
    failures.push(`coverage below threshold: ${workerResult.coveragePercent} < ${gates.minCoveragePercent}`);
  }

  // Empty-changeset guardrail: reject tasks that changed zero real code files.
  // BOX_FALLBACK_NOTE.md and other non-code artifacts do not count.
  // Diagnostic/scan tasks (kind=scan or contract.requireCodeChanges=false) are exempt —
  // their output is an analysis report, not a code change.
  const taskKind = String(task?.kind || "").toLowerCase();
  const codeChangesRequired = task?.contract?.requireCodeChanges !== false
    && taskKind !== "scan"
    && taskKind !== "diagnostic";
  if (codeChangesRequired) {
    const meta = workerResult.copilotMeta || {};
    const changedFiles = Array.isArray(meta.changedFiles) ? meta.changedFiles : [];
    const nonArtifactFiles = changedFiles.filter((f) => {
      const lower = String(f || "").toLowerCase();
      return !lower.endsWith("fallback_note.md") && !lower.endsWith(".md") || lower.includes("src/");
    });
    const isFallbackProvider = String(meta.invocation || "") === "fallback-provider";
    if (isFallbackProvider || changedFiles.length === 0 || nonArtifactFiles.length === 0) {
      failures.push("empty changeset: no real code files modified");
    }
  }

  return {
    ok: failures.length === 0,
    failures
  };
}
