import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { runDoctor } from "../../src/core/doctor.js";

describe("doctor", () => {
  let originalTargetRepo: string | undefined;

  beforeEach(() => {
    originalTargetRepo = process.env.TARGET_REPO;
  });

  afterEach(async () => {
    if (originalTargetRepo === undefined) {
      delete process.env.TARGET_REPO;
    } else {
      process.env.TARGET_REPO = originalTargetRepo;
    }
  });

  it("returns checks object and warning list", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-doctor-"));
    const result = await runDoctor({
      paths: { stateDir: tmpDir },
      env: { githubToken: "x", targetRepo: "CanerDoqdu/Box", copilotCliCommand: "node", claudeApiKey: "" }
    });
    assert.equal(typeof result.ok, "boolean");
    assert.equal(typeof result.checks.node, "boolean");
    assert.ok(Array.isArray(result.warnings));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it("negative path: emits integration warning when github token or target repo missing", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-doctor-"));
    const result = await runDoctor({
      paths: { stateDir: tmpDir },
      env: { githubToken: "", targetRepo: "", copilotCliCommand: "node" }
    });
    assert.equal(result.ok, false);
    assert.ok(result.warnings.some((w: string) => w.includes("GitHub integration not ready")));
    await fs.rm(tmpDir, { recursive: true, force: true });
  });
});

