/**
 * Visibility for sessions built without the `agent` / `skill` / `compose`
 * executors (#3442). A bare `new AgentSession(config)` exposes none of the
 * three tools; this module names what is missing on `SessionMetadata` and
 * warns once per process so SDK embedders are not left guessing.
 *
 * @module agent/session/session-setup.missing-executors
 */

import { listSkills } from '../../skills/skill-registry.js';
import type { AgentConfig } from '../types.js';

/** Tool names whose executors a bare session lacks, in schema order. */
const EXECUTOR_TOOL_NAMES = ['agent', 'skill', 'compose'] as const;

// Invariant: one warning per PROCESS, not per session. Embedders that build
// many bare sessions (loops, servers) must not get one stderr line each.
let missingExecutorsWarned = false;

/**
 * Names of the executor-backed tools this session cannot offer, or
 * `undefined` when nothing is reported.
 *
 * Contract: reported only when ALL hold: no `config.executors`, no injected
 * `provider` / `providerFactory` (those carry their own executors), the
 * session is not a subagent fork, and at least one skill is registered (the
 * process-global skill registry; built-in skills count). Otherwise
 * `undefined`, so wired surfaces never see the field.
 */
export function computeMissingExecutors(config: AgentConfig): string[] | undefined {
  if (config.executors !== undefined) return undefined;
  if (config.provider !== undefined || config.providerFactory !== undefined) return undefined;
  if (config.isSubagentFork === true || config.parentSessionId !== undefined) return undefined;
  if (listSkills().length === 0) return undefined;
  return [...EXECUTOR_TOOL_NAMES];
}

/**
 * Emit the one-time process warning for {@link computeMissingExecutors}.
 * Never throws; a diagnostic must not fail session construction.
 */
export function warnMissingExecutorsOnce(missing: readonly string[]): void {
  if (missingExecutorsWarned) return;
  missingExecutorsWarned = true;
  try {
    console.warn(
      `[afk] AgentSession built without executors: the ${missing.join('/')} tools are unavailable ` +
        'although skills are installed. Pass `executors: createWiredExecutors(config, opts).executors` ' +
        'in AgentConfig to enable them (see SessionMetadata.missingExecutors).',
    );
  } catch {
    // stderr unavailable: swallow.
  }
}

/** Test-only: re-arm the once-per-process latch. Production must not call. */
/**
 * Turn-start hook: emit the one-time warning only when a session actually runs
 * a model turn. Construction alone stays silent so probe sessions (e.g.
 * `afk status`, which builds and closes a bare session) never print it.
 * Cheap after the first warning: the process flag short-circuits before
 * re-scanning the skill registry.
 */
export function warnMissingExecutorsOnTurn(config: AgentConfig): void {
  if (missingExecutorsWarned) return;
  const missing = computeMissingExecutors(config);
  if (missing !== undefined) warnMissingExecutorsOnce(missing);
}

export function resetMissingExecutorsWarningForTests(): void {
  missingExecutorsWarned = false;
}
