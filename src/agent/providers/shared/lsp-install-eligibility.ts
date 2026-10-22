import type { AgentConfig } from '../../types/config-types.js';

/** Opt-in comes from the interactive surface builder, never model arguments. */
export function lspInstallEligible(config: Pick<AgentConfig,
  'lspInstallAllowed' | 'surface' | 'isNonInteractive' | 'depth' | 'parentSessionId' | 'subagentId'>): boolean {
  return config.lspInstallAllowed === true
    && (config.surface === 'cli' || config.surface === 'telegram' || config.surface === 'repl')
    && config.isNonInteractive !== true
    && (config.depth === undefined || config.depth === 0)
    && config.parentSessionId === undefined && config.subagentId === undefined;
}
