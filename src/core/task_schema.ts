import { createHash } from "node:crypto";

export type Domain = "quality" | "stability" | "production" | "security" | "general";

export type TaskKind =
  | "bootstrap"
  | "quality"
  | "stability"
  | "production"
  | "refactor"
  | "frontend"
  | "backend"
  | "api"
  | "integration"
  | "test"
  | "qa"
  | "devops"
  | "security"
  | "scan"
  | "general";

export type TaskStatus = "queued" | "running" | "blocked" | "failed" | "passed" | "parked";

export interface TaskLoopMetadata {
  fingerprint: string;
  attempts: number;
  semanticAttempts: number;
  repeatedFailureCount: number;
  failureSignature?: string;
  contextRevision: number;
  cooldownUntil?: string;
  lineageRootTaskId: number;
  splitDepth: number;
  splitCount?: number;
}

export interface TaskContract {
  contractVersion: "1.0";
  domain: Domain;
  goal: string;
  nonGoals: string[];
  filesInScope: string[];
  testsToAdd: string[];
  exitCriteria: string[];
  rollbackPlan: string;
  invariants: string[];
  riskLevel: "low" | "medium" | "high";
}

export interface QueueTask {
  id: number;
  semanticKey: string;
  title: string;
  kind: TaskKind;
  priority: 1 | 2 | 3 | 4 | 5;
  status: TaskStatus;
  source: "roadmap" | "autonomous-retry" | "autonomous-split" | "autonomous-resume" | "autonomous-cycle";
  attempt: number;
  contract: TaskContract;
  version: number;
  createdAt: string;
  updatedAt: string;
  parentTaskId?: number;
  splitDepth?: number;
  lineageRootTaskId?: number;
  dependsOnIssueNumber?: number;
  linkedIssueNumber?: number;
  assignedRole?: string;
  assignedWorker?: string;
  assignedAt?: string;
  failureReason?: string;
  lastTransition?: string;
  lastTransitionAt?: string;
  transitionBy?: string;
  loop?: TaskLoopMetadata;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  errors: string[];
}

const ALLOWED_KINDS: Set<TaskKind> = new Set([
  "bootstrap", "quality", "stability", "production", "refactor", "frontend", "backend", "api", "integration", "test", "qa", "devops", "security", "scan", "general"
]);

const ALLOWED_DOMAINS: Set<Domain> = new Set(["quality", "stability", "production", "security", "general"]);

function asIsoDate(value: unknown): boolean {
  if (typeof value !== "string" || value.trim().length === 0) {
    return false;
  }
  const ts = Date.parse(value);
  return Number.isFinite(ts);
}

function normalizePath(pathValue: string): string {
  return pathValue.replace(/\\/g, "/").replace(/\/+/, "/").trim();
}

function isSafeRepoRelativePath(pathValue: string): boolean {
  const value = normalizePath(pathValue);
  if (!value || value.startsWith("/") || value.startsWith("../") || value.includes("://")) {
    return false;
  }
  return !value.split("/").includes("..");
}

export function buildSemanticKey(kind: TaskKind, title: string): string {
  const normalizedTitle = String(title || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s:_-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  const digest = createHash("sha1").update(`${kind}|${normalizedTitle}`).digest("hex").slice(0, 16);
  return `${kind}::${digest}`;
}

export function validateTaskContract(input: unknown): ValidationResult<TaskContract> {
  const errors: string[] = [];
  const value = input as Partial<TaskContract>;

  if (!value || typeof value !== "object") {
    return { ok: false, errors: ["contract must be an object"] };
  }
  if (value.contractVersion !== "1.0") {
    errors.push("contractVersion must be '1.0'");
  }
  if (!ALLOWED_DOMAINS.has(value.domain as Domain)) {
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

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: value as TaskContract, errors: [] };
}

export function validateQueueTask(input: unknown): ValidationResult<QueueTask> {
  const errors: string[] = [];
  const value = input as Partial<QueueTask>;

  if (!value || typeof value !== "object") {
    return { ok: false, errors: ["task must be an object"] };
  }

  if (!Number.isInteger(value.id) || Number(value.id) <= 0) {
    errors.push("id must be positive integer");
  }
  if (typeof value.title !== "string" || value.title.trim().length === 0) {
    errors.push("title is required");
  }
  if (!ALLOWED_KINDS.has(value.kind as TaskKind)) {
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
    const loop = value.loop as Partial<TaskLoopMetadata>;
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

  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: value as QueueTask, errors: [] };
}
