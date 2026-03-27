/**
 * contract_health.ts — Worker startup contract health types and utilities.
 *
 * Exported separately from run_task.ts so that orchestrator, runtime gates,
 * and tests can import these helpers without triggering the main() entry point.
 *
 * Format: WORKER_CONTRACT_HEALTH=env_vars:<pass|fail|n/a>;payload:<pass|fail|n/a>;role:<pass|fail|n/a>
 */

export type ContractSlot = "pass" | "fail" | "n/a";

export interface ContractHealth {
  env_vars: ContractSlot;
  payload: ContractSlot;
  role: ContractSlot;
}

/**
 * Format a ContractHealth object as the canonical WORKER_CONTRACT_HEALTH= line.
 * The line is deterministic and machine-parseable.
 */
export function formatContractHealth(health: ContractHealth): string {
  return `WORKER_CONTRACT_HEALTH=env_vars:${health.env_vars};payload:${health.payload};role:${health.role}`;
}

/**
 * Parse a WORKER_CONTRACT_HEALTH= line back into a ContractHealth object.
 * Returns null if the line does not contain a valid health marker.
 *
 * Accepts both stdout (success) and stderr (failure) output lines.
 */
export function parseContractHealth(line: string): ContractHealth | null {
  const match = String(line || "").match(/WORKER_CONTRACT_HEALTH=([^\s\r\n]+)/);
  if (!match) return null;

  const parts = match[1].split(";");
  const slots: Partial<ContractHealth> = {};
  for (const part of parts) {
    const idx = part.indexOf(":");
    if (idx === -1) continue;
    const key = part.slice(0, idx) as keyof ContractHealth;
    const val = part.slice(idx + 1) as ContractSlot;
    if (key && (val === "pass" || val === "fail" || val === "n/a")) {
      slots[key] = val;
    }
  }

  if (!slots.env_vars || !slots.payload || !slots.role) return null;
  return slots as ContractHealth;
}

/**
 * Returns true when every contract slot is "pass" — the startup contract is healthy.
 * Returns false for any "fail" or "n/a" slot.
 */
export function isContractHealthy(health: ContractHealth): boolean {
  return health.env_vars === "pass" && health.payload === "pass" && health.role === "pass";
}
