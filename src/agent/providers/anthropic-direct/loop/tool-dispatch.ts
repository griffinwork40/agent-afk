/**
 * Tool-call construction and dispatch for one round.
 *
 * Builds the {@link ToolCall} list from the model's `tool_use` blocks, emits
 * the `tool.use.start` surface events and `tool_call.started` trace events,
 * then runs the batch or sequential dispatcher.
 *
 * Invariant: dispatch never throws. Both the batch and the sequential path wrap
 * the dispatcher in a catch that converts a throw into `is_error` results, so a
 * misbehaving tool degrades into model-visible feedback rather than killing the
 * turn. The one exception is deliberate — see the denial circuit breaker in
 * `tool-results.ts`.
 *
 * @module agent/providers/anthropic-direct/loop/tool-dispatch
 */

import type { ContentBlockParam, ToolResultBlockParam } from '@anthropic-ai/sdk/resources';
import type { ProviderEvent } from '../../../provider.js';
import type { RunTurnInput, ToolCall, ToolResult, TurnResult } from '../types.js';
import { abortFailureClass } from '../../../abort-reason.js';
import { emitToolCall } from '../../../trace/emit.js';
import { extractCaptureToolInput, extractRawToolInput } from '../../../facets/raw-input.js';
import { env } from '../../../../config/env.js';
import { summarizeToolInput } from '../../shared/tool-input-summary.js';
import { buildToolCallStartedPayload } from '../../shared/tool-call-trace.js';
import type { TurnAccumulator } from './turn-accumulator.js';

/**
 * Dispatch result.
 *
 * `aborted` means the turn signal fired between building the calls and running
 * them: synthetic error results have already been pushed so history stays
 * consistent, and the terminal event has already been yielded.
 */
export type DispatchResult =
  | {
      kind: 'dispatched';
      calls: ToolCall[];
      results: ToolResult[];
      /** Per-call start timestamps keyed by toolUseId, for `durationMs`. */
      startTimes: Map<string, number>;
    }
  | { kind: 'aborted' };

/**
 * Build and run this round's tool calls.
 *
 * Yields one `tool.use.start` per block before dispatching, so a surface can
 * paint the pending calls even if the tools themselves are slow.
 */
export async function* dispatchToolCalls(
  turnResult: TurnResult,
  input: RunTurnInput,
  turn: TurnAccumulator,
): AsyncGenerator<ProviderEvent, DispatchResult, void> {
  const calls: ToolCall[] = [];
  // Per-call start timestamps keyed by toolUseId so the completed trace event
  // can carry an accurate `durationMs`. Scoped to this round only.
  const startTimes = new Map<string, number>();

  for (const block of turnResult.toolUseBlocks) {
    calls.push({ id: block.id, name: block.name, input: block.input, signal: input.signal });
    startTimes.set(block.id, Date.now());
    // Witness layer: tool_call.started fires BEFORE dispatch so even a crashing
    // tool leaves evidence that it was attempted. Fire-and-forget —
    // emitToolCall swallows writer errors internally.
    void emitToolCall(
      input.traceWriter,
      buildToolCallStartedPayload({
        toolUseId: block.id,
        name: block.name,
        input: block.input,
        subagentId: input.subagentId,
      }),
    );
    yield {
      type: 'tool.use.start',
      toolUseId: block.id,
      toolName: block.name,
      toolInput: summarizeToolInput(block.name, block.input),
      toolInputRaw: extractRawToolInput(block.input),
      toolInputCapture: env.AFK_CAPTURE_SUBAGENT_OUTPUT === '1' ? extractCaptureToolInput(block.input) : undefined,
      sessionId: input.ctx.sessionId,
    };
  }

  if (input.signal.aborted) {
    // Push a matching `tool_result` for every `tool_use` already in history, so
    // the assistant turn is never left unmatched (a 400 on the next request).
    // History is consistent after this, which is why the caller's rollback
    // catch deliberately does not fire for this path.
    const abortedResults: ToolResultBlockParam[] = calls.map((call) => ({
      type: 'tool_result' as const,
      tool_use_id: call.id,
      content: 'Tool call aborted',
      is_error: true,
    }));
    input.messages.push({ role: 'user', content: abortedResults as ContentBlockParam[] });
    yield {
      type: 'turn.completed',
      usage: turn.terminalUsage(),
      sessionId: input.ctx.sessionId,
    };
    return { kind: 'aborted' };
  }

  // Dispatch: batch (parallel for safe tools) or sequential fallback.
  let results: ToolResult[];
  if (input.toolDispatcher.executeBatch) {
    try {
      results = await input.toolDispatcher.executeBatch(calls);
    } catch (err) {
      results = calls.map(() => ({
        content: `Tool batch execution failed: ${err instanceof Error ? err.message : String(err)}`,
        isError: true as const,
      }));
    }
  } else {
    results = [];
    for (const call of calls) {
      if (input.signal.aborted) {
        results.push({
          content: 'Tool call aborted',
          isError: true,
          failureClass: abortFailureClass(input.signal),
        });
        continue;
      }
      try {
        results.push(await input.toolDispatcher.execute(call));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        results.push({ content: `Tool execution threw: ${message}`, isError: true });
      }
    }
  }

  return { kind: 'dispatched', calls, results, startTimes };
}
