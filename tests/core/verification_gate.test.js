import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
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
});
