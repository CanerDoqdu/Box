/**
 * Self-Development Guard
 *
 * Safety layer activated when BOX targets its own repository.
 * Prevents workers from modifying critical system files that would
 * break the running orchestrator mid-cycle.
 *
 * Recovery flow:
 *   1. Copilot (you) tries to fix any failure first
 *   2. If unfixable → rollback to recovery tag: box/recovery-v0.1.0-pre-selfdev
 *
 * Rules enforced:
 *   - NEVER modify files in CRITICAL_FILES during a worker run
 *   - NEVER delete state files or .env
 *   - NEVER touch git config / force push
 *   - Max files per PR is capped (prevent mega-refactors)
 *   - All changes MUST be on a branch (never main)
 *   - Lint + test gate is mandatory (no bypass)
 *   - self_dev_guard.js itself is immutable during self-dev
 */

// Unused imports kept as _prefixed for future recovery flows
import _path from "node:path";  

// ── Critical paths that must NEVER be modified by workers during self-dev ─────

const CRITICAL_FILES = [
  "src/core/orchestrator.ts",
  "src/core/self_dev_guard.ts",
  "src/core/daemon_control.ts",
  "src/core/policy_engine.ts",
  "src/cli.ts",
  ".env",
  ".env.sandbox",
  "policy.json",
];

const CRITICAL_PREFIXES = [
  "state/",
  ".git/",
  "node_modules/",
  ".next/",
];

// Files that can be modified but need extra caution (warn, don't block)
const CAUTION_FILES = [
  "src/core/self_improvement.ts",
  "src/core/jesus_supervisor.ts",
  "src/core/prometheus.ts",
  "box.config.json",
  "package.json",
];

// ── Self-dev detection ───────────────────────────────────────────────────────

/**
 * Detect if BOX is targeting its own repository.
 * Checks both config and ENV to be safe.
 */
export function isSelfDevMode(config) {
  const targetRepo = String(config?.env?.targetRepo || process.env.TARGET_REPO || "").toLowerCase();
  const selfRepoMarkers = [
    "box-orchestrator",
    "box/box",
    "/box",
  ];
  // Explicit flag in config
  if (config?.selfDev?.enabled === true) return true;
  // Check if target repo name indicates self
  return selfRepoMarkers.some(m => targetRepo.endsWith(m) || targetRepo.includes("box-orchestrator"));
}

// ── File change validation ───────────────────────────────────────────────────

/**
 * Validate a list of changed file paths against self-dev rules.
 * Returns { allowed: boolean, blocked: string[], warnings: string[] }
 */
export function validateFileChanges(changedFiles) {
  const blocked = [];
  const warnings = [];

  for (const file of changedFiles) {
    const normalized = file.replace(/\\/g, "/").toLowerCase();

    // Check critical files (absolute block)
    for (const critical of CRITICAL_FILES) {
      if (normalized === critical.toLowerCase() || normalized.endsWith("/" + critical.toLowerCase())) {
        blocked.push(`BLOCKED: ${file} is a critical system file — cannot modify during self-dev`);
      }
    }

    // Check critical prefixes
    for (const prefix of CRITICAL_PREFIXES) {
      if (normalized.startsWith(prefix) || normalized.includes("/" + prefix)) {
        blocked.push(`BLOCKED: ${file} is under protected prefix ${prefix}`);
      }
    }

    // Check caution files (warn only)
    for (const caution of CAUTION_FILES) {
      if (normalized === caution.toLowerCase() || normalized.endsWith("/" + caution.toLowerCase())) {
        warnings.push(`CAUTION: ${file} is a sensitive system file — review carefully`);
      }
    }
  }

  return {
    allowed: blocked.length === 0,
    blocked,
    warnings,
  };
}

// ── PR size guard ────────────────────────────────────────────────────────────

/**
 * Check if the number of changed files exceeds the self-dev limit.
 */
export function validatePrSize(changedFilesCount, config) {
  const maxFiles = Number(config?.selfDev?.maxFilesPerPr || 8);
  if (changedFilesCount > maxFiles) {
    return {
      allowed: false,
      reason: `Self-dev PR too large: ${changedFilesCount} files changed (max ${maxFiles}). Break into smaller PRs.`,
    };
  }
  return { allowed: true, reason: "" };
}

// ── Branch guard ─────────────────────────────────────────────────────────────

/**
 * Ensure work is on a branch, never directly on main/master.
 */
export function validateBranch(branchName) {
  const name = String(branchName || "").trim().toLowerCase();
  if (!name || name === "main" || name === "master") {
    return {
      allowed: false,
      reason: `Self-dev mode requires a feature branch. Current: "${branchName || "(none)"}". Use box/selfdev-* prefix.`,
    };
  }
  return { allowed: true, reason: "" };
}

// ── Gate enforcement ─────────────────────────────────────────────────────────

/**
 * Return the gate overrides for self-dev mode.
 * These are stricter than normal — lint and tests are mandatory.
 */
export function getSelfDevGateOverrides() {
  return {
    requireBuild: true,
    requireTests: true,
    requireLint: true,
    requireSecurityScan: true,
    minCoveragePercent: 0, // don't block on coverage, but lint+test must pass
  };
}

// ── Worker context injection ─────────────────────────────────────────────────

/**
 * Returns extra context to inject into worker prompts during self-dev.
 * This tells workers what they CAN and CANNOT do.
 */
export function getSelfDevWorkerContext() {
  return [
    "## SELF-DEVELOPMENT MODE ACTIVE",
    "You are modifying the BOX system itself. Follow these rules strictly:",
    "",
    "### FORBIDDEN (will be rejected):",
    `- Do NOT modify these files: ${CRITICAL_FILES.join(", ")}`,
    `- Do NOT touch files under: ${CRITICAL_PREFIXES.join(", ")}`,
    "- Do NOT delete any existing files",
    "- Do NOT add force-push, --no-verify, or skip-test flags",
    "- Do NOT modify the self-dev guard itself",
    "- Do NOT make changes directly on main branch",
    "",
    "### REQUIRED:",
    "- All changes must pass lint AND tests",
    "- Keep PRs small (max 8 files changed)",
    "- Each PR should do ONE thing",
    "- Add tests for any new functionality",
    "- Use existing code patterns (ESM, readJson/writeJson, appendProgress)",
    "",
    "### CAUTION (allowed but review carefully):",
    `- ${CAUTION_FILES.join(", ")}`,
    "- Changes to these files affect core behavior — be precise",
    "",
    "### RECOVERY:",
    "- Recovery tag: box/recovery-v0.1.0-pre-selfdev",
    "- If something breaks: Copilot fixes first, then rollback to tag if needed",
  ].join("\n");
}

// ── Recovery info ────────────────────────────────────────────────────────────

export const RECOVERY_TAG = "box/recovery-v0.1.0-pre-selfdev";

/**
 * Get recovery instructions for the current self-dev session.
 */
export function getRecoveryInstructions() {
  return {
    tag: RECOVERY_TAG,
    rollbackCommand: `git checkout ${RECOVERY_TAG} -- .`,
    hardResetCommand: `git reset --hard ${RECOVERY_TAG}`,
    note: "Try Copilot fix first. Hard reset is last resort — loses all self-dev work.",
  };
}
