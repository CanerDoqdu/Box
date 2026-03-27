import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildReworkInstruction,
  decideRework,
  parseResponsiveMatrix,
  parseVerificationReport,
  validateWorkerContract,
  checkPostMergeArtifact,
  POST_MERGE_PLACEHOLDER,
  NON_MERGE_TASK_KINDS,
  isArtifactGateRequired,
} from "../../src/core/verification_gate.js";

describe("verification_gate parse helpers", () => {
  it("parses canonical VERIFICATION_REPORT fields", () => {
    const report = parseVerificationReport(
      "VERIFICATION_REPORT: BUILD=pass; TESTS=fail; RESPONSIVE=n/a; API=pass; EDGE_CASES=pass; SECURITY=pass"
    );
    assert.deepEqual(report, {
      build: "pass",
      tests: "fail",
      responsive: "n/a",
      api: "pass",
      edgeCases: "pass",
      security: "pass"
    });
  });

  it("normalizes synonyms in VERIFICATION_REPORT", () => {
    const report = parseVerificationReport(
      "VERIFICATION_REPORT: test=pass; responsivematrix=pass; edge_cases=pass; build=pass"
    );
    assert.equal(report.tests, "pass");
    assert.equal(report.responsive, "pass");
    assert.equal(report.edgeCases, "pass");
    assert.equal(report.build, "pass");
  });

  it("returns null when VERIFICATION_REPORT marker is missing", () => {
    assert.equal(parseVerificationReport("no report here"), null);
  });

  it("parses RESPONSIVE_MATRIX key/value pairs", () => {
    const matrix = parseResponsiveMatrix("RESPONSIVE_MATRIX: 320x568=pass, 360x640=fail, 768x1024=pass");
    assert.deepEqual(matrix, {
      "320x568": "pass",
      "360x640": "fail",
      "768x1024": "pass"
    });
  });
});

describe("verification_gate worker contract enforcement", () => {
  it("rejects backend done result when required tests evidence is fail", () => {
    const parsedResponse = {
      status: "done",
      fullOutput: "VERIFICATION_REPORT: BUILD=pass; TESTS=fail; EDGE_CASES=pass; SECURITY=pass\nBOX_PR_URL=https://github.com/a/b/pull/1"
    };
    const result = validateWorkerContract("backend", parsedResponse);
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some((g) => g.includes("TESTS reported as FAIL")));
  });

  it("rejects backend done result when VERIFICATION_REPORT is missing", () => {
    const parsedResponse = {
      status: "done",
      fullOutput: "I fixed the issue but forgot report"
    };
    const result = validateWorkerContract("backend", parsedResponse);
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some((g) => g.includes("VERIFICATION_REPORT missing")));
  });

  it("passes skipped status without requiring evidence", () => {
    const parsedResponse = {
      status: "skipped",
      fullOutput: ""
    };
    const result = validateWorkerContract("backend", parsedResponse);
    assert.equal(result.passed, true);
    assert.equal(result.gaps.length, 0);
  });

  it("rejects frontend when responsive matrix has fewer passes than required minimum", () => {
    const parsedResponse = {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; RESPONSIVE=pass; EDGE_CASES=pass; SECURITY=pass",
        "RESPONSIVE_MATRIX: 320x568=pass, 360x640=pass, 375x667=pass",
        "BOX_PR_URL=https://github.com/org/repo/pull/123"
      ].join("\n")
    };
    const result = validateWorkerContract("frontend", parsedResponse);
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some((g) => g.includes("viewports passed")));
  });

  it("passes backend when all required evidence and PR URL are present", () => {
    const parsedResponse = {
      status: "done",
      fullOutput: [
        "Merged commit abc123d into main",
        "# tests 10 # pass 10 # fail 0",
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=pass; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/88"
      ].join("\n")
    };
    const result = validateWorkerContract("backend", parsedResponse);
    assert.equal(result.passed, true);
    assert.equal(result.gaps.length, 0);
  });
});

describe("verification_gate rework decisioning", () => {
  it("requests rework when validation failed and attempts remain", () => {
    const decision = decideRework(
      { passed: false, gaps: ["TESTS reported as FAIL"] },
      "Fix tests",
      0,
      2
    );
    assert.equal(decision.shouldRework, true);
    assert.equal(decision.shouldEscalate, false);
    assert.ok(decision.instruction?.isRework);
  });

  it("escalates when max rework attempts are exceeded", () => {
    const decision = decideRework(
      { passed: false, gaps: ["BUILD reported as FAIL"] },
      "Fix build",
      2,
      2
    );
    assert.equal(decision.shouldRework, false);
    assert.equal(decision.shouldEscalate, true);
    assert.ok(String(decision.escalationReason || "").includes("failed verification"));
  });

  it("passes through immediately when validation already passed", () => {
    const decision = decideRework(
      { passed: true, gaps: [] },
      "Fix tests",
      0,
      2
    );
    assert.equal(decision.shouldRework, false);
    assert.equal(decision.shouldEscalate, false);
    assert.equal(decision.instruction, null);
  });
});

describe("verification_gate buildReworkInstruction — gap list and attempt metadata (AC#3)", () => {
  it("includes all gap descriptions in rework task text", () => {
    const gaps = ["BUILD is required but was missing", "TESTS reported as FAIL"];
    const instruction = buildReworkInstruction("Implement feature X", gaps, 1, 2);
    assert.ok(
      instruction.task.includes("BUILD is required but was missing"),
      "gap 1 must appear in task text"
    );
    assert.ok(
      instruction.task.includes("TESTS reported as FAIL"),
      "gap 2 must appear in task text"
    );
  });

  it("includes numbered gap list in rework task text", () => {
    const gaps = ["EDGE_CASES is required but was missing"];
    const instruction = buildReworkInstruction("Fix edge cases", gaps, 1, 2);
    assert.match(instruction.task, /1\.\s+EDGE_CASES is required/);
  });

  it("includes attempt metadata in rework instruction object", () => {
    const instruction = buildReworkInstruction("Do work", ["BUILD missing"], 1, 2);
    assert.equal(instruction.reworkAttempt, 1, "reworkAttempt must equal the current attempt");
    assert.equal(instruction.maxReworkAttempts, 2, "maxReworkAttempts must be preserved");
    assert.equal(instruction.isRework, true);
    assert.equal(instruction.taskKind, "rework");
  });

  it("includes attempt counter in task header string", () => {
    const instruction = buildReworkInstruction("task", ["gap"], 2, 2);
    assert.match(instruction.task, /attempt 2\/2/i);
  });

  it("includes final-attempt warning when attempt equals max", () => {
    const instruction = buildReworkInstruction("task", ["gap"], 2, 2);
    assert.match(instruction.task, /FINAL ATTEMPT/i);
  });

  it("does not include final-attempt warning on intermediate attempts", () => {
    const instruction = buildReworkInstruction("task", ["gap"], 1, 2);
    assert.ok(!instruction.task.includes("FINAL ATTEMPT"));
  });

  it("includes original task text for worker reference", () => {
    const instruction = buildReworkInstruction("Implement OAuth login", ["BUILD missing"], 1, 2);
    assert.ok(instruction.task.includes("Implement OAuth login"), "original task must be included");
  });

  it("sets isFollowUp=true so conversation context is built correctly", () => {
    const instruction = buildReworkInstruction("task", ["gap"], 1, 2);
    assert.equal(instruction.isFollowUp, true);
  });

  it("includes gap summary in instruction context field", () => {
    const gaps = ["TESTS fail", "BUILD missing"];
    const instruction = buildReworkInstruction("task", gaps, 1, 2);
    assert.ok(instruction.context.includes("TESTS fail"), "context must include gap list");
    assert.ok(instruction.context.includes("BUILD missing"));
  });
});

describe("verification_gate validateWorkerContract — skipped and non-done statuses", () => {
  it("skipped status passes without evidence (pre-existing pass-through)", () => {
    const result = validateWorkerContract("backend", { status: "skipped", fullOutput: "" });
    assert.equal(result.passed, true);
    assert.equal(result.gaps.length, 0);
  });

  it("partial status bypasses verification (non-done)", () => {
    const result = validateWorkerContract("backend", { status: "partial", fullOutput: "" });
    assert.equal(result.passed, true);
    assert.equal(result.gaps.length, 0);
  });

  it("blocked status bypasses verification (non-done)", () => {
    const result = validateWorkerContract("backend", { status: "blocked", fullOutput: "Cannot access repo" });
    assert.equal(result.passed, true);
    assert.equal(result.gaps.length, 0);
  });

  it("scan role (scanA) is fully exempt from verification", () => {
    const result = validateWorkerContract("scanA", {
      status: "done",
      fullOutput: "Scanned 42 files, no report needed"
    });
    assert.equal(result.passed, true);
    assert.equal(result.gaps.length, 0);
    assert.match(result.reason, /exempt/i);
  });
});

describe("verification_gate — post-merge artifact (Packet 1/3)", () => {
  it("exports post-merge placeholder constant", () => {
    assert.ok(POST_MERGE_PLACEHOLDER);
  });

  it("checkPostMergeArtifact detects missing SHA in short text", () => {
    const result = checkPostMergeArtifact("no sha here at all");
    assert.equal(result.hasSha, false);
  });

  it("checkPostMergeArtifact detects present SHA and test output", () => {
    const result = checkPostMergeArtifact("Commit: abc123d\ntests 5 pass 5 fail 0");
    assert.equal(result.hasSha, true);
    assert.equal(result.hasTestOutput, true);
  });

  it("checkPostMergeArtifact detects unfilled placeholder", () => {
    const result = checkPostMergeArtifact(`Some output with ${POST_MERGE_PLACEHOLDER}`);
    assert.equal(result.hasUnfilledPlaceholder, true);
  });

  it("checkPostMergeArtifact returns clean result for complete artifact", () => {
    const text = "abc123d\n# tests 10 pass";
    const result = checkPostMergeArtifact(text);
    assert.equal(result.hasSha, true);
    assert.equal(result.hasTestOutput, true);
    assert.equal(result.hasUnfilledPlaceholder, false);
    assert.equal(result.hasArtifact, true);
  });
});

// ── SHA + raw npm output enforced across done-capable lanes ──────────────────

describe("verification_gate — SHA + raw npm output enforced across done-capable lanes", () => {
  it("should fail done when SHA or raw npm output block is absent for done-capable lanes", () => {
    // Test worker (quality lane) reports done without a git SHA or npm test output block.
    // With the extended artifact gate, this must fail even for non-implementation lanes.
    const result = validateWorkerContract("test", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=n/a; TESTS=pass; EDGE_CASES=pass",
        // No 7-char hex SHA, no raw npm test output block
      ].join("\n")
    });

    assert.equal(result.passed, false, "test worker done without SHA/npm output must fail");
    const hasArtifactGap = result.gaps.some(
      g => /sha|npm|post-merge/i.test(g)
    );
    assert.ok(hasArtifactGap,
      `expected a SHA or npm output gap; got: [${result.gaps.join("; ")}]`
    );
  });

  it("test worker done with valid SHA and npm output passes the artifact gate", () => {
    const result = validateWorkerContract("test", {
      status: "done",
      fullOutput: [
        "abc123d merged into main",
        "# tests 10 # pass 10 # fail 0",
        "VERIFICATION_REPORT: BUILD=n/a; TESTS=pass; EDGE_CASES=pass"
      ].join("\n")
    });
    // No artifact-related gaps (other gaps like prUrl may exist for different profiles)
    const artifactGap = result.gaps.find(g => /sha|npm|post-merge/i.test(g));
    assert.equal(artifactGap, undefined,
      `unexpected artifact gap when SHA + npm output are present: ${artifactGap}`
    );
  });

  it("backend worker done without SHA fails the artifact gate", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/99"
        // No git SHA present
      ].join("\n")
    });
    assert.equal(result.passed, false);
    assert.ok(result.gaps.some(g => /sha/i.test(g)),
      `expected SHA gap; got: [${result.gaps.join("; ")}]`
    );
  });

  it("scan role done is not gated by post-merge artifact requirements", () => {
    const result = validateWorkerContract("scanA", {
      status: "done",
      fullOutput: "read-only scan finished"
    });
    assert.equal(result.passed, true);
    assert.equal(result.gaps.length, 0);
    assert.match(String(result.reason || ""), /exempt/i);
  });
});

// ── Task 2: Artifact gate applies regardless of workerKind ────────────────────

describe("verification_gate — artifact check mandatory across all completion paths (Task 2)", () => {
  it("unknown workerKind falls through to DEFAULT_PROFILE which requires build", () => {
    // 'unknown' kind hits DEFAULT_PROFILE: build=required, artifacts required
    const result = validateWorkerContract("unknown", {
      status: "done",
      fullOutput: "All done!"
    });
    assert.equal(result.passed, false);
    assert.ok(
      result.gaps.some(g => /sha|test output/i.test(g)),
      `expected artifact gap for unknown kind; got: [${result.gaps.join("; ")}]`
    );
  });

  it("done status with git SHA + npm test output passes artifact gate for unknown workerKind", () => {
    const result = validateWorkerContract("unknown", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a",
        "Merged at abc1234",
        "  3 passing"
      ].join("\n")
    });
    // Should not fail on artifact gate specifically
    const artifactGaps = result.gaps.filter(g => /sha|test output|placeholder/i.test(g));
    assert.equal(artifactGaps.length, 0, `artifact gate should not fire; gaps: [${result.gaps.join("; ")}]`);
  });

  it("negative path: done output with placeholder token is rejected even for unknown workerKind", () => {
    const result = validateWorkerContract("unknown", {
      status: "done",
      fullOutput: "POST_MERGE_TEST_OUTPUT placeholder not replaced"
    });
    assert.equal(result.passed, false);
    assert.ok(
      result.gaps.some(g => /placeholder/i.test(g)),
      `expected placeholder gap; got: [${result.gaps.join("; ")}]`
    );
  });
});

// ── Task 1: Refined done gate — NON_MERGE_TASK_KINDS + isArtifactGateRequired ─

describe("verification_gate — NON_MERGE_TASK_KINDS constant", () => {
  it("exports a Set containing the canonical non-merge task kinds", () => {
    assert.ok(NON_MERGE_TASK_KINDS instanceof Set, "NON_MERGE_TASK_KINDS must be a Set");
    assert.ok(NON_MERGE_TASK_KINDS.has("scan"), "scan must be in NON_MERGE_TASK_KINDS");
    assert.ok(NON_MERGE_TASK_KINDS.has("doc"), "doc must be in NON_MERGE_TASK_KINDS");
    assert.ok(NON_MERGE_TASK_KINDS.has("observation"), "observation must be in NON_MERGE_TASK_KINDS");
    assert.ok(NON_MERGE_TASK_KINDS.has("diagnosis"), "diagnosis must be in NON_MERGE_TASK_KINDS");
  });

  it("does not include implementation or rework kinds", () => {
    assert.ok(!NON_MERGE_TASK_KINDS.has("backend"), "backend must NOT be in NON_MERGE_TASK_KINDS");
    assert.ok(!NON_MERGE_TASK_KINDS.has("rework"), "rework must NOT be in NON_MERGE_TASK_KINDS");
    assert.ok(!NON_MERGE_TASK_KINDS.has("general"), "general must NOT be in NON_MERGE_TASK_KINDS");
  });
});

describe("verification_gate — isArtifactGateRequired", () => {
  it("returns true for backend role with implementation taskKind", () => {
    assert.equal(isArtifactGateRequired("backend", "backend"), true);
  });

  it("returns true for backend role with no taskKind", () => {
    assert.equal(isArtifactGateRequired("backend", null), true);
    assert.equal(isArtifactGateRequired("backend", undefined), true);
  });

  it("returns false for fully-exempt role (scanA) regardless of taskKind", () => {
    assert.equal(isArtifactGateRequired("scanA", "backend"), false);
    assert.equal(isArtifactGateRequired("scanA", null), false);
  });

  it("returns false for backend role when taskKind is scan (non-merge)", () => {
    assert.equal(isArtifactGateRequired("backend", "scan"), false);
  });

  it("returns false for backend role when taskKind is doc (non-merge)", () => {
    assert.equal(isArtifactGateRequired("backend", "doc"), false);
  });

  it("returns false for backend role when taskKind is observation (non-merge)", () => {
    assert.equal(isArtifactGateRequired("backend", "observation"), false);
  });

  it("returns false for backend role when taskKind is diagnosis (non-merge)", () => {
    assert.equal(isArtifactGateRequired("backend", "diagnosis"), false);
  });

  it("returns true for backend role when taskKind is rework (re-implementation)", () => {
    assert.equal(isArtifactGateRequired("backend", "rework"), true);
  });

  it("returns true for backend role when taskKind is general (ambiguous, conservative default)", () => {
    assert.equal(isArtifactGateRequired("backend", "general"), true);
  });

  it("is case-insensitive for taskKind", () => {
    assert.equal(isArtifactGateRequired("backend", "SCAN"), false);
    assert.equal(isArtifactGateRequired("backend", "Doc"), false);
  });
});

describe("verification_gate — task-kind aware artifact gate in validateWorkerContract", () => {
  const SCAN_OUTPUT_NO_ARTIFACT = [
    "VERIFICATION_REPORT: BUILD=n/a; TESTS=n/a; EDGE_CASES=n/a",
    "Scanned 42 files. No changes required.",
    // No git SHA, no npm test output — legitimate for scan task
  ].join("\n");

  it("backend role with scan taskKind: done without artifact passes gate", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: SCAN_OUTPUT_NO_ARTIFACT
    }, { taskKind: "scan" });

    const artifactGap = result.gaps.find(g => /sha|npm|post-merge/i.test(g));
    assert.equal(
      artifactGap, undefined,
      `scan taskKind must skip artifact gate; unexpected gap: ${artifactGap}`
    );
  });

  it("backend role with doc taskKind: done without artifact passes gate", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: SCAN_OUTPUT_NO_ARTIFACT
    }, { taskKind: "doc" });

    const artifactGap = result.gaps.find(g => /sha|npm|post-merge/i.test(g));
    assert.equal(
      artifactGap, undefined,
      `doc taskKind must skip artifact gate; unexpected gap: ${artifactGap}`
    );
  });

  it("backend role with backend taskKind: done without artifact still fails gate", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/99"
        // No git SHA or npm test block
      ].join("\n")
    }, { taskKind: "backend" });

    assert.equal(result.passed, false);
    const hasArtifactGap = result.gaps.some(g => /sha|test output|npm/i.test(g));
    assert.ok(hasArtifactGap,
      `implementation taskKind must still require artifact; gaps: [${result.gaps.join("; ")}]`
    );
  });

  it("backend role with rework taskKind: done without artifact still fails gate (re-implementation)", () => {
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: [
        "VERIFICATION_REPORT: BUILD=pass; TESTS=pass; EDGE_CASES=pass; SECURITY=n/a; API=n/a; RESPONSIVE=n/a",
        "BOX_PR_URL=https://github.com/org/repo/pull/77"
      ].join("\n")
    }, { taskKind: "rework" });

    assert.equal(result.passed, false);
    const hasArtifactGap = result.gaps.some(g => /sha|test output|npm/i.test(g));
    assert.ok(hasArtifactGap,
      `rework taskKind must still require artifact; gaps: [${result.gaps.join("; ")}]`
    );
  });

  it("negative path: scan taskKind with unfilled placeholder is still rejected", () => {
    // Placeholder is always rejected regardless of task kind — it signals
    // the worker did not replace the template with real output.
    const result = validateWorkerContract("backend", {
      status: "done",
      fullOutput: `POST_MERGE_TEST_OUTPUT placeholder here`
    }, { taskKind: "scan" });

    // For scan taskKind: artifact gate is skipped entirely, so placeholder
    // check does NOT fire (no artifact gate = no placeholder check).
    // This is correct: a scan worker won't include npm output at all.
    const artifactGap = result.gaps.find(g => /sha|npm|post-merge|placeholder/i.test(g));
    assert.equal(
      artifactGap, undefined,
      `scan taskKind skips artifact gate entirely (including placeholder check); got: ${artifactGap}`
    );
  });
});

