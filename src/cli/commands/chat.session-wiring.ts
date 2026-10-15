/**
 * Post-construction wiring for the one-shot `afk chat` session.
 *
 * Extracted from chat.ts (one whole concern: everything bound onto the
 * session after it is constructed) so chat.ts, which is grandfathered over
 * the file-size ceiling, does not grow.
 *
 * @module cli/commands/chat.session-wiring
 */

import type { AgentSession } from '../../agent/session.js';

type SubagentCompletionArgs = Parameters<AgentSession['recordSubagentCompletion']>;

/** Anything that reports successful subagent runs (root manager, compose executor). */
export interface SubagentSuccessSource {
  setOnSubagentSucceeded(cb: (...args: SubagentCompletionArgs) => void): void;
}

/**
 * Bind the one-shot chat session to its runtime.
 *
 * - Stop fires from the session layer at the end of the turn. `afk chat` has
 *   no next user turn, so a Stop `injectContext` is dropped with a
 *   `stop_inject_dropped` trace event. The terminal-state gate is
 *   autonomous-only and chat defaults to bypassPermissions, so it does not
 *   fire here unless the permission mode is changed. Shell Stop hooks run only
 *   when `enableShellHooks` is true.
 * - Subagent-success rollup: every source (root manager, compose executor)
 *   reports into this session so compose DAG nodes and subagent token/cost
 *   data land in its `session_sealed` telemetry. Late-bound because the
 *   session is constructed after the executors.
 */
export function wireOneShotChatSession(
  session: AgentSession,
  sources: readonly SubagentSuccessSource[],
): void {
  // Optional per IAgentSession: sessions that predate Stop wiring skip it.
  session.wireStopHook?.({ getHasNextTurn: () => false });
  for (const source of sources) {
    source.setOnSubagentSucceeded((...args) => session.recordSubagentCompletion(...args));
  }
}
