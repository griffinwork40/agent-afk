/**
 * Delegation-budget enforcement for `SubagentManager.forkSubagent`.
 *
 * Extracted from `../subagent.ts` to keep that file within its code-line
 * ceiling (#1899). All budget logic — admission check, slot recording, and
 * terminal-hook wrapping — is concentrated here so `forkSubagent` stays
 * readable while enforcing the same limits as the agent-tool / compose /
 * DAG dispatch paths.
 *
 * @module agent/subagent/fork-budget
 */

import type { DelegationBudget, SpawnReceipt } from '../tools/delegation-budget.js';
import { buildBudgetRefusalMessage } from '../tools/delegation-budget.js';

export { SpawnReceipt };
export type { DelegationBudget };

/**
 * Admission check + slot reservation for one fork.
 *
 * Returns a `SpawnReceipt` (call `release()` on terminal, `rollback()` on
 * construction failure) when a budget is active, or `undefined` when the
 * manager carries no budget (the common case — all three env vars unset).
 *
 * Throws `Error` with a human-readable message when the budget is exhausted.
 * The check and record are performed synchronously (no await) so concurrent
 * parallel forks cannot all pass `canSpawn` before any reaches `recordSpawn`.
 */
export function admitFork(
  budget: DelegationBudget | undefined,
  parentId: string,
): SpawnReceipt | undefined {
  if (!budget) return undefined;
  const check = budget.canSpawn(parentId);
  if (!check.allowed) {
    throw new Error(buildBudgetRefusalMessage(check));
  }
  return budget.recordSpawn(parentId);
}

/**
 * Wrap a terminal-hook callback so the budget slot is released when the
 * forked child reaches its terminal state. When `receipt` is undefined
 * (no budget configured), returns `base` unchanged — zero overhead.
 */
export function wrapTerminalWithRelease(
  base: () => void,
  receipt: SpawnReceipt | undefined,
): () => void {
  if (!receipt) return base;
  return () => { receipt.release(); base(); };
}
