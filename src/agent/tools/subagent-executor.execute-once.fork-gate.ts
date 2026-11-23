/**
 * Fork-mode skill background-dispatch gate (#5177).
 *
 * Extracted from `subagent-executor.execute-once.helpers.ts` to satisfy the
 * 350-code-line file ceiling.  The gate is a self-contained concern: a pure
 * function that rejects `mode: "background"` when it is called from inside a
 * fork-mode skill context.
 *
 * @module agent/tools/subagent-executor.execute-once.fork-gate
 */

import type { ToolResult } from './types.js';

/**
 * Returns a `ToolResult` refusal when `mode: "background"` is requested
 * inside a fork-mode skill context, or `undefined` when the dispatch is
 * permitted.
 *
 * A fork-mode skill runs in a single turn. Any background child it
 * dispatches is orphaned when that turn ends and was previously logged as
 * "succeeded" / "completed" even though it was cut off with no deliverable.
 *
 * The signal is `skillDispatchName` being set on the executor's
 * `defaultConfig`. `buildForkedChildConfig` (fork-child-config.ts:219-221)
 * copies it from `baseConfig.skillDispatchName` exactly when the current
 * session was launched as a fork-mode skill dispatch.
 */
export function checkForkModeBackgroundGate(
  mode: string | undefined,
  skillDispatchName: string | undefined,
): ToolResult | undefined {
  if (mode !== 'background' || skillDispatchName === undefined) return undefined;
  return {
    content:
      'Background subagent dispatch is not allowed inside a fork-mode skill. ' +
      'A fork-mode skill runs in a single turn; any background child would be ' +
      'orphaned when that turn ends and silently recorded as succeeded with no ' +
      'deliverable. Use mode: "foreground" (the default) instead, or restructure ' +
      'the skill to not use background dispatch.',
    isError: true,
  };
}
