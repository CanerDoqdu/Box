import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";

const ROOT = process.cwd();
const TEST_ROOT = path.join(ROOT, "tests");

async function collectTestFiles(dir: string, out: string[]): Promise<void> {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await collectTestFiles(fullPath, out);
      continue;
    }
    if (entry.isFile() && fullPath.endsWith(".test.ts")) {
      out.push(fullPath);
    }
  }
}

async function main(): Promise<void> {
  const testFiles: string[] = [];
  await collectTestFiles(TEST_ROOT, testFiles);
  testFiles.sort();

  if (testFiles.length === 0) {
    console.log("No .test.ts files found under tests/.");
    process.exit(1);
  }

  const relativeFiles = testFiles.map((filePath) => path.relative(ROOT, filePath));
  const args = ["--import", "tsx", "--test", ...relativeFiles];

  const child = spawn(process.execPath, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env
  });

  child.on("exit", (code, signal) => {
    if (signal) {
      process.exit(1);
    }
    process.exit(code ?? 1);
  });
}

main().catch((error) => {
  console.error(`[run_tests] fatal: ${String(error?.message || error)}`);
  process.exit(1);
});
