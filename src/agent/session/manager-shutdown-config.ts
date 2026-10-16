import type { SubagentManager } from '../subagent.js';
import type { AgentConfig } from '../types.js';

/** Anything that owns forked children whose abandoned streams can still bill. */
export interface BillingStreamSource {
  getPendingChildBillingStreams(): readonly Promise<void>[];
}

/**
 * Union of every source's live abandoned-stream receipts. Compose DAG nodes
 * fork through the compose executor's own ephemeral managers, NOT the root
 * manager, so a surface that passes only the root manager silently drops
 * late compose-node billing at seal (#3889 round 3).
 */
export function pendingChildBillingStreams(
  ...sources: ReadonlyArray<BillingStreamSource | undefined>
): readonly Promise<void>[] {
  return sources.flatMap((source) => source?.getPendingChildBillingStreams() ?? []);
}

/** Keep manager drain, terminal-write and billing-settlement ownership together. */
export function managerShutdownConfig(
  manager: SubagentManager,
  composeExecutor?: BillingStreamSource,
): Pick<AgentConfig, 'drainSubagents' | 'getPendingChildTerminalWrites' | 'getPendingChildBillingStreams'> {
  return {
    drainSubagents: (reason) =>
      manager.abortAllAndDrain('session_end', 'user_signal', undefined, reason === 'reset'),
    getPendingChildTerminalWrites: () => manager.getPendingChildTerminalWrites(),
    getPendingChildBillingStreams: () => pendingChildBillingStreams(manager, composeExecutor),
  };
}
