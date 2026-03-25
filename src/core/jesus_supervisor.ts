/**
 * Jesus — CEO AI Supervisor
 *
 * Jesus activates ONCE at system startup.
 * He reads everything: GitHub state, worker sessions, last coordination, last Prometheus analysis.
 * He calls the AI agent with NO restrictions — free thinking, full analysis.
 *
 * His output:
 *   - A comprehensive directive for Prometheus including his full reasoning
 *   - Optional: request Prometheus for a fresh deep repo scan
 *   - Optional: wait if there is genuinely nothing to do
 *
 * Escalations come back to Jesus via state/jesus_escalation.json.
 * Jesus writes his directive to state/jesus_directive.json for dashboard visibility.
 */

import path from "node:path";
import { readJson, readJsonSafe, writeJson, spawnAsync } from "./fs_utils.js";
import { appendProgress, appendAlert, ALERT_SEVERITY } from "./state_tracker.js";
import { getRoleRegistry } from "./role_registry.js";
import { buildAgentArgs, parseAgentOutput, logAgentThinking } from "./agent_loader.js";
import { chatLog } from "./logger.js";
import {
  validateLeadershipContract,
  LEADERSHIP_CONTRACT_TYPE,
  TRUST_BOUNDARY_ERROR,
} from "./trust_boundary.js";
import { getRecentCapacity, computeTrend } from "./capacity_scoreboard.js";

async function callCopilotAgent(command, agentSlug, contextPrompt) {
  const args = buildAgentArgs({ agentSlug, prompt: contextPrompt, allowAll: true, noAskUser: true });
  const result: any = await spawnAsync(command, args, { env: process.env });
  const stdout = result.stdout;
  const stderr = result.stderr;
  if (result.status !== 0) {
    return { ok: false, raw: stdout || stderr, parsed: null, thinking: "", error: `exited ${result.status}` };
  }
  return parseAgentOutput(stdout || stderr);
}

// ── Hierarchical System Health Audit ─────────────────────────────────────────
// Jesus runs this audit on every cycle. It checks for structural problems that
// workers and Athena might have missed. When gaps are found, they're injected
// into the Jesus directive as specific remediation items AND fed to the self-
// improvement system as capability gaps.

async function runSystemHealthAudit(config, githubState, AthenaCoordination, sessions) {
  const findings = [];

  // 1. CI Health — is main branch green?
  if (githubState.latestMainCi) {
    if (githubState.latestMainCi.conclusion !== "success") {
      findings.push({
        area: "ci",
        severity: "critical",
        finding: `CI on ${githubState.latestMainCi.branch} is ${githubState.latestMainCi.conclusion} (commit ${githubState.latestMainCi.commit})`,
        remediation: "Dispatch a worker to fix CI immediately — broken main blocks all progress",
        capabilityNeeded: "ci-fix"
      });
    }
  } else {
    findings.push({
      area: "ci",
      severity: "warning",
      finding: "No CI runs found on default branch — CI may not be configured",
      remediation: "Set up GitHub Actions CI workflow if missing",
      capabilityNeeded: "ci-setup"
    });
  }

  // 2. Failed CI runs on open PR branches
  if (githubState.failedCiRuns.length > 0) {
    for (const run of githubState.failedCiRuns) {
      findings.push({
        area: "ci",
        severity: "important",
        finding: `Failed CI: ${run.name} on branch ${run.branch} (${run.commit})`,
        remediation: `Fix CI failure on ${run.branch} — this blocks PR merge`,
        capabilityNeeded: "ci-fix"
      });
    }
  }

  // 3. Stale PRs — open PRs that might be abandoned or forgotten
  if (githubState.pullRequests.length > 0) {
    const stalePRs = githubState.pullRequests.filter(p => !p.draft);
    if (stalePRs.length > 3) {
      findings.push({
        area: "github-hygiene",
        severity: "warning",
        finding: `${stalePRs.length} open non-draft PRs — possible stale or duplicate PRs`,
        remediation: "Review open PRs: close duplicates, merge ready ones, or update stale ones",
        capabilityNeeded: "pr-management"
      });
    }
  }

  // 4. Worker session health — detect stuck or errored workers
  const workerIssues = [];
  for (const [role, session] of Object.entries(sessions) as any[]) {
    if (session?.status === "error") {
      workerIssues.push(`${role}: errored`);
    }
    if (session?.status === "working") {
      const lastActive = session.lastActiveAt ? new Date(session.lastActiveAt).getTime() : 0;
      const minutesSinceActive = lastActive ? (Date.now() - lastActive) / 60000 : Infinity;
      if (minutesSinceActive > 60) {
        workerIssues.push(`${role}: stuck working for ${minutesSinceActive.toFixed(0)}m`);
      }
    }
  }
  if (workerIssues.length > 0) {
    findings.push({
      area: "worker-health",
      severity: "warning",
      finding: `Worker issues detected: ${workerIssues.join("; ")}`,
      remediation: "Reset stuck workers, investigate error causes",
      capabilityNeeded: "worker-recovery"
    });
  }

  // 5. Athena coordination gaps — did Athena complete all planned waves?
  const completedTasks = Array.isArray(AthenaCoordination?.completedTasks)
    ? AthenaCoordination.completedTasks : [];
  const executionWaves = Array.isArray(AthenaCoordination?.executionStrategy?.waves)
    ? AthenaCoordination.executionStrategy.waves : [];
  if (executionWaves.length > 0) {
    const incompleteWaves = executionWaves.filter(w => {
      const waveId = String(w?.id || "").trim().toLowerCase();
      return waveId && !completedTasks.some(t => String(t).toLowerCase().includes(waveId));
    });
    if (incompleteWaves.length > 0) {
      findings.push({
        area: "execution-gaps",
        severity: "important",
        finding: `${incompleteWaves.length} wave(s) not yet completed: ${incompleteWaves.map(w => w.id).join(", ")}`,
        remediation: "Continue execution of incomplete waves in next Athena cycle",
        capabilityNeeded: "wave-continuation"
      });
    }
  }

  // 6. Knowledge memory — check if self-improvement detected critical issues
  try {
    const stateDir = config.paths?.stateDir || "state";
    const km = await readJson(path.join(stateDir, "knowledge_memory.json"), {});
    const criticalLessons = (km.lessons || []).filter(l => l.severity === "critical").slice(-3);
    const capGaps = Array.isArray(km.capabilityGaps) ? km.capabilityGaps.slice(-5) : [];

    if (criticalLessons.length > 0) {
      findings.push({
        area: "system-learning",
        severity: "warning",
        finding: `Self-improvement flagged ${criticalLessons.length} critical lesson(s): ${criticalLessons.map(l => l.lesson).join("; ").slice(0, 300)}`,
        remediation: "Address critical lessons in next cycle planning",
        capabilityNeeded: "system-improvement"
      });
    }

    if (capGaps.length > 0) {
      for (const gap of capGaps.slice(0, 3)) {
        findings.push({
          area: "capability-gap",
          severity: gap.severity || "warning",
          finding: `Missing capability: ${gap.gap}`,
          remediation: gap.proposedFix || "Add missing capability to system",
          capabilityNeeded: gap.capability || "unknown"
        });
      }
    }
  } catch { /* knowledge memory not available — no-op */ }

  return findings;
}

function formatHealthAuditFindings(findings) {
  if (findings.length === 0) return "  No structural issues detected — system is healthy.";

  return findings.map((f, i) => {
    const icon = f.severity === "critical" ? "🔴" : f.severity === "important" ? "🟡" : "🟢";
    return `  ${i + 1}. ${icon} [${f.area}] ${f.finding}\n     → ${f.remediation}`;
  }).join("\n");
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
  const [issues, prs, repoInfo, recentRuns, mergedPrs] = await Promise.all([
    ghGet(`${base}/issues?state=open&per_page=20&sort=updated`),
    ghGet(`${base}/pulls?state=open&per_page=20&sort=updated`),
    ghGet(base),
    ghGet(`${base}/actions/runs?per_page=15`),
    ghGet(`${base}/pulls?state=closed&sort=updated&direction=desc&per_page=10`)
  ]);

  const defaultBranch = (repoInfo as any)?.default_branch || "main";
  const allRuns = Array.isArray((recentRuns as any)?.workflow_runs) ? (recentRuns as any).workflow_runs : [];

  // Latest completed run on default branch — the real CI health signal
  const mainRuns = allRuns.filter(r => r.head_branch === defaultBranch && r.status === "completed");
  const latestMainRun = mainRuns[0] || null;

  // Only count failures from the last 24 hours on branches with open PRs or the default branch
  const cutoff = Date.now() - 86400000;
  const openPrBranches = new Set(
    (Array.isArray(prs) ? prs : []).map(p => p.head?.ref).filter(Boolean)
  );
  openPrBranches.add(defaultBranch);
  const recentFailures = allRuns
    .filter(r => r.conclusion === "failure" &&
      new Date(r.updated_at).getTime() > cutoff &&
      openPrBranches.has(r.head_branch))
    .slice(0, 5);

  return {
    issues: Array.isArray(issues) ? issues.slice(0, 15).map(i => ({ number: i.number, title: i.title, labels: i.labels?.map(l => l.name) || [], state: i.state })) : [],
    pullRequests: Array.isArray(prs) ? prs.slice(0, 10).map(p => ({ number: p.number, title: p.title, state: p.state, draft: p.draft })) : [],
    repoInfo: repoInfo ? { name: (repoInfo as any).name, defaultBranch: (repoInfo as any).default_branch, openIssuesCount: (repoInfo as any).open_issues_count } : null,
    latestMainCi: latestMainRun ? {
      conclusion: latestMainRun.conclusion,
      branch: latestMainRun.head_branch,
      commit: latestMainRun.head_sha?.slice(0, 7),
      updatedAt: latestMainRun.updated_at
    } : null,
    failedCiRuns: recentFailures.map(r => ({
      name: r.name,
      branch: r.head_branch,
      commit: r.head_sha?.slice(0, 7),
      conclusion: r.conclusion,
      updatedAt: r.updated_at
    })),
    recentlyMergedPrs: Array.isArray(mergedPrs)
      ? mergedPrs.filter(p => p.merged_at).slice(0, 10).map(p => ({
          number: p.number,
          title: p.title,
          mergedAt: p.merged_at
        }))
      : []
  };
}

// ── Main Jesus Cycle ─────────────────────────────────────────────────────────

/**
 * Build the capacity delta report for the Jesus directive (Packet 13).
 * Identifies top bottlenecks, projected gains, and commanded interventions.
 *
 * @param {object} d — parsed AI decision
 * @param {object[]} healthFindings — from health audit
 * @param {object} kpis — parser confidence, plan count, etc.
 * @returns {{ topBottlenecks: Array, projectedGains: Array, commandedInterventions: Array }}
 */
function buildCapacityDeltaReport(d, healthFindings, kpis) {
  const topBottlenecks = [];
  const projectedGains = [];
  const commandedInterventions = [];

  // Extract bottlenecks from health findings
  const criticalFindings = (healthFindings || []).filter(f => f.severity === "critical");
  const importantFindings = (healthFindings || []).filter(f => f.severity === "important");

  for (const f of criticalFindings.slice(0, 3)) {
    topBottlenecks.push({
      area: f.area,
      severity: f.severity,
      description: f.finding,
    });
    commandedInterventions.push({
      action: f.remediation,
      priority: "immediate",
      capability: f.capabilityNeeded,
    });
  }

  for (const f of importantFindings.slice(0, 2)) {
    topBottlenecks.push({
      area: f.area,
      severity: f.severity,
      description: f.finding,
    });
  }

  // Add capacity KPI-based insights
  if (kpis.parserConfidence !== "n/a" && Number(kpis.parserConfidence) < 0.5) {
    topBottlenecks.push({
      area: "parser-reliability",
      severity: "important",
      description: `Parser confidence is ${kpis.parserConfidence} — plan quality may be degraded`,
    });
    projectedGains.push({
      improvement: "parser-reliability",
      estimatedGain: "20-40% reduction in plan retry churn",
    });
  }

  if (kpis.planCount === 0) {
    topBottlenecks.push({
      area: "planning-void",
      severity: "critical",
      description: "Prometheus produced zero plans — system cannot evolve",
    });
  }

  // Extract priorities from Jesus decision if available
  const priorities = Array.isArray(d?.priorities) ? d.priorities : [];
  for (const p of priorities.slice(0, 3)) {
    const text = typeof p === "string" ? p : p?.description || "";
    if (text) {
      projectedGains.push({
        improvement: text.slice(0, 100),
        estimatedGain: "capacity increase per Jesus priority",
      });
    }
  }

  return { topBottlenecks, projectedGains, commandedInterventions };
}

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
    AthenaCoordination,
    prometheusAnalysis,
    githubState,
    sessions
  ] = await Promise.all([
    readJson(path.join(stateDir, "jesus_directive.json"), {}),
    readJson(path.join(stateDir, "athena_coordination.json"), {}),
    readJson(path.join(stateDir, "prometheus_analysis.json"), {}),
    fetchGitHubState(config),
    readJson(path.join(stateDir, "worker_sessions.json"), {})
  ]);

  // ── Hierarchical Health Audit — detect what lower layers missed ──────────
  const healthFindings = await runSystemHealthAudit(config, githubState, AthenaCoordination, sessions);
  if (healthFindings.length > 0) {
    const criticalCount = healthFindings.filter(f => f.severity === "critical").length;
    await appendProgress(config, `[JESUS][AUDIT] ${healthFindings.length} finding(s) — ${criticalCount} critical`);
    chatLog(stateDir, jesusName, `Health audit: ${healthFindings.length} findings (${criticalCount} critical)`);

    // Persist findings for self-improvement to consume
    await writeJson(path.join(stateDir, "health_audit_findings.json"), {
      findings: healthFindings,
      auditedAt: new Date().toISOString()
    });
  }

  const activeSessions = Object.keys(sessions).filter(k => sessions[k]?.status === "working").length;
  const lastCycleAt = lastDirective?.decidedAt ? new Date(lastDirective.decidedAt).toLocaleString() : "never";
  const prometheusLastRunAt = prometheusAnalysis?.analyzedAt ? new Date(prometheusAnalysis.analyzedAt).toLocaleString() : "never";

  // Cost guard: skip the AI call if GitHub state hasn't changed and last directive is fresh
  const now = Date.now();
  const lastDecisionMs = lastDirective?.decidedAt ? new Date(lastDirective.decidedAt).getTime() : 0;
  const minutesSinceLast = (now - lastDecisionMs) / 60000;
  const ghFingerprint = [
    githubState.issues.map(i => i.number).join(","),
    githubState.pullRequests.map(p => p.number).join(","),
    githubState.failedCiRuns.length,
    githubState.latestMainCi?.conclusion || ""
  ].join("|");

  // Reuse directive if: (a) state unchanged + workers busy, OR (b) directive is very fresh with pending work
  const hasPendingWork = Array.isArray(lastDirective?.workItems) && lastDirective.workItems.length > 0;
  const isFreshDirective = minutesSinceLast < 2 && hasPendingWork && lastDirective?.wakeAthena;
  const directiveFreshnessMins = Number(config.runtime?.jesusDirectiveFreshnessMinutes) || 30;
  if (
    (minutesSinceLast < directiveFreshnessMins && lastDirective?.decision && lastDirective?.githubStateHash === ghFingerprint && activeSessions > 0) ||
    isFreshDirective
  ) {
    await appendProgress(config, `[JESUS] State unchanged (${minutesSinceLast.toFixed(1)}m ago) — reusing last directive (AI call skipped)`);
    chatLog(stateDir, jesusName, `State unchanged — reusing last directive (saved AI call)`);
    return lastDirective;
  }

  const prometheusAgeHours = prometheusAnalysis?.analyzedAt
    ? (now - new Date(prometheusAnalysis.analyzedAt).getTime()) / 3600000
    : Infinity;

  const workersList = Object.entries(registry?.workers || {})
    .map(([kind, w]) => `  - ${(w as any).name} (${kind}): ${(w as any).model}`)
    .join("\n");

  // English system state context — persona and output format are in jesus.agent.md
  // ── Capacity KPIs for strategic decisions ──────────────────────────────────
  const parserConfidence = prometheusAnalysis?.parserConfidence ?? "n/a";
  const planCount = Array.isArray(prometheusAnalysis?.plans) ? prometheusAnalysis.plans.length : 0;
  const optimizerStatus = prometheusAnalysis?.interventionOptimizer?.status || "n/a";
  const budgetUsed = prometheusAnalysis?.interventionOptimizer?.totalBudgetUsed ?? "n/a";
  const budgetLimit = prometheusAnalysis?.interventionOptimizer?.totalBudgetLimit ?? "n/a";

  // ── Capacity trends from scoreboard ────────────────────────────────────────
  let capacityTrendBlock = "";
  try {
    const recentEntries = await getRecentCapacity(config, 10);
    if (recentEntries.length >= 3) {
      const confTrend = computeTrend(recentEntries, "parserConfidence");
      const planTrend = computeTrend(recentEntries, "planCount");
      const budgetTrend = computeTrend(recentEntries, "budgetUsed");
      const workerTrend = computeTrend(recentEntries, "workersDone");
      capacityTrendBlock = `\n**Capacity Trends (last ${recentEntries.length} cycles):**
  Parser confidence trend: ${confTrend}
  Plan count trend: ${planTrend}
  Budget usage trend: ${budgetTrend}
  Worker completion trend: ${workerTrend}`;
    }
  } catch { /* non-critical */ }

  const contextPrompt = `TARGET REPO: ${config.env?.targetRepo || "unknown"}

## CURRENT SYSTEM STATE

**Active Worker Sessions:** ${activeSessions}
**Last Cycle:** ${lastCycleAt}
**Prometheus Last Analysis:** ${prometheusLastRunAt}${prometheusAgeHours < 6 ? ` (${prometheusAgeHours.toFixed(1)}h ago — FRESH, only set callPrometheus=true if health is critical)` : ""}

**GitHub State — ${config.env?.targetRepo}:**
Open Issues (${githubState.issues.length}):
${githubState.issues.length > 0
  ? githubState.issues.map(i => `  #${i.number}: ${i.title} [${i.labels.join(", ") || "no labels"}]`).join("\n")
  : "  No open issues"}

Open PRs (${githubState.pullRequests.length}):
${githubState.pullRequests.length > 0
  ? githubState.pullRequests.map(p => `  #${p.number}: ${p.title} [${p.draft ? "draft" : "open"}]`).join("\n")
  : "  No open PRs"}

**Latest CI on default branch (${githubState.latestMainCi?.branch || "main"}):**
${githubState.latestMainCi
  ? `  ${githubState.latestMainCi.conclusion} (${githubState.latestMainCi.commit}) [${githubState.latestMainCi.updatedAt}]`
  : "  No CI runs found"}

**Recent CI Failures (last 24h): ${githubState.failedCiRuns.length}**
${githubState.failedCiRuns.length > 0
  ? githubState.failedCiRuns.map(r => `  ${r.name} on ${r.branch} (${r.commit}) — ${r.conclusion} [${r.updatedAt}]`).join("\n")
  : "  No recent failures"}

**Recently Merged PRs (${githubState.recentlyMergedPrs.length}):**
${githubState.recentlyMergedPrs.length > 0
  ? githubState.recentlyMergedPrs.map(p => `  #${p.number}: ${p.title} [merged ${p.mergedAt}]`).join("\n")
  : "  No recently merged PRs"}

**Last Coordination:**
${AthenaCoordination?.summary ? `  ${AthenaCoordination.summary}` : "  No previous coordination"}
${AthenaCoordination?.completedTasks ? `  Completed tasks: ${AthenaCoordination.completedTasks}` : ""}

**Prometheus's Last Analysis:**
${prometheusAnalysis?.projectHealth ? `  Health: ${prometheusAnalysis.projectHealth}` : "  No analysis available"}
${prometheusAnalysis?.keyFindings ? `  Key findings: ${prometheusAnalysis.keyFindings}` : ""}
${prometheusAnalysis?.projectClassification ? `  Project type: ${prometheusAnalysis.projectClassification.type} (${prometheusAnalysis.projectClassification.confidence})` : ""}

**Capacity KPIs (use for strategic decisions):**
  Parser confidence: ${parserConfidence}
  Plans produced: ${planCount}
  Optimizer: status=${optimizerStatus} budget=${budgetUsed}/${budgetLimit}
  Prometheus age: ${prometheusAgeHours < Infinity ? `${prometheusAgeHours.toFixed(1)}h` : "never"}
${capacityTrendBlock}

**Hierarchical System Health Audit (detected by YOU — issues workers/Athena may have missed):**
${formatHealthAuditFindings(healthFindings)}
${healthFindings.filter(f => f.severity === "critical").length > 0 ? "\n⚠️ CRITICAL FINDINGS ABOVE — these MUST be addressed. Workers and Athena missed them." : ""}
${healthFindings.filter(f => f.area === "capability-gap").length > 0 ? "\n⚠️ CAPABILITY GAPS DETECTED — the system is missing abilities that caused failures. Consider requesting Prometheus to plan fixes." : ""}

**Available Workers:**
${workersList}`;

  chatLog(stateDir, jesusName, "Calling AI for strategic analysis...");
  const aiResult = await callCopilotAgent(command, "jesus", contextPrompt);

  if (!aiResult.ok || !aiResult.parsed) {
    await appendProgress(config, `[JESUS] AI call failed — ${(aiResult as any).error || "no JSON"}`);
    chatLog(stateDir, jesusName, `AI failed: ${(aiResult as any).error || "no JSON"}`);
    const needsPrometheus = prometheusAgeHours > 6;
    return {
      wait: false,
      wakeAthena: true,
      callPrometheus: needsPrometheus,
      prometheusReason: needsPrometheus ? "AI call failed and no recent Prometheus analysis — must scan" : undefined,
      decision: "tactical",
      systemHealth: "unknown",
      thinking: "",
      fullOutput: (aiResult as any).raw || "",
      briefForPrometheus: `Check GitHub issues and activate appropriate workers. Target repo: ${config.env?.targetRepo}`,
      priorities: [],
      workerSuggestions: []
    };
  }

  logAgentThinking(stateDir, jesusName, aiResult.thinking);

  // ── Trust boundary validation ────────────────────────────────────────────
  const tbMode = config?.runtime?.trustBoundaryMode === "warn" ? "warn" : "enforce";
  const trustCheck = validateLeadershipContract(
    LEADERSHIP_CONTRACT_TYPE.SUPERVISOR, aiResult.parsed, { mode: tbMode }
  );
  if (!trustCheck.ok && tbMode === "enforce") {
    const tbErrors = trustCheck.errors.map(e => `${e.payloadPath}: ${e.message}`).join(" | ");
    await appendProgress(config, `[JESUS][TRUST_BOUNDARY] Supervisor output failed contract validation — class=${TRUST_BOUNDARY_ERROR} reasonCode=${trustCheck.reasonCode} errors=${tbErrors}`);
    try {
      await appendAlert(config, {
        severity: ALERT_SEVERITY.CRITICAL,
        source: "jesus_supervisor",
        title: "Supervisor output failed trust-boundary validation",
        message: `class=${TRUST_BOUNDARY_ERROR} reasonCode=${trustCheck.reasonCode} errors=${tbErrors}`
      });
    } catch { /* non-fatal */ }
    // Degrade to safe fallback directive; never silently pass invalid output
    const needsPrometheus = prometheusAgeHours > 6;
    return {
      wait: false,
      wakeAthena: true,
      callPrometheus: needsPrometheus,
      prometheusReason: needsPrometheus ? "Trust-boundary violation in supervisor output and no recent Prometheus analysis" : undefined,
      decision: "tactical",
      systemHealth: "unknown",
      thinking: aiResult.thinking,
      fullOutput: (aiResult as any).raw || "",
      briefForPrometheus: `Check GitHub issues and activate appropriate workers. Target repo: ${config.env?.targetRepo}`,
      priorities: [],
      workerSuggestions: [],
      _trustBoundaryViolation: true,
      _trustBoundaryErrors: tbErrors
    };
  }
  if (trustCheck.errors.length > 0 && tbMode === "warn") {
    const tbErrors = trustCheck.errors.map(e => `${e.payloadPath}: ${e.message}`).join(" | ");
    await appendProgress(config, `[JESUS][TRUST_BOUNDARY][WARN] Contract violations (warn mode, not blocking): ${tbErrors}`);
  }

  const d = aiResult.parsed;

  // Safety net: force callPrometheus=true when no valid Prometheus analysis exists
  if (!d.callPrometheus && prometheusAgeHours > 6) {
    d.callPrometheus = true;
    d.prometheusReason = (d.prometheusReason || "") + " [OVERRIDE: no recent Prometheus analysis — forced callPrometheus=true]";
    await appendProgress(config, `[JESUS] callPrometheus overridden to true — Prometheus analysis is ${prometheusAgeHours === Infinity ? "missing" : prometheusAgeHours.toFixed(1) + "h old"}`);
  }

  // ── Safety net: force replanning if Athena rejected the previous plan ──────
  // If the last plan was rejected and we're about to skip replanning, that's wrong.
  // Athena rejection = mandatory replan, regardless of Prometheus freshness.
  if (!d.callPrometheus) {
    try {
      const athenaRejection = await readJsonSafe(path.join(stateDir, "athena_plan_rejection.json"));
      if (athenaRejection && typeof athenaRejection === "object") {
        d.callPrometheus = true;
        d.prometheusReason = (d.prometheusReason || "") + " [OVERRIDE: Athena rejected previous plan — forced callPrometheus=true for replan]";
        await appendProgress(config, `[JESUS] callPrometheus overridden to true — Athena rejection detected, mandatory replan`);
      }
    } catch { /* non-fatal: if athena_plan_rejection doesn't exist or is malformed, continue */ }
  }

  chatLog(stateDir, jesusName,
    `Decision: ${d.decision || "?"} | Health: ${d.systemHealth || "?"} | callPrometheus: ${d.callPrometheus} | wakeAthena: ${d.wakeAthena}`
  );
  await appendProgress(config,
    `[JESUS] decision=${d.decision} health=${d.systemHealth} callPrometheus=${d.callPrometheus} wakeAthena=${d.wakeAthena}`
  );

  // ── Capacity Delta Report (Packet 13) ──────────────────────────────────
  // Extract top bottlenecks and projected gains from Jesus's analysis.
  const capacityDelta = buildCapacityDeltaReport(d, healthFindings, {
    parserConfidence, planCount, optimizerStatus, budgetUsed, budgetLimit
  });

  const directive = {
    ...d,
    thinking: aiResult.thinking,
    fullOutput: (aiResult as any).raw || "",
    decidedAt: new Date().toISOString(),
    model: jesusModel,
    repo: config.env?.targetRepo,
    githubStateHash: ghFingerprint,
    capacityDelta,
  };

  await writeJson(path.join(stateDir, "jesus_directive.json"), directive);

  return directive;
}
