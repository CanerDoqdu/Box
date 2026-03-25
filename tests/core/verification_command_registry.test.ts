import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { getVerificationCommands, getTestCommand, VERIFICATION_DEFAULTS, checkForbiddenCommands, FORBIDDEN_VERIFICATION_PATTERNS } from "../../src/core/verification_command_registry.js";

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
  });
});
