import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildReworkInstruction,
  decideRework,
  parseResponsiveMatrix,
  parseVerificationReport,
  validateWorkerContract
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
