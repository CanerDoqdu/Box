/**
 * Jesus — CEO AI Supervisor
 *
 * Jesus activates ONCE at system startup.
 * He reads everything: GitHub state, worker sessions, last Moses coordination, last Trump analysis.
 * He calls the AI agent with NO restrictions — free thinking, full analysis.
 *
 * His output:
 *   - A comprehensive directive for Moses including his full reasoning
 *   - Optional: request Trump for a full repo scan before Moses acts
 *   - Optional: wait if there is genuinely nothing to do
 *
 * Moses escalates critical system problems back to Jesus via state/jesus_escalation.json.
 * Jesus writes his directive to state/jesus_directive.json for dashboard visibility.
 */

import path from "node:path";
import { readJson, writeJson, spawnAsync } from "./fs_utils.js";
import { appendProgress } from "./state_tracker.js";
import { getRoleRegistry } from "./role_registry.js";
import { buildAgentArgs, parseAgentOutput, logAgentThinking } from "./agent_loader.js";
import { chatLog } from "./logger.js";

async function callCopilotAgent(command, agentSlug, contextPrompt) {
  const args = buildAgentArgs({ agentSlug, prompt: contextPrompt });
  const result = await spawnAsync(command, args, { env: process.env });
  const stdout = result.stdout;
  const stderr = result.stderr;
  if (result.status !== 0) {
    return { ok: false, raw: stdout || stderr, parsed: null, thinking: "", error: `exited ${result.status}` };
  }
  return parseAgentOutput(stdout || stderr);
}

// ── GitHub Intelligence ──────────────────────────────────────────────────────

async function fetchGitHubState(config) {
  const token = config?.env?.githubToken;
  const repo = config?.env?.targetRepo;
  if (!token || !repo) return { issues: [], pullRequests: [], repoInfo: null };

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
  const [issues, prs, repoInfo, failedRuns] = await Promise.all([
    ghGet(`${base}/issues?state=open&per_page=20&sort=updated`),
    ghGet(`${base}/pulls?state=open&per_page=20&sort=updated`),
    ghGet(base),
    ghGet(`${base}/actions/runs?status=failure&per_page=5`)
  ]);

  return {
    issues: Array.isArray(issues) ? issues.slice(0, 15).map(i => ({ number: i.number, title: i.title, labels: i.labels?.map(l => l.name) || [], state: i.state })) : [],
    pullRequests: Array.isArray(prs) ? prs.slice(0, 10).map(p => ({ number: p.number, title: p.title, state: p.state, draft: p.draft })) : [],
    repoInfo: repoInfo ? { name: repoInfo.name, defaultBranch: repoInfo.default_branch, openIssuesCount: repoInfo.open_issues_count } : null,
    failedCiRuns: Array.isArray(failedRuns?.workflow_runs)
      ? failedRuns.workflow_runs.slice(0, 5).map(r => ({
          name: r.name,
          branch: r.head_branch,
          commit: r.head_sha?.slice(0, 7),
          conclusion: r.conclusion,
          updatedAt: r.updated_at
        }))
      : []
  };
}

// ── Main Jesus Cycle ─────────────────────────────────────────────────────────

export async function runJesusCycle(config) {
  const stateDir = config.paths?.stateDir || "state";
  const registry = getRoleRegistry(config);
  const jesusName = registry?.ceoSupervisor?.name || "Jesus";
  const jesusModel = registry?.ceoSupervisor?.model || "Claude Sonnet 4.6";
  const command = config.env?.copilotCliCommand || "copilot";

  await appendProgress(config, `[JESUS] ${jesusName} awakening — analyzing system state`);
  chatLog(stateDir, jesusName, "Awakening — reading system state...");

  // Read all state (no budget)
  const [
    lastDirective,
    mosesCoordination,
    trumpAnalysis,
    githubState,
    sessions
  ] = await Promise.all([
    readJson(path.join(stateDir, "jesus_directive.json"), {}),
    readJson(path.join(stateDir, "moses_coordination.json"), {}),
    readJson(path.join(stateDir, "trump_analysis.json"), {}),
    fetchGitHubState(config),
    readJson(path.join(stateDir, "worker_sessions.json"), {})
  ]);

  const activeSessions = Object.keys(sessions).filter(k => sessions[k]?.status === "working").length;
  const lastCycleAt = lastDirective?.decidedAt ? new Date(lastDirective.decidedAt).toLocaleString() : "never";
  const trumpLastRunAt = trumpAnalysis?.analyzedAt ? new Date(trumpAnalysis.analyzedAt).toLocaleString() : "never";

  // Cost guard: skip the AI call if GitHub state hasn't changed and last directive is fresh
  const now = Date.now();
  const lastDecisionMs = lastDirective?.decidedAt ? new Date(lastDirective.decidedAt).getTime() : 0;
  const minutesSinceLast = (now - lastDecisionMs) / 60000;
  const ghFingerprint = [
    githubState.issues.map(i => i.number).join(","),
    githubState.pullRequests.map(p => p.number).join(","),
    githubState.failedCiRuns.length
  ].join("|");

  if (
    minutesSinceLast < 8 &&
    lastDirective?.decision &&
    lastDirective?.githubStateHash === ghFingerprint &&
    activeSessions > 0
  ) {
    await appendProgress(config, `[JESUS] State unchanged (${minutesSinceLast.toFixed(1)}m ago) — reusing last directive (AI call skipped)`);
    chatLog(stateDir, jesusName, `State unchanged — reusing last directive (saved AI call)`);
    return lastDirective;
  }

  const trumpAgeHours = trumpAnalysis?.analyzedAt
    ? (now - new Date(trumpAnalysis.analyzedAt).getTime()) / 3600000
    : Infinity;

  const workersList = Object.entries(registry?.workers || {})
    .map(([kind, w]) => `  - ${w.name} (${kind}): ${w.model}`)
    .join("\n");

  // English system state context — persona and output format are in jesus.agent.md
  const contextPrompt = `TARGET REPO: ${config.env?.targetRepo || "unknown"}

## CURRENT SYSTEM STATE

**Active Worker Sessions:** ${activeSessions}
**Last Cycle:** ${lastCycleAt}
**Trump Last Analysis:** ${trumpLastRunAt}${trumpAgeHours < 6 ? ` (${trumpAgeHours.toFixed(1)}h ago — FRESH, only set callTrump=true if health is critical)` : ""}

**GitHub State — ${config.env?.targetRepo}:**
Open Issues (${githubState.issues.length}):
${githubState.issues.length > 0
  ? githubState.issues.map(i => `  #${i.number}: ${i.title} [${i.labels.join(", ") || "no labels"}]`).join("\n")
  : "  No open issues"}

Open PRs (${githubState.pullRequests.length}):
${githubState.pullRequests.length > 0
  ? githubState.pullRequests.map(p => `  #${p.number}: ${p.title} [${p.draft ? "draft" : "open"}]`).join("\n")
  : "  No open PRs"}

**Failing CI Runs (${githubState.failedCiRuns.length}):**
${githubState.failedCiRuns.length > 0
  ? githubState.failedCiRuns.map(r => `  ${r.name} on ${r.branch} (${r.commit}) — ${r.conclusion} [${r.updatedAt}]`).join("\n")
  : "  No failing CI runs"}

**Last Moses Coordination:**
${mosesCoordination?.summary ? `  ${mosesCoordination.summary}` : "  No previous coordination"}
${mosesCoordination?.completedTasks ? `  Completed tasks: ${mosesCoordination.completedTasks}` : ""}

**Trump's Last Analysis:**
${trumpAnalysis?.projectHealth ? `  Health: ${trumpAnalysis.projectHealth}` : "  No analysis available"}
${trumpAnalysis?.keyFindings ? `  Key findings: ${trumpAnalysis.keyFindings}` : ""}

**Available Workers:**
${workersList}`;

  chatLog(stateDir, jesusName, "Calling AI for strategic analysis...");
  const aiResult = await callCopilotAgent(command, "jesus", contextPrompt);

  if (!aiResult.ok || !aiResult.parsed) {
    await appendProgress(config, `[JESUS] AI call failed — ${aiResult.error || "no JSON"}`);
    chatLog(stateDir, jesusName, `AI failed: ${aiResult.error || "no JSON"}`);
    return {
      wait: false,
      wakeMoses: true,
      callTrump: false,
      decision: "tactical",
      systemHealth: "unknown",
      thinking: "",
      fullOutput: aiResult.raw || "",
      briefForMoses: `Check GitHub issues and activate appropriate workers. Target repo: ${config.env?.targetRepo}`,
      priorities: [],
      workerSuggestions: []
    };
  }

  logAgentThinking(stateDir, jesusName, aiResult.thinking);

  const d = aiResult.parsed;

  chatLog(stateDir, jesusName,
    `Decision: ${d.decision || "?"} | Health: ${d.systemHealth || "?"} | callTrump: ${d.callTrump} | wakeMoses: ${d.wakeMoses}`
  );
  await appendProgress(config,
    `[JESUS] decision=${d.decision} health=${d.systemHealth} callTrump=${d.callTrump} wakeMoses=${d.wakeMoses}`
  );

  const directive = {
    ...d,
    thinking: aiResult.thinking,
    fullOutput: aiResult.raw || "",
    decidedAt: new Date().toISOString(),
    model: jesusModel,
    repo: config.env?.targetRepo,
    githubStateHash: ghFingerprint
  };

  await writeJson(path.join(stateDir, "jesus_directive.json"), directive);

  return directive;
}
