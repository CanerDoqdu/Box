import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { checkArchitectureDrift } from "../../src/core/architecture_drift.js";

describe("architecture_drift", () => {
  let rootDir: string;

  beforeEach(async () => {
    rootDir = await fs.mkdtemp(path.join(os.tmpdir(), "box-arch-drift-"));
  });

  afterEach(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("reports no stale references when all doc-mentioned paths exist", async () => {
    await fs.mkdir(path.join(rootDir, "docs"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "src", "core"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "src", "core", "orchestrator.ts"),
      "export {};\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "docs", "architecture.md"),
      "# Arch\n\nMain entry: `src/core/orchestrator.ts`\n",
      "utf8"
    );

    const report = await checkArchitectureDrift({ rootDir });
    assert.equal(report.staleCount, 0);
    assert.equal(report.presentCount, 1);
    assert.deepEqual(report.staleReferences, []);
    assert.ok(report.scannedDocs.includes("docs/architecture.md"));
  });

  it("detects stale reference when a doc mentions a file that does not exist", async () => {
    await fs.mkdir(path.join(rootDir, "docs"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "src", "core"), { recursive: true });

    // Only orchestrator.ts exists; task_queue.ts does not
    await fs.writeFile(
      path.join(rootDir, "src", "core", "orchestrator.ts"),
      "export {};\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "docs", "architecture.md"),
      [
        "# Arch",
        "",
        "Present: `src/core/orchestrator.ts`",
        "Missing: `src/core/task_queue.ts`"
      ].join("\n"),
      "utf8"
    );

    const report = await checkArchitectureDrift({ rootDir });
    assert.equal(report.staleCount, 1);
    assert.equal(report.presentCount, 1);
    assert.equal(report.staleReferences[0].referencedPath, "src/core/task_queue.ts");
    assert.equal(report.staleReferences[0].docPath, "docs/architecture.md");
    assert.equal(report.staleReferences[0].line, 4);
  });

  it("negative path: ignores absolute and environment paths — no false positives", async () => {
    await fs.mkdir(path.join(rootDir, "docs"), { recursive: true });

    // These must NOT be picked up — they are not repo-local prefixes
    await fs.writeFile(
      path.join(rootDir, "docs", "notes.md"),
      [
        "# Notes",
        "",
        "System path: `/etc/hosts`",
        "Home dir: `/home/user/.bashrc`",
        "Windows path: `C:\\Windows\\System32\\cmd.exe`",
        "Relative no-prefix: `lib/utils.ts`"
      ].join("\n"),
      "utf8"
    );

    const report = await checkArchitectureDrift({ rootDir });
    assert.equal(report.staleCount, 0);
    assert.equal(report.presentCount, 0);
    assert.deepEqual(report.staleReferences, []);
  });

  it("handles multiple docs and aggregates stale refs across all of them", async () => {
    await fs.mkdir(path.join(rootDir, "docs"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "src", "core"), { recursive: true });
    await fs.mkdir(path.join(rootDir, "docker"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "src", "core", "policy_engine.ts"),
      "export {};\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "docker", "Dockerfile"),
      "FROM node:20\n",
      "utf8"
    );

    await fs.writeFile(
      path.join(rootDir, "docs", "arch.md"),
      "Core: `src/core/policy_engine.ts` and `src/core/gates.ts`\n",
      "utf8"
    );
    await fs.writeFile(
      path.join(rootDir, "docs", "ops.md"),
      "Docker: `docker/Dockerfile` — missing: `docker/worker.Dockerfile`\n",
      "utf8"
    );

    const report = await checkArchitectureDrift({ rootDir });
    assert.equal(report.presentCount, 2);
    assert.equal(report.staleCount, 2);

    const stalePaths = report.staleReferences.map((r) => r.referencedPath);
    assert.ok(stalePaths.includes("src/core/gates.ts"));
    assert.ok(stalePaths.includes("docker/worker.Dockerfile"));
  });

  it("returns empty report when docs directory does not exist", async () => {
    // No docs/ directory created
    const report = await checkArchitectureDrift({ rootDir });
    assert.equal(report.staleCount, 0);
    assert.equal(report.presentCount, 0);
    assert.deepEqual(report.scannedDocs, []);
  });

  it("deduplicates repeated mentions of the same path within a doc", async () => {
    await fs.mkdir(path.join(rootDir, "docs"), { recursive: true });

    await fs.writeFile(
      path.join(rootDir, "docs", "arch.md"),
      [
        "# Arch",
        "`src/core/missing.ts` is referenced here.",
        "And again: `src/core/missing.ts` for clarity."
      ].join("\n"),
      "utf8"
    );

    const report = await checkArchitectureDrift({ rootDir });
    // Same path in same doc should only be counted once
    assert.equal(report.staleCount, 1);
  });
});
