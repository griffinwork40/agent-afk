/**
 * Undispatched tool calls: calls whose arguments were lost in transit or
 * failed to JSON-parse (issue #3808).
 *
 * Invariant: a call recorded in `parseErrors` by
 * `accumulatedToolCallsToToolCalls` (openai-compatible/loop.ts) MUST NOT reach
 * the tool dispatcher. Its input is a placeholder `{}`, not what the model
 * sent, so executing it is pointless at best (the tool's own validation error)
 * and harmful at worst: the dispatcher's repeat-failure guard fingerprints
 * `{name, input}`, so three lost-argument rounds of the same tool collapse to
 * one fingerprint and the fourth GENUINE call is refused with a misleading
 * "change the arguments" message. These calls get a synthetic isError result
 * instead, built here and merged back into batch order by the caller.
 *
 * Contract: like an aborted call (dispatch-append.ts abort branch), an
 * undispatched call fires no PreToolUse/PostToolUse hooks, because hooks wrap
 * execution and nothing executes. Its `tool.use.start`/`tool_call.started`
 * and `tool.output`/`tool_call.completed` events are still emitted by the
 * normal path, so trace pairing and the transcript are unchanged in shape.
 *
 * @module agent/providers/openai-compatible/query/dispatch-append.parse-errors
 */

import type { ToolCall, ToolResult } from '../../anthropic-direct/types.js';
import type { AccumulatedToolCall } from '../translate.js';

/**
 * Model-facing result for a call that was not executed. `argumentsLost`
 * selects the wording: an empty argument stream is a delivery failure the
 * model did not cause, so it is told to resend rather than to fix its output.
 */
export function parseErrorResult(name: string, diagnostic: string, argumentsLost: boolean): ToolResult {
  const instruction = argumentsLost
    ? `This call was NOT executed: its arguments were lost in transit between the API and the harness, ` +
      `so nothing was wrong with the call you made. Resend the same "${name}" call with its full arguments.`
    : `This call was NOT executed because its arguments could not be parsed as JSON. ` +
      `Resend the "${name}" call with its arguments as a single valid JSON object.`;
  return { content: `${diagnostic}\n\n${instruction}`, isError: true };
}

/** The calls that may reach the dispatcher: those with no recorded parse error. */
export function dispatchableCalls(
  calls: readonly ToolCall[],
  parseErrors: ReadonlyMap<string, string>,
): ToolCall[] {
  return calls.filter((c) => !parseErrors.has(c.id));
}

/**
 * Rebuild a full, batch-ordered result array: dispatched results fill the
 * slots of dispatchable calls in order, synthetic results fill the rest.
 *
 * Contract: `dispatchedResults` is index-aligned with
 * `dispatchableCalls(calls, parseErrors)`, and `accumulated` is index-aligned
 * with `calls` (accumulatedToolCallsToToolCalls pushes one call per
 * accumulated entry, in order). A missing dispatched result degrades to an
 * error rather than throwing, so a short dispatcher reply cannot desync the
 * assistant tool_calls / tool-result pairing.
 */
export function mergeUndispatchedResults(
  calls: readonly ToolCall[],
  accumulated: readonly AccumulatedToolCall[],
  parseErrors: ReadonlyMap<string, string>,
  dispatchedResults: readonly ToolResult[],
): ToolResult[] {
  let next = 0;
  return calls.map((call, i) => {
    const diagnostic = parseErrors.get(call.id);
    if (diagnostic !== undefined) {
      const argumentsLost = (accumulated[i]?.argumentsRaw ?? '').length === 0;
      return parseErrorResult(call.name, diagnostic, argumentsLost);
    }
    return dispatchedResults[next++] ?? { content: 'Tool call produced no result', isError: true };
  });
}
