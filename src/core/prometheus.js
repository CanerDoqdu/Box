/**
 * Prometheus — Self-Evolution Engine & Key Planner (Autonomous Mode)
 *
 * Prometheus is activated by Jesus for deep repository analysis.
 * Uses single-prompt mode: one request per invocation, no autopilot continuations.
 * Prometheus scans the repo, reads files, analyzes code, and produces worker plans.
 *
 * Output: detailed worker assignments in state/prometheus_analysis.json
 */

import path from "node:path";
import fs from "node:fs/promises";
import { writeJson, spawnAsync } from "./fs_utils.js";
import { appendAlert, appendProgress } from "./state_tracker.js";
import { getRoleRegistry } from "./role_registry.js";
import { buildAgentArgs, parseAgentOutput, logAgentThinking } from "./agent_loader.js";
import { chatLog } from "./logger.js";

export function detectModelFallback(rawText) {
  const text = String(rawText || "");
  const match = text.match(/Warning:\s*Custom agent\s+"([^"]+)"\s+specifies model\s+"([^"]+)"\s+which is not available;\s+using\s+"([^"]+)"\s+instead/i);
  if (!match) return null;
  return { agent: match[1], requestedModel: match[2], fallbackModel: match[3] };
}

export function buildPrometheusPlanningPolicy(config) {
  const planner = config?.planner || {};
  const maxWorkersPerWave = Math.max(1, Number(planner.defaultMaxWorkersPerWave || config?.maxParallelWorkers || 10));
  const rawMaxTasks = Number(planner.maxTasks);
  const maxTasks = Number.isFinite(rawMaxTasks) && rawMaxTasks > 0 ? Math.floor(rawMaxTasks) : 0;
  return {
    maxTasks,
    maxWorkersPerWave,
    preferFewestWorkers: planner.preferFewestWorkers !== false,
    allowSameCycleFollowUps: Boolean(planner.allowSameCycleFollowUps),
    requireDependencyAwareWaves: planner.requireDependencyAwareWaves !== false,
    enforcePrometheusExecutionStrategy: planner.enforcePrometheusExecutionStrategy !== false
  };
}

export function normalizeRepoPath(filePath) {
  return String(filePath || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\//, "")
    .trim()
    .toLowerCase();
}

async function collectScanTargets(repoRoot) {
  const ignoreDirs = new Set([".git", "node_modules", "state", ".box-work", "coverage", "dist"]);
  const targets = new Set();
  const broadSourcePrefixes = ["src/", "tests/", "docs/", "scripts/", "docker/"];
  const metadataPrefixes = [".github/"];
  const allowedExt = new Set([".js", ".mjs", ".cjs", ".json", ".md", ".yml", ".yaml", ".txt", ".ps1", ".sh"]);

  async function walk(absDir, relDir = "") {
    const entries = await fs.readdir(absDir, { withFileTypes: true }).catch(() => null);
    if (!entries) {
      return;
    }

    for (const entry of entries) {
      const relPath = relDir ? `${relDir}/${entry.name}` : entry.name;
      const normalized = normalizeRepoPath(relPath);
      const absPath = path.join(absDir, entry.name);

      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) continue;
        await walk(absPath, relPath);
        continue;
      }

      const ext = path.extname(entry.name).toLowerCase();
      const isDockerfile = /dockerfile/i.test(entry.name);
      const inBroadScope = broadSourcePrefixes.some((prefix) => normalized.startsWith(prefix));
      const inMetadataScope = metadataPrefixes.some((prefix) => normalized.startsWith(prefix));

      if (inBroadScope || inMetadataScope) {
        if (allowedExt.has(ext) || isDockerfile) {
          targets.add(normalized);
        }
      }
    }
  }

  await walk(repoRoot);

  try {
    const rootEntries = await fs.readdir(repoRoot, { withFileTypes: true });
    for (const entry of rootEntries) {
      if (!entry.isFile()) continue;
      const fileName = entry.name;
      const ext = path.extname(fileName).toLowerCase();
      const normalized = normalizeRepoPath(fileName);
      const isDockerfile = /dockerfile/i.test(fileName);
      if (allowedExt.has(ext) || isDockerfile) {
        targets.add(normalized);
      }
    }
  } catch {
    // Root scan is best-effort.
  }

  return Array.from(targets).sort();
}

function detectFenceLanguage(filePath) {
  const ext = path.extname(String(filePath || "")).toLowerCase();
  if (ext === ".js" || ext === ".mjs") return "js";
  if (ext === ".json") return "json";
  if (ext === ".yml" || ext === ".yaml") return "yaml";
  if (ext === ".md") return "md";
  return "text";
}

async function createPrometheusRepoExport(repoRoot, stateDir, scanTargets, criticalFiles, chunkCharLimit = 120000) {
  const stateDirAbs = path.isAbsolute(stateDir) ? stateDir : path.join(repoRoot, stateDir);
  const exportDir = path.join(stateDirAbs, "prometheus_repo_export");
  await fs.rm(exportDir, { recursive: true, force: true });
  await fs.mkdir(exportDir, { recursive: true });

  const chunkPaths = [];
  const chunkFiles = [];
  let currentChunk = [];
  let currentSize = 0;
  let readErrors = [];

  async function flushChunk() {
    if (currentChunk.length === 0) return;
    const chunkIndex = chunkFiles.length + 1;
    const fileName = `chunk-${String(chunkIndex).padStart(2, "0")}.md`;
    const relativePath = normalizeRepoPath(path.relative(repoRoot, path.join(exportDir, fileName)));
    const absolutePath = path.join(exportDir, fileName);
    await fs.writeFile(absolutePath, currentChunk.join("\n\n"), "utf8");
    chunkPaths.push(relativePath);
    chunkFiles.push({ path: relativePath, fileCount: currentChunk.length });
    currentChunk = [];
    currentSize = 0;
  }

  for (const target of scanTargets) {
    const absPath = path.join(repoRoot, target);
    const contentResult = await fs.readFile(absPath, "utf8")
      .then((value) => ({ content: value, reason: null }))
      .catch((err) => ({ content: null, reason: String(err?.message || err) }));

    let content = contentResult.content;
    if (contentResult.reason) {
      const reason = contentResult.reason;
      readErrors.push({ file: target, reason });
      content = `READ_ERROR: ${reason}`;
    }

    const lineCount = content.split(/\r?\n/).length;
    const section = [
      `## FILE: ${target}`,
      `LINES: ${lineCount}`,
      `BYTES: ${Buffer.byteLength(content, "utf8")}`,
      `\`\`\`${detectFenceLanguage(target)}`,
      content,
      "```"
    ].join("\n");

    if (currentSize > 0 && (currentSize + section.length) > chunkCharLimit) {
      await flushChunk();
    }

    currentChunk.push(section);
    currentSize += section.length;
  }

  await flushChunk();

  const manifestPath = normalizeRepoPath(path.relative(repoRoot, path.join(exportDir, "manifest.md")));
  const manifestBody = [
    "# Prometheus Repo Export",
    `GeneratedAt: ${new Date().toISOString()}`,
    `SourceTargetCount: ${scanTargets.length}`,
    `ChunkCount: ${chunkPaths.length}`,
    "",
    "## Instructions",
    "1. Read THIS manifest first.",
    "2. Read EVERY chunk file listed below using read_file.",
    "3. Base your analysis on exported file contents, not on snapshot guesses.",
    "",
    "## Critical Source Files",
    ...criticalFiles.map((file) => `- ${file}`),
    "",
    "## Chunk Files",
    ...chunkPaths.map((chunkPath, index) => `${index + 1}. ${chunkPath}`),
    "",
    "## Read Errors",
    ...(readErrors.length > 0 ? readErrors.map((entry) => `- ${entry.file}: ${entry.reason}`) : ["- none"])
  ].join("\n");

  await fs.writeFile(path.join(exportDir, "manifest.md"), manifestBody, "utf8");

  return {
    manifestPath,
    chunkPaths,
    readErrors,
    sourceTargetCount: scanTargets.length,
    chunkCount: chunkPaths.length
  };
}

export function extractReadTargetsFromThinking(thinking) {
  const text = String(thinking || "");
  const out = new Set();
  const lines = text.split(/\r?\n/);

  for (const line of lines) {
    const match = line.match(/[|│]\s+([^\r\n]+)/);
    if (!match) continue;
    let candidate = match[1].trim();
    candidate = candidate.replace(/\s+\(.*line[s]? read\)\s*$/i, "").trim();
    candidate = candidate.replace(/\s+\(.*\)\s*$/i, "").trim();
    if (!candidate) continue;
    if (!(/[\\/]/.test(candidate) || /\.[a-z0-9]+$/i.test(candidate))) continue;

    out.add(normalizeRepoPath(candidate));
  }

  return Array.from(out);
}

function extractAnchoredPaths(text) {
  const source = String(text || "");
  const matches = source.match(
    /(?:^|[\s`("'[,{])((?:src|tests|docs|docker|scripts|state|\.github)\/[A-Za-z0-9_./-]+|README\.md|package\.json|box\.config\.json|policy\.json|docker-compose\.yml)(?=$|[\s`)"'\],:;])/gm
  ) || [];

  return Array.from(new Set(matches.map((entry) => {
    const normalized = String(entry || "")
      .trim()
      .replace(/^[\s`("'[,{]+/, "")
      .replace(/[\s`)"'\],:;]+$/, "");
    return normalizeRepoPath(normalized);
  }).filter(Boolean)));
}

function countLineAnchors(text) {
  const source = String(text || "");
  const matches = source.match(/\b(?:L\d+(?::\d+)?|lines?\s+\d+(?:\s*[-:]\s*\d+)?)\b/gi);
  return Array.isArray(matches) ? matches.length : 0;
}

function collectPlanEvidenceErrors(plans) {
  const list = Array.isArray(plans) ? plans : [];
  const errors = [];

  list.forEach((plan, index) => {
    const context = String(plan?.context || "");
    if (!context.trim()) {
      errors.push(`plan ${index + 1} is missing context`);
      return;
    }

    if (extractAnchoredPaths(context).length === 0) {
      errors.push(`plan ${index + 1} context lacks file anchors`);
    }
    if (countLineAnchors(context) === 0) {
      errors.push(`plan ${index + 1} context lacks line anchors`);
    }
  });

  return errors;
}

export function evaluatePrometheusReadCoverage({ thinking, parsed, targets, criticalFiles, requiredCoverage = 1 }) {
  const targetList = Array.isArray(targets) ? targets.map(normalizeRepoPath) : [];
  const criticalList = Array.isArray(criticalFiles) ? criticalFiles.map(normalizeRepoPath) : [];
  const readTargets = extractReadTargetsFromThinking(thinking);
  const readSet = new Set(readTargets);

  const matchedTargets = targetList.filter((target) => {
    if (readSet.has(target)) return true;
    const suffix = `/${target}`;
    for (const readPath of readSet) {
      if (readPath.endsWith(suffix)) return true;
    }
    return false;
  });

  const matchedSet = new Set(matchedTargets);
  const missingCritical = criticalList.filter((file) => !matchedSet.has(file));
  const totalTargets = targetList.length;
  const coverage = totalTargets > 0 ? matchedTargets.length / totalTargets : 0;

  const mergedText = [
    String(thinking || ""),
    String(parsed?.analysis || ""),
    String(parsed?.strategicNarrative || ""),
    String(parsed?.keyFindings || ""),
    ...(Array.isArray(parsed?.plans) ? parsed.plans.map((plan) => String(plan?.context || "")) : [])
  ].join("\n");
  const loweredMergedText = mergedText.toLowerCase();
  const anchoredPaths = extractAnchoredPaths(mergedText);
  const lineAnchorCount = countLineAnchors(mergedText);

  const errors = [];
  if (loweredMergedText.includes("snapshot signals")) {
    errors.push("snapshot-only analysis detected");
  }
  if (readTargets.length < 10) {
    errors.push("insufficient read_file evidence in Prometheus thinking log");
  }
  if (coverage < requiredCoverage) {
    errors.push(`read coverage too low (${matchedTargets.length}/${totalTargets}, required ${(requiredCoverage * 100).toFixed(0)}%)`);
  }
  if (missingCritical.length > 0) {
    errors.push(`missing critical reads: ${missingCritical.slice(0, 6).join(", ")}${missingCritical.length > 6 ? " ..." : ""}`);
  }
  if (anchoredPaths.length < 5) {
    errors.push(`analysis lacks concrete file anchors (${anchoredPaths.length}/5)`);
  }
  if (lineAnchorCount < 3) {
    errors.push(`analysis lacks concrete line anchors (${lineAnchorCount}/3)`);
  }
  errors.push(...collectPlanEvidenceErrors(parsed?.plans));

  return {
    ok: errors.length === 0,
    errors,
    readTargets,
    matchedTargets,
    anchoredPaths,
    lineAnchorCount,
    missingTargets: targetList.filter((file) => !matchedSet.has(file)),
    missingCritical,
    totalTargets,
    matchedCount: matchedTargets.length,
    coverage
  };
}

async function callCopilotAgent(command, agentSlug, contextPrompt, config, model) {
  const args = buildAgentArgs({
    agentSlug,
    prompt: contextPrompt,
    model,
    allowAll: false,
    maxContinues: undefined
  });
  const result = await spawnAsync(command, args, { env: process.env });
  const stdout = String(result?.stdout || "");
  const stderr = String(result?.stderr || "");
  const raw = stdout || stderr;
  const combinedRaw = `${stdout}\n${stderr}`.trim();
  if (result.status !== 0) {
    return { ok: false, raw, combinedRaw, parsed: null, thinking: "", error: `exited ${result.status}: ${(stderr || stdout).slice(0, 300)}` };
  }
  const parsed = parseAgentOutput(raw);
  return { ...parsed, raw, combinedRaw };
}

// ── Main Prometheus Analysis ─────────────────────────────────────────────────

export async function runPrometheusAnalysis(config, options = {}) {
  const stateDir = config.paths?.stateDir || "state";
  const repoRoot = process.cwd();
  const registry = getRoleRegistry(config);
  const prometheusName = registry?.deepPlanner?.name || "Prometheus";
  const prometheusModel = registry?.deepPlanner?.model || "GPT-5.3-Codex";
  const command = config.env?.copilotCliCommand || "copilot";
  const maxAttempts = Math.max(1, Number(config?.runtime?.prometheusAnalysisMaxAttempts || 4));
  const requiredCoverage = Math.max(0, Math.min(1, Number(config?.runtime?.prometheusRequiredReadCoverage ?? 1)));

  const userPrompt = options.prompt || options.prometheusReason || "Full repository self-evolution analysis";
  const requestedBy = options.requestedBy || "Jesus";

  const scanTargets = await collectScanTargets(repoRoot);
  const criticalFiles = [
    "src/core/orchestrator.js",
    "src/core/prometheus.js",
    "src/core/athena_reviewer.js",
    "src/core/worker_runner.js",
    "src/core/jesus_supervisor.js",
    "src/dashboard/live_dashboard.js",
    "src/config.js",
    "src/cli.js"
  ].filter((file) => scanTargets.includes(normalizeRepoPath(file)));
  const repoExport = await createPrometheusRepoExport(
    repoRoot,
    stateDir,
    scanTargets,
    criticalFiles,
    Number(config?.runtime?.prometheusRepoExportChunkChars || 120000)
  );
  const exportTargets = [repoExport.manifestPath, ...repoExport.chunkPaths];

  await appendProgress(config, `[PROMETHEUS] ${prometheusName} awakening — starting deep repository analysis`);
  await appendProgress(config, `[PROMETHEUS] Repo export prepared: sourceTargets=${scanTargets.length}, chunks=${repoExport.chunkCount}, readErrors=${repoExport.readErrors.length}`);
  await appendProgress(config, `[PROMETHEUS] Read-coverage gate enabled: exportTargets=${exportTargets.length}, required=${Math.round(requiredCoverage * 100)}%`);
  chatLog(stateDir, prometheusName, "Awakening — full repository scan starting...");

  const planningPolicy = buildPrometheusPlanningPolicy(config);

  const workersList = Object.entries(registry?.workers || {})
    .map(([kind, w]) => `  - "${w.name}" (kind: ${kind}, model: ${w.model})`)
    .join("\n") || "  (none configured)";

  let rejectionHint = "";
  let accepted = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const contextPrompt = `TARGET REPO: ${config.env?.targetRepo || "unknown"}
REPO PATH: ${process.cwd()}
  SOURCE TARGET COUNT: ${scanTargets.length}
  EXPORT MANIFEST: ${repoExport.manifestPath}

## YOUR MISSION
You are Prometheus — BOX Self-Evolution Engine & Key Planner. Your job is to:
  1. READ the parent-generated repository export manifest and every chunk file it lists.
  2. ANALYZE code quality, architecture, security, testing, CI/CD, performance — then identify self-evolution opportunities.
  3. Use only list_dir/read_file/grep_search/file_search. Do NOT use shell/task tools.
  4. If any operation returns permission denied, continue scanning with allowed read-only tools.
  5. Do not claim snapshot-only analysis. Use concrete file reads.
  6. Analyze across all dimensions: architecture, security, testing, performance, CI/CD, docs, UI/UX, observability.
  7. Every major finding must cite exact file paths and line anchors.
  8. Every plans[].context entry must include exact file paths, line anchors, and concrete implementation guidance.
  9. Write your full analysis narrative, then produce structured JSON between markers.

## OPERATOR OBJECTIVE
${userPrompt}

## GROUNDED INPUT SOURCE
  - BOX already exported the full repository into chunk files using direct filesystem access.
  - Read manifest first: ${repoExport.manifestPath}
  - Then read EVERY listed chunk file. Those chunks contain full contents of ${scanTargets.length} source/config/test/agent files.
  - You may inspect raw repo paths for spot checks, but your primary grounding must be the export chunks.

## MANDATORY READ EVIDENCE
- Critical files that MUST appear in your reads: ${criticalFiles.join(", ") || "(none)"}
  - Export files that MUST appear in your reads: ${exportTargets.join(", ")}
  - System enforces minimum read coverage of ${(requiredCoverage * 100).toFixed(0)}% over ${exportTargets.length} export files.
  - If you skip export reads, your analysis will be rejected and retried.

## PLANNING POLICY (NO ARTIFICIAL CAP)
- maxTasks: ${planningPolicy.maxTasks > 0 ? planningPolicy.maxTasks : "UNLIMITED"}
- maxWorkersPerWave: ${planningPolicy.maxWorkersPerWave}
- preferFewestWorkers: ${planningPolicy.preferFewestWorkers}
- allowSameCycleFollowUps: ${planningPolicy.allowSameCycleFollowUps}
- requireDependencyAwareWaves: ${planningPolicy.requireDependencyAwareWaves}
- enforcePrometheusExecutionStrategy: ${planningPolicy.enforcePrometheusExecutionStrategy}
- If maxTasks is UNLIMITED, include ALL materially distinct actionable tasks you find (no arbitrary 3/5/10 cap).
- Do not optimize for brevity. Optimize for completeness, depth, and implementation-ready detail.

## AVAILABLE WORKERS
${workersList}

${rejectionHint}

## OUTPUT FORMAT
Write a substantial senior-level narrative first. Then output structured JSON:

===DECISION===
{
  "analysis": "<comprehensive summary>",
  "strategicNarrative": "<execution strategy>",
  "projectHealth": "good | needs-work | critical",
  "keyFindings": "<top 3-5 findings>",
  "productionReadinessCoverage": [{"domain": "...", "status": "adequate|missing|not-applicable", "why": "..."}],
  "dependencyModel": {"criticalPath": [...], "parallelizableTracks": [...], "blockedBy": [...]},
  "executionStrategy": {"waves": [{"id": "wave-1", "workers": [...], "gate": "...", "estimatedRequests": 0}]},
  "requestBudget": {"estimatedPremiumRequestsTotal": 0, "errorMarginPercent": 20, "hardCapTotal": 0, "confidence": "medium", "byWave": [], "byRole": []},
  "plans": [
    {
      "role": "<worker name>",
      "kind": "<worker kind>",
      "priority": 1,
      "wave": "wave-1",
      "task": "<short task description>",
      "context": "<detailed 500-2000 word implementation checklist>",
      "verification": "<how to verify>",
      "dependencies": [],
      "downstream": "<what this enables>"
    }
  ]
}
===END===

CRITICAL: JSON must be between ===DECISION=== and ===END=== markers exactly.`;

    chatLog(stateDir, prometheusName, `Calling AI for deep repository analysis (single-prompt), attempt ${attempt}/${maxAttempts}...`);
    const aiResult = await callCopilotAgent(command, "prometheus", contextPrompt, config, prometheusModel);

    // Check for model fallback
    const fallback = detectModelFallback(aiResult?.combinedRaw || aiResult?.raw || "");
    if (fallback) {
      const warningMessage = `Prometheus model fallback: requested=${fallback.requestedModel}, active=${fallback.fallbackModel}`;
      await appendProgress(config, `[PROMETHEUS][WARN] ${warningMessage}`);
      try {
        await appendAlert(config, { severity: "warning", source: "prometheus", title: "Prometheus model fallback", message: warningMessage });
      } catch { /* non-fatal */ }
    }

    if (!aiResult?.ok || !aiResult?.parsed) {
      await appendProgress(config, `[PROMETHEUS][WARN] Attempt ${attempt}/${maxAttempts} failed — ${aiResult?.error || "no valid JSON"}`);
      if (attempt >= maxAttempts) {
        await appendProgress(config, `[PROMETHEUS] Analysis failed — ${aiResult?.error || "no valid JSON"}`);
        chatLog(stateDir, prometheusName, `Analysis failed: ${aiResult?.error || "no JSON"}`);
        return null;
      }
      rejectionHint = `## PREVIOUS ATTEMPT REJECTED\n- Reason: ${String(aiResult?.error || "no valid JSON")}\n- Fix: perform full read_file scan and return valid JSON markers.`;
      continue;
    }

    const coverage = evaluatePrometheusReadCoverage({
      thinking: aiResult.thinking,
      parsed: aiResult.parsed,
      targets: exportTargets,
      criticalFiles: exportTargets,
      requiredCoverage
    });

    try {
      await writeJson(path.join(stateDir, "prometheus_read_audit.json"), {
        analyzedAt: new Date().toISOString(),
        attempt,
        maxAttempts,
        ok: coverage.ok,
        matchedCount: coverage.matchedCount,
        totalTargets: coverage.totalTargets,
        coverage: coverage.coverage,
        missingCritical: coverage.missingCritical,
        sourceTargetCount: scanTargets.length,
        exportTargets,
        exportReadErrors: repoExport.readErrors,
        anchoredPaths: coverage.anchoredPaths,
        lineAnchorCount: coverage.lineAnchorCount,
        errors: coverage.errors,
        missingTargetsSample: coverage.missingTargets.slice(0, 50)
      });
    } catch { /* non-fatal */ }

    if (!coverage.ok) {
      const reason = coverage.errors.join(" | ");
      await appendProgress(config, `[PROMETHEUS][WARN] Attempt ${attempt}/${maxAttempts} rejected by read-coverage gate — ${reason}`);
      if (attempt >= maxAttempts) {
        await appendProgress(config, `[PROMETHEUS] Analysis failed — read-coverage gate not satisfied`);
        chatLog(stateDir, prometheusName, `Read-coverage gate failed: ${reason}`);
        return null;
      }
      rejectionHint = `## PREVIOUS ATTEMPT REJECTED\n- Reason: ${reason}\n- Required: read ALL targets, include critical file reads in thinking/tool trace, and cite exact file paths plus line anchors in the narrative and every plan context.`;
      continue;
    }

    await appendProgress(config, `[PROMETHEUS] Read coverage OK: ${coverage.matchedCount}/${coverage.totalTargets} (${(coverage.coverage * 100).toFixed(1)}%)`);
    accepted = { aiResult, coverage };
    break;
  }

  if (!accepted) {
    await appendProgress(config, "[PROMETHEUS] Analysis failed — unknown gate failure");
    return null;
  }

  const { aiResult, coverage } = accepted;

  logAgentThinking(stateDir, prometheusName, aiResult.thinking);

  // Save dossier if thinking is substantial
  if (aiResult.thinking && aiResult.thinking.length > 500) {
    try {
      await fs.writeFile(path.join(stateDir, "prometheus_dossier.md"), `${aiResult.thinking}\n`, "utf8");
    } catch { /* non-fatal */ }
  }

  // ── Enforce mandatory requestBudget ──────────────────────────────────────
  const parsed = aiResult.parsed;
  if (!parsed.requestBudget || !Number.isFinite(Number(parsed.requestBudget.estimatedPremiumRequestsTotal))) {
    const planCount = Array.isArray(parsed.plans) ? parsed.plans.length : 4;
    const margin = 25;
    parsed.requestBudget = {
      estimatedPremiumRequestsTotal: planCount,
      errorMarginPercent: margin,
      hardCapTotal: Math.ceil(planCount * (1 + margin / 100)),
      confidence: "low",
      byWave: [],
      byRole: [],
      _fallback: true
    };
    await appendProgress(config, `[PROMETHEUS][WARN] No requestBudget — fallback: ${parsed.requestBudget.hardCapTotal} requests`);
  } else {
    const rb = parsed.requestBudget;
    const total = Number(rb.estimatedPremiumRequestsTotal) || 0;
    const margin = Number(rb.errorMarginPercent) || 20;
    if (!Number.isFinite(Number(rb.hardCapTotal)) || Number(rb.hardCapTotal) <= 0) {
      rb.hardCapTotal = Math.ceil(total * (1 + margin / 100));
    }
  }

  const analysis = {
    ...parsed,
    readAudit: {
      coverage: coverage.coverage,
      matchedCount: coverage.matchedCount,
      totalTargets: coverage.totalTargets,
      missingCritical: coverage.missingCritical,
      sourceTargetCount: scanTargets.length,
      exportManifest: repoExport.manifestPath,
      exportChunkCount: repoExport.chunkCount,
      exportReadErrors: repoExport.readErrors.length
    },
    dossierPath: path.join(stateDir, "prometheus_dossier.md"),
    analyzedAt: new Date().toISOString(),
    model: prometheusModel,
    repo: config.env?.targetRepo,
    requestedBy
  };

  await writeJson(path.join(stateDir, "prometheus_analysis.json"), analysis);

  const planCount = Array.isArray(analysis.plans) ? analysis.plans.length : 0;
  await appendProgress(config, `[PROMETHEUS] Analysis complete — ${planCount} work items | health=${analysis.projectHealth}`);
  chatLog(stateDir, prometheusName, `Analysis ready: ${planCount} plans | health=${analysis.projectHealth}`);

  return analysis;
}
