import fs from "node:fs/promises";
import path from "node:path";

const IGNORED_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "coverage",
  ".box-work",
  "state/backups"
]);

const MAX_SCAN_FILES = 1200;
const MAX_PREVIEW_FILES = 12;
const PREVIEW_BYTES = 2000;

function inferCommands(packageJson) {
  const scripts = packageJson?.scripts ?? {};
  return {
    install: scripts.ci ? "npm run ci" : "npm ci",
    build: scripts.build ? "npm run build" : null,
    test: scripts.test ? "npm test -- --ci" : null,
    lint: scripts.lint ? "npm run lint" : null
  };
}

function toSetKeys(obj) {
  return new Set(Object.keys(obj || {}).map((k) => String(k).toLowerCase()));
}

function detectFrameworks(pkg) {
  const deps = toSetKeys(pkg?.dependencies);
  const devDeps = toSetKeys(pkg?.devDependencies);
  const all = new Set([...deps, ...devDeps]);

  const frameworks = [];
  if (all.has("next")) frameworks.push("nextjs");
  if (all.has("react") || all.has("react-dom")) frameworks.push("react");
  if (all.has("vue")) frameworks.push("vue");
  if (all.has("svelte")) frameworks.push("svelte");
  if (all.has("express") || all.has("fastify") || all.has("koa")) frameworks.push("node-api");
  if (all.has("jest") || all.has("vitest") || all.has("mocha")) frameworks.push("test-runner");
  if (all.has("playwright") || all.has("cypress")) frameworks.push("e2e");
  if (all.has("typescript")) frameworks.push("typescript");

  return frameworks;
}

function detectDomains(scripts, frameworks) {
  const domains = new Set();
  const s = scripts || {};
  if (s.build || frameworks.includes("nextjs") || frameworks.includes("react")) {
    domains.add("frontend");
  }
  if (frameworks.includes("node-api") || s.start || s.dev) {
    domains.add("backend");
  }
  if (s.test || frameworks.includes("test-runner") || frameworks.includes("e2e")) {
    domains.add("quality");
  }
  if (s.lint) {
    domains.add("code-quality");
  }
  return [...domains];
}

function isTestLike(filePath) {
  const lower = String(filePath || "").toLowerCase();
  return lower.endsWith(".test.js")
    || lower.endsWith(".spec.js")
    || lower.includes("/__tests__/")
    || lower.endsWith(".test.ts")
    || lower.endsWith(".spec.ts");
}

async function pathExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

function pickPreviewTargets(files) {
  const preferred = [
    "readme.md",
    "package.json",
    "box.config.json",
    "docker-compose.yml",
    "src/cli.js",
    "src/core/orchestrator.js",
    "src/core/project_scanner.js",
    "src/core/task_planner.js",
    "src/core/roadmap_engine.js"
  ];

  const normalizedFiles = files.map((f) => String(f).replace(/\\/g, "/"));
  const selected = [];
  for (const target of preferred) {
    const hit = normalizedFiles.find((item) => item.toLowerCase() === target);
    if (hit) {
      selected.push(hit);
    }
  }

  for (const file of normalizedFiles) {
    if (selected.length >= MAX_PREVIEW_FILES) {
      break;
    }
    if (selected.includes(file)) {
      continue;
    }
    if (file.startsWith("src/") || isTestLike(file)) {
      selected.push(file);
    }
  }

  return selected.slice(0, MAX_PREVIEW_FILES);
}

async function buildRepositorySignals(rootDir) {
  const queue = [""];
  const files = [];

  while (queue.length > 0 && files.length < MAX_SCAN_FILES) {
    const relDir = queue.shift();
    const absDir = path.join(rootDir, relDir);
    let entries;
    try {
      entries = await fs.readdir(absDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const normalized = relPath.replace(/\\/g, "/");
      if (entry.isDirectory()) {
        const lower = normalized.toLowerCase();
        if (IGNORED_DIRS.has(lower) || lower.startsWith("state/backups")) {
          continue;
        }
        queue.push(normalized);
        continue;
      }
      if (entry.isFile()) {
        files.push(normalized);
        if (files.length >= MAX_SCAN_FILES) {
          break;
        }
      }
    }
  }

  const extensionHistogram: Record<string, any> = {};
  let srcFileCount = 0;
  let testFileCount = 0;
  let jsFileCount = 0;
  let tsFileCount = 0;
  for (const relFile of files) {
    const ext = path.extname(relFile).toLowerCase() || "[noext]";
    extensionHistogram[ext] = (extensionHistogram[ext] || 0) + 1;
    if (relFile.startsWith("src/")) {
      srcFileCount += 1;
    }
    if (isTestLike(relFile)) {
      testFileCount += 1;
    }
    if (ext === ".js" || ext === ".mjs" || ext === ".cjs") {
      jsFileCount += 1;
    }
    if (ext === ".ts" || ext === ".tsx") {
      tsFileCount += 1;
    }
  }

  const topLevelDirs = [...new Set(files.map((f) => String(f).split("/")[0]))]
    .filter((dir) => dir && !dir.includes("."))
    .slice(0, 20);

  const previewTargets = pickPreviewTargets(files);
  const keyFilePreviews = [];
  for (const relFile of previewTargets) {
    const abs = path.join(rootDir, relFile);
    try {
      const content = await fs.readFile(abs, "utf8");
      keyFilePreviews.push({
        path: relFile,
        preview: String(content).slice(0, PREVIEW_BYTES)
      });
    } catch {
      // Ignore unreadable files; keep scan deterministic.
    }
  }

  let workflowFileCount = 0;
  try {
    const workflowsDir = path.join(rootDir, ".github", "workflows");
    const workflowEntries = await fs.readdir(workflowsDir, { withFileTypes: true });
    workflowFileCount = workflowEntries.filter((entry) => {
      if (!entry.isFile()) {
        return false;
      }
      const lower = String(entry.name || "").toLowerCase();
      return lower.endsWith(".yml") || lower.endsWith(".yaml");
    }).length;
  } catch { /* already 0 */ }

  return {
    scannedFileCount: files.length,
    topLevelDirs,
    extensionHistogram,
    srcFileCount,
    testFileCount,
    jsFileCount,
    tsFileCount,
    hasDockerCompose: await pathExists(path.join(rootDir, "docker-compose.yml")),
    hasReadme: await pathExists(path.join(rootDir, "README.md")),
    hasGithubActions: await pathExists(path.join(rootDir, ".github", "workflows")),
    hasDockerDir: await pathExists(path.join(rootDir, "docker")),
    hasPackageLock: await pathExists(path.join(rootDir, "package-lock.json")),
    hasYarnLock: await pathExists(path.join(rootDir, "yarn.lock")),
    hasPnpmLock: await pathExists(path.join(rootDir, "pnpm-lock.yaml")),
    workflowFileCount,
    keyFilePreviews
  };
}

export async function scanProject(config) {
  const packagePath = path.join(config.rootDir, "package.json");
  const result = {
    timestamp: new Date().toISOString(),
    rootDir: config.rootDir,
    hasPackageJson: false,
    packageName: null,
    scripts: {},
    commands: {},
    frameworks: [],
    domains: [],
    dependencyCount: 0,
    repositorySignals: {
      scannedFileCount: 0,
      topLevelDirs: [],
      extensionHistogram: {},
      srcFileCount: 0,
      testFileCount: 0,
      jsFileCount: 0,
      tsFileCount: 0,
      hasDockerCompose: false,
      hasReadme: false,
      hasGithubActions: false,
      hasDockerDir: false,
      hasPackageLock: false,
      hasYarnLock: false,
      hasPnpmLock: false,
      workflowFileCount: 0,
      keyFilePreviews: []
    }
  };

  try {
    const raw = await fs.readFile(packagePath, "utf8");
    const pkg = JSON.parse(raw);
    result.hasPackageJson = true;
    result.packageName = pkg.name ?? null;
    result.scripts = pkg.scripts ?? {};
    result.commands = inferCommands(pkg);
    result.frameworks = detectFrameworks(pkg);
    result.domains = detectDomains(result.scripts, result.frameworks);
    result.dependencyCount =
      Object.keys(pkg?.dependencies || {}).length +
      Object.keys(pkg?.devDependencies || {}).length;
  } catch {
    result.commands = {
      install: "npm ci",
      build: null,
      test: null,
      lint: null
    };
    result.frameworks = [];
    result.domains = [];
    result.dependencyCount = 0;
  }

  result.repositorySignals = await buildRepositorySignals(config.rootDir);

  if (result.repositorySignals.testFileCount > 0 && !result.domains.includes("quality")) {
    result.domains.push("quality");
  }
  if (result.repositorySignals.srcFileCount > 0 && !result.domains.includes("backend")) {
    result.domains.push("backend");
  }
  if (result.repositorySignals.hasDockerDir && !result.domains.includes("devops")) {
    result.domains.push("devops");
  }

  return result;
}
