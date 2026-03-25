import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isSelfDevMode,
  validateFileChanges,
  validatePrSize,
  validateBranch,
  getSelfDevGateOverrides,
  getRecoveryInstructions
} from "../../src/core/self_dev_guard.js";

describe("self_dev_guard", () => {
  it("detects self-dev mode via explicit flag", () => {
    assert.equal(isSelfDevMode({ selfDev: { enabled: true }, env: { targetRepo: "" } }), true);
  });

  it("validates blocked and caution file changes", () => {
    const result = validateFileChanges([
      "src/core/orchestrator.ts",
      "box.config.json"
    ]);
    assert.equal(result.allowed, false);
    assert.ok(result.blocked.some((b) => b.includes("critical system file")));
    assert.ok(result.warnings.some((w) => w.includes("sensitive system file")));
  });

  it("negative path: rejects main branch and oversized PR", () => {
    const branch = validateBranch("main");
    const size = validatePrSize(99, { selfDev: { maxFilesPerPr: 8 } });
    assert.equal(branch.allowed, false);
    assert.equal(size.allowed, false);
  });

  it("returns deterministic gate overrides and recovery metadata", () => {
    const gates = getSelfDevGateOverrides();
    const recovery = getRecoveryInstructions();
    assert.equal(gates.requireLint, true);
    assert.equal(gates.requireTests, true);
    assert.ok(recovery.tag.includes("box/recovery"));
  });
});

