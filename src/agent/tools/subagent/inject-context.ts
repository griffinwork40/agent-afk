/**
 * Shared in-turn SubagentStop injectContext append helper.
 *
 * Extracted from the duplicate guard+append blocks in `skill-executor.ts` and
 * `foreground-promotion.ts` (issue #393). Each call site keeps its own
 * `getLastStopInjectContext?.()` extraction (the handle-nullability differs)
 * then calls this to perform the identical guard + append.
 *
 * @module agent/tools/subagent/inject-context
 */

import type { ToolResult } from '../types.js';

/**
 * Append a SubagentStop injectContext note to a completion `ToolResult`
 * in-turn. No-op unless the run produced a `ToolResult` AND the note is a
 * non-empty string — the error/rethrow paths leave `toolResult` unset, so the
 * note is dropped for that stop by design (the error is the parent's signal).
 * Mutates `toolResult.content` in place.
 *
 * Keep-drop confirmed in #392 (follow-up to #387). A queue fallback for the
 * true-throw path was considered and rejected: it would deliver a stale,
 * caller-detached note on a LATER parent turn (re-opening the one-position
 * displacement hazard the queue channel warns about in handle.ts), and the
 * canonical producer (shadow-verify nudge) is output-gated on the subagent's
 * findings — so it cannot fire on a throw that produced none anyway. The
 * throw-path drop is pinned by tests in subagent-executor.test.ts and
 * skill-executor.test.ts ("... when runToResult throws").
 */
export function appendInjectContext(
  toolResult: ToolResult | undefined,
  injectContext: string | undefined,
): void {
  if (toolResult !== undefined && injectContext !== undefined && injectContext.length > 0) {
    toolResult.content = `${toolResult.content}\n\n${injectContext}`;
  }
}
