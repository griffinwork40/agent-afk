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
 */
export function appendInjectContext(
  toolResult: ToolResult | undefined,
  injectContext: string | undefined,
): void {
  if (toolResult !== undefined && injectContext !== undefined && injectContext.length > 0) {
    toolResult.content = `${toolResult.content}\n\n${injectContext}`;
  }
}
