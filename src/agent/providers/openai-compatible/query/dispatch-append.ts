import { randomUUID } from 'node:crypto';
import { emitToolCall } from '../../../trace/emit.js';
import type { TraceWriter } from '../../../trace/index.js';
import type { ProviderEvent } from '../../../provider.js';
import { extractRawToolInput } from '../../../facets/raw-input.js';
import type { ToolDispatcher } from '../../anthropic-direct/tool-dispatcher.js';
import type { ToolResult } from '../../anthropic-direct/types.js';
import { DENIAL_BREAKER_FAILURE_CLASS } from '../../../tools/denial-circuit-breaker.js';
import { summarizeToolInput } from '../../shared/tool-input-summary.js';
import type { OpenAIMessage } from '../messages.js';
import type { StreamState } from '../translate.js';
import { finalizedToolCalls } from '../translate.js';
import {
  accumulatedToolCallsToToolCalls,
  assistantMessageWithToolCalls,
  toolImageFollowupMessage,
  toolResultsToMessages,
} from '../loop.js';

export interface DispatchAndAppendInput {
  state: StreamState;
  signal: AbortSignal;
  vision: boolean;
  toolDispatcher: ToolDispatcher | undefined;
  traceWriter: TraceWriter | undefined;
  priorTurns: OpenAIMessage[];
  sessionId: string;
}

/**
 * After an iteration produced tool calls: emit `tool.use.start` per call,
 * dispatch through the shared dispatcher (which runs PreToolUse hooks +
 * permission checks + the actual handler + PostToolUse hooks), then emit
 * `tool.output` per result, then append the assistant{tool_calls} +
 * tool{result} messages to running history for the next iteration.
 *
 * Returns the tripping {@link ToolResult} when a forked child hit the denial
 * circuit breaker (#546) this round — the caller yields a loud `error` event
 * and ends the turn — or `undefined` otherwise. History is appended before the
 * return either way, so the trip surfaces on a consistent transcript.
 */
export async function* dispatchAndAppendToolCalls({
  state,
  signal,
  vision,
  toolDispatcher,
  traceWriter,
  priorTurns,
  sessionId,
}: DispatchAndAppendInput): AsyncGenerator<ProviderEvent, ToolResult | undefined> {
  if (!toolDispatcher) {
    // Shouldn't reach here — runIteration won't return needsToolDispatch=true
    // when we have no dispatcher because we don't send `tools[]` — but
    // belt-and-braces against a misbehaving model.
    return undefined;
  }

  const accumulated = finalizedToolCalls(state);
  // Invariant: every dispatched tool call MUST carry a non-empty id, and the
  // SAME id must appear on BOTH the assistant turn's `tool_calls[]` and each
  // matching tool-result message's `tool_call_id` — OpenAI rejects a
  // tool_call_id with no corresponding assistant tool_calls[] entry (HTTP
  // 400). Local OpenAI-shim runners (MLX, llama.cpp) sometimes stream
  // tool_calls with an empty or absent id. Mint one synthetic id HERE, once,
  // so both downstream builders observe the same value:
  // accumulatedToolCallsToToolCalls (→ tool-result tool_call_id) and
  // assistantMessageWithToolCalls (→ assistant tool_calls[].id) below.
  // Generating it independently in each builder would desync the pair and
  // reintroduce the 400.
  for (const c of accumulated) {
    if (c.id.length === 0) c.id = randomUUID();
  }
  const { calls, parseErrors } = accumulatedToolCallsToToolCalls(accumulated, signal);

  // Witness layer: per-call start timestamps keyed by toolUseId so the
  // completed trace event carries an accurate durationMs. Mirrors
  // anthropic-direct/loop.ts:524-525. Lives within this dispatchAndAppend
  // invocation only — the next tool-use round starts fresh.
  const startTimes = new Map<string, number>();

  // Emit tool.use.start BEFORE dispatching, matching anthropic-direct.
  // Witness layer: tool_call.started fires here too — BEFORE dispatch so
  // even a crashing tool leaves evidence that it was attempted. Mirrors
  // anthropic-direct/loop.ts:535-543.
  for (const call of calls) {
    const now = Date.now();
    startTimes.set(call.id, now);
    // Fire-and-forget — emitToolCall swallows writer errors internally.
    void emitToolCall(traceWriter, {
      phase: 'started',
      toolUseId: call.id,
      name: call.name,
      inputBytes: Buffer.byteLength(JSON.stringify(call.input ?? {}), 'utf8'),
    });
    yield {
      type: 'tool.use.start',
      toolUseId: call.id,
      toolName: call.name,
      toolInput: summarizeToolInput(call.name, call.input),
      toolInputRaw: extractRawToolInput(call.input),
      sessionId,
    };
  }

  // Build results — start with synthetic errors for any JSON parse failures.
  const results: { call: typeof calls[number]; result: ToolResult }[] = [];

  if (signal.aborted) {
    // Aborted before dispatch — synthesize aborted results and emit outputs.
    for (const call of calls) {
      const result: ToolResult = { content: 'Tool call aborted', isError: true };
      results.push({ call, result });
      yield {
        type: 'tool.output',
        toolUseId: call.id,
        toolName: call.name,
        content: result.content,
        isError: true,
        sessionId,
      };
    }
  } else {
    // Real dispatch — batch when available, sequential fallback.
    let dispatcherResults: ToolResult[];
    try {
      if (toolDispatcher.executeBatch) {
        dispatcherResults = await toolDispatcher.executeBatch(calls);
      } else {
        dispatcherResults = [];
        for (const call of calls) {
          if (signal.aborted) {
            dispatcherResults.push({ content: 'Tool call aborted', isError: true });
            continue;
          }
          try {
            dispatcherResults.push(await toolDispatcher.execute(call));
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            dispatcherResults.push({
              content: `Tool execution threw: ${message}`,
              isError: true,
            });
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      dispatcherResults = calls.map(() => ({
        content: `Tool batch execution failed: ${message}`,
        isError: true,
      }));
    }

    for (let i = 0; i < calls.length; i++) {
      const call = calls[i]!;
      let result = dispatcherResults[i]!;
      // Layer parse-error diagnostics in front of the dispatcher result —
      // the model needs to know its arguments were malformed.
      const parseErr = parseErrors.get(call.id);
      if (parseErr !== undefined) {
        result = {
          content: `${parseErr}\n--\n${result.content}`,
          isError: true,
          ...(result.truncated === true ? { truncated: true } : {}),
        };
      }
      results.push({ call, result });

      // Witness layer: tool_call.completed pairs with the .started event
      // emitted above. Mirrors anthropic-direct/loop.ts:605-624.
      // Fire-and-forget to keep the loop iteration cheap.
      const startedAt = startTimes.get(call.id);
      const durationMs = typeof startedAt === 'number' ? Date.now() - startedAt : 0;
      const truncated = result.truncated === true || result.content.includes('[output truncated');
      void emitToolCall(traceWriter, {
        phase: 'completed',
        toolUseId: call.id,
        name: call.name,
        resultBytes: Buffer.byteLength(result.content, 'utf8'),
        isError: result.isError === true,
        truncated,
        durationMs,
        ...(result.circuitBreaker === true ? { circuitBreaker: true } : {}),
        ...(result.failureClass ? { failureClass: result.failureClass } : {}),
        ...(typeof result.batchIndex === 'number' && typeof result.batchSize === 'number'
          ? { batchIndex: result.batchIndex, batchSize: result.batchSize }
          : {}),
      });

      yield {
        type: 'tool.output',
        toolUseId: call.id,
        toolName: call.name,
        content: result.content,
        ...(result.isError === true ? { isError: true } : {}),
        ...(result.truncated === true ? { truncated: true } : {}),
        // Plumb concurrency-batch membership onto the render-facing event, not
        // just the trace event above, so the TUI `∥i/N` badge works here too.
        // Parity with anthropic-direct/loop.ts's tool.output yield — omitting it
        // silently drops the badge for every openai-compatible session.
        ...(typeof result.batchIndex === 'number' && typeof result.batchSize === 'number'
          ? { batchIndex: result.batchIndex, batchSize: result.batchSize }
          : {}),
        sessionId,
      };
      if (result.render?.diff) {
        yield {
          type: 'tool.diff',
          toolUseId: call.id,
          diff: result.render.diff,
          sessionId,
        };
      }
    }
  }

  // Append the assistant turn (with tool_calls) and the tool-result
  // messages to running history so the next iteration's request includes
  // them. OpenAI is strict about this order: assistant{tool_calls} must
  // precede the tool{} messages, and each tool{} must reference a
  // tool_call_id that exists in the assistant turn.
  //
  // `state.reasoningText` is threaded in so DeepSeek-R1-class thinking-mode
  // providers see the reasoning trace echoed back on the assistant turn —
  // omitting it on those providers yields a 400 ("The `reasoning_content`
  // in the thinking mode must be passed back to the API"). Empty text is
  // a no-op for non-thinking providers (the field is omitted entirely).
  priorTurns.push(
    assistantMessageWithToolCalls(state.assistantText, accumulated, state.reasoningText) as unknown as OpenAIMessage,
  );
  for (const m of toolResultsToMessages(results)) {
    priorTurns.push(m as unknown as OpenAIMessage);
  }
  // Tool-result images (e.g. browser_screenshot) can't ride the `role:'tool'`
  // message (OpenAI carries only text there). On vision-capable models they
  // surface as a follow-up `role:'user'` image message pushed AFTER the tool
  // messages so the alternation stays valid. Undefined (no push) when the
  // model lacks vision or no result carried an image. See issue #127.
  const imageFollowup = toolImageFollowupMessage(results, { vision });
  if (imageFollowup) priorTurns.push(imageFollowup);

  // Denial circuit breaker (#546): if the dispatcher tripped this round, hand
  // the tripping result back so the caller can surface a loud `error` event and
  // stop — matching anthropic-direct/loop.ts. History is already appended above.
  return results.find((r) => r.result.failureClass === DENIAL_BREAKER_FAILURE_CLASS)?.result;
}
