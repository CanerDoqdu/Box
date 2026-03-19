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
import { buildAgentArgs, parseAgentOutput, logAgentThinking } from "./agent_loader.js";
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

// ── Project Type Classification ────────────────────────────────────────────

function classifyProjectType(repoInfo, fileTree, packageJson) {
  const signals = {
    type: "generic",
    confidence: "low",
    indicators: []
  };

  const files = (fileTree || []).map(f => f.toLowerCase());
  const deps = Object.keys(packageJson?.dependencies || {}).concat(
    Object.keys(packageJson?.devDependencies || {})
  ).map(d => d.toLowerCase());
  const topics = (repoInfo?.topics || []).map(t => t.toLowerCase());
  const description = String(repoInfo?.description || "").toLowerCase();
  const _language = String(repoInfo?.language || "").toLowerCase();

  const scores = {
    fintech: 0,
    ecommerce: 0,
    saas: 0,
    blog: 0,
    portfolio: 0,
    dashboard: 0,
    api: 0,
    mobile: 0,
    "real-time": 0,
    "data-pipeline": 0
  };

  // Fintech signals
  const fintechDeps = ["stripe", "@stripe/stripe-js", "plaid", "paypal", "braintree", "square", "adyen"];
  const fintechKeywords = ["payment", "fintech", "banking", "transaction", "wallet", "invoice", "billing", "subscription"];
  for (const d of deps) { if (fintechDeps.some(fd => d.includes(fd))) scores.fintech += 3; }
  for (const k of fintechKeywords) { if (description.includes(k) || topics.includes(k)) scores.fintech += 2; }
  if (files.some(f => f.includes("payment") || f.includes("checkout") || f.includes("billing"))) scores.fintech += 2;

  // E-commerce signals
  const ecomDeps = ["shopify", "snipcart", "medusa", "saleor", "commerce", "cart"];
  const ecomKeywords = ["ecommerce", "e-commerce", "shop", "store", "product", "cart", "catalog"];
  for (const d of deps) { if (ecomDeps.some(ed => d.includes(ed))) scores.ecommerce += 3; }
  for (const k of ecomKeywords) { if (description.includes(k) || topics.includes(k)) scores.ecommerce += 2; }
  if (files.some(f => f.includes("product") || f.includes("cart") || f.includes("catalog"))) scores.ecommerce += 2;

  // SaaS signals
  const saasDeps = ["next-auth", "@auth/core", "clerk", "supabase", "firebase", "prisma", "@prisma/client"];
  const saasKeywords = ["saas", "platform", "dashboard", "multi-tenant", "subscription", "api"];
  for (const d of deps) { if (saasDeps.some(sd => d.includes(sd))) scores.saas += 2; }
  for (const k of saasKeywords) { if (description.includes(k) || topics.includes(k)) scores.saas += 2; }
  if (files.some(f => f.includes("api/") || f.includes("auth") || f.includes("middleware"))) scores.saas += 1;

  // Blog / Content site signals
  const blogDeps = ["contentlayer", "mdx", "@next/mdx", "sanity", "contentful", "strapi"];
  const blogKeywords = ["blog", "content", "article", "post", "cms", "editorial"];
  for (const d of deps) { if (blogDeps.some(bd => d.includes(bd))) scores.blog += 3; }
  for (const k of blogKeywords) { if (description.includes(k) || topics.includes(k)) scores.blog += 2; }

  // Portfolio / Landing page signals
  const portfolioKeywords = ["portfolio", "personal", "landing", "resume", "cv", "showcase"];
  for (const k of portfolioKeywords) { if (description.includes(k) || topics.includes(k)) scores.portfolio += 3; }
  if (files.length < 30 && !files.some(f => f.includes("api/"))) scores.portfolio += 1;

  // Dashboard / Admin signals
  const dashDeps = ["recharts", "chart.js", "d3", "victory", "ag-grid", "tanstack"];
  for (const d of deps) { if (dashDeps.some(dd => d.includes(dd))) scores.dashboard += 2; }
  if (files.some(f => f.includes("dashboard") || f.includes("admin") || f.includes("analytics"))) scores.dashboard += 2;

  // API-only signals
  const apiDeps = ["express", "fastify", "hono", "koa", "nest"];
  for (const d of deps) { if (apiDeps.some(ad => d.includes(ad))) scores.api += 3; }
  if (!files.some(f => f.includes("components/") || f.includes("pages/") || f.includes("app/"))) scores.api += 2;

  // Real-time signals
  const rtDeps = ["socket.io", "ws", "pusher", "ably", "livekit"];
  for (const d of deps) { if (rtDeps.some(rd => d.includes(rd))) scores["real-time"] += 3; }

  // Mobile signals
  const mobileDeps = ["react-native", "expo", "capacitor", "ionic"];
  for (const d of deps) { if (mobileDeps.some(md => d.includes(md))) scores.mobile += 5; }

  // Find the top type
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topType, topScore] = sorted[0];
  const [secondType, secondScore] = sorted[1] || ["generic", 0];

  if (topScore >= 4) {
    signals.type = topType;
    signals.confidence = topScore >= 7 ? "high" : "medium";
    signals.indicators.push(`${topType}: score ${topScore}`);
    if (secondScore >= 3) {
      signals.secondaryType = secondType;
      signals.indicators.push(`secondary: ${secondType} (score ${secondScore})`);
    }
  } else if (topScore >= 2) {
    signals.type = topType;
    signals.confidence = "low";
    signals.indicators.push(`${topType}: score ${topScore} (low confidence)`);
  }

  return signals;
}

function determineComplexityCeiling(projectType, secondaryType) {
  // Maps project type to production readiness requirements with priority levels
  // "critical" = must have, "important" = should have, "optional" = nice to have
  const ceilings = {
    fintech: {
      description: "Financial technology — handles money, requires bank-grade security and reliability",
      dimensions: {
        security: { priority: "critical", scope: "PCI-DSS awareness, input validation on ALL endpoints, CSRF+XSS protection, rate limiting, fraud detection signals, auth token rotation, secrets audit, dependency vulnerability scan" },
        reliability: { priority: "critical", scope: "Error boundaries, retry+circuit breaker on payment flows, idempotent transactions, graceful degradation, health checks" },
        testing: { priority: "critical", scope: "100% business logic unit tests, integration tests on payment/transaction flows, E2E for critical money paths" },
        performance: { priority: "important", scope: "Sub-200ms API responses, optimized DB queries, caching for read-heavy paths" },
        observability: { priority: "critical", scope: "Structured logging on all transactions, error tracking (Sentry), audit trail for financial operations" },
        "ci-cd": { priority: "important", scope: "Full CI with lint+type-check+test, staging environment, rollback strategy" },
        "ui-ux": { priority: "important", scope: "Responsive design, clear error states, loading states, form validation" },
        documentation: { priority: "important", scope: "API docs, architecture overview, deployment runbook" },
        "github-settings": { priority: "important", scope: "Branch protection, required reviews, auto-delete branches, dependabot" },
        "new-features": { priority: "important", scope: "Complete payment flows, proper error handling UI, email notifications" }
      }
    },
    ecommerce: {
      description: "E-commerce — product catalog, cart, checkout, order management",
      dimensions: {
        security: { priority: "critical", scope: "Payment input validation, CSRF, XSS, rate limiting on checkout, auth, secrets management" },
        "ui-ux": { priority: "critical", scope: "Full responsive design, product pages, cart UX, checkout flow, empty/loading/error states, accessibility WCAG 2.1 AA" },
        performance: { priority: "critical", scope: "Image optimization, lazy loading, CDN, Core Web Vitals targets, SSR/SSG for product pages" },
        testing: { priority: "important", scope: "Unit tests for cart/price logic, integration tests for checkout, E2E for purchase flow" },
        reliability: { priority: "important", scope: "Error boundaries, retry on payment, inventory consistency, graceful degradation" },
        "ci-cd": { priority: "important", scope: "CI pipeline, build optimization, staging, SEO validation" },
        observability: { priority: "important", scope: "Error tracking, analytics, conversion tracking" },
        documentation: { priority: "optional", scope: "README, API docs if headless" },
        "github-settings": { priority: "optional", scope: "Branch protection, auto-delete branches" },
        "new-features": { priority: "critical", scope: "Complete product pages, cart, checkout, search/filter, order confirmation" }
      }
    },
    saas: {
      description: "SaaS platform — multi-user, auth, API, dashboard",
      dimensions: {
        security: { priority: "critical", scope: "Auth/authz, session management, RBAC, input validation, CSRF, rate limiting, API key management" },
        reliability: { priority: "critical", scope: "Error boundaries, graceful degradation, retry logic, health checks, data backup strategy" },
        testing: { priority: "critical", scope: "Unit tests for business logic, integration tests for API, E2E for auth+core flows" },
        performance: { priority: "important", scope: "API response times, query optimization, caching, pagination" },
        "ui-ux": { priority: "important", scope: "Responsive dashboard, loading/error states, accessibility, onboarding flow" },
        observability: { priority: "important", scope: "Structured logging, error tracking, uptime monitoring, usage analytics" },
        "ci-cd": { priority: "important", scope: "Full CI, staging environment, database migrations, rollback" },
        documentation: { priority: "important", scope: "API documentation, architecture docs, onboarding guide" },
        "github-settings": { priority: "important", scope: "Branch protection, required reviews, dependabot, code scanning" },
        "new-features": { priority: "important", scope: "Complete CRUD flows, user management, settings, notifications" }
      }
    },
    blog: {
      description: "Blog / Content site — articles, SEO, static generation",
      dimensions: {
        performance: { priority: "critical", scope: "SSG/ISR, image optimization, Core Web Vitals, lazy loading, minimal JS" },
        "ui-ux": { priority: "critical", scope: "Responsive design, reading experience, typography, dark mode, accessibility" },
        "new-features": { priority: "important", scope: "SEO meta tags, sitemap, RSS feed, social sharing, search" },
        testing: { priority: "optional", scope: "Basic component tests, accessibility tests" },
        security: { priority: "optional", scope: "Content sanitization if user input exists, security headers" },
        reliability: { priority: "optional", scope: "Error boundaries, 404 handling" },
        "ci-cd": { priority: "optional", scope: "Build + deploy pipeline, preview environments" },
        observability: { priority: "optional", scope: "Analytics, basic error tracking" },
        documentation: { priority: "optional", scope: "README with setup instructions" },
        "github-settings": { priority: "optional", scope: "Auto-delete branches" }
      }
    },
    portfolio: {
      description: "Portfolio / Landing page — showcase, minimal complexity",
      dimensions: {
        "ui-ux": { priority: "critical", scope: "Responsive design, animations, visual polish, accessibility" },
        performance: { priority: "critical", scope: "Fast load times, image optimization, Core Web Vitals" },
        "new-features": { priority: "important", scope: "Contact form, SEO, social links, project showcase" },
        testing: { priority: "optional", scope: "Visual regression tests if complex animations" },
        security: { priority: "optional", scope: "Form input validation if contact form exists" },
        reliability: { priority: "optional", scope: "Error boundaries" },
        "ci-cd": { priority: "optional", scope: "Deploy pipeline" },
        observability: { priority: "optional", scope: "Analytics" },
        documentation: { priority: "optional", scope: "README" },
        "github-settings": { priority: "optional", scope: "Auto-delete branches" }
      }
    },
    dashboard: {
      description: "Dashboard / Admin panel — data visualization, CRUD operations",
      dimensions: {
        "ui-ux": { priority: "critical", scope: "Responsive tables/charts, loading states, filters, pagination, accessibility" },
        performance: { priority: "critical", scope: "Virtualized lists, chart rendering optimization, data caching, lazy loading" },
        security: { priority: "critical", scope: "Auth/authz, RBAC, input validation, CSRF, session management" },
        testing: { priority: "important", scope: "Unit tests for data transformations, integration tests for API calls, E2E for critical admin flows" },
        reliability: { priority: "important", scope: "Error boundaries, retry on API calls, graceful degradation" },
        "ci-cd": { priority: "important", scope: "CI pipeline, type checking, staging" },
        observability: { priority: "important", scope: "Error tracking, usage analytics" },
        documentation: { priority: "optional", scope: "API docs, data model documentation" },
        "github-settings": { priority: "optional", scope: "Branch protection" },
        "new-features": { priority: "important", scope: "Export functionality, advanced filters, bulk operations" }
      }
    },
    api: {
      description: "API service — backend-only, no UI",
      dimensions: {
        security: { priority: "critical", scope: "Input validation on ALL endpoints, auth/authz, rate limiting, CORS, injection prevention, API key management" },
        testing: { priority: "critical", scope: "Unit tests for business logic, integration tests for all endpoints, contract tests" },
        reliability: { priority: "critical", scope: "Error handling, retry logic, circuit breakers, health checks, graceful shutdown" },
        performance: { priority: "important", scope: "Response time targets, query optimization, connection pooling, caching" },
        observability: { priority: "critical", scope: "Structured logging, request tracing, error tracking, metrics" },
        "ci-cd": { priority: "important", scope: "Full CI, database migrations, staging, rollback strategy" },
        documentation: { priority: "critical", scope: "OpenAPI/Swagger docs, architecture docs, deployment guide" },
        "github-settings": { priority: "important", scope: "Branch protection, required reviews, dependabot" },
        "ui-ux": { priority: "optional", scope: "N/A for API-only" },
        "new-features": { priority: "important", scope: "Complete CRUD, pagination, filtering, versioning" }
      }
    },
    "real-time": {
      description: "Real-time application — WebSocket/streaming, live updates",
      dimensions: {
        reliability: { priority: "critical", scope: "Connection recovery, message ordering, backpressure handling, graceful reconnection" },
        performance: { priority: "critical", scope: "Low-latency message delivery, efficient serialization, connection pooling" },
        security: { priority: "critical", scope: "WebSocket auth, message validation, rate limiting per connection" },
        testing: { priority: "important", scope: "Connection lifecycle tests, message ordering tests, load tests" },
        observability: { priority: "important", scope: "Connection metrics, message throughput, error rates" },
        "ci-cd": { priority: "important", scope: "CI pipeline, load testing in CI" },
        "ui-ux": { priority: "important", scope: "Real-time UI updates, connection status indicators" },
        documentation: { priority: "important", scope: "Protocol documentation, message format docs" },
        "github-settings": { priority: "optional", scope: "Branch protection" },
        "new-features": { priority: "important", scope: "Presence, typing indicators, message history" }
      }
    },
    generic: {
      description: "Generic project — apply balanced production standards",
      dimensions: {
        security: { priority: "important", scope: "Input validation, auth if applicable, security headers" },
        testing: { priority: "important", scope: "Unit tests for business logic, integration tests for key flows" },
        reliability: { priority: "important", scope: "Error handling, graceful degradation" },
        performance: { priority: "important", scope: "Reasonable load times, optimization where needed" },
        "ui-ux": { priority: "important", scope: "Responsive design if UI exists, accessibility basics" },
        "ci-cd": { priority: "important", scope: "CI pipeline, automated checks" },
        observability: { priority: "optional", scope: "Error tracking, basic logging" },
        documentation: { priority: "important", scope: "README, setup instructions" },
        "github-settings": { priority: "optional", scope: "Auto-delete branches, branch protection" },
        "new-features": { priority: "important", scope: "Feature completeness based on project goals" }
      }
    }
  };

  const primary = ceilings[projectType] || ceilings.generic;

  // If there's a secondary type, merge its critical dimensions as important
  if (secondaryType && ceilings[secondaryType]) {
    const secondary = ceilings[secondaryType];
    for (const [dim, spec] of Object.entries(secondary.dimensions)) {
      if (spec.priority === "critical" && primary.dimensions[dim]?.priority !== "critical") {
        primary.dimensions[dim] = { ...spec, priority: "important", scope: `${spec.scope} (from ${secondaryType} secondary type)` };
      }
    }
  }

  return primary;
}

function formatComplexityCeiling(ceiling) {
  const lines = [`PROJECT TYPE: ${ceiling.description}`, ""];
  const priorityOrder = ["critical", "important", "optional"];
  for (const priority of priorityOrder) {
    const dims = Object.entries(ceiling.dimensions)
      .filter(([, spec]) => spec.priority === priority);
    if (dims.length === 0) continue;
    lines.push(`### ${priority.toUpperCase()} DIMENSIONS:`);
    for (const [dim, spec] of dims) {
      lines.push(`  - **${dim}**: ${spec.scope}`);
    }
    lines.push("");
  }
  return lines.join("\n");
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

async function _buildLocalRepoSnapshot(config) {
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
      "```" + language,
      `${entry.content}${truncationNote}`,
      "```",
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
  const args = buildAgentArgs({ agentSlug, prompt: contextPrompt });
  const result = await spawnAsync(command, args, { env: process.env });
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
  const args = buildAgentArgs({ agentSlug, prompt: contextPrompt });
  const result = await spawnAsync(command, args, { env: process.env });
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

// ── Simplified retry prompt for JSON-only extraction ─────────────────────────
// When the full JSON call fails, we send a focused prompt with just the dossier
// and ask the model to produce ONLY the JSON. This avoids tool-use confusion.

function buildRetryJsonPrompt(dossierText, workersList, config, planningPolicy, projectClassification) {
  return `You are Trump — BOX's deep project analyst. A prior call already produced a full dossier.
Your ONLY job now is to produce the structured JSON output based on that dossier.

TARGET REPO: ${config.env?.targetRepo || "unknown"}
PROJECT TYPE: ${projectClassification.type} (${projectClassification.confidence})

## PRIOR DOSSIER (use this as your source of truth)
${dossierText ? dossierText.slice(0, 8000) : "No dossier available."}

## AVAILABLE WORKERS
${workersList}

## EXECUTION POLICY
- Max workers per wave: ${planningPolicy.maxWorkersPerWave}
- Prefer fewest workers: ${planningPolicy.preferFewestWorkers ? "YES" : "NO"}
- Dependency-aware waves: ${planningPolicy.requireDependencyAwareWaves ? "YES" : "NO"}

## YOUR ONLY TASK
Based on the dossier above, produce your analysis as structured JSON.
Do NOT use any tools. Do NOT read any files. Just convert the dossier into the JSON format below.
Write a brief narrative first, then the JSON block.

===DECISION===
{
  "analysis": "<comprehensive summary from dossier>",
  "strategicNarrative": "<execution strategy narrative>",
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
      "context": "<detailed 500-2000 word implementation checklist for the worker>",
      "verification": "<how to verify completion>",
      "dependencies": [],
      "downstream": "<what this enables>"
    }
  ]
}
===END===

CRITICAL: You MUST wrap the JSON between ===DECISION=== and ===END=== markers exactly as shown above. This is how the system parses your output.`;
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
  const planningPolicy = buildTrumpPlanningPolicy(config);

  // ── Project Type Classification & Complexity Ceiling ─────────────────────
  // Read package.json from local snapshot for dependency analysis
  let packageJson = {};
  try {
    const localDir = await resolveLocalRepoDir(config);
    if (localDir) {
      packageJson = JSON.parse(await fs.readFile(path.join(localDir, "package.json"), "utf8"));
    }
  } catch { /* no package.json available */ }

  const projectClassification = classifyProjectType(context.repoInfo, context.fileTree, packageJson);
  const complexityCeiling = determineComplexityCeiling(
    projectClassification.type,
    projectClassification.secondaryType
  );
  const ceilingText = formatComplexityCeiling(complexityCeiling);

  chatLog(stateDir, trumpName, `Project classified as: ${projectClassification.type} (${projectClassification.confidence}) — ceiling applied`);
  await appendProgress(config, `[TRUMP] Project type: ${projectClassification.type} (${projectClassification.confidence})${projectClassification.secondaryType ? ` + ${projectClassification.secondaryType}` : ""}`);

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

  // Build knowledge memory context if available
  const knowledgeMemoryPath = path.join(stateDir, "knowledge_memory.json");
  let knowledgeSection = "";
  try {
    const km = JSON.parse(await fs.readFile(knowledgeMemoryPath, "utf8"));
    const lessons = Array.isArray(km?.lessons) ? km.lessons.slice(-10) : [];
    if (lessons.length > 0) {
      knowledgeSection = `\n## LESSONS FROM PREVIOUS CYCLES (knowledge memory)\n${lessons.map(l => `- [${l.source || "system"}] ${l.lesson}`).join("\n")}\nUse these lessons to avoid repeating past mistakes and to build on what worked.\n`;
    }
  } catch { /* no knowledge memory yet */ }

  const sharedContext = `TARGET REPO: ${config.env?.targetRepo || "unknown"}
${context.repoInfo ? `Project: ${context.repoInfo.name} | Language: ${context.repoInfo.language} | Topics: ${context.repoInfo.topics.join(", ")}` : ""}

## PROJECT CLASSIFICATION
Type: ${projectClassification.type} (confidence: ${projectClassification.confidence})
${projectClassification.secondaryType ? `Secondary type: ${projectClassification.secondaryType}` : ""}
Indicators: ${projectClassification.indicators.join(", ") || "generic signals"}

## COMPLEXITY CEILING — What a senior big-tech engineer expects for THIS project type
${ceilingText}

⚠️ THIS CEILING IS YOUR GUIDE. Do NOT blindly add everything from all 10 dimensions.
Focus your planning on CRITICAL dimensions first, then IMPORTANT ones. OPTIONAL dimensions
should only be addressed if the critical/important ones are already satisfactory.
A portfolio site does NOT need the same security infrastructure as a fintech app.
A blog does NOT need rate limiting or circuit breakers.
Plan what THIS specific project type ACTUALLY NEEDS at production level.

## YOUR MISSION — TARGETED PRODUCTION READINESS
You are the deep strategic analyst for this repository. Your job is to make this project **production-ready**
at a **senior engineer level** — but SCOPED to what THIS project type actually needs.

The COMPLEXITY CEILING above defines your target. Plan work that hits CRITICAL dimensions fully,
IMPORTANT dimensions substantially, and only touch OPTIONAL dimensions if everything else is solid.
Do NOT waste worker premium requests on things this project type doesn't need.

Evaluate and plan work across the following dimensions, PRIORITIZED by the complexity ceiling:

### 1. NEW FEATURES & CAPABILITIES
- What features are missing for a complete product?
- What libraries, tools, or dependencies should be added?
- What functionality gaps exist compared to a production-grade project in this category?

### 2. SECURITY (OWASP Top 10 + beyond)
- Input validation, sanitization, injection prevention (SQL, XSS, command)
- Auth/authz, session management, CSRF/CORS
- Secret management, env var security, key rotation
- Dependency vulnerability audit, supply chain security
- Security headers, CSP, rate limiting, abuse prevention

### 3. PERFORMANCE & OPTIMIZATION
- Bundle size, code splitting, lazy loading
- Image optimization, caching strategies
- Database query optimization, connection pooling
- Core Web Vitals (LCP, FID, CLS), performance budgets
- SSR/SSG optimization where applicable

### 4. UI/UX & ACCESSIBILITY
- Responsive design across all breakpoints
- WCAG 2.1 AA compliance, aria labels, keyboard navigation
- Error states, loading states, empty states
- User feedback, form validation UX, animations

### 5. RELIABILITY & ERROR HANDLING
- Error boundaries, graceful degradation
- Retry logic, circuit breakers, timeout handling
- Logging, structured error reporting
- Health checks, readiness probes

### 6. TESTING
- Unit tests for all business logic
- Integration tests for API routes
- E2E tests for critical user flows
- Test coverage targets, testing infrastructure

### 7. CI/CD & DEVOPS
- GitHub Actions workflow completeness
- Build optimization, caching, parallelization
- Deployment pipeline, staging/production environments
- Rollback strategy, release tagging

### 8. GITHUB REPO SETTINGS & CONFIGURATION
- Branch protection rules, required reviews
- Auto-delete head branches after merge ✓ (enabled)
- Issue/PR templates, labels, milestones
- Secret and variable management
- Dependabot, code scanning, security alerts

### 9. DOCUMENTATION
- README completeness, setup instructions
- API documentation, architecture docs
- Contributing guide, code of conduct
- Changelog, versioning strategy

### 10. OBSERVABILITY & MONITORING
- Structured logging, log levels
- Error tracking (Sentry or equivalent)
- Uptime monitoring, alerting
- Analytics, user behavior tracking

## ALREADY-DONE WORK — AUDIT & DECIDE
The following PRs are MERGED and issues CLOSED. For each:
- If COMPLETE and correct in the local snapshot → SKIP
- If INCOMPLETE, BROKEN, or HALF-DONE → plan as "regression-fix"
- If the area needs NEW work beyond what was merged → plan as "new"

MERGED PULL REQUESTS:
${mergedPRsSummary}

RECENT MERGED COMMITS:
${mergedCommitsSummary}

CLOSED ISSUES:
${closedIssueSummary}
${knowledgeSection}
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
- Workers CAN install npm packages, add new files, create new components, write new tests, add new libraries.
- Workers CAN and SHOULD add missing tooling: testing frameworks, linters, monitoring, analytics, etc.
- The goal is a COMPLETE production-ready project, not just fixing existing code.

Design the plan so that upstream workers prepare downstream prerequisites whenever practical. If frontend/API/backend/auth work is related, sequence it deliberately instead of waking everyone at once.

## MANDATORY: READ EVERY SOURCE FILE BEFORE WRITING ANYTHING
You have FULL tool access. The repo is at: ${process.cwd()}

### STEP 1 — DISCOVER (do this FIRST, before any analysis)
Run these commands using your tools:
- list_dir on the repo root to see top-level files
- list_dir on src/, src/core/, src/providers/, docker/, .github/
- Read package.json, box.config.json, policy.json, docker-compose.yml

### STEP 2 — READ EVERY SOURCE FILE (do this SECOND)
Use view (or read_file) to read the COMPLETE contents of EVERY .js file under:
- src/cli.js, src/config.js
- EVERY file in src/core/ (orchestrator.js, worker_runner.js, trump.js, jesus_supervisor.js, moses_coordinator.js, agent_loader.js, task_routing.js, policy_engine.js, gates.js, state_tracker.js, budget_controller.js, checkpoint_engine.js, doctor.js, project_scanner.js, fs_utils.js, logger.js, and any others)
- EVERY file in src/providers/ (all subdirectories)
- EVERY file in src/workers/
- EVERY file in src/dashboard/
- EVERY file in docker/
- EVERY .agent.md file in .github/agents/
Read them one by one. Do NOT skip any file. Do NOT summarize from file names.

### STEP 3 — ONLY THEN WRITE YOUR ANALYSIS
After reading ALL source files, write your analysis based on ACTUAL CODE you read.
Reference specific function names, line numbers, variable names, and code patterns.
If your analysis mentions a file, you MUST have read it first.

CRITICAL RULES:
- Do NOT write any analysis before completing Step 1 and Step 2.
- Do NOT say "insufficient context provided" — if you need info, READ THE FILE.
- Do NOT base analysis on file names alone — read the actual code.
- Every finding MUST reference actual code you read (function names, patterns, line numbers).

## OPEN ISSUES (${context.issues.length})
${context.issues.length > 0 ? context.issues.map(i => `  #${i.number} [${i.labels.join(", ") || "no labels"}]: ${i.title}`).join("\n") : "No open issues"}

## OPEN PULL REQUESTS (${context.pullRequests.length})
${context.pullRequests.length > 0 ? context.pullRequests.map(p => `  #${p.number} [${p.draft ? "DRAFT" : "ready"}]: ${p.title}`).join("\n") : "No open PRs"}

## AVAILABLE WORKERS
${workersList}`;

  const dossierPrompt = `${sharedContext}

DOSSIER MODE

Produce a long-form senior-staff execution dossier for this repository.
Do not emit JSON.

IMPORTANT: This project is classified as "${projectClassification.type}" (${projectClassification.confidence} confidence).
Your analysis MUST be calibrated to this project type's complexity ceiling.
Focus deepest analysis on CRITICAL dimensions, substantial analysis on IMPORTANT ones,
and only brief notes on OPTIONAL dimensions. Do NOT over-engineer for the project type.

Write substantial sections covering:
1. Architecture reading and technology stack assessment
2. FULL production readiness gap analysis across ALL 10 dimensions listed in YOUR MISSION above
3. New features, libraries, and tooling that should be added — not just fixing existing code
4. Security audit findings and remediation plan
5. Performance optimization opportunities
6. UI/UX and accessibility gaps
7. Testing strategy and coverage plan (including what testing frameworks/tools to add)
8. CI/CD and GitHub repo configuration improvements
9. Documentation gaps
10. Observability and monitoring plan
11. Dependency ordering and worker activation strategy
12. Role ownership and detailed phased execution plan
13. Premium request budget section with total, by-wave, and by-role estimates

Each recommended worker should receive a large work packet with prerequisites, substeps, verification, and downstream handoff expectations.
Workers SHOULD install new packages, add new files, create new components, and add missing tooling. This is NOT just a regression audit — it is a full production readiness transformation.

IMPORTANT CONSTRAINTS:
- You have FULL tool access: view, list_dir, grep_search. USE THEM.
- BEFORE writing your dossier, you MUST read every source file using the view tool.
- The repo is at: ${process.cwd()}. Read files directly.
- Do NOT say "insufficient context provided" — if you need info, READ THE FILE with your tools.
- Do NOT provide speculative time/hour estimates for workers.
- Discover the most important production-level dimensions for THIS target repo and go beyond baseline depth.
- Review the full production-readiness surface. For each major domain, state whether it is already adequate, missing and required, or not applicable.
- Do not silently skip common production domains such as auth/session management, token rotation, anomaly detection, SEO, performance budgets, observability, rollback safety, and platform security.
- For every recommendation, include explicit evidence mapping: file paths, commits, issues, PRs, or snapshot indicators.
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
- You have FULL tool access: view, list_dir, grep_search. USE THEM.
- BEFORE writing your plan, READ every important source file using the view tool.
- The repo is at: ${process.cwd()}. Read files directly.
- Do NOT say "insufficient context provided" — if you need info, READ THE FILE.
- No speculative hour/time estimates.
- Discover repo-specific production priorities across ALL 10 dimensions in YOUR MISSION.
- This is NOT just a regression audit. Plan NEW features, NEW libraries, NEW tooling, NEW tests, NEW infrastructure that the project needs to be production-ready.
- Workers CAN install npm packages, create new files, add new libraries, write new components, add monitoring/analytics/testing tools.
- Evaluate the full production-readiness surface and explicitly classify major domains as already adequate, missing and required, or not applicable.
- Do not silently omit common production domains such as auth/session management, token rotation, anomaly detection, SEO, performance, observability, rollback safety, and deployment/platform security.
- Every plan item must include evidence anchors: file paths, function names, line numbers from code you actually read.
- If evidence is missing, READ THE FILE with your tools — do NOT write "insufficient context provided".
- All output and JSON fields must be in English only.
- MANDATORY: Include a \`requestBudget\` object. The system will HARD-CAP all premium requests to this number. The budget is binding — once exhausted no more workers run.
  Structure: { "estimatedPremiumRequestsTotal": <number>, "errorMarginPercent": <number 10-30>, "hardCapTotal": <number = total * (1 + margin/100) rounded up>, "confidence": "high|medium|low", "byWave": [{"waveId": "...", "requests": <n>}], "byRole": [{"role": "...", "requests": <n>}] }
  Rules: count 1 premium request per worker dispatch. Include validation/retry cycles in the estimate. The hardCapTotal is what the system enforces — set it conservatively.
- Include a \`productionReadinessCoverage\` array that states for each relevant production domain whether it is adequate, missing, or not applicable, with evidence-based justification.
- Premium request estimates must reflect likely worker activations and validation cycles, not arbitrary round numbers.
- Workers must receive large, complete task packets. Each worker must do substantial production-quality work (hundreds to thousands of lines) in a single request. Never assign trivial 10-line tasks.
- Workers SHOULD add new npm packages, create new files, add testing frameworks, add monitoring tools, add missing libraries. This is full production readiness, not just fixing existing code.
- CRITICAL: The "context" field in each plan is what the worker will literally receive as their task description. Write it as an exhaustive implementation checklist: every file to modify, every function to add/change, every edge case to handle, every test to write, every npm package to install. The worker will use this as their reference and checklist — they will work through it item by item. Make it EXTREMELY detailed (500-2000 words per worker plan). The more detail here, the higher quality the worker output.
- Include in each plan's context: the EXACT current state of the code (which you read with your tools), what's wrong with it, what the fix should be, which files to create/modify, which patterns to follow from the existing codebase, what the verification steps are, which npm packages to install.
- Think of each plan's context as a senior engineer's handoff document: if a new hire received this, they could execute perfectly without asking a single question.`;

  chatLog(stateDir, trumpName, "Calling AI for deep repository analysis (this may take a while)...");

  // ── JSON call with retry logic ───────────────────────────────────────────
  const MAX_JSON_RETRIES = 2;
  let aiResult = null;
  for (let attempt = 0; attempt <= MAX_JSON_RETRIES; attempt++) {
    const isRetry = attempt > 0;
    const promptForAttempt = isRetry
      ? buildRetryJsonPrompt(dossierText, workersList, config, planningPolicy, projectClassification)
      : contextPrompt;

    if (isRetry) {
      await appendProgress(config, `[TRUMP] JSON retry attempt ${attempt}/${MAX_JSON_RETRIES} — using simplified prompt`);
      chatLog(stateDir, trumpName, `JSON retry ${attempt}/${MAX_JSON_RETRIES}...`);
    }

    aiResult = await callCopilotAgent(command, "trump", promptForAttempt);
    const fallback = detectModelFallback(aiResult?.combinedRaw || aiResult?.raw || "");
    if (fallback) {
      const warningMessage = `Trump model fallback detected: requested=${fallback.requestedModel}, active=${fallback.fallbackModel}`;
      await appendProgress(config, `[TRUMP][WARN] ${warningMessage}`);
      try {
        await appendAlert(config, { severity: "warning", source: "trump", title: "Trump model fallback", message: warningMessage });
      } catch { /* non-fatal */ }
    }

    if (aiResult.ok && aiResult.parsed) break;

    await appendProgress(config, `[TRUMP] JSON attempt ${attempt + 1} failed — ${aiResult.error || "no valid JSON in output"}`);
    chatLog(stateDir, trumpName, `JSON attempt ${attempt + 1} failed: ${aiResult.error || "no parseable JSON"}`);
  }

  if (!aiResult?.ok || !aiResult?.parsed) {
    await appendProgress(config, `[TRUMP] All ${MAX_JSON_RETRIES + 1} JSON attempts failed — Trump analysis returning null`);
    chatLog(stateDir, trumpName, `Analysis failed after ${MAX_JSON_RETRIES + 1} attempts — no valid JSON produced`);
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
    projectClassification,
    complexityCeiling: {
      type: projectClassification.type,
      secondaryType: projectClassification.secondaryType || null,
      confidence: projectClassification.confidence,
      description: complexityCeiling.description,
      criticalDimensions: Object.entries(complexityCeiling.dimensions)
        .filter(([, s]) => s.priority === "critical").map(([d]) => d),
      importantDimensions: Object.entries(complexityCeiling.dimensions)
        .filter(([, s]) => s.priority === "important").map(([d]) => d)
    },
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
