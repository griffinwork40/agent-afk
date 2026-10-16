import type { SubagentManager } from '../subagent.js';
import type { AgentConfig } from '../types.js';

/** Keep manager drain, terminal-write and billing-settlement ownership together. */
export function managerShutdownConfig(manager: SubagentManager): Pick<AgentConfig,
  'drainSubagents' | 'getPendingChildTerminalWrites' | 'getPendingChildBillingStreams'
> {
  return {
    drainSubagents: (reason) =>
      manager.abortAllAndDrain('session_end', 'user_signal', undefined, reason === 'reset'),
    getPendingChildTerminalWrites: () => manager.getPendingChildTerminalWrites(),
    getPendingChildBillingStreams: () => manager.getPendingChildBillingStreams(),
  };
}
