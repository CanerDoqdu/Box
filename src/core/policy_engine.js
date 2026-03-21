import { readJson } from "./fs_utils.js";

export async function loadPolicy(config) {
  return readJson(config.paths.policyFile, {
    protectedPaths: [],
    requireReviewerApprovalForProtectedPaths: true,
    blockedCommands: [],
    rolePolicies: {}
  });
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function matchPathPattern(targetPath, pattern) {
  const pathNorm = normalizePath(targetPath);
  const patternNorm = normalizePath(pattern);
  if (!pathNorm || !patternNorm) return false;

  if (patternNorm.endsWith("/**")) {
    const prefix = patternNorm.slice(0, -3);
    return pathNorm === prefix || pathNorm.startsWith(`${prefix}/`);
  }

  if (patternNorm.startsWith("**/")) {
    const suffix = patternNorm.slice(3);
    return pathNorm.endsWith(suffix);
  }

  return pathNorm === patternNorm;
}

export function isProtectedPath(policy, filePath) {
  const patterns = Array.isArray(policy?.protectedPaths) ? policy.protectedPaths : [];
  return patterns.some((pattern) => matchPathPattern(filePath, pattern));
}

export function getProtectedPathMatches(policy, filePaths) {
  const files = Array.isArray(filePaths) ? filePaths : [];
  return files.filter((file) => isProtectedPath(policy, file));
}

export function validateShellCommand(policy, command) {
  const normalized = String(command || "").toLowerCase();
  const blocked = (Array.isArray(policy?.blockedCommands) ? policy.blockedCommands : [])
    .find((item) => normalized.includes(String(item).toLowerCase()));
  if (blocked) {
    return { ok: false, reason: `blocked command matched: ${blocked}` };
  }
  return { ok: true };
}

function normalizeRoleName(roleName) {
  return String(roleName || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-");
}

function getRolePolicy(policy, roleName) {
  const all = policy?.rolePolicies;
  if (!all || typeof all !== "object") return null;

  const normalized = normalizeRoleName(roleName);
  if (!normalized) return null;

  if (all[normalized]) return all[normalized];

  const direct = String(roleName || "").trim();
  if (direct && all[direct]) return all[direct];
  return null;
}

export function getRolePathViolations(policy, roleName, filePaths) {
  const rolePolicy = getRolePolicy(policy, roleName);
  const files = Array.isArray(filePaths) ? filePaths : [];
  if (!rolePolicy || files.length === 0) {
    return {
      role: String(roleName || ""),
      deniedMatches: [],
      outsideAllowed: [],
      hasViolation: false
    };
  }

  const allowedPaths = Array.isArray(rolePolicy?.allowedPaths) ? rolePolicy.allowedPaths : [];
  const deniedPaths = Array.isArray(rolePolicy?.deniedPaths) ? rolePolicy.deniedPaths : [];

  const deniedMatches = deniedPaths.length > 0
    ? files.filter((file) => deniedPaths.some((pattern) => matchPathPattern(file, pattern)))
    : [];

  const outsideAllowed = allowedPaths.length > 0
    ? files.filter((file) => !allowedPaths.some((pattern) => matchPathPattern(file, pattern)))
    : [];

  return {
    role: String(roleName || ""),
    deniedMatches,
    outsideAllowed,
    hasViolation: deniedMatches.length > 0 || outsideAllowed.length > 0
  };
}
