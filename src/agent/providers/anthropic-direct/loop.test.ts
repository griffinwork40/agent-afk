/**
 * Unit tests for `loop.ts` — the per-turn agentic loop.
 *
 * These tests exercise runTurn directly with minimal stubs, focusing on
 * previously-uncovered lines 174-276 and 325-331.
 *
 * Coverage targets:
 *  - Stream ends without turn-result → yields turn.completed with accumulated usage
 *  - maxToolUseIterations cap → yields turn.completed with stopReason='tool_use_loop_capped'
 *  - Sequential tool dispatch (no executeBatch) with abort mid-sequence
 *  - Sequential tool dispatch with errors
 *  - Batch tool dispatch with errors
 *  - Signal aborted after tool.use.start events emitted
 *  - summarizeToolInput helper behavior
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { RawMessageStreamEvent, MessageParam, ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { runTurn, DEFAULT_MAX_TOOL_USE_ITERATIONS, isTransientServerError, isOverloadedErrorEvent, OVERLOAD_MAX_RETRIES } from './loop.js';
import type { ProviderEvent } from '../../provider.js';
import type {
  AnthropicClientLike,
  ToolDispatcherLike,
  ToolCall,
  ToolResult,
  TranslateCtx,
} from './types.js';

// --- Helpers ---

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

async function collect(gen: AsyncGenerator<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

const SESSION_ID = 'sess_loop_test';
const ctx: TranslateCtx = { sessionId: SESSION_ID };

function baseUsage(): {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
} {
  return {
    input_tokens: 10,
    output_tokens: 5,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
}

function makeTextStream(text: string, stopReason: string = 'end_turn'): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: baseUsage(),
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_stop',
      index: 0,
    } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: { output_tokens: 5 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

function makeToolUseStream(
  toolId: string,
  toolName: string,
  inputJson: string,
): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_t',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: baseUsage(),
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: inputJson },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_stop',
      index: 0,
    } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 9 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

function makeMultiToolUseStream(
  tools: Array<{ id: string; name: string; input: string }>,
): RawMessageStreamEvent[] {
  const events: RawMessageStreamEvent[] = [
    {
      type: 'message_start',
      message: {
        id: 'msg_multi',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: baseUsage(),
      },
    } as unknown as RawMessageStreamEvent,
  ];

  tools.forEach((tool, idx) => {
    events.push({
      type: 'content_block_start',
      index: idx,
      content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} },
    } as unknown as RawMessageStreamEvent);
    events.push({
      type: 'content_block_delta',
      index: idx,
      delta: { type: 'input_json_delta', partial_json: tool.input },
    } as unknown as RawMessageStreamEvent);
    events.push({
      type: 'content_block_stop',
      index: idx,
    } as unknown as RawMessageStreamEvent);
  });

  events.push({
    type: 'message_delta',
    delta: { stop_reason: 'tool_use', stop_sequence: null },
    usage: { output_tokens: 10 },
  } as unknown as RawMessageStreamEvent);
  events.push({ type: 'message_stop' } as unknown as RawMessageStreamEvent);

  return events;
}

function makeClient(
  streamFactory: () => AsyncIterable<RawMessageStreamEvent>,
): AnthropicClientLike {
  return {
    messages: {
      create: vi.fn(() => streamFactory()),
    },
  };
}

function makeDispatcher(
  executeFn: (call: ToolCall) => Promise<ToolResult>,
): ToolDispatcherLike {
  return { execute: executeFn };
}

function makeBatchDispatcher(
  executeBatchFn: (calls: ToolCall[]) => Promise<ToolResult[]>,
): ToolDispatcherLike {
  return {
    execute: vi.fn(() => Promise.reject(new Error('should use batch'))),
    executeBatch: executeBatchFn,
  };
}

// --- Tests ---

describe('loop.ts runTurn', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('DEFAULT_MAX_TOOL_USE_ITERATIONS is 0 (no cap by default)', () => {
    expect(DEFAULT_MAX_TOOL_USE_ITERATIONS).toBe(0);
  });

  // Note on lines 166-170 and 176-182:
  // These are defensive code paths that appear unreachable with the current 
  // translateMessageStream implementation:
  // - Lines 166-170 (catch block): translateMessageStream catches all errors internally
  //   and yields them as error events, so nothing propagates to this catch.
  // - Lines 176-182 (turnResult === null): translateMessageStream ALWAYS yields a 
  //   turn-result at the end unless it yields an error event first. If it yields
  //   an error, translatorErrored = true and we return at line 172 before reaching 173.
  // 
  // These defensive paths protect against future changes to translateMessageStream
  // but cannot be exercised without mocking the translate module directly.

  // This test verifies the error path works through translate's error yielding
  it('yields error event when SDK stream throws during iteration', async () => {
    async function* throwingStream(): AsyncIterable<RawMessageStreamEvent> {
      yield {
        type: 'message_start',
        message: {
          id: 'msg_throw',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: baseUsage(),
        },
      } as unknown as RawMessageStreamEvent;
      // Throw mid-stream — caught by translateMessageStream, yielded as error event
      throw new Error('SDK stream exploded');
    }

    const client = makeClient(() => throwingStream());
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'ok' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];
    const abortController = new AbortController();

    const events = await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: null,
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // Error yielded by translate, forwarded by loop
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error.message).toContain('SDK stream exploded');
    }

    // No turn.completed when error occurs (translatorErrored path)
    const completed = events.find((e) => e.type === 'turn.completed');
    expect(completed).toBeUndefined();
  });

  // covers lines 324-331: maxToolUseIterations cap
  it('caps tool-use iterations when maxToolUseIterations is set', async () => {
    let callIdx = 0;
    const client = makeClient(() => {
      callIdx += 1;
      // Always return tool_use — would loop forever without the cap
      return fromArray(makeToolUseStream(`toolu_${callIdx}`, 'read_file', '{}'));
    });
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'ok' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'do stuff' }];
    const abortController = new AbortController();

    const events = await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
        maxToolUseIterations: 2, // Cap at 2 iterations
      }),
    );

    // Should have exactly 2 tool-use rounds
    const progressEvents = events.filter((e) => e.type === 'progress');
    expect(progressEvents.length).toBe(2);

    // Final turn.completed should have stopReason='tool_use_loop_capped'
    const completed = events.find((e) => e.type === 'turn.completed');
    expect(completed).toBeDefined();
    if (completed?.type === 'turn.completed') {
      expect(completed.usage.stopReason).toBe('tool_use_loop_capped');
    }
  });

  // covers lines 264-278: sequential tool dispatch fallback (no executeBatch)
  it('dispatches tools sequentially when executeBatch is not provided', async () => {
    let callIdx = 0;
    const client = makeClient(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return fromArray(
          makeMultiToolUseStream([
            { id: 'toolu_1', name: 'read_file', input: '{"path":"/a"}' },
            { id: 'toolu_2', name: 'write_file', input: '{"path":"/b"}' },
          ]),
        );
      }
      return fromArray(makeTextStream('Done'));
    });

    const executedCalls: string[] = [];
    const dispatcher = makeDispatcher(async (call) => {
      executedCalls.push(call.name);
      return { content: `result_${call.name}` };
    });

    const messages: MessageParam[] = [{ role: 'user', content: 'multi-tool' }];
    const abortController = new AbortController();

    const events = await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [
          { name: 'read_file', input_schema: { type: 'object' } },
          { name: 'write_file', input_schema: { type: 'object' } },
        ],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // Both tools should have been dispatched sequentially
    expect(executedCalls).toEqual(['read_file', 'write_file']);

    // tool.output events should be present
    const toolOutputs = events.filter((e) => e.type === 'tool.output');
    expect(toolOutputs.length).toBe(2);
  });

  // covers lines 271-276: sequential dispatch error handling
  it('captures errors in sequential tool dispatch and reports isError', async () => {
    let callIdx = 0;
    const client = makeClient(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return fromArray(makeToolUseStream('toolu_err', 'failing_tool', '{}'));
      }
      return fromArray(makeTextStream('Recovered'));
    });

    const dispatcher = makeDispatcher(async () => {
      throw new Error('Tool exploded');
    });

    const messages: MessageParam[] = [{ role: 'user', content: 'test error' }];
    const abortController = new AbortController();

    const events = await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [{ name: 'failing_tool', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // tool.output should have isError: true
    const toolOutput = events.find((e) => e.type === 'tool.output');
    expect(toolOutput).toBeDefined();
    if (toolOutput?.type === 'tool.output') {
      expect(toolOutput.isError).toBe(true);
      expect(toolOutput.content).toContain('Tool execution threw');
      expect(toolOutput.content).toContain('Tool exploded');
    }
  });

  // A ToolResult carrying `image` (e.g. browser_screenshot) must be emitted as
  // an image content block + text block in the model-facing tool_result.
  it('emits a tool image as an image content block in the tool_result', async () => {
    let callIdx = 0;
    const client = makeClient(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return fromArray(makeToolUseStream('toolu_shot', 'browser_screenshot', '{}'));
      }
      return fromArray(makeTextStream('done'));
    });

    const dispatcher = makeDispatcher(async () => ({
      content: '{"path":"/x.png","width":1280,"height":800}',
      image: { mediaType: 'image/png' as const, data: 'QUJDREVG' },
    }));

    const messages: MessageParam[] = [{ role: 'user', content: 'shot' }];
    const abortController = new AbortController();

    await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [{ name: 'browser_screenshot', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // Locate the user turn carrying tool_result blocks (runTurn appends it).
    const toolResultTurn = messages.find(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some(
          (b) => typeof b === 'object' && b !== null && (b as { type?: string }).type === 'tool_result',
        ),
    );
    expect(toolResultTurn).toBeDefined();

    const blocks = toolResultTurn!.content as Array<{ type: string; content: unknown }>;
    const trBlock = blocks.find((b) => b.type === 'tool_result')!;
    // content is an array: [image block, text block] — not a bare string.
    expect(Array.isArray(trBlock.content)).toBe(true);
    const parts = trBlock.content as Array<Record<string, unknown>>;
    expect(parts[0]).toMatchObject({
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'QUJDREVG' },
    });
    expect(parts[1]).toMatchObject({
      type: 'text',
      text: '{"path":"/x.png","width":1280,"height":800}',
    });
  });

  // covers lines 255-263: batch dispatch with executeBatch
  it('uses executeBatch when provided on the dispatcher', async () => {
    let callIdx = 0;
    const client = makeClient(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return fromArray(
          makeMultiToolUseStream([
            { id: 'toolu_a', name: 'tool_a', input: '{}' },
            { id: 'toolu_b', name: 'tool_b', input: '{}' },
          ]),
        );
      }
      return fromArray(makeTextStream('Batch done'));
    });

    const batchExecuted = vi.fn(async (calls: ToolCall[]) => {
      return calls.map((c) => ({ content: `batch_result_${c.name}` }));
    });
    const dispatcher = makeBatchDispatcher(batchExecuted);

    const messages: MessageParam[] = [{ role: 'user', content: 'batch test' }];
    const abortController = new AbortController();

    const events = await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [
          { name: 'tool_a', input_schema: { type: 'object' } },
          { name: 'tool_b', input_schema: { type: 'object' } },
        ],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // executeBatch should have been called once with both tools
    expect(batchExecuted).toHaveBeenCalledTimes(1);
    expect(batchExecuted.mock.calls[0]?.[0]).toHaveLength(2);

    // tool.output events should reflect batch results
    const toolOutputs = events.filter((e) => e.type === 'tool.output');
    expect(toolOutputs.length).toBe(2);
    if (toolOutputs[0]?.type === 'tool.output') {
      expect(toolOutputs[0].content).toBe('batch_result_tool_a');
    }
  });

  // covers lines 258-263: batch dispatch error handling
  it('handles errors in batch dispatch by returning isError for all tools', async () => {
    let callIdx = 0;
    const client = makeClient(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return fromArray(
          makeMultiToolUseStream([
            { id: 'toolu_x', name: 'tool_x', input: '{}' },
            { id: 'toolu_y', name: 'tool_y', input: '{}' },
          ]),
        );
      }
      return fromArray(makeTextStream('Recovered from batch failure'));
    });

    const dispatcher = makeBatchDispatcher(async () => {
      throw new Error('Batch execution crashed');
    });

    const messages: MessageParam[] = [{ role: 'user', content: 'batch error' }];
    const abortController = new AbortController();

    const events = await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [
          { name: 'tool_x', input_schema: { type: 'object' } },
          { name: 'tool_y', input_schema: { type: 'object' } },
        ],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // Both tool.output events should have isError: true
    const toolOutputs = events.filter((e) => e.type === 'tool.output');
    expect(toolOutputs.length).toBe(2);
    for (const output of toolOutputs) {
      if (output?.type === 'tool.output') {
        expect(output.isError).toBe(true);
        expect(output.content).toContain('Tool batch execution failed');
      }
    }
  });

  // covers lines 242-251: signal aborted after tool calls built but before dispatch
  // The abort check (line 242) happens AFTER tool.use.start events are emitted (lines 233-240)
  // but BEFORE the actual tool dispatch. To hit this path, we need the signal to be
  // aborted AFTER yield in the for-loop (line 233-240) but BEFORE the if-check (line 242).
  // The yields are synchronous within the loop iteration, so we simulate this by
  // aborting when we see the last tool.use.start from the loop.
  it('handles abort after tool calls built by pushing aborted tool_result blocks', async () => {
    const abortController = new AbortController();

    const client = makeClient(() =>
      fromArray(makeToolUseStream('toolu_abort', 'slow_tool', '{}')),
    );

    let dispatcherCalled = false;
    const dispatcher = makeDispatcher(async () => {
      dispatcherCalled = true;
      return { content: 'should not run' };
    });

    const messages: MessageParam[] = [{ role: 'user', content: 'abort test' }];

    // Custom iteration: abort AFTER loop's tool.use.start but BEFORE we'd yield the next event
    const generator = runTurn({
      client,
      messages,
      system: null,
      tools: [{ name: 'slow_tool', input_schema: { type: 'object' } }],
      toolDispatcher: dispatcher,
      model: 'claude-test',
      maxTokens: 1024,
      headers: {},
      signal: abortController.signal,
      ctx,
    });

    const events: ProviderEvent[] = [];
    let loopToolStartSeen = false;
    for await (const ev of generator) {
      events.push(ev);
      // Detect the loop's tool.use.start (not translate's ' …')
      if (ev.type === 'tool.use.start' && ev.toolInput !== ' …') {
        loopToolStartSeen = true;
        // Abort immediately after this event. The next thing the generator
        // would do is check input.signal.aborted at line 242.
        abortController.abort();
        // Continue iterating to let the generator see the abort and push results
      }
    }

    expect(loopToolStartSeen).toBe(true);

    // The dispatcher should NOT have been called because abort happened before dispatch
    expect(dispatcherCalled).toBe(false);

    // Messages should have assistant turn and aborted tool_result turn appended
    expect(messages.length).toBe(3);
    expect(messages[1]?.role).toBe('assistant');
    expect(messages[2]?.role).toBe('user');
    const toolResultContent = messages[2]?.content as ContentBlockParam[];
    expect(toolResultContent[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_abort',
      content: 'Tool call aborted',
      is_error: true,
    });
  });

  // covers lines 267-269: sequential dispatch with abort mid-sequence
  it('handles abort mid-sequence in sequential dispatch', async () => {
    const abortController = new AbortController();
    let callIdx = 0;

    const client = makeClient(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return fromArray(
          makeMultiToolUseStream([
            { id: 'toolu_1', name: 'first_tool', input: '{}' },
            { id: 'toolu_2', name: 'second_tool', input: '{}' },
          ]),
        );
      }
      return fromArray(makeTextStream('Done'));
    });

    let execCount = 0;
    const dispatcher = makeDispatcher(async (_call) => {
      execCount += 1;
      if (execCount === 1) {
        // After first tool completes, abort
        abortController.abort();
        return { content: 'first_result' };
      }
      // Second tool should see abort signal
      return { content: 'second_result' };
    });

    const messages: MessageParam[] = [{ role: 'user', content: 'multi abort' }];

    const events = await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [
          { name: 'first_tool', input_schema: { type: 'object' } },
          { name: 'second_tool', input_schema: { type: 'object' } },
        ],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // First tool should have completed
    const toolOutputs = events.filter((e) => e.type === 'tool.output');
    expect(toolOutputs.length).toBeGreaterThanOrEqual(1);

    // Second tool should have isError: true with 'aborted' content
    const secondOutput = toolOutputs.find(
      (e) => e.type === 'tool.output' && e.content === 'Tool call aborted',
    );
    expect(secondOutput).toBeDefined();
  });

  // covers lines 189-215: non-tool_use stopReason handling (assistant.message, suggestion)
  it('emits assistant.message and suggestion for short final text', async () => {
    const shortText = 'Try this: pnpm test';
    const client = makeClient(() => fromArray(makeTextStream(shortText)));
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'unused' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'what next?' }];
    const abortController = new AbortController();

    const events = await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: null,
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // assistant.message should be emitted
    const assistantMsg = events.find((e) => e.type === 'assistant.message');
    expect(assistantMsg).toBeDefined();
    if (assistantMsg?.type === 'assistant.message') {
      expect(assistantMsg.text).toBe(shortText);
    }

    // suggestion should be emitted for short text (<=200 chars)
    const suggestion = events.find((e) => e.type === 'suggestion');
    expect(suggestion).toBeDefined();
    if (suggestion?.type === 'suggestion') {
      expect(suggestion.suggestion).toBe(shortText);
    }

    // turn.completed should have stopReason='end_turn'
    const completed = events.find((e) => e.type === 'turn.completed');
    expect(completed).toBeDefined();
    if (completed?.type === 'turn.completed') {
      expect(completed.usage.stopReason).toBe('end_turn');
    }
  });

  // Regression guard: turn.completed must carry durationMs so the REPL
  // footer (`◦ Xs · $cost · N tok`) renders the turn duration.
  // Pre-fix all 8 yield sites in this file passed bare accumulatedUsage,
  // and neither toProviderUsage nor sumProviderUsage ever wrote
  // durationMs — so the footer dropped to just `◦ N tok` for every turn.
  // The withTurnDuration helper at the top of runTurn now wraps every yield.
  it('emits turn.completed with usage.durationMs on the happy path', async () => {
    const client = makeClient(() => fromArray(makeTextStream('hello')));
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'unused' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];
    const abortController = new AbortController();

    const events = await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: null,
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    const completed = events.find((e) => e.type === 'turn.completed');
    expect(completed).toBeDefined();
    if (completed?.type === 'turn.completed') {
      expect(typeof completed.usage.durationMs).toBe('number');
      expect(completed.usage.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  // Defense-in-depth: the iteration-cap branch wraps a SPREAD
  // (`{ ...accumulatedUsage, stopReason: 'tool_use_loop_capped' }`) — easy
  // to refactor and accidentally drop durationMs. Pin both fields together.
  it('emits turn.completed with usage.durationMs even when iteration cap hits', async () => {
    // Build a stream where the model keeps emitting tool_use → looped
    // dispatch → another tool_use, exhausting maxToolUseIterations=1.
    let callCount = 0;
    const client = makeClient(() => {
      callCount += 1;
      return fromArray(makeToolUseStream(`tu_${callCount}`, 'first_tool', '{}'));
    });
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'tool output' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'do work' }];
    const abortController = new AbortController();

    const events = await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [{ name: 'first_tool', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
        maxToolUseIterations: 1,
      }),
    );

    const completed = events.find((e) => e.type === 'turn.completed');
    expect(completed).toBeDefined();
    if (completed?.type === 'turn.completed') {
      expect(completed.usage.stopReason).toBe('tool_use_loop_capped');
      expect(typeof completed.usage.durationMs).toBe('number');
      expect(completed.usage.durationMs).toBeGreaterThanOrEqual(0);
    }
  });

  // covers lines 196-203: no suggestion for long text
  it('does not emit suggestion for text longer than 200 chars', async () => {
    const longText = 'x'.repeat(201);
    const client = makeClient(() => fromArray(makeTextStream(longText)));
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'unused' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'explain' }];
    const abortController = new AbortController();

    const events = await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: null,
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // assistant.message should still be emitted
    const assistantMsg = events.find((e) => e.type === 'assistant.message');
    expect(assistantMsg).toBeDefined();

    // suggestion should NOT be emitted
    const suggestion = events.find((e) => e.type === 'suggestion');
    expect(suggestion).toBeUndefined();
  });

  // covers lines 205-214: messages array is mutated with assistant turn
  it('mutates messages array with assistant turn on non-tool_use stop', async () => {
    const client = makeClient(() => fromArray(makeTextStream('Response')));
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'unused' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'query' }];
    const abortController = new AbortController();

    await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: null,
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // messages should now have the assistant turn appended
    expect(messages.length).toBe(2);
    expect(messages[1]?.role).toBe('assistant');
    const content = messages[1]?.content as ContentBlockParam[];
    expect(Array.isArray(content)).toBe(true);
    expect(content[0]).toEqual({ type: 'text', text: 'Response' });
  });

  // covers lines 219-222, 280-306: tool-use pushes assistant + tool_result turns
  it('mutates messages with assistant and tool_result turns on tool_use', async () => {
    let callIdx = 0;
    const client = makeClient(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return fromArray(makeToolUseStream('toolu_mut', 'grep', '{"pattern":"foo"}'));
      }
      return fromArray(makeTextStream('Found it'));
    });

    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'match found' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'search' }];
    const abortController = new AbortController();

    await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [{ name: 'grep', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // messages should have: user, assistant (tool_use), user (tool_result), assistant (text)
    expect(messages.length).toBe(4);
    expect(messages[0]?.role).toBe('user');
    expect(messages[1]?.role).toBe('assistant');
    expect(messages[2]?.role).toBe('user');
    expect(messages[3]?.role).toBe('assistant');

    // tool_result turn should have the dispatcher's content
    const toolResultTurn = messages[2]?.content as ContentBlockParam[];
    expect(toolResultTurn[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'toolu_mut',
      content: 'match found',
    });
  });

  // covers lines 224-240: tool.use.start events emitted with summarized input
  // Note: translateMessageStream ALSO emits tool.use.start events (with placeholder ' …')
  // so we get 2 events per tool: one from translate (early) and one from loop (with summary)
  it('emits tool.use.start events with summarized input from loop', async () => {
    let callIdx = 0;
    const client = makeClient(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return fromArray(
          makeMultiToolUseStream([
            { id: 'toolu_a', name: 'read_file', input: '{"file_path":"/tmp/test.txt"}' },
            { id: 'toolu_b', name: 'bash', input: '{"command":"echo hello"}' },
          ]),
        );
      }
      return fromArray(makeTextStream('Done'));
    });

    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'ok' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'multi' }];
    const abortController = new AbortController();

    const events = await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [
          { name: 'read_file', input_schema: { type: 'object' } },
          { name: 'bash', input_schema: { type: 'object' } },
        ],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    const toolStarts = events.filter((e) => e.type === 'tool.use.start');
    // 4 total: 2 from translateMessageStream (with ' …') + 2 from loop (with summarized input)
    expect(toolStarts.length).toBe(4);

    // Find the loop-emitted events (ones with actual summarized input, not ' …')
    const loopEmittedStarts = toolStarts.filter(
      (e) => e.type === 'tool.use.start' && e.toolInput !== ' …',
    );
    expect(loopEmittedStarts.length).toBe(2);

    // First loop-emitted tool.use.start should have summarized file_path
    const readFileStart = loopEmittedStarts.find(
      (e) => e.type === 'tool.use.start' && e.toolName === 'read_file',
    );
    expect(readFileStart).toBeDefined();
    if (readFileStart?.type === 'tool.use.start') {
      expect(readFileStart.toolInput).toContain('/tmp/test.txt');
    }

    // Second loop-emitted tool.use.start should have summarized command
    const bashStart = loopEmittedStarts.find(
      (e) => e.type === 'tool.use.start' && e.toolName === 'bash',
    );
    expect(bashStart).toBeDefined();
    if (bashStart?.type === 'tool.use.start') {
      expect(bashStart.toolInput).toContain('echo hello');
    }
  });

  it('thinking blocks in messages array are API-valid after multi-turn accumulation', async () => {
    function makeThinkingThenToolStream(): RawMessageStreamEvent[] {
      return [
        {
          type: 'message_start',
          message: {
            id: 'msg_think', type: 'message', role: 'assistant', content: [],
            model: 'claude-test', stop_reason: null, stop_sequence: null, usage: baseUsage(),
          },
        } as unknown as RawMessageStreamEvent,
        // thinking block at index 0
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } as unknown as RawMessageStreamEvent,
        { type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me think...' } } as unknown as RawMessageStreamEvent,
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-123' } } as unknown as RawMessageStreamEvent,
        { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
        // tool_use block at index 1
        { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_t1', name: 'read_file', input: {} } } as unknown as RawMessageStreamEvent,
        { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"path":"/a"}' } } as unknown as RawMessageStreamEvent,
        { type: 'content_block_stop', index: 1 } as unknown as RawMessageStreamEvent,
        { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 10 } } as unknown as RawMessageStreamEvent,
        { type: 'message_stop' } as unknown as RawMessageStreamEvent,
      ];
    }

    let callIdx = 0;
    const client = makeClient(() => {
      callIdx += 1;
      if (callIdx === 1) return fromArray(makeThinkingThenToolStream());
      return fromArray(makeTextStream('Done'));
    });
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'file contents' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'read a file' }];
    const abortController = new AbortController();

    await collect(runTurn({
      client, messages, system: null,
      tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
      toolDispatcher: dispatcher, model: 'claude-test', maxTokens: 1024,
      headers: {}, signal: abortController.signal, ctx,
    }));

    // After the turn: [user, assistant(thinking+tool_use), user(tool_result), assistant(text)]
    expect(messages.length).toBe(4);

    // The assistant turn with thinking should have valid blocks
    const assistantTurn = messages[1]!;
    expect(assistantTurn.role).toBe('assistant');
    const blocks = assistantTurn.content as ContentBlockParam[];
    expect(blocks.length).toBe(2);

    // Validate thinking block is API-valid (non-empty thinking)
    const thinkingBlock = blocks[0] as { type: string; thinking: string; signature: string };
    expect(thinkingBlock.type).toBe('thinking');
    expect(thinkingBlock.thinking).toBe('Let me think...');
    expect(thinkingBlock.thinking.length).toBeGreaterThan(0);
    expect(thinkingBlock.signature).toBe('sig-123');

    // Tool use block
    const toolBlock = blocks[1] as { type: string; id: string; name: string };
    expect(toolBlock.type).toBe('tool_use');
    expect(toolBlock.name).toBe('read_file');
  });

  it('thinking block with only signature_delta (no thinking_delta) is filtered out', async () => {
    function makeEmptyThinkingThenTextStream(): RawMessageStreamEvent[] {
      return [
        {
          type: 'message_start',
          message: {
            id: 'msg_empty_think', type: 'message', role: 'assistant', content: [],
            model: 'claude-test', stop_reason: null, stop_sequence: null, usage: baseUsage(),
          },
        } as unknown as RawMessageStreamEvent,
        // thinking block at index 0 — only gets signature, no thinking content
        { type: 'content_block_start', index: 0, content_block: { type: 'thinking', thinking: '', signature: '' } } as unknown as RawMessageStreamEvent,
        { type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'sig-orphan' } } as unknown as RawMessageStreamEvent,
        { type: 'content_block_stop', index: 0 } as unknown as RawMessageStreamEvent,
        // text block at index 1
        { type: 'content_block_start', index: 1, content_block: { type: 'text', text: '' } } as unknown as RawMessageStreamEvent,
        { type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'Hello' } } as unknown as RawMessageStreamEvent,
        { type: 'content_block_stop', index: 1 } as unknown as RawMessageStreamEvent,
        { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } } as unknown as RawMessageStreamEvent,
        { type: 'message_stop' } as unknown as RawMessageStreamEvent,
      ];
    }

    const client = makeClient(() => fromArray(makeEmptyThinkingThenTextStream()));
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'unused' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];
    const abortController = new AbortController();

    await collect(runTurn({
      client, messages, system: null, tools: null,
      toolDispatcher: dispatcher, model: 'claude-test', maxTokens: 1024,
      headers: {}, signal: abortController.signal, ctx,
    }));

    // Assistant turn should only have the text block (empty thinking filtered out)
    expect(messages.length).toBe(2);
    const blocks = messages[1]!.content as ContentBlockParam[];
    expect(blocks.length).toBe(1);
    expect(blocks[0]!.type).toBe('text');
    expect((blocks[0] as { text: string }).text).toBe('Hello');
  });

  // covers summarizeToolInput helper (lines 58-71)
  it('summarizeToolInput extracts query/pattern/url/description fields', async () => {
    let callIdx = 0;
    const client = makeClient(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return fromArray(
          makeToolUseStream('toolu_q', 'search', '{"query":"test pattern"}'),
        );
      }
      return fromArray(makeTextStream('Found'));
    });

    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'result' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'search' }];
    const abortController = new AbortController();

    const events = await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [{ name: 'search', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // Loop emits tool.use.start with summarized input; translate emits with ' …'
    // Find the loop-emitted one (not ' …')
    const loopEmittedStart = events.find(
      (e) => e.type === 'tool.use.start' && e.toolInput !== ' …',
    );
    expect(loopEmittedStart).toBeDefined();
    if (loopEmittedStart?.type === 'tool.use.start') {
      expect(loopEmittedStart.toolInput).toContain('test pattern');
    }
  });

  // Regression: skill dispatch must surface WHICH skill in the tool lane.
  // The skill tool's input is `{ name, arguments }` — none of the
  // file_path/command/query fields match, so summarizeToolInput used to
  // return '' and the lane rendered a bare `skill [skill]` with no hint of
  // which skill ran. The fix returns the paren-wrapped skill name so the
  // lane renders `skill(diagnose)`.
  it('summarizeToolInput surfaces the skill name as a paren-wrapped label for skill dispatch', async () => {
    let callIdx = 0;
    const client = makeClient(() => {
      callIdx += 1;
      if (callIdx === 1) {
        return fromArray(
          makeToolUseStream('toolu_s', 'skill', '{"name":"diagnose","arguments":"flaky test"}'),
        );
      }
      return fromArray(makeTextStream('Done'));
    });

    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'ok' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'diagnose this' }];
    const abortController = new AbortController();

    const events = await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [{ name: 'skill', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // Loop emits tool.use.start with the summarized label; translate emits ' …'.
    const loopEmittedStart = events.find(
      (e) => e.type === 'tool.use.start' && e.toolInput !== ' …',
    );
    expect(loopEmittedStart).toBeDefined();
    if (loopEmittedStart?.type === 'tool.use.start') {
      // Paren-wrapped so the renderer treats it as a promoted dispatch label
      // (matching `Agent(<label>)`), not a leaf-tool ` arg` suffix.
      expect(loopEmittedStart.toolInput).toBe('(diagnose)');
      // The skill `arguments` field is intentionally NOT echoed — the name
      // alone identifies which skill ran, matching the Agent(label) form.
      expect(loopEmittedStart.toolInput).not.toContain('flaky test');
    }
  });
});

// ---------------------------------------------------------------------------
// Witness-layer trace emission (PR #2 commit 2)
// ---------------------------------------------------------------------------

describe('loop.ts runTurn — witness-layer tool_call emission', () => {
  // Import dynamically inside the describe to avoid forcing an eager
  // import at module top when the rest of the file does not need it.
  it('emits tool_call.started before dispatch and tool_call.completed after', async () => {
    const { InMemoryTraceWriter } = await import('../../trace/writer.js');
    const writer = new InMemoryTraceWriter();

    // Two streams: first emits a tool_use, second emits final text.
    let callIdx = 0;
    const streams = [
      () => fromArray(makeToolUseStream('tu_1', 'search', '{"q":"hello"}')),
      () => fromArray(makeTextStream('done', 'end_turn')),
    ];
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => streams[callIdx++ % streams.length]!()),
      },
    };
    const dispatcher = makeDispatcher(async () => ({
      content: 'search result',
      isError: false,
    }));
    const messages: MessageParam[] = [{ role: 'user', content: 'search please' }];
    const ac = new AbortController();

    await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [{ name: 'search', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: ac.signal,
        ctx,
        traceWriter: writer,
      }),
    );

    // Drain microtasks so the fire-and-forget emit calls settle.
    await new Promise((resolve) => setImmediate(resolve));

    const toolCalls = writer.events.filter((e) => e.kind === 'tool_call');
    expect(toolCalls).toHaveLength(2);
    if (toolCalls[0]?.kind !== 'tool_call' || toolCalls[1]?.kind !== 'tool_call') {
      throw new Error('unreachable');
    }
    expect(toolCalls[0].payload.phase).toBe('started');
    expect(toolCalls[1].payload.phase).toBe('completed');
    if (toolCalls[0].payload.phase !== 'started') throw new Error('unreachable');
    if (toolCalls[1].payload.phase !== 'completed') throw new Error('unreachable');
    expect(toolCalls[0].payload.toolUseId).toBe('tu_1');
    expect(toolCalls[0].payload.name).toBe('search');
    expect(toolCalls[0].payload.inputBytes).toBeGreaterThan(0);
    expect(toolCalls[1].payload.toolUseId).toBe('tu_1');
    expect(toolCalls[1].payload.name).toBe('search');
    expect(toolCalls[1].payload.resultBytes).toBe(Buffer.byteLength('search result'));
    expect(toolCalls[1].payload.isError).toBe(false);
    expect(toolCalls[1].payload.truncated).toBe(false);
    expect(toolCalls[1].payload.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('emits exactly one model_ttfb session_phase on the first streamed event', async () => {
    const { InMemoryTraceWriter } = await import('../../trace/writer.js');
    const writer = new InMemoryTraceWriter();

    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => fromArray(makeTextStream('hi', 'end_turn'))),
      },
    };
    const messages: MessageParam[] = [{ role: 'user', content: 'hello' }];
    const ac = new AbortController();

    await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [],
        toolDispatcher: makeDispatcher(async () => ({ content: '', isError: false })),
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: ac.signal,
        ctx,
        traceWriter: writer,
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));

    const ttfb = writer.events.filter(
      (e) =>
        e.kind === 'session_phase' &&
        (e.payload as { phase: string }).phase === 'model_ttfb',
    );
    // Single text-stream turn => exactly one model API call => one TTFB.
    expect(ttfb).toHaveLength(1);
    const payload = ttfb[0]!.payload as { durationMs?: number; resolvedModel?: string };
    expect(payload.durationMs).toBeTypeOf('number');
    expect(payload.durationMs).toBeGreaterThanOrEqual(0);
    // model_ttfb carries the resolved wire id for THIS call (input.model).
    expect(payload.resolvedModel).toBe('claude-test');
  });

  it('records isError=true and truncated=true based on tool result content', async () => {
    const { InMemoryTraceWriter } = await import('../../trace/writer.js');
    const writer = new InMemoryTraceWriter();

    let callIdx = 0;
    const streams = [
      () => fromArray(makeToolUseStream('tu_err', 'bash', '{}')),
      () => fromArray(makeTextStream('done', 'end_turn')),
    ];
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => streams[callIdx++ % streams.length]!()),
      },
    };
    const dispatcher = makeDispatcher(async () => ({
      content: 'partial...[output truncated — exceeded 100KB]',
      isError: true,
    }));

    await collect(
      runTurn({
        client,
        messages: [{ role: 'user', content: 'run' }],
        system: null,
        tools: [{ name: 'bash', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
        traceWriter: writer,
      }),
    );

    await new Promise((resolve) => setImmediate(resolve));

    const completed = writer.events.find(
      (e) => e.kind === 'tool_call' && e.payload.phase === 'completed',
    );
    expect(completed?.kind).toBe('tool_call');
    if (completed?.kind !== 'tool_call' || completed.payload.phase !== 'completed') {
      throw new Error('unreachable');
    }
    expect(completed.payload.isError).toBe(true);
    expect(completed.payload.truncated).toBe(true);
  });

  // Regression: prefer the structured `ToolResult.truncated` flag over the
  // in-band sentinel string. Before this flag existed, the trace writer
  // sniffed `result.content.includes('[output truncated')` — fragile
  // because it relied on a particular sentinel literal staying in content
  // and because external (third-party) handlers had no clean way to mark
  // overflow. The dispatcher in this test returns truncated:true with NO
  // sentinel in content; both the trace and the `tool.output` event must
  // still reflect truncation.
  it('propagates ToolResult.truncated=true to trace and tool.output event without sentinel', async () => {
    const { InMemoryTraceWriter } = await import('../../trace/writer.js');
    const writer = new InMemoryTraceWriter();

    let callIdx = 0;
    const streams = [
      () => fromArray(makeToolUseStream('tu_t', 'bash', '{}')),
      () => fromArray(makeTextStream('done', 'end_turn')),
    ];
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => streams[callIdx++ % streams.length]!()),
      },
    };
    // Notably: content has no `[output truncated …]` sentinel string.
    // Detection must come from the structured flag alone.
    const dispatcher = makeDispatcher(async () => ({
      content: 'some legitimate-looking output with no sentinel',
      truncated: true,
    }));

    const events = await collect(
      runTurn({
        client,
        messages: [{ role: 'user', content: 'run' }],
        system: null,
        tools: [{ name: 'bash', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
        traceWriter: writer,
      }),
    );

    await new Promise((resolve) => setImmediate(resolve));

    // Trace records the structured flag.
    const completed = writer.events.find(
      (e) => e.kind === 'tool_call' && e.payload.phase === 'completed',
    );
    if (completed?.kind !== 'tool_call' || completed.payload.phase !== 'completed') {
      throw new Error('unreachable');
    }
    expect(completed.payload.truncated).toBe(true);

    // The tool.output ProviderEvent carries the flag through to downstream
    // consumers (stream-consumer → ToolResultChunk → subagent trace).
    const toolOutput = events.find((e) => e.type === 'tool.output');
    if (toolOutput?.type !== 'tool.output') {
      throw new Error('expected tool.output event');
    }
    expect(toolOutput.truncated).toBe(true);
  });

  it('emits no tool_call events when traceWriter is absent', async () => {
    const { InMemoryTraceWriter } = await import('../../trace/writer.js');
    const writer = new InMemoryTraceWriter();

    let callIdx = 0;
    const streams = [
      () => fromArray(makeToolUseStream('tu_q', 'search', '{}')),
      () => fromArray(makeTextStream('done', 'end_turn')),
    ];
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => streams[callIdx++ % streams.length]!()),
      },
    };
    const dispatcher = makeDispatcher(async () => ({ content: 'r', isError: false }));

    await collect(
      runTurn({
        client,
        messages: [{ role: 'user', content: 'x' }],
        system: null,
        tools: [{ name: 'search', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
        // traceWriter omitted intentionally
      }),
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(writer.events).toHaveLength(0);
  });
});

describe('loop.ts runTurn — render-only diff sidecar', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits tool.diff event when handler returns render.diff', async () => {
    // First iteration: tool_use. Second iteration: end_turn (to terminate the loop).
    let callIdx = 0;
    const client = makeClient(() => {
      callIdx += 1;
      if (callIdx === 1) return fromArray(makeToolUseStream('tu_diff', 'edit_file', '{}'));
      return fromArray(makeTextStream('done', 'end_turn'));
    });

    const dispatcher = makeDispatcher(() =>
      Promise.resolve({
        content: 'Replaced 1 occurrence in /tmp/x.ts',
        render: {
          diff: {
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: [{ kind: '-' as const, text: 'a' }, { kind: '+' as const, text: 'b' }],
              },
            ],
            addedLines: 1,
            removedLines: 1,
          },
        },
      }),
    );

    const events = await collect(
      runTurn({
        client,
        messages: [{ role: 'user', content: 'edit it' }],
        system: null,
        tools: [{ name: 'edit_file', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
      }),
    );

    // Find tool.output and tool.diff for the same toolUseId.
    const output = events.find((e) => e.type === 'tool.output');
    const diff = events.find((e) => e.type === 'tool.diff');
    expect(output).toBeDefined();
    expect(diff).toBeDefined();
    if (output?.type === 'tool.output' && diff?.type === 'tool.diff') {
      expect(diff.toolUseId).toBe(output.toolUseId);
      expect(diff.diff.addedLines).toBe(1);
      expect(diff.diff.removedLines).toBe(1);
    }

    // Order invariant: tool.diff arrives AFTER tool.output for the same id.
    const outputIdx = events.findIndex((e) => e.type === 'tool.output');
    const diffIdx = events.findIndex((e) => e.type === 'tool.diff');
    expect(diffIdx).toBeGreaterThan(outputIdx);
  });

  it('does NOT emit tool.diff when handler omits render', async () => {
    let callIdx = 0;
    const client = makeClient(() => {
      callIdx += 1;
      if (callIdx === 1) return fromArray(makeToolUseStream('tu_no_diff', 'read_file', '{}'));
      return fromArray(makeTextStream('done', 'end_turn'));
    });
    const dispatcher = makeDispatcher(() =>
      Promise.resolve({ content: 'file contents' }),
    );

    const events = await collect(
      runTurn({
        client,
        messages: [{ role: 'user', content: 'read it' }],
        system: null,
        tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
      }),
    );

    expect(events.some((e) => e.type === 'tool.output')).toBe(true);
    expect(events.some((e) => e.type === 'tool.diff')).toBe(false);
  });

  it('does NOT include render.diff in the model-facing tool_result block', async () => {
    // Structural correctness check: the messages array (which is what's
    // sent back to the model on the next iteration) must contain only the
    // result.content string — never the diff payload. This is the central
    // invariant the render channel exists to enforce.
    let callIdx = 0;
    const client = makeClient(() => {
      callIdx += 1;
      if (callIdx === 1) return fromArray(makeToolUseStream('tu_leak', 'edit_file', '{}'));
      return fromArray(makeTextStream('done', 'end_turn'));
    });
    const dispatcher = makeDispatcher(() =>
      Promise.resolve({
        content: 'Replaced 1 occurrence',
        render: {
          diff: {
            hunks: [
              {
                oldStart: 1,
                oldLines: 1,
                newStart: 1,
                newLines: 1,
                lines: [
                  { kind: '-' as const, text: 'SECRET_BEFORE' },
                  { kind: '+' as const, text: 'SECRET_AFTER' },
                ],
              },
            ],
            addedLines: 1,
            removedLines: 1,
          },
        },
      }),
    );

    const messages: MessageParam[] = [{ role: 'user', content: 'edit it' }];
    await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [{ name: 'edit_file', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
      }),
    );

    // The loop pushes a `tool_result` MessageParam after dispatching tools.
    // Walk every tool_result block in the final messages array and assert
    // that no diff-payload sentinel ever appears in the content the model
    // would see.
    const serialized = JSON.stringify(messages);
    expect(serialized).not.toContain('SECRET_BEFORE');
    expect(serialized).not.toContain('SECRET_AFTER');
    expect(serialized).not.toContain('"hunks"');
    expect(serialized).not.toContain('"addedLines"');

    // And the model's tool_result content should be the one-line summary only.
    let found = false;
    for (const msg of messages) {
      if (msg.role === 'user' && Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (
            block &&
            typeof block === 'object' &&
            'type' in block &&
            block.type === 'tool_result'
          ) {
            found = true;
            expect((block as { content: unknown }).content).toBe('Replaced 1 occurrence');
          }
        }
      }
    }
    expect(found).toBe(true);
  });
});

// ─── isTransientServerError ──────────────────────────────────────────────────

describe('isTransientServerError', () => {
  it('returns true for HTTP 529 (overloaded)', () => {
    const err = Object.assign(new Error('Overloaded'), { status: 529 });
    expect(isTransientServerError(err)).toBe(true);
  });

  it('returns true for HTTP 503 (service unavailable)', () => {
    const err = Object.assign(new Error('Service Unavailable'), { status: 503 });
    expect(isTransientServerError(err)).toBe(true);
  });

  it('returns false for HTTP 429 (rate limit)', () => {
    const err = Object.assign(new Error('Rate limited'), { status: 429 });
    expect(isTransientServerError(err)).toBe(false);
  });

  it('returns false for HTTP 401 (auth)', () => {
    const err = Object.assign(new Error('Unauthorized'), { status: 401 });
    expect(isTransientServerError(err)).toBe(false);
  });

  it('returns false for errors without status', () => {
    expect(isTransientServerError(new Error('network failure'))).toBe(false);
  });
});

// ─── isOverloadedErrorEvent ──────────────────────────────────────────────────
//
// Mid-stream overloads carry NO HTTP status (the SDK throws them from inside
// the stream iterator as `new APIError(undefined, <parsed SSE body>, …)`), so
// detection must key off the parsed body, not `status`. The body shape from a
// real Anthropic `event: error` SSE frame is double-nested:
//   {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}
describe('isOverloadedErrorEvent', () => {
  it('detects a mid-stream overload from the double-nested SSE body (status undefined)', () => {
    const err = Object.assign(new Error('Overloaded'), {
      status: undefined,
      error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' }, request_id: 'req_x' },
    });
    expect(isOverloadedErrorEvent(err)).toBe(true);
  });

  it('detects a flat overload body shape', () => {
    const err = Object.assign(new Error('Overloaded'), {
      error: { type: 'overloaded_error', message: 'Overloaded' },
    });
    expect(isOverloadedErrorEvent(err)).toBe(true);
  });

  it('detects a connection-phase 529/503 by status', () => {
    expect(isOverloadedErrorEvent(Object.assign(new Error('x'), { status: 529 }))).toBe(true);
    expect(isOverloadedErrorEvent(Object.assign(new Error('x'), { status: 503 }))).toBe(true);
  });

  it('returns false for a non-overload error event (e.g. invalid_request)', () => {
    const err = Object.assign(new Error('bad'), {
      status: undefined,
      error: { type: 'error', error: { type: 'invalid_request_error', message: 'bad' } },
    });
    expect(isOverloadedErrorEvent(err)).toBe(false);
  });

  it('returns false for a plain error with no body or status', () => {
    expect(isOverloadedErrorEvent(new Error('network failure'))).toBe(false);
    expect(isOverloadedErrorEvent(null)).toBe(false);
    expect(isOverloadedErrorEvent(undefined)).toBe(false);
    expect(isOverloadedErrorEvent('overloaded_error')).toBe(false);
  });
});

// ─── createWithRetry (via runTurn) ───────────────────────────────────────────

describe('runTurn transient error retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('retries on 529 and succeeds on subsequent attempt', async () => {
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => {
          callCount++;
          if (callCount === 1) {
            throw Object.assign(new Error('Overloaded'), { status: 529, type: 'overloaded_error' });
          }
          return fromArray(makeTextStream('recovered'));
        }),
      },
    };
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'ok' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];
    const abortController = new AbortController();

    const resultPromise = collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: null,
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // Advance past the retry delay
    await vi.advanceTimersByTimeAsync(10_000);

    const events = await resultPromise;

    expect(callCount).toBe(2);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeUndefined();
    const completed = events.find((e) => e.type === 'turn.completed');
    expect(completed).toBeDefined();
  });

  it('exhausts retries and yields error on persistent 529', async () => {
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => {
          throw Object.assign(new Error('Overloaded'), { status: 529, type: 'overloaded_error' });
        }),
      },
    };
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'ok' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];
    const abortController = new AbortController();

    const resultPromise = collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: null,
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // Advance past all retry delays (5s + 10s + 20s = 35s)
    await vi.advanceTimersByTimeAsync(40_000);

    const events = await resultPromise;

    // 1 initial + OVERLOAD_MAX_RETRIES retries
    expect(client.messages.create).toHaveBeenCalledTimes(OVERLOAD_MAX_RETRIES + 1);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error.message).toContain('Overloaded');
    }
  });

  it('does not retry non-transient errors (e.g. 400)', async () => {
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => {
          throw Object.assign(new Error('Bad request'), { status: 400 });
        }),
      },
    };
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'ok' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];
    const abortController = new AbortController();

    const events = await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: null,
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    expect(client.messages.create).toHaveBeenCalledTimes(1);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
  });

  it('aborts during retry sleep and yields turn.completed', async () => {
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => {
          callCount++;
          throw Object.assign(new Error('Overloaded'), { status: 529 });
        }),
      },
    };
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'ok' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];
    const abortController = new AbortController();

    const resultPromise = collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: null,
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // Let the first attempt fail, then abort during the sleep
    await vi.advanceTimersByTimeAsync(100);
    abortController.abort('interrupted');
    await vi.advanceTimersByTimeAsync(10_000);

    const events = await resultPromise;

    expect(callCount).toBe(1);
    const completed = events.find((e) => e.type === 'turn.completed');
    expect(completed).toBeDefined();
  });
});

// ─── Mid-stream overload retry (via runTurn) ─────────────────────────────────
//
// Regression for the v3.78.x crash: an Anthropic `overloaded_error` delivered
// mid-stream (HTTP 200, then an `event: error` SSE frame) is thrown from the
// SDK stream iterator with `status === undefined`. createWithRetry — status-
// based and wrapping only the connection-phase messages.create() — never saw
// it, the auth/usage-limit retry tiers ignored it, and the error event
// propagated to a fatal turn crash. These tests pin the mid-stream retry path.
describe('runTurn mid-stream overload retry', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // A stream that yields message_start then throws the exact mid-stream
  // overload shape the SDK produces: status undefined, double-nested
  // overloaded_error body. translateMessageStream catches the throw and yields
  // it as an in-band error event — the path runTurn must now retry.
  function midStreamOverloadStream(): AsyncIterable<RawMessageStreamEvent> {
    return (async function* () {
      yield {
        type: 'message_start',
        message: {
          id: 'msg_overload', type: 'message', role: 'assistant', content: [],
          model: 'claude-test', stop_reason: null, stop_sequence: null, usage: baseUsage(),
        },
      } as unknown as RawMessageStreamEvent;
      throw Object.assign(new Error('Overloaded'), {
        status: undefined,
        error: { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' }, request_id: 'req_overload' },
      });
    })();
  }

  it('retries a mid-stream overload and succeeds on the next attempt', async () => {
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => {
          callCount++;
          return callCount === 1 ? midStreamOverloadStream() : fromArray(makeTextStream('recovered'));
        }),
      },
    };
    const resultPromise = collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {}, signal: new AbortController().signal, ctx,
      }),
    );

    await vi.advanceTimersByTimeAsync(10_000); // past the first 5s backoff
    const events = await resultPromise;

    expect(callCount).toBe(2);
    expect(events.find((e) => e.type === 'error')).toBeUndefined();
    expect(events.find((e) => e.type === 'turn.completed')).toBeDefined();
    // The retry emits exactly one stream.retry marker so surfaces can discard
    // the overloaded attempt's partial text before the recovered re-stream.
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(1);
  });

  it('exhausts the retry budget on a persistent mid-stream overload and yields the error', async () => {
    const client: AnthropicClientLike = {
      messages: { create: vi.fn(() => midStreamOverloadStream()) },
    };
    const resultPromise = collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {}, signal: new AbortController().signal, ctx,
      }),
    );

    await vi.advanceTimersByTimeAsync(40_000); // past all backoffs (5s + 10s + 20s)
    const events = await resultPromise;

    expect(client.messages.create).toHaveBeenCalledTimes(OVERLOAD_MAX_RETRIES + 1);
    // One stream.retry per backoff/re-drive — OVERLOAD_MAX_RETRIES total (the
    // final, exhausted attempt yields the error, not another retry marker).
    expect(events.filter((e) => e.type === 'stream.retry')).toHaveLength(OVERLOAD_MAX_RETRIES);
    const errorEvent = events.find((e) => e.type === 'error');
    expect(errorEvent).toBeDefined();
    if (errorEvent?.type === 'error') {
      expect(errorEvent.error.message).toContain('Overloaded');
    }
  });

  it('does NOT retry a non-overload mid-stream error', async () => {
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => {
          callCount++;
          return (async function* () {
            yield {
              type: 'message_start',
              message: {
                id: 'msg_bad', type: 'message', role: 'assistant', content: [],
                model: 'claude-test', stop_reason: null, stop_sequence: null, usage: baseUsage(),
              },
            } as unknown as RawMessageStreamEvent;
            throw Object.assign(new Error('Invalid request'), {
              status: undefined,
              error: { type: 'error', error: { type: 'invalid_request_error', message: 'Invalid request' } },
            });
          })();
        }),
      },
    };
    const events = await collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {}, signal: new AbortController().signal, ctx,
      }),
    );

    expect(callCount).toBe(1); // no backoff, no retry — surfaces immediately
    expect(events.find((e) => e.type === 'error')).toBeDefined();
    // A non-overload error surfaces immediately — no retry, so no marker.
    expect(events.find((e) => e.type === 'stream.retry')).toBeUndefined();
  });

  it('aborts during the mid-stream retry backoff and yields turn.completed', async () => {
    let callCount = 0;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn(() => {
          callCount++;
          return midStreamOverloadStream();
        }),
      },
    };
    const abortController = new AbortController();
    const resultPromise = collect(
      runTurn({
        client, messages: [{ role: 'user', content: 'hi' }], system: null, tools: null,
        toolDispatcher: makeDispatcher(() => Promise.resolve({ content: 'ok' })),
        model: 'claude-test', maxTokens: 1024, headers: {}, signal: abortController.signal, ctx,
      }),
    );

    await vi.advanceTimersByTimeAsync(100); // first attempt overloads, enters backoff
    abortController.abort('interrupted');
    await vi.advanceTimersByTimeAsync(10_000);
    const events = await resultPromise;

    expect(callCount).toBe(1); // aborted before the retry attempt
    expect(events.find((e) => e.type === 'turn.completed')).toBeDefined();
  });
});

// ─── Regression: orphan tool_use prevention ────────────────────────────────────
//
// Anthropic Messages API rejects any user-turn submit whose prior assistant
// message contains a `tool_use` block not immediately followed by a user
// message of matching `tool_result` blocks:
//
//   400 messages.N: `tool_use` ids were found without `tool_result` blocks
//   immediately after: toolu_XXX
//
// runTurn must never leave history in that shape. These tests pin the two
// codepaths that historically did:
//
//   1. stopReason != 'tool_use' but assistantBlocks contains a tool_use block
//      (e.g. `max_tokens` truncated the message after the tool_use opened).
//      Pre-fix: the tool_use block was pushed verbatim — instant orphan.
//      Post-fix: tool_use blocks are filtered from the pushed assistant turn.
//
//   2. stopReason == 'tool_use' but the dispatcher throws synchronously
//      OUTSIDE the dispatcher's own try/catch (e.g. accessor on
//      `input.toolDispatcher` throws). Pre-fix: assistant tool_use push
//      remained in history. Post-fix: rollback splices it back out.

describe('loop.ts runTurn — orphan tool_use prevention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('strips tool_use blocks when stopReason is not tool_use (max_tokens truncation)', async () => {
    // Stream: a tool_use block opens AND closes, but message_delta carries
    // stop_reason='max_tokens' (model ran out of budget before the model would
    // have actually requested a dispatch). assistantBlocks contains the
    // tool_use block; runTurn must NOT leak it into history.
    const truncatedToolUseStream: RawMessageStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_truncate',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: baseUsage(),
        },
      } as unknown as RawMessageStreamEvent,
      {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_orphan', name: 'read_file', input: {} },
      } as unknown as RawMessageStreamEvent,
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"file":"a.ts"}' },
      } as unknown as RawMessageStreamEvent,
      {
        type: 'content_block_stop',
        index: 0,
      } as unknown as RawMessageStreamEvent,
      {
        type: 'message_delta',
        delta: { stop_reason: 'max_tokens', stop_sequence: null },
        usage: { output_tokens: 4 },
      } as unknown as RawMessageStreamEvent,
      { type: 'message_stop' } as unknown as RawMessageStreamEvent,
    ];

    const client = makeClient(() => fromArray(truncatedToolUseStream));
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'never called' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'do a thing' }];
    const abortController = new AbortController();

    await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: null,
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // History invariant: no message ends in an unmatched tool_use block.
    // Equivalent: no assistant message anywhere carries tool_use without a
    // following user message of tool_result blocks. With this stream we
    // expect the assistant turn to be either skipped entirely (no usable
    // content) or to contain only non-tool_use blocks. The tool_use must
    // NOT appear in history.
    const flatTooluses: string[] = [];
    for (const m of messages) {
      if (typeof m.content === 'string') continue;
      for (const b of m.content as ContentBlockParam[]) {
        if (b.type === 'tool_use') flatTooluses.push((b as { id: string }).id);
      }
    }
    expect(flatTooluses).not.toContain('toolu_orphan');
  });

  it('rolls back the assistant tool_use push when the dispatcher accessor throws', async () => {
    // Build a dispatcher whose `executeBatch` is a getter that throws on
    // access. This simulates a throw between "tool_use is committed to
    // history" and "tool_result is committed to history" that NOT absorbed
    // by the existing executeBatch try/catch (which only catches when the
    // function call itself throws, after access succeeds).
    const dispatcher: ToolDispatcherLike = {
      execute: vi.fn(() => Promise.reject(new Error('should use batch'))),
    };
    Object.defineProperty(dispatcher, 'executeBatch', {
      get() {
        throw new Error('synthetic mid-turn failure');
      },
    });

    const stream = makeToolUseStream('toolu_will_orphan', 'read_file', '{"file":"a.ts"}');
    const client = makeClient(() => fromArray(stream));
    const messages: MessageParam[] = [{ role: 'user', content: 'do it' }];
    const initialLength = messages.length;
    const abortController = new AbortController();

    let caught: Error | null = null;
    try {
      await collect(
        runTurn({
          client,
          messages,
          system: null,
          tools: null,
          toolDispatcher: dispatcher,
          model: 'claude-test',
          maxTokens: 1024,
          headers: {},
          signal: abortController.signal,
          ctx,
        }),
      );
    } catch (err) {
      caught = err as Error;
    }

    // The throw is intentional — runTurn re-throws after rolling back. The
    // invariant under test is: history does NOT carry the orphan tool_use.
    expect(caught).toBeInstanceOf(Error);
    expect(messages.length).toBe(initialLength);
    for (const m of messages) {
      if (typeof m.content === 'string') continue;
      for (const b of m.content as ContentBlockParam[]) {
        expect(b.type).not.toBe('tool_use');
      }
    }
  });

  it('leaves history matched (tool_use + tool_result) on the normal dispatch path', async () => {
    // Sanity guard: the rollback wrapper must not corrupt the happy path.
    // After one tool_use round + dispatch, history should contain exactly
    // the assistant tool_use turn followed by the user tool_result turn.
    const stream = makeToolUseStream('toolu_ok', 'read_file', '{"file":"a.ts"}');
    const client = makeClient(() =>
      // After the dispatch turn, the model would emit a follow-up — but we
      // only need one round, so the second call gets an end_turn text stream.
      fromArray(stream),
    );
    // Replace the create mock with a sequence: first call returns the tool_use
    // stream, second call returns an end_turn text stream.
    let callIdx = 0;
    client.messages.create = vi.fn(() => {
      callIdx++;
      return callIdx === 1
        ? fromArray(stream)
        : fromArray(makeTextStream('done', 'end_turn'));
    });

    const dispatcher = makeBatchDispatcher(async (calls) =>
      calls.map(() => ({ content: 'file contents', isError: false as const })),
    );
    const messages: MessageParam[] = [{ role: 'user', content: 'read it' }];
    const abortController = new AbortController();

    await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: null,
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    // Find the assistant tool_use message and verify the very next message
    // is a user message whose content covers the same tool_use_id.
    let toolUseIdx = -1;
    for (let i = 0; i < messages.length; i++) {
      const m = messages[i]!;
      if (m.role !== 'assistant' || typeof m.content === 'string') continue;
      for (const b of m.content as ContentBlockParam[]) {
        if (b.type === 'tool_use') {
          toolUseIdx = i;
          break;
        }
      }
      if (toolUseIdx >= 0) break;
    }
    expect(toolUseIdx).toBeGreaterThanOrEqual(0);
    const next = messages[toolUseIdx + 1];
    expect(next?.role).toBe('user');
    expect(typeof next?.content).not.toBe('string');
    const nextBlocks = next!.content as ContentBlockParam[];
    expect(nextBlocks.some((b) => b.type === 'tool_result' && (b as { tool_use_id: string }).tool_use_id === 'toolu_ok')).toBe(true);
  });

  // Regression: the Anthropic Messages API rejects extra fields on custom
  // tool definitions with 400 `tools.0.custom.category: Extra inputs are
  // not permitted`. AnthropicToolDef carries internal classification
  // metadata (`category`, `concurrencySafe`, `riskClass`) that must be
  // stripped before send. `toWireTool` projects to the wire-safe shape;
  // this test pins the contract.
  it('strips internal classification metadata (category, concurrencySafe, riskClass) before sending tools to the API', async () => {
    let captured: { tools?: unknown } | undefined;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((params: unknown) => {
          captured = params as { tools?: unknown };
          return fromArray(makeTextStream('hi'));
        }),
      },
    };
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'ok' }));

    const messages: MessageParam[] = [{ role: 'user', content: 'hi' }];
    const abortController = new AbortController();

    await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [
          {
            name: 'bash',
            description: 'run a shell command',
            input_schema: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] },
            category: 'shell',
            concurrencySafe: false,
            riskClass: 'destructive',
          },
        ],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
      }),
    );

    expect(captured).toBeDefined();
    const sentTools = (captured!.tools as Array<Record<string, unknown>> | undefined) ?? [];
    expect(sentTools).toHaveLength(1);
    const sent = sentTools[0]!;
    // wire-safe fields preserved
    expect(sent['name']).toBe('bash');
    expect(sent['description']).toBe('run a shell command');
    expect(sent['input_schema']).toBeDefined();
    // internal metadata MUST be stripped — these caused the 400
    expect(sent).not.toHaveProperty('category');
    expect(sent).not.toHaveProperty('concurrencySafe');
    expect(sent).not.toHaveProperty('riskClass');
    // exhaustive: only the three wire-safe keys leave the boundary
    expect(Object.keys(sent).sort()).toEqual(['description', 'input_schema', 'name']);
  });

  it('omits `description` when not provided (does not emit `description: undefined`)', async () => {
    let captured: { tools?: unknown } | undefined;
    const client: AnthropicClientLike = {
      messages: {
        create: vi.fn((params: unknown) => {
          captured = params as { tools?: unknown };
          return fromArray(makeTextStream('hi'));
        }),
      },
    };
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'ok' }));

    await collect(
      runTurn({
        client,
        messages: [{ role: 'user', content: 'hi' }],
        system: null,
        tools: [{ name: 'no_desc', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: new AbortController().signal,
        ctx,
      }),
    );

    const sentTools = (captured!.tools as Array<Record<string, unknown>>);
    expect(Object.keys(sentTools[0]!).sort()).toEqual(['input_schema', 'name']);
  });
});

// ─── onUsageProgress mid-turn hook ───────────────────────────────────────────

describe('loop.ts runTurn — onUsageProgress mid-turn hook', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('fires onUsageProgress once per round with monotonically non-decreasing cumulative tokens', async () => {
    // Round 1: tool_use response with input=100, output=20 (via message_start + message_delta).
    // Round 2: final text response with input=150, output=30.
    // Streams use the same structure as makeToolUseStream / makeTextStream but
    // with explicit token counts so the assertion is deterministic.
    function makeToolUseStreamWithUsage(
      toolId: string,
      toolName: string,
      inputJson: string,
      inputTokens: number,
      outputTokens: number,
    ): RawMessageStreamEvent[] {
      return [
        {
          type: 'message_start',
          message: {
            id: 'msg_progress_t',
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'claude-test',
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: inputTokens,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        } as unknown as RawMessageStreamEvent,
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: toolId, name: toolName, input: {} },
        } as unknown as RawMessageStreamEvent,
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: inputJson },
        } as unknown as RawMessageStreamEvent,
        {
          type: 'content_block_stop',
          index: 0,
        } as unknown as RawMessageStreamEvent,
        {
          type: 'message_delta',
          delta: { stop_reason: 'tool_use', stop_sequence: null },
          usage: { output_tokens: outputTokens },
        } as unknown as RawMessageStreamEvent,
        { type: 'message_stop' } as unknown as RawMessageStreamEvent,
      ];
    }

    function makeTextStreamWithUsage(
      text: string,
      inputTokens: number,
      outputTokens: number,
    ): RawMessageStreamEvent[] {
      return [
        {
          type: 'message_start',
          message: {
            id: 'msg_progress_txt',
            type: 'message',
            role: 'assistant',
            content: [],
            model: 'claude-test',
            stop_reason: null,
            stop_sequence: null,
            usage: {
              input_tokens: inputTokens,
              output_tokens: 0,
              cache_creation_input_tokens: 0,
              cache_read_input_tokens: 0,
            },
          },
        } as unknown as RawMessageStreamEvent,
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        } as unknown as RawMessageStreamEvent,
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        } as unknown as RawMessageStreamEvent,
        {
          type: 'content_block_stop',
          index: 0,
        } as unknown as RawMessageStreamEvent,
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn', stop_sequence: null },
          usage: { output_tokens: outputTokens },
        } as unknown as RawMessageStreamEvent,
        { type: 'message_stop' } as unknown as RawMessageStreamEvent,
      ];
    }

    let callIdx = 0;
    const client = makeClient(() => {
      callIdx += 1;
      if (callIdx === 1) {
        // Round 1: tool_use with input=100, output=20
        return fromArray(makeToolUseStreamWithUsage('toolu_prog', 'read_file', '{}', 100, 20));
      }
      // Round 2: final text with input=150, output=30
      return fromArray(makeTextStreamWithUsage('Done', 150, 30));
    });

    const onUsageProgress = vi.fn();
    const dispatcher = makeDispatcher(() => Promise.resolve({ content: 'ok' }));
    const messages: MessageParam[] = [{ role: 'user', content: 'progress test' }];
    const abortController = new AbortController();

    await collect(
      runTurn({
        client,
        messages,
        system: null,
        tools: [{ name: 'read_file', input_schema: { type: 'object' } }],
        toolDispatcher: dispatcher,
        model: 'claude-test',
        maxTokens: 1024,
        headers: {},
        signal: abortController.signal,
        ctx,
        onUsageProgress,
      }),
    );

    // Called at least once per round (round 1 = tool_use, round 2 = end_turn).
    expect(onUsageProgress).toHaveBeenCalledTimes(2);

    // Extract the full usage objects from each call for exact-value checks.
    const call0 = onUsageProgress.mock.calls[0]?.[0] as {
      inputTokens?: number;
      outputTokens?: number;
    };
    const call1 = onUsageProgress.mock.calls[1]?.[0] as {
      inputTokens?: number;
      outputTokens?: number;
    };

    // Exact-value anchors — these prove per-round firing, not just that the
    // hook was called:
    //
    // Round 1: translateMessageStream merges message_start.usage
    //   { input_tokens: 100, output_tokens: 0 } with message_delta.usage
    //   { output_tokens: 20 } → { input_tokens: 100, output_tokens: 20 }.
    //   sumProviderUsage({}, round1) → cumulative = { inputTokens: 100,
    //   outputTokens: 20 }. onUsageProgress receives exactly this.
    expect(call0?.inputTokens).toBe(100);
    expect(call0?.outputTokens).toBe(20);

    // Round 2: input_tokens: 150, output_tokens: 30.
    //   sumProviderUsage(round1, round2) → { inputTokens: 250, outputTokens: 50 }.
    //   onUsageProgress receives the NEW cumulative (not round-2's delta alone).
    expect(call1?.inputTokens).toBe(250);
    expect(call1?.outputTokens).toBe(50);

    // Monotonicity is now a corollary of the exact values, but keep it as an
    // explicit guard for future token-count changes that might regress ordering.
    const tokenTotals = [call0, call1].map((u) =>
      (u?.inputTokens ?? 0) + (u?.outputTokens ?? 0),
    );
    for (let i = 1; i < tokenTotals.length; i++) {
      expect(tokenTotals[i]).toBeGreaterThanOrEqual(tokenTotals[i - 1]!);
    }
  });
});
