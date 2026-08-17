/**
 * Pre-flight validation for `SubagentManager.forkSubagent`.
 *
 * Extracted from `../subagent.ts` (#919) to keep the fork method focused on
 * orchestration. Each helper in this file throws synchronously BEFORE any
 * side-effect (SubagentStart hook, abort-graph registration, AgentSession ctor)
 * so a misconfigured call is caught cheaply without leaving orphan graph nodes.
 *
 * @module agent/subagent/fork-validation
 */

import type { ForkSubagentOptions } from './fork-types.js';

/**
 * Validate the `phaseRole` ↔ `config.provider` mutual exclusion.
 *
 * Contract: phaseRole and config.provider are mutually exclusive. The
 * manager owns provider construction when phaseRole is set; a caller
 * explicitly supplying their own provider would silently override the
 * phase-restricted one — the exact failure mode this option exists to
 * prevent. Throw synchronously BEFORE any side-effect (SubagentStart
 * hook, abort-graph registration, AgentSession ctor).
 */
export function validatePhaseRole(options: Pick<ForkSubagentOptions, 'phaseRole' | 'config'>): void {
  if (
    options.phaseRole !== undefined &&
    options.phaseRole !== 'read-write' &&
    options.config.provider !== undefined
  ) {
    throw new Error(
      `SubagentManager.forkSubagent: phaseRole "${options.phaseRole}" is mutually ` +
        `exclusive with config.provider. Remove one — either let the manager ` +
        `construct the phase-restricted provider, or use config.provider with ` +
        `phaseRole: "read-write" (default).`,
    );
  }
}
