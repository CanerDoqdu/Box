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
