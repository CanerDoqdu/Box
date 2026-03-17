/**
 * Trump — Deep Project Analyst
 *
 * Trump is activated by Jesus when a full project scan is needed.
 * He reads the entire repository structure, all GitHub issues/PRs,
 * existing code health, and builds a comprehensive plan.
 *
 * Trump sends his plans directly to Moses.
 * Trump has NO restrictions on thinking time or output length.
 *
 * Output: detailed worker assignments with full context.
 */

import path from "node:path";
import fs from "node:fs/promises";
import { writeJson, spawnAsync } from "./fs_utils.js";
import { appendAlert, appendProgress } from "./state_tracker.js";
import { getRoleRegistry } from "./role_registry.js";
import { buildAgentArgs, cleanupPromptFile, parseAgentOutput, logAgentThinking } from "./agent_loader.js";
import { chatLog } from "./logger.js";

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function buildLocalRepoCandidates(config) {
  const cwd = process.cwd();
  const rawRepo = String(config?.env?.targetRepo || "").trim();
  const repoName = rawRepo.includes("/") ? rawRepo.split("/").pop() : rawRepo;
  const candidates = [
    path.resolve(cwd),
    repoName ? path.resolve(cwd, repoName) : null,
    repoName ? path.resolve(cwd, "..", repoName) : null
  ].filter(Boolean);

  // De-duplicate while preserving order.
  return [...new Set(candidates)];
}

async function resolveLocalRepoDir(config) {
  const targetRepo = String(config?.env?.targetRepo || "").trim();
  const expectedRepoName = targetRepo.includes("/") ? targetRepo.split("/").pop() : targetRepo;

  for (const candidate of buildLocalRepoCandidates(config)) {
    const gitDir = path.join(candidate, ".git");
    const pkgFile = path.join(candidate, "package.json");
    const candidateBase = path.basename(candidate).toLowerCase();
    const expectedBase = String(expectedRepoName || "").toLowerCase();
    const nameLooksRight = expectedBase ? candidateBase === expectedBase : true;
    const hasGit = await pathExists(gitDir);
    const hasPackage = await pathExists(pkgFile);
    if (nameLooksRight && (hasGit || hasPackage)) return candidate;
  }

  return null;
}

async function listRepoFiles(localRepoDir) {
  const result = await spawnAsync("git", ["-C", localRepoDir, "ls-files"], { env: process.env });
  if (result.status === 0) {
    return String(result.stdout || "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }
  return [];
}

function looksTextFile(filePath) {
  const lower = filePath.toLowerCase();
  if (lower.includes("node_modules/") || lower.includes("/.git/") || lower.startsWith(".git/")) return false;
  if (lower.startsWith("dist/") || lower.startsWith("build/") || lower.startsWith("coverage/") || lower.startsWith(".next/")) return false;
  if (lower.startsWith("public/") && !lower.endsWith(".json") && !lower.endsWith(".md")) return false;
  return [
    ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    ".json", ".md", ".yml", ".yaml", ".css", ".scss", ".html"
  ].some((ext) => lower.endsWith(ext));
}

function scoreFileForSnapshot(filePath) {
  const lower = filePath.toLowerCase();
  let score = 0;

  if (lower === "package.json" || lower === "readme.md" || lower.startsWith(".github/workflows/")) score += 120;
  if (lower.includes("tsconfig") || lower.includes("next.config") || lower.includes("vitest") || lower.includes("playwright")) score += 90;
  if (lower.includes("app/api/") || lower.includes("route.")) score += 100;
  if (lower.includes("lib/api/") || lower.includes("validation")) score += 80;
  if (lower.includes("components/") || lower.includes("hooks/") || lower.includes("types/")) score += 60;
  if (lower.includes("test") || lower.endsWith(".test.ts") || lower.endsWith(".test.js")) score += 70;
  if (lower.endsWith(".md")) score += 20;

  // Slightly prefer shorter paths to keep foundation files visible.
  score -= Math.floor(filePath.length / 20);
  return score;
}

function inferLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const map = {
    ".js": "javascript",
    ".jsx": "javascript",
    ".ts": "typescript",
    ".tsx": "typescript",
    ".mjs": "javascript",
    ".cjs": "javascript",
    ".json": "json",
    ".md": "markdown",
    ".yml": "yaml",
    ".yaml": "yaml",
    ".css": "css",
    ".scss": "scss",
    ".html": "html"
  };
  return map[ext] || "text";
}

async function buildRepoSignals(localRepoDir, files) {
  const directoryCounts = new Map();
  const keywordHits = {
    todo: 0,
    fixme: 0,
    tsIgnore: 0,
    anyType: 0,
    errorBoundary: 0,
    rateLimit: 0,
    csrf: 0,
    validation: 0,
    tests: 0
  };

  for (const relPath of files) {
    const topDir = relPath.includes("/") ? relPath.split("/")[0] : "(root)";
    directoryCounts.set(topDir, (directoryCounts.get(topDir) || 0) + 1);

    const absPath = path.join(localRepoDir, relPath);
    try {
      const content = await fs.readFile(absPath, "utf8");
      const lower = content.toLowerCase();
      keywordHits.todo += (lower.match(/\btodo\b/g) || []).length;
      keywordHits.fixme += (lower.match(/\bfixme\b/g) || []).length;
      keywordHits.tsIgnore += (lower.match(/@ts-ignore/g) || []).length;
      keywordHits.anyType += (lower.match(/\bany\b/g) || []).length;
      keywordHits.errorBoundary += (lower.match(/errorboundary|error boundary/g) || []).length;
      keywordHits.rateLimit += (lower.match(/rate\s*limit|ratelimit/g) || []).length;
      keywordHits.csrf += (lower.match(/\bcsrf\b/g) || []).length;
      keywordHits.validation += (lower.match(/\bvalidat(ion|e)\b/g) || []).length;
      keywordHits.tests += (lower.match(/\bdescribe\(|\btest\(|\bit\(/g) || []).length;
    } catch {
      // Skip unreadable files.
    }
  }

  const topDirectories = [...directoryCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([dir, count]) => `${dir}:${count}`)
    .join(", ");

  return {
    topDirectories,
    keywordHits
  };
}

async function buildLocalRepoSnapshot(config) {
  const localRepoDir = await resolveLocalRepoDir(config);
  if (!localRepoDir) {
    return {
      source: "none",
      localRepoDir: null,
      filesRead: 0,
      totalChars: 0,
      text: ""
    };
  }

  const trackedFiles = await listRepoFiles(localRepoDir);
  const candidateFiles = trackedFiles.filter(looksTextFile);
  const repoSignals = await buildRepoSignals(localRepoDir, candidateFiles);
  const sortedFiles = [...candidateFiles].sort((a, b) => scoreFileForSnapshot(b) - scoreFileForSnapshot(a));

  const maxFiles = 8;
  const maxTotalChars = 5000;
  const maxCharsPerFile = 700;
  const selected = [];
  let totalChars = 0;

  for (const relPath of sortedFiles) {
    if (selected.length >= maxFiles || totalChars >= maxTotalChars) break;
    const absPath = path.join(localRepoDir, relPath);
    try {
      const raw = await fs.readFile(absPath, "utf8");
      const trimmed = raw.slice(0, maxCharsPerFile).trim();
      if (!trimmed) continue;
      selected.push({ relPath, content: trimmed, truncated: raw.length > maxCharsPerFile });
      totalChars += trimmed.length;
    } catch {
      // Non-fatal: skip unreadable files.
    }
  }

  const header = [
    `LOCAL REPO SNAPSHOT SOURCE: ${localRepoDir}`,
    `TRACKED FILES TOTAL: ${trackedFiles.length}`,
    `TEXT FILES ANALYZED: ${candidateFiles.length}`,
    `FILES READ: ${selected.length}`,
    `CONTENT CHARS: ${totalChars}`,
    `TOP DIRECTORIES: ${repoSignals.topDirectories || "n/a"}`,
    `KEYWORD HITS: ${JSON.stringify(repoSignals.keywordHits)}`,
    ""
  ];

  const sections = selected.map((entry) => {
    const language = inferLanguage(entry.relPath);
    const truncationNote = entry.truncated ? "\n# NOTE: content truncated for prompt budget" : "";
    return [
      `### FILE: ${entry.relPath}`,
      `\`\`\`${language}`,
      `${entry.content}${truncationNote}`,
      "\`\`\`",
      ""
    ].join("\n");
  });

  return {
    source: "local-repo",
    localRepoDir,
    filesRead: selected.length,
    totalChars,
    text: `${header.join("\n")}${sections.join("\n")}`.trim()
  };
}

async function callCopilotAgent(command, agentSlug, contextPrompt) {
  const { args, promptFile } = buildAgentArgs({ agentSlug, prompt: contextPrompt });
  const result = await spawnAsync(command, args, { env: process.env });
  cleanupPromptFile(promptFile);
  const stdout = String(result?.stdout || "");
  const stderr = String(result?.stderr || "");
  const raw = stdout || stderr;
  const combinedRaw = `${stdout}\n${stderr}`.trim();
  if (result.status !== 0) {
    return { ok: false, raw, combinedRaw, parsed: null, thinking: "", error: `exited ${result.status}: ${(stderr || stdout).slice(0, 300)}` };
  }
  const parsed = parseAgentOutput(raw);
  return {
    ...parsed,
    raw,
    combinedRaw
  };
}

async function callCopilotRaw(command, agentSlug, contextPrompt) {
  const { args, promptFile } = buildAgentArgs({ agentSlug, prompt: contextPrompt });
  const result = await spawnAsync(command, args, { env: process.env });
  cleanupPromptFile(promptFile);
  const stdout = String(result?.stdout || "");
  const stderr = String(result?.stderr || "");
  const combinedRaw = `${stdout}\n${stderr}`.trim();
  return {
    ok: result.status === 0,
    raw: stdout || stderr,
    combinedRaw,
    error: result.status === 0 ? null : `exited ${result.status}: ${(stderr || stdout).slice(0, 300)}`
  };
}

function buildTrumpPlanningPolicy(config) {
  const planner = config?.planner || {};
  const maxWorkersPerWave = Math.max(1, Number(planner.defaultMaxWorkersPerWave || config?.maxParallelWorkers || 10));
  return {
    maxWorkersPerWave,
    preferFewestWorkers: planner.preferFewestWorkers !== false,
    allowSameCycleFollowUps: Boolean(planner.allowSameCycleFollowUps),
    requireDependencyAwareWaves: planner.requireDependencyAwareWaves !== false,
    enforceTrumpExecutionStrategy: planner.enforceTrumpExecutionStrategy !== false
  };
}

function detectModelFallback(rawText) {
  const text = String(rawText || "");
  const match = text.match(/Warning:\s*Custom agent\s+"([^"]+)"\s+specifies model\s+"([^"]+)"\s+which is not available; using\s+"([^"]+)"\s+instead/i);
  if (!match) return null;
  return {
    agent: match[1],
    requestedModel: match[2],
    fallbackModel: match[3]
  };
}

// ── GitHub Full Fetch ────────────────────────────────────────────────────────

async function fetchFullRepoContext(config) {
  const token = config?.env?.githubToken;
  const repo = config?.env?.targetRepo;
  if (!token || !repo) return { issues: [], pullRequests: [], fileTree: [], recentCommits: [] };

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "BOX/1.0"
  };

  async function ghGet(url) {
    try {
      const res = await fetch(url, { headers });
      if (!res.ok) return null;
      return res.json();
    } catch { return null; }
  }

  const base = `https://api.github.com/repos/${repo}`;
  const [issues, prs, commits, tree, repoInfo] = await Promise.all([
    ghGet(`${base}/issues?state=open&per_page=50&sort=updated`),
    ghGet(`${base}/pulls?state=open&per_page=30&sort=updated`),
    ghGet(`${base}/commits?per_page=20`),
    ghGet(`${base}/git/trees/HEAD?recursive=1`),
    ghGet(base)
  ]);

  // Fetch closed issues AND merged PRs to understand what's already done
  const [closedIssues, mergedPRs] = await Promise.all([
    ghGet(`${base}/issues?state=closed&per_page=20&sort=updated`),
    ghGet(`${base}/pulls?state=closed&per_page=30&sort=updated&direction=desc`)
  ]);

  const fileTree = Array.isArray(tree?.tree)
    ? tree.tree.filter(f => f.type === "blob").map(f => f.path).slice(0, 200)
    : [];

  return {
    repoInfo: repoInfo ? {
      name: repoInfo.name,
      description: repoInfo.description,
      defaultBranch: repoInfo.default_branch,
      language: repoInfo.language,
      openIssuesCount: repoInfo.open_issues_count,
      topics: repoInfo.topics || []
    } : null,
    issues: Array.isArray(issues) ? issues.map(i => ({
      number: i.number,
      title: i.title,
      body: String(i.body || "").slice(0, 500),
      labels: i.labels?.map(l => l.name) || [],
      state: i.state,
      createdAt: i.created_at
    })) : [],
    closedIssues: Array.isArray(closedIssues) ? closedIssues.slice(0, 10).map(i => ({
      number: i.number,
      title: i.title,
      labels: i.labels?.map(l => l.name) || []
    })) : [],
    mergedPullRequests: Array.isArray(mergedPRs)
      ? mergedPRs.filter(p => p.merged_at).slice(0, 20).map(p => ({
          number: p.number,
          title: p.title,
          mergedAt: p.merged_at?.slice(0, 10)
        }))
      : [],
    pullRequests: Array.isArray(prs) ? prs.map(p => ({
      number: p.number,
      title: p.title,
      state: p.state,
      draft: p.draft,
      body: String(p.body || "").slice(0, 300)
    })) : [],
    recentCommits: Array.isArray(commits) ? commits.slice(0, 15).map(c => ({
      sha: c.sha?.slice(0, 8),
      message: String(c.commit?.message || "").split("\n")[0].slice(0, 100),
      author: c.commit?.author?.name,
      date: c.commit?.author?.date
    })) : [],
    fileTree
  };
}

// ── Main Trump Cycle ─────────────────────────────────────────────────────────

export async function runTrumpAnalysis(config, jesusDecision) {
  const stateDir = config.paths?.stateDir || "state";
  const registry = getRoleRegistry(config);
  const trumpName = registry?.deepPlanner?.name || "Trump";
  const trumpModel = registry?.deepPlanner?.model || "Claude Sonnet 4.6";
  const command = config.env?.copilotCliCommand || "copilot";

  await appendProgress(config, `[TRUMP] ${trumpName} awakening — starting deep repository analysis`);
  chatLog(stateDir, trumpName, "Awakening — full repository scan starting...");

  const context = await fetchFullRepoContext(config);
  const localSnapshot = await buildLocalRepoSnapshot(config);
  const planningPolicy = buildTrumpPlanningPolicy(config);

  const workersList = Object.entries(registry?.workers || {})
    .map(([kind, w]) => `  - "${w.name}" (kind: ${kind}, model: ${w.model})`)
    .join("\n");

  // Build completed-work summary for Trump to skip already-done tasks
  const mergedCommitsSummary = context.recentCommits.length > 0
    ? context.recentCommits.map(c => `  ${c.sha} (${c.date?.slice(0, 10)}) — ${c.message}`).join("\n")
    : "  No recent commits available";

  const mergedPRsSummary = (context.mergedPullRequests || []).length > 0
    ? context.mergedPullRequests.map(p => `  PR #${p.number} [merged ${p.mergedAt}]: ${p.title}`).join("\n")
    : "  No merged PRs found";

  const closedIssueSummary = context.closedIssues.length > 0
    ? context.closedIssues.map(i => `  #${i.number}: ${i.title}`).join("\n")
    : "  No closed issues available";

  const sharedContext = `TARGET REPO: ${config.env?.targetRepo || "unknown"}
${context.repoInfo ? `Project: ${context.repoInfo.name} | Language: ${context.repoInfo.language} | Topics: ${context.repoInfo.topics.join(", ")}` : ""}

## ⛔ ALREADY-DONE WORK — SKIP & AUDIT RULE
The following PRs are MERGED and the following issues are CLOSED.
BEFORE planning ANY task for ANY worker, cross-reference the task against every item below.

### SKIP vs REGRESSION-FIX decision:
For each merged PR, check the LOCAL FILE CONTENT SNAPSHOT below. If the code shows the feature was
implemented COMPLETELY and correctly → SKIP (do not re-plan).
But if the local snapshot reveals that a merged PR's work is INCOMPLETE, BROKEN, or HALF-DONE
(e.g. responsive PR merged but breakpoints are missing, accessibility PR merged but aria labels absent,
performance PR merged but images still unoptimized) → plan it as kind: "regression-fix" (not "new").
A regression-fix task costs fewer requests because the foundation exists — just the gaps need filling.

MERGED PULL REQUESTS (verify quality against local snapshot before skipping):
${mergedPRsSummary}

RECENT MERGED COMMITS (cross-reference before planning):
${mergedCommitsSummary}

CLOSED ISSUES (verify resolution quality — if poorly resolved, plan a regression-fix):
${closedIssueSummary}

## WHY JESUS CALLED YOU
${jesusDecision?.trumpReason || "Full strategic analysis required — project needs comprehensive scan"}

## EXECUTION OPTIMIZATION POLICY
- Optimize for minimum request burn and minimum worker activations.
- Prefer the fewest workers that can still do the job safely: ${planningPolicy.preferFewestWorkers ? "YES" : "NO"}
- Soft worker ceiling unless clearly justified otherwise: ${planningPolicy.maxWorkersPerWave}
- Same-cycle follow-up tasks allowed: ${planningPolicy.allowSameCycleFollowUps ? "YES" : "NO"}
- Dependency-aware waves required: ${planningPolicy.requireDependencyAwareWaves ? "YES" : "NO"}
- Execution strategy must be explicit and Moses will consume it: ${planningPolicy.enforceTrumpExecutionStrategy ? "YES" : "NO"}
- Preserve role purity. Do not assign backend/security/test ownership to frontend roles unless the repo structure truly demands it.
- All output must be in English only.
- You must estimate premium request usage for the proposed execution plan.

Design the plan so that upstream workers prepare downstream prerequisites whenever practical. If frontend/API/backend/auth work is related, sequence it deliberately instead of waking everyone at once.

## REPO FILE STRUCTURE (${context.fileTree.length} files)
${context.fileTree.slice(0, 80).join("\n")}
${context.fileTree.length > 80 ? `... and ${context.fileTree.length - 80} more files` : ""}

## OPEN ISSUES (${context.issues.length})
${context.issues.length > 0 ? context.issues.map(i => `  #${i.number} [${i.labels.join(", ") || "no labels"}]: ${i.title}`).join("\n") : "No open issues"}

## OPEN PULL REQUESTS (${context.pullRequests.length})
${context.pullRequests.length > 0 ? context.pullRequests.map(p => `  #${p.number} [${p.draft ? "DRAFT" : "ready"}]: ${p.title}`).join("\n") : "No open PRs"}

## AVAILABLE WORKERS
${workersList}

## LOCAL FILE CONTENT SNAPSHOT
${localSnapshot.text || "No local repository snapshot available in this runtime."}`;

  const dossierPrompt = `${sharedContext}

DOSSIER MODE

Produce a long-form senior-staff execution dossier for this repository.
Do not emit JSON.
Write substantial sections covering architecture reading, production risk and opportunity model, dependency ordering, worker activation strategy, role ownership, and a detailed phased execution plan.
Each recommended worker should receive a large work packet with prerequisites, substeps, verification, and downstream handoff expectations.
Include a dedicated premium request budget section with total estimate, by-wave estimate, and by-role estimate.

IMPORTANT CONSTRAINTS:
- You have NO direct tool access in this run.
- Never claim that you executed commands or attempted tool calls.
- Never include lines like "Tool X does not exist".
- Base analysis only on the provided repository context and local file snapshot.
- If a detail is missing, state "insufficient context provided" instead of guessing.
- Do NOT provide speculative time/hour estimates for workers.
- Do NOT lock into static checklist headings. Discover the most important production-level dimensions for THIS target repo and go beyond baseline depth.
- Review the full production-readiness surface, but never force irrelevant categories into the plan. For each major domain, state whether it is already adequate, missing and required, or not applicable for this repository.
- Do not silently skip common production domains such as auth/session management, token rotation, anomaly detection, SEO, performance budgets, observability, rollback safety, and platform security. Mark them as covered, missing, or not applicable with evidence.
- For every major recommendation, include explicit evidence mapping: file paths, commits, issues, PRs, or snapshot indicators that justify it.
- If proposing an alternative path, include impact analysis (correctness risk, scope risk, rollback, and whether it is permanent or temporary).
- Estimate premium request usage conservatively based on worker activations, validation passes, likely retries, and wave count.
- Write in English only.`;

  chatLog(stateDir, trumpName, "Generating long-form execution dossier...");
  const dossierResult = await callCopilotRaw(command, "trump", dossierPrompt);
  const dossierText = String(dossierResult.raw || "").trim();
  const dossierModelFallback = detectModelFallback(dossierResult.combinedRaw || dossierResult.raw);
  if (dossierModelFallback) {
    const warningMessage = `Trump model fallback detected: requested=${dossierModelFallback.requestedModel}, active=${dossierModelFallback.fallbackModel}`;
    await appendProgress(config, `[TRUMP][WARN] ${warningMessage}`);
    try {
      await appendAlert(config, {
        severity: "warning",
        source: "trump",
        title: "Trump model fallback",
        message: warningMessage
      });
    } catch {
      // Non-fatal alert path.
    }
  }
  if (dossierText) {
    await fs.writeFile(path.join(stateDir, "trump_dossier.md"), `${dossierText}\n`, "utf8");
    logAgentThinking(stateDir, trumpName, dossierText);
  }

  // Only runtime context — persona and output format are in trump.agent.md
  const contextPrompt = `${sharedContext}

Write a substantial senior-level narrative before the final JSON. The final JSON should still be rich, with large task packets, substeps, verification, dependency reasoning, and worker handoff contracts.

## PRIOR DOSSIER
${dossierText ? dossierText.slice(0, 5000) : "No prior dossier generated."}

IMPORTANT CONSTRAINTS:
- You have NO direct tool access in this run.
- Never claim command execution or tool failures.
- Use only supplied context and snapshot evidence.
- No speculative hour/time estimates.
- No fixed canned sectioning; discover repo-specific production priorities.
- Evaluate the full production-readiness surface and explicitly classify major domains as already adequate, missing and required, or not applicable for this repo.
- Do not silently omit common production domains such as auth/session management, token rotation, anomaly detection, SEO, performance, observability, rollback safety, and deployment/platform security.
- Every plan item must include evidence anchors from provided context.
- If evidence is missing, explicitly write "insufficient context provided".
- All output and JSON fields must be in English only.
- MANDATORY: Include a \`requestBudget\` object. The system will HARD-CAP all premium requests to this number. The budget is binding — once exhausted no more workers run.
  Structure: { "estimatedPremiumRequestsTotal": <number>, "errorMarginPercent": <number 10-30>, "hardCapTotal": <number = total * (1 + margin/100) rounded up>, "confidence": "high|medium|low", "byWave": [{"waveId": "...", "requests": <n>}], "byRole": [{"role": "...", "requests": <n>}] }
  Rules: count 1 premium request per worker dispatch. Include validation/retry cycles in the estimate. The hardCapTotal is what the system enforces — set it conservatively.
- Include a \`productionReadinessCoverage\` array that states for each relevant production domain whether it is adequate, missing, or not applicable, with evidence-based justification.
- Premium request estimates must reflect likely worker activations and validation cycles, not arbitrary round numbers.
- Workers must receive large, complete task packets. Each worker must do substantial production-quality work (hundreds to thousands of lines) in a single request. Never assign trivial 10-line tasks.
- CRITICAL: The \"context\" field in each plan is what the worker will literally receive as their task description. Write it as an exhaustive implementation checklist: every file to modify, every function to add/change, every edge case to handle, every test to write. The worker will use this as their reference and checklist — they will work through it item by item. Make it EXTREMELY detailed (500-2000 words per worker plan). The more detail here, the higher quality the worker output.
- Include in each plan's context: the EXACT current state of the code (from the snapshot), what's wrong with it, what the fix should be, which files to create/modify, which patterns to follow from the existing codebase, what the verification steps are.
- Think of each plan's context as a senior engineer's handoff document: if a new hire received this, they could execute perfectly without asking a single question.`;

  chatLog(stateDir, trumpName, "Calling AI for deep repository analysis (this may take a while)...");
  const aiResult = await callCopilotAgent(command, "trump", contextPrompt);
  const finalModelFallback = detectModelFallback(aiResult?.combinedRaw || aiResult?.raw || "");
  if (finalModelFallback) {
    const warningMessage = `Trump model fallback detected: requested=${finalModelFallback.requestedModel}, active=${finalModelFallback.fallbackModel}`;
    await appendProgress(config, `[TRUMP][WARN] ${warningMessage}`);
    try {
      await appendAlert(config, {
        severity: "warning",
        source: "trump",
        title: "Trump model fallback",
        message: warningMessage
      });
    } catch {
      // Non-fatal alert path.
    }
  }

  if (!aiResult.ok || !aiResult.parsed) {
    await appendProgress(config, `[TRUMP] AI call failed — ${aiResult.error || "no JSON"}`);
    chatLog(stateDir, trumpName, `Analysis failed: ${aiResult.error || "response could not be parsed"}`);
    return null;
  }

  logAgentThinking(stateDir, trumpName, aiResult.thinking);

  // ── Enforce mandatory requestBudget ──────────────────────────────────────
  const parsed = aiResult.parsed;
  if (!parsed.requestBudget || !Number.isFinite(Number(parsed.requestBudget.estimatedPremiumRequestsTotal))) {
    // Fallback: estimate from plan count (1 request per plan + 20% margin)
    const planCount = Array.isArray(parsed.plans) ? parsed.plans.length : 4;
    const estimated = planCount;
    const margin = 25;
    parsed.requestBudget = {
      estimatedPremiumRequestsTotal: estimated,
      errorMarginPercent: margin,
      hardCapTotal: Math.ceil(estimated * (1 + margin / 100)),
      confidence: "low",
      byWave: [],
      byRole: [],
      _fallback: true
    };
    await appendProgress(config, `[TRUMP][WARN] No requestBudget in output — fallback estimate: ${parsed.requestBudget.hardCapTotal} requests`);
  } else {
    // Ensure hardCapTotal is computed if Trump didn't provide it
    const rb = parsed.requestBudget;
    const total = Number(rb.estimatedPremiumRequestsTotal) || 0;
    const margin = Number(rb.errorMarginPercent) || 20;
    if (!Number.isFinite(Number(rb.hardCapTotal)) || Number(rb.hardCapTotal) <= 0) {
      rb.hardCapTotal = Math.ceil(total * (1 + margin / 100));
    }
  }

  const analysis = {
    ...aiResult.parsed,
    dossierPath: path.join(stateDir, "trump_dossier.md"),
    analyzedAt: new Date().toISOString(),
    model: trumpModel,
    repo: config.env?.targetRepo,
    requestedBy: "Jesus",
    jesusReason: jesusDecision?.trumpReason
  };

  await writeJson(path.join(stateDir, "trump_analysis.json"), analysis);

  const planCount = Array.isArray(analysis.plans) ? analysis.plans.length : 0;
  await appendProgress(config, `[TRUMP] Analysis complete — ${planCount} work items | health=${analysis.projectHealth}`);
  chatLog(stateDir, trumpName, `Analysis ready: ${planCount} plans | health=${analysis.projectHealth} | sending to Moses`);

  return analysis;
}
