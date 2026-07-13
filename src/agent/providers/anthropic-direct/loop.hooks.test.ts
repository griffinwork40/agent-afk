// onUsageProgress mid-turn hook tests for loop.ts runTurn.
// Split out of loop.test.ts (#370) — bodies moved verbatim.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RawMessageStreamEvent, MessageParam } from '@anthropic-ai/sdk/resources';
import { runTurn } from './loop.js';
import {
  fromArray,
  collect,
  ctx,
  makeTextStream,
  makeToolUseStream,
  makeClient,
  makeDispatcher,
} from './loop.test-helpers.js';

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
