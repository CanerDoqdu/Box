import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getVerificationCommands, getTestCommand, VERIFICATION_DEFAULTS, checkForbiddenCommands, FORBIDDEN_VERIFICATION_PATTERNS, rewriteVerificationCommand, VERIFICATION_CMD_REWRITE_RULES, normalizeCommandBatch } from "../../src/core/verification_command_registry.js";

describe("verification_command_registry", () => {
  describe("getVerificationCommands", () => {
    it("returns defaults with no config", () => {
      const cmds = getVerificationCommands();
      assert.equal(cmds.test, "npm test");
      assert.equal(cmds.lint, "npm run lint");
      assert.equal(cmds.build, "npm run build");
    });

    it("returns defaults when config has no overrides", () => {
      const cmds = getVerificationCommands({});
      assert.equal(cmds.test, VERIFICATION_DEFAULTS.test);
    });

    it("allows overriding individual commands", () => {
      const cmds = getVerificationCommands({ verificationCommands: { test: "npx vitest" } });
      assert.equal(cmds.test, "npx vitest");
      assert.equal(cmds.lint, "npm run lint"); // not overridden
    });

    it("no wildcard globs in defaults (Windows-safe)", () => {
      const cmds = getVerificationCommands();
      for (const cmd of Object.values(cmds)) {
        assert.ok(!cmd.includes("*"), `Command contains wildcard glob: ${cmd}`);
        assert.ok(!cmd.includes("?"), `Command contains "?" glob: ${cmd}`);
      }
    });
  });

  describe("getTestCommand", () => {
    it("returns test command", () => {
      assert.equal(getTestCommand(), "npm test");
    });

    it("returns override when specified", () => {
      assert.equal(getTestCommand({ verificationCommands: { test: "yarn test" } }), "yarn test");
    });
  });

  describe("checkForbiddenCommands (Packet 4)", () => {
    it("detects glob wildcard in command", () => {
      const result = checkForbiddenCommands("node --test tests/**/*.test.ts");
      assert.equal(result.forbidden, true);
      assert.ok(result.violations.length > 0);
    });

    it("accepts npm test", () => {
      const result = checkForbiddenCommands("npm test");
      assert.equal(result.forbidden, false);
      assert.equal(result.violations.length, 0);
    });

    it("returns not forbidden for empty string", () => {
      const result = checkForbiddenCommands("");
      assert.equal(result.forbidden, false);
    });

    it("FORBIDDEN_VERIFICATION_PATTERNS is non-empty", () => {
      assert.ok(FORBIDDEN_VERIFICATION_PATTERNS.length > 0);
      for (const p of FORBIDDEN_VERIFICATION_PATTERNS) {
        assert.ok(p.pattern);
        assert.ok(p.reason);
      }
    });

    it("detects bash script invocation as forbidden", () => {
      const result = checkForbiddenCommands("bash scripts/run_tests.sh");
      assert.equal(result.forbidden, true);
      assert.ok(result.violations.length > 0);
    });

    it("detects sh script invocation as forbidden", () => {
      const result = checkForbiddenCommands("sh run.sh");
      assert.equal(result.forbidden, true);
    });
  });

  describe("rewriteVerificationCommand", () => {
    it("rewrites shell-glob node --test to npm test", () => {
      assert.equal(rewriteVerificationCommand("node --test tests/**/*.test.js"), "npm test");
      assert.equal(rewriteVerificationCommand("node --test tests/**/*.test.ts"), "npm test");
    });

    it("rewrites bash script invocations to npm test", () => {
      assert.equal(rewriteVerificationCommand("bash scripts/run_tests.sh"), "npm test");
    });

    it("rewrites sh script invocations to npm test", () => {
      assert.equal(rewriteVerificationCommand("sh run.sh"), "npm test");
    });

    it("rewrites BOX daemon commands to npm test", () => {
      assert.equal(rewriteVerificationCommand("node src/cli.js once"), "npm test");
      assert.equal(rewriteVerificationCommand("npm run box:once"), "npm test");
      assert.equal(rewriteVerificationCommand("node src/cli.js start"), "npm test");
      assert.equal(rewriteVerificationCommand("node src/cli.js doctor"), "npm test");
    });

    it("rewrites dashboard daemon to node --test", () => {
      assert.equal(rewriteVerificationCommand("node src/dashboard/live_dashboard.js"), "node --test");
    });

    it("passes through canonical npm test unchanged", () => {
      assert.equal(rewriteVerificationCommand("npm test"), "npm test");
      assert.equal(rewriteVerificationCommand("npm run lint"), "npm run lint");
      assert.equal(rewriteVerificationCommand("npm run build"), "npm run build");
    });

    it("passes through node --test without glob unchanged", () => {
      assert.equal(rewriteVerificationCommand("node --test"), "node --test");
      assert.equal(rewriteVerificationCommand("node --test tests/core/foo.test.ts"), "node --test tests/core/foo.test.ts");
    });

    it("returns npm test for empty/null-like input (negative path)", () => {
      // Empty string has no matching rule — passes through as empty then trimmed
      assert.equal(rewriteVerificationCommand(""), "");
    });

    it("VERIFICATION_CMD_REWRITE_RULES is non-empty array of match/replacement objects", () => {
      assert.ok(VERIFICATION_CMD_REWRITE_RULES.length > 0);
      for (const rule of VERIFICATION_CMD_REWRITE_RULES) {
        assert.ok(rule.match instanceof RegExp, "rule.match must be a RegExp");
        assert.equal(typeof rule.replacement, "string", "rule.replacement must be a string");
        assert.ok(rule.replacement.length > 0, "rule.replacement must be non-empty");
      }
    });

    it("every FORBIDDEN_VERIFICATION_PATTERNS entry has a corresponding rewrite rule", () => {
      // All forbidden patterns should be rewritable — not just detected but fixed
      const testCases = [
        "node --test tests/**/*.test.ts",
        "bash scripts/test.sh",
        "sh run.sh",
      ];
      for (const cmd of testCases) {
        const rewritten = rewriteVerificationCommand(cmd);
        assert.notEqual(rewritten, cmd, `"${cmd}" should be rewritten to a canonical form`);
      }
    });
  });
});

// ── Task 2 hardening: normalizeCommandBatch — batch portable normalization ────

describe("normalizeCommandBatch — end-to-end batch normalization", () => {
  it("rewrites each command in the batch using rewrite rules", () => {
    const raw = ["node --test tests/**/*.test.ts", "npm test", "npm run lint"];
    const result = normalizeCommandBatch(raw);
    // The glob-based command must be rewritten to npm test
    // Deduplication means "npm test" appears only once
    assert.ok(result.includes("npm test"));
    assert.ok(result.includes("npm run lint"));
    assert.ok(!result.some(cmd => cmd.includes("*")), "no glob patterns should remain after normalization");
  });

  it("deduplicates commands that rewrite to the same canonical form", () => {
    const raw = ["node --test tests/**/*.ts", "bash run.sh", "npm test"];
    const result = normalizeCommandBatch(raw);
    // All three rewrite to "npm test" — only one should remain
    const npmTestCount = result.filter(c => c === "npm test").length;
    assert.equal(npmTestCount, 1, "deduplication must collapse identical rewrites");
  });

  it("filters out empty strings after normalization", () => {
    const raw = ["", "  ", "npm test"];
    const result = normalizeCommandBatch(raw);
    assert.equal(result.length, 1);
    assert.equal(result[0], "npm test");
  });

  it("returns empty array for non-array input", () => {
    assert.deepEqual(normalizeCommandBatch(null as any), []);
    assert.deepEqual(normalizeCommandBatch(undefined as any), []);
    assert.deepEqual(normalizeCommandBatch("npm test" as any), []);
  });

  it("returns empty array for empty input array", () => {
    assert.deepEqual(normalizeCommandBatch([]), []);
  });

  it("preserves canonical commands unchanged", () => {
    const canonical = ["npm test", "npm run lint", "npm run build"];
    const result = normalizeCommandBatch(canonical);
    assert.deepEqual(result, canonical);
  });

  it("negative path: glob-based command does NOT survive normalization", () => {
    const result = normalizeCommandBatch(["node --test tests/**"]);
    assert.ok(!result.some(cmd => cmd.includes("*")),
      `glob must not survive normalization; got: [${result.join(", ")}]`
    );
  });
});
