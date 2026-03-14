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
import { writeJson, spawnAsync } from "./fs_utils.js";
import { appendProgress } from "./state_tracker.js";
import { getRoleRegistry } from "./role_registry.js";
import { buildAgentArgs, parseAgentOutput, logAgentThinking } from "./agent_loader.js";
import { chatLog } from "./logger.js";

async function callCopilotAgent(command, agentSlug, contextPrompt) {
  const args = buildAgentArgs({ agentSlug, prompt: contextPrompt });
  const result = await spawnAsync(command, args, { env: process.env });
  const stdout = String(result?.stdout || "");
  const stderr = String(result?.stderr || "");
  if (result.status !== 0) {
    return { ok: false, raw: stdout || stderr, parsed: null, thinking: "", error: `exited ${result.status}: ${(stderr || stdout).slice(0, 300)}` };
  }
  return parseAgentOutput(stdout || stderr);
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

  // Also fetch closed issues to understand project history
  const closedIssues = await ghGet(`${base}/issues?state=closed&per_page=20&sort=updated`);

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

  const workersList = Object.entries(registry?.workers || {})
    .map(([kind, w]) => `  - "${w.name}" (kind: ${kind}, model: ${w.model})`)
    .join("\n");

  // Only runtime context — persona and output format are in trump.agent.md
  const contextPrompt = `TARGET REPO: ${config.env?.targetRepo || "unknown"}
${context.repoInfo ? `Project: ${context.repoInfo.name} | Language: ${context.repoInfo.language} | Topics: ${context.repoInfo.topics.join(", ")}` : ""}

## WHY JESUS CALLED YOU
${jesusDecision?.trumpReason || "Full strategic analysis required — project needs comprehensive scan"}

## REPO FILE STRUCTURE (${context.fileTree.length} files)
${context.fileTree.slice(0, 150).join("\n")}
${context.fileTree.length > 150 ? `... and ${context.fileTree.length - 150} more files` : ""}

## OPEN ISSUES (${context.issues.length})
${context.issues.length > 0 ? context.issues.map(i => `  #${i.number} [${i.labels.join(", ") || "no labels"}]: ${i.title}\n  ${i.body ? i.body.slice(0, 200) : "no description"}`).join("\n\n") : "No open issues"}

## OPEN PULL REQUESTS (${context.pullRequests.length})
${context.pullRequests.length > 0 ? context.pullRequests.map(p => `  #${p.number} [${p.draft ? "DRAFT" : "ready"}]: ${p.title}`).join("\n") : "No open PRs"}

## RECENT COMMITS
${context.recentCommits.map(c => `  ${c.sha} ${c.date?.slice(0, 10)} — ${c.message} (${c.author})`).join("\n")}

## RECENTLY CLOSED ISSUES
${context.closedIssues.map(i => `  #${i.number}: ${i.title}`).join("\n")}

## AVAILABLE WORKERS
${workersList}`;

  chatLog(stateDir, trumpName, "Calling AI for deep repository analysis (this may take a while)...");
  const aiResult = await callCopilotAgent(command, "trump", contextPrompt);

  if (!aiResult.ok || !aiResult.parsed) {
    await appendProgress(config, `[TRUMP] AI call failed — ${aiResult.error || "no JSON"}`);
    chatLog(stateDir, trumpName, `Analysis failed: ${aiResult.error || "response could not be parsed"}`);
    return null;
  }

  logAgentThinking(stateDir, trumpName, aiResult.thinking);

  const analysis = {
    ...aiResult.parsed,
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
