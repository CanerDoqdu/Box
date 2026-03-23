/**
 * Task schema definitions for BOX.
 * JSDoc @typedef equivalents of the original TypeScript types.
 * Provides IDE type-hinting without requiring a TypeScript build pipeline.
 */

import { createHash } from "node:crypto";
import { validateLineageEntry, LINEAGE_ERROR_CODE } from "./lineage_graph.js";

export { validateLineageEntry, LINEAGE_ERROR_CODE };

/**
 * @typedef {"quality"|"stability"|"production"|"security"|"general"} Domain
 */

/**
 * @typedef {"bootstrap"|"quality"|"stability"|"production"|"refactor"|"frontend"|"backend"|"api"|"integration"|"test"|"qa"|"devops"|"security"|"scan"|"general"} TaskKind
 */

/**
 * @typedef {"queued"|"running"|"blocked"|"failed"|"passed"|"parked"} TaskStatus
 */

/**
 * @typedef {object} TaskLoopMetadata
 * @property {string}  fingerprint
 * @property {number}  attempts
 * @property {number}  semanticAttempts
 * @property {number}  repeatedFailureCount
 * @property {string}  [failureSignature]
 * @property {number}  contextRevision
 * @property {string}  [cooldownUntil]
 * @property {number}  lineageRootTaskId
 * @property {number}  splitDepth
 * @property {number}  [splitCount]
 */

/**
 * Lineage entry schema — one node in the task fingerprint lineage graph.
 *
 * 'split ancestry' definition: when a task is produced via source='autonomous-split',
 * splitAncestry holds the ordered chain of taskIds from the lineage root down to (but
 * not including) the current task. For root tasks and non-split retries the array is empty.
 *
 * @typedef {object} LineageEntry
 * @property {string}      id            — unique entry ID: <fp_prefix>-<taskId>-<attempt>
 * @property {number}      taskId        — the QueueTask.id this entry tracks
 * @property {string}      semanticKey   — QueueTask.semanticKey
 * @property {string}      fingerprint   — sha1(kind|normalizedTitle) 40-char hex
 * @property {string|null} parentId      — lineage entry ID of the direct parent; null for roots
 * @property {number}      rootId        — taskId of the lineage root (equals taskId for roots)
 * @property {number}      depth         — depth from lineage root (0 = root)
 * @property {"running"|"passed"|"failed"|"blocked"|"parked"} status
 * @property {string}      timestamp     — ISO 8601 recording timestamp
 * @property {string|null} failureReason — populated when status is 'failed' or 'blocked'; null otherwise
 * @property {number[]}    splitAncestry — ordered taskIds [root, ..., direct-parent]; empty for non-splits
 */

/**
 * Failure cluster — a group of failed/blocked entries sharing the same task fingerprint.
 * Only clusters with count >= LINEAGE_THRESHOLDS.CLUSTER_MIN_SIZE are reported.
 *
 * @typedef {object} FailureCluster
 * @property {string}   fingerprint   — task fingerprint (sha1 hex) shared by all entries
 * @property {string}   semanticKey   — representative semanticKey (from most recent entry)
 * @property {string}   failureReason — most common failure reason across the cluster
 * @property {number}   count         — number of failed/blocked entries
 * @property {number[]} taskIds       — deduplicated list of taskIds in this cluster
 * @property {string}   lastFailedAt  — ISO timestamp of the most recent failure
 */

/**
 * @typedef {object} TaskContract
 * @property {"1.0"}             contractVersion
 * @property {Domain}            domain
 * @property {string}            goal
 * @property {string[]}          nonGoals
 * @property {string[]}          filesInScope
 * @property {string[]}          testsToAdd
 * @property {string[]}          exitCriteria
 * @property {string}            rollbackPlan
 * @property {string[]}          invariants
 * @property {"low"|"medium"|"high"} riskLevel
 */

/**
 * @typedef {object} QueueTask
 * @property {number}           id
 * @property {string}           semanticKey
 * @property {string}           title
 * @property {TaskKind}         kind
 * @property {1|2|3|4|5}        priority
 * @property {TaskStatus}       status
 * @property {"roadmap"|"autonomous-retry"|"autonomous-split"|"autonomous-resume"|"autonomous-cycle"} source
 * @property {number}           attempt
 * @property {TaskContract}     contract
 * @property {number}           version
 * @property {string}           createdAt
 * @property {string}           updatedAt
 * @property {number}           [parentTaskId]
 * @property {number}           [splitDepth]
 * @property {number}           [lineageRootTaskId]
 * @property {number}           [dependsOnIssueNumber]
 * @property {number}           [linkedIssueNumber]
 * @property {string}           [assignedRole]
 * @property {string}           [assignedWorker]
 * @property {string}           [assignedAt]
 * @property {string}           [failureReason]
 * @property {string}           [lastTransition]
 * @property {string}           [lastTransitionAt]
 * @property {string}           [transitionBy]
 * @property {TaskLoopMetadata} [loop]
 */

/**
 * @template T
 * @typedef {object} ValidationResult
 * @property {boolean}  ok
 * @property {T}        [value]
 * @property {string[]} errors
 */

const ALLOWED_KINDS = new Set([
  "bootstrap", "quality", "stability", "production", "refactor",
  "frontend", "backend", "api", "integration", "test", "qa",
  "devops", "security", "scan", "general"
]);

const ALLOWED_DOMAINS = new Set(["quality", "stability", "production", "security", "general"]);

function asIsoDate(value) {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  return Number.isFinite(Date.parse(value));
}

function normalizePath(pathValue) {
  return pathValue.replace(/\\/g, "/").replace(/\/+/, "/").trim();
}

function isSafeRepoRelativePath(pathValue) {
  const value = normalizePath(pathValue);
  if (!value || value.startsWith("/") || value.startsWith("../") || value.includes("://")) return false;
  return !value.split("/").includes("..");
}

/**
 * Build a stable semantic key for deduplication.
 * @param {TaskKind} kind
 * @param {string}   title
 * @returns {string}
 */
export function buildSemanticKey(kind, title) {
  const normalizedTitle = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s:_-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const digest = createHash("sha1").update(`${kind}|${normalizedTitle}`).digest("hex").slice(0, 16);
  return `${kind}::${digest}`;
}

/**
 * Validate a TaskContract object.
 * @param {unknown} input
 * @returns {ValidationResult<TaskContract>}
 */
export function validateTaskContract(input) {
  const errors = [];
  const value = /** @type {Partial<TaskContract>} */ (input);

  if (!value || typeof value !== "object") {
    return { ok: false, errors: ["contract must be an object"] };
  }
  if (value.contractVersion !== "1.0") {
    errors.push("contractVersion must be '1.0'");
  }
  if (!ALLOWED_DOMAINS.has(value.domain)) {
    errors.push("domain is invalid");
  }
  if (typeof value.goal !== "string" || value.goal.trim().length === 0) {
    errors.push("goal is required");
  }
  if (!Array.isArray(value.nonGoals) || value.nonGoals.length === 0) {
    errors.push("nonGoals must be non-empty array");
  }
  if (!Array.isArray(value.exitCriteria) || value.exitCriteria.length === 0) {
    errors.push("exitCriteria must be non-empty array");
  }
  if (typeof value.rollbackPlan !== "string" || value.rollbackPlan.trim().length === 0) {
    errors.push("rollbackPlan is required");
  }
  if (!Array.isArray(value.invariants) || value.invariants.length === 0) {
    errors.push("invariants must be non-empty array");
  }
  if (value.domain === "production" || value.domain === "security") {
    if (!Array.isArray(value.invariants) || value.invariants.length === 0) {
      errors.push("production/security contracts require invariants");
    }
  }
  if (!Array.isArray(value.filesInScope)) {
    errors.push("filesInScope must be an array");
  } else {
    for (const p of value.filesInScope) {
      if (typeof p !== "string" || !isSafeRepoRelativePath(p)) {
        errors.push(`filesInScope contains unsafe path: ${String(p)}`);
      }
    }
  }
  if (!Array.isArray(value.testsToAdd)) {
    errors.push("testsToAdd must be an array");
  }
  if (!["low", "medium", "high"].includes(String(value.riskLevel))) {
    errors.push("riskLevel must be low|medium|high");
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: /** @type {TaskContract} */ (value), errors: [] };
}

/**
 * Validate a QueueTask object.
 * @param {unknown} input
 * @returns {ValidationResult<QueueTask>}
 */
export function validateQueueTask(input) {
  const errors = [];
  const value = /** @type {Partial<QueueTask>} */ (input);

  if (!value || typeof value !== "object") {
    return { ok: false, errors: ["task must be an object"] };
  }
  if (!Number.isInteger(value.id) || Number(value.id) <= 0) {
    errors.push("id must be positive integer");
  }
  if (typeof value.title !== "string" || value.title.trim().length === 0) {
    errors.push("title is required");
  }
  if (!ALLOWED_KINDS.has(value.kind)) {
    errors.push("kind is invalid");
  }
  if (![1, 2, 3, 4, 5].includes(Number(value.priority))) {
    errors.push("priority must be 1..5");
  }
  if (!["queued", "running", "blocked", "failed", "passed", "parked"].includes(String(value.status))) {
    errors.push("status is invalid");
  }
  if (!Number.isInteger(value.attempt) || Number(value.attempt) < 1) {
    errors.push("attempt must be >= 1");
  }
  if (!Number.isInteger(value.version) || Number(value.version) < 1) {
    errors.push("version must be >= 1");
  }
  if (!asIsoDate(value.createdAt) || !asIsoDate(value.updatedAt)) {
    errors.push("createdAt/updatedAt must be valid ISO timestamps");
  }
  if (typeof value.semanticKey !== "string" || value.semanticKey.trim().length === 0) {
    errors.push("semanticKey is required");
  }

  if (value.loop !== undefined) {
    const loop = /** @type {Partial<TaskLoopMetadata>} */ (value.loop);
    if (typeof loop.fingerprint !== "string" || loop.fingerprint.trim().length === 0) {
      errors.push("loop.fingerprint is required when loop metadata is present");
    }
    if (!Number.isInteger(loop.attempts) || Number(loop.attempts) < 0) {
      errors.push("loop.attempts must be >= 0");
    }
    if (!Number.isInteger(loop.semanticAttempts) || Number(loop.semanticAttempts) < 0) {
      errors.push("loop.semanticAttempts must be >= 0");
    }
    if (!Number.isInteger(loop.contextRevision) || Number(loop.contextRevision) < 0) {
      errors.push("loop.contextRevision must be >= 0");
    }
    if (!Number.isInteger(loop.lineageRootTaskId) || Number(loop.lineageRootTaskId) <= 0) {
      errors.push("loop.lineageRootTaskId must be positive integer");
    }
    if (!Number.isInteger(loop.splitDepth) || Number(loop.splitDepth) < 0) {
      errors.push("loop.splitDepth must be >= 0");
    }
  }

  const contractResult = validateTaskContract(value.contract);
  if (!contractResult.ok) {
    errors.push(...contractResult.errors.map((e) => `contract.${e}`));
  }

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: /** @type {QueueTask} */ (value), errors: [] };
}
