/**
 * Pure-function tests for the compact helper module.
 *
 * Covers:
 *  - `isFreshUserTurn` distinguishes real user input from tool-result turns.
 *  - `findCompactionBoundary` walks back N fresh user turns.
 *  - `applyCompaction` produces a valid alternation-preserving array.
 *  - `buildSummarizationRequest` shape.
 *  - `estimateTokensSaved` is non-negative and grows with dropped content.
 */

import { describe, it, expect } from 'vitest';
import type { MessageParam } from '@anthropic-ai/sdk/resources';
import {
  COMPACT_ACK_TEXT,
  COMPACT_SUMMARY_HEADER,
  applyCompaction,
  buildSummarizationRequest,
  estimateTokensSaved,
  findCompactionBoundary,
  isFreshUserTurn,
} from './compact.js';

describe('isFreshUserTurn', () => {
  it('returns true for string-content user message', () => {
    expect(isFreshUserTurn({ role: 'user', content: 'hello' })).toBe(true);
  });

  it('returns true for array-content user message with no tool_result blocks', () => {
    expect(
      isFreshUserTurn({
        role: 'user',
        content: [{ type: 'text', text: 'hello' }],
      }),
    ).toBe(true);
  });

  it('returns false for user message containing a tool_result block', () => {
    expect(
      isFreshUserTurn({
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'sunny' },
        ],
      }),
    ).toBe(false);
  });

  it('returns false for assistant messages', () => {
    expect(isFreshUserTurn({ role: 'assistant', content: 'hi' })).toBe(false);
  });
});

describe('findCompactionBoundary', () => {
  function userText(text: string): MessageParam {
    return { role: 'user', content: text };
  }
  function asstText(text: string): MessageParam {
    return { role: 'assistant', content: text };
  }
  function asstToolUse(name: string, id: string): MessageParam {
    return {
      role: 'assistant',
      content: [
        { type: 'tool_use', id, name, input: {} },
      ],
    };
  }
  function userToolResult(id: string, body: string): MessageParam {
    return {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: body }],
    };
  }

  it('returns -1 when fewer fresh user turns than keepLastN', () => {
    const msgs: MessageParam[] = [userText('u1'), asstText('a1')];
    expect(findCompactionBoundary(msgs, 3)).toBe(-1);
  });

  it('returns the index of the K-th fresh user turn from the end', () => {
    const msgs: MessageParam[] = [
      userText('u1'),
      asstToolUse('grep', 't1'),
      userToolResult('t1', 'found'),
      userText('u2'),
      userText('u3'),
      userText('u4'),
    ];
    // 4 fresh user turns. keep last 3 -> boundary at index of u2 = 3.
    expect(findCompactionBoundary(msgs, 3)).toBe(3);
  });

  it('counts only fresh user turns — tool_result turns don\'t count', () => {
    const msgs: MessageParam[] = [
      userText('u1'),
      userText('u2'),
      asstToolUse('grep', 't1'),
      userToolResult('t1', 'found'),
      userText('u3'),
    ];
    // Fresh: u1, u2, u3. keep last 2 -> boundary at u2 = index 1.
    expect(findCompactionBoundary(msgs, 2)).toBe(1);
  });

  it('returns 0 when boundary lands on the very first message', () => {
    const msgs: MessageParam[] = [
      userText('u1'),
      userText('u2'),
      userText('u3'),
    ];
    expect(findCompactionBoundary(msgs, 3)).toBe(0);
  });

  it('treats keepLastN <= 0 as "keep nothing" by returning messages.length', () => {
    const msgs: MessageParam[] = [userText('u1'), userText('u2')];
    expect(findCompactionBoundary(msgs, 0)).toBe(2);
  });
});

describe('applyCompaction', () => {
  it('replaces messages[0..boundary) with summary preamble + tail', () => {
    const msgs: MessageParam[] = [
      { role: 'user', content: 'old1' },
      { role: 'assistant', content: 'old2' },
      { role: 'user', content: 'kept1' },
      { role: 'user', content: 'kept2' },
    ];
    const result = applyCompaction(msgs, 2, 'SUMMARY');
    expect(result.length).toBe(4);
    expect(result[0]?.role).toBe('user');
    expect(result[0]?.content).toContain(COMPACT_SUMMARY_HEADER);
    expect(result[0]?.content).toContain('SUMMARY');
    expect(result[1]?.role).toBe('assistant');
    expect(result[1]?.content).toBe(COMPACT_ACK_TEXT);
    expect(result[2]?.content).toBe('kept1');
    expect(result[3]?.content).toBe('kept2');
  });

  it('preserves user/assistant alternation in the resulting array', () => {
    const msgs: MessageParam[] = [
      { role: 'user', content: 'u1' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 't1', name: 'g', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }],
      },
      { role: 'user', content: 'u2-fresh' },
    ];
    const result = applyCompaction(msgs, 3, 'sum');
    // Expected order: user(summary) → assistant(ack) → user('u2-fresh')
    expect(result.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
  });
});

describe('buildSummarizationRequest', () => {
  it('returns a streaming, tool-less, non-empty messages.create body', () => {
    const older: MessageParam[] = [
      { role: 'user', content: 'find weather' },
      { role: 'assistant', content: 'sunny' },
    ];
    const params = buildSummarizationRequest(older, 'claude-haiku-4-5', 1024);
    expect(params.model).toBe('claude-haiku-4-5');
    expect(params.max_tokens).toBe(1024);
    expect(params.stream).toBe(true);
    expect(params.tools).toBeUndefined();
    expect(params.messages.length).toBe(1);
    expect(params.messages[0]?.role).toBe('user');
    expect(typeof params.messages[0]?.content).toBe('string');
    expect(params.messages[0]?.content as string).toContain('find weather');
    expect(typeof params.system).toBe('string');
  });

  it('renders tool_use and tool_result blocks readably', () => {
    const older: MessageParam[] = [
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 't1', name: 'grep', input: { q: 'foo' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 't1', content: 'matched 3 lines' },
        ],
      },
    ];
    const params = buildSummarizationRequest(older, 'm', 256);
    const body = params.messages[0]?.content as string;
    expect(body).toContain('[tool call: grep');
    expect(body).toContain('[tool result: matched 3 lines]');
  });
});

describe('estimateTokensSaved', () => {
  it('is zero when boundary is 0', () => {
    const msgs: MessageParam[] = [{ role: 'user', content: 'u1' }];
    expect(estimateTokensSaved(msgs, 0, 'summary text')).toBe(0);
  });

  it('grows with dropped content size', () => {
    const big = 'x'.repeat(4000);
    const msgs: MessageParam[] = [
      { role: 'user', content: big },
      { role: 'user', content: 'tail' },
    ];
    const saved = estimateTokensSaved(msgs, 1, 'summary');
    expect(saved).toBeGreaterThan(0);
    expect(saved).toBeLessThan(big.length); // sanity: not larger than chars
  });
});

// ---------------------------------------------------------------------------
// Integration tests: auto-compaction trigger via AnthropicDirectQuery
// ---------------------------------------------------------------------------
// These tests exercise the threshold-crossing path end-to-end:
//   session turn completes with high token usage → compact() fires exactly once
//   second turn while isCompacting → compact() does NOT re-trigger
// ---------------------------------------------------------------------------

import { describe as describeIntegration, it as itIntegration, expect as expectIntegration, vi, beforeEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import { AnthropicDirectQuery } from './query.js';
import type { ToolDispatcher } from './tool-dispatcher.js';
import { createHookRegistry } from '../../hooks.js';

const autoCompactMock = vi.fn();

class MockAnthropicForAutoCompact {
  public messages: { create: typeof autoCompactMock };
  constructor() {
    this.messages = { create: autoCompactMock };
  }
}

async function* fromArr<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

/**
 * Build a minimal streaming event sequence that reports `inputTokens` high
 * enough to cross the 90% threshold on a 200k-context-window model.
 * 200_000 * 0.90 = 180_000 — use 181_000 to be safely above.
 */
function makeHighUsageStream(): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_high_usage',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-5',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 181_000,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '', citations: [] },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'Reply near context limit.' },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_stop',
      index: 0,
    } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 50 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

/** Minimal summary stream returned by the compaction summarization request. */
function makeSummaryStream(): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_summary',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-haiku-4-5-20251001',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          server_tool_use: null,
          service_tier: null,
        },
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '', citations: [] },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: '## Summary\n\nOlder context compressed.' },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_stop',
      index: 0,
    } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 20 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

const noopAutoCompactDispatcher: ToolDispatcher = {
  get toolDefs() {
    return [];
  },
  async execute() {
    return { content: '', isError: false };
  },
};

/** Build a history long enough that compact() finds something to summarize. */
function makeMinimalHistory(): MessageParam[] {
  const out: MessageParam[] = [];
  for (let i = 0; i < 6; i++) {
    out.push({ role: 'user', content: `turn ${i}` });
    out.push({ role: 'assistant', content: `reply ${i}` });
  }
  return out;
}

async function* singleTurnStream(content: string): AsyncIterable<{ content: string }> {
  yield { content };
}

describeIntegration('auto-compaction integration', () => {
  beforeEach(() => {
    autoCompactMock.mockReset();
  });

  itIntegration('fires compact() exactly once when usage crosses 90% threshold', async () => {
    // Call #1: main turn response with high token usage
    // Call #2: compaction summarization request
    let callCount = 0;
    autoCompactMock.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) return fromArr(makeHighUsageStream());
      // Second call is the compaction summarization request
      return fromArr(makeSummaryStream());
    });

    const query = new AnthropicDirectQuery({
      client: new MockAnthropicForAutoCompact() as unknown as Anthropic,
      authMode: 'api-key',
      promptStream: singleTurnStream('test message'),
      toolDispatcher: noopAutoCompactDispatcher,
      initialMessages: makeMinimalHistory(),
      model: 'claude-sonnet-5',
      maxTokens: 4096,
      tools: null,
      userSystem: null,
      systemPrefix: null,
      autoCompactThreshold: 0.9,
    });

    // Spy on compact() to track invocations without changing behavior.
    const compactSpy = vi.spyOn(query, 'compact');

    const events: import('../../provider.js').ProviderEvent[] = [];
    for await (const ev of query) {
      events.push(ev);
    }

    // compact() must have been called exactly once — the turn crossed 90%
    // and the auto-trigger fired at the turn boundary.
    expectIntegration(compactSpy).toHaveBeenCalledTimes(1);
    // The session should have emitted turn.completed (not an error).
    const completed = events.find((e) => e.type === 'turn.completed');
    expectIntegration(completed).toBeDefined();
  });

  itIntegration('does NOT trigger compact() when autoCompactThreshold is undefined (disabled)', async () => {
    autoCompactMock.mockImplementation(() => fromArr(makeHighUsageStream()));

    const query = new AnthropicDirectQuery({
      client: new MockAnthropicForAutoCompact() as unknown as Anthropic,
      authMode: 'api-key',
      promptStream: singleTurnStream('test message'),
      toolDispatcher: noopAutoCompactDispatcher,
      initialMessages: makeMinimalHistory(),
      model: 'claude-sonnet-5',
      maxTokens: 4096,
      tools: null,
      userSystem: null,
      systemPrefix: null,
      // No autoCompactThreshold — disabled by default
    });

    const compactSpy = vi.spyOn(query, 'compact');

    for await (const _ev of query) { /* drain */ }

    expectIntegration(compactSpy).not.toHaveBeenCalled();
  });

  itIntegration('dispatches PreCompact(trigger:auto) hook before compact() fires', async () => {
    let callCount = 0;
    autoCompactMock.mockImplementation(() => {
      callCount += 1;
      if (callCount === 1) return fromArr(makeHighUsageStream());
      return fromArr(makeSummaryStream());
    });

    const registry = createHookRegistry();
    const preCompactContexts: Array<{ trigger?: string }> = [];
    registry.register('PreCompact', async (ctx) => {
      preCompactContexts.push({ trigger: (ctx as { trigger?: string }).trigger });
      return { decision: 'continue' as const };
    });

    const query = new AnthropicDirectQuery({
      client: new MockAnthropicForAutoCompact() as unknown as Anthropic,
      authMode: 'api-key',
      promptStream: singleTurnStream('test message'),
      toolDispatcher: noopAutoCompactDispatcher,
      initialMessages: makeMinimalHistory(),
      model: 'claude-sonnet-5',
      maxTokens: 4096,
      tools: null,
      userSystem: null,
      systemPrefix: null,
      autoCompactThreshold: 0.9,
      hookRegistry: registry,
    });

    const compactSpy = vi.spyOn(query, 'compact');

    for await (const _ev of query) { /* drain */ }

    // Hook must have fired exactly once with trigger:'auto'.
    expectIntegration(preCompactContexts).toHaveLength(1);
    expectIntegration(preCompactContexts[0]?.trigger).toBe('auto');
    // compact() must have been called — hook allowed it.
    expectIntegration(compactSpy).toHaveBeenCalledTimes(1);
  });

  itIntegration('honors a blocking PreCompact hook — skips compact() without error', async () => {
    autoCompactMock.mockImplementation(() => fromArr(makeHighUsageStream()));

    const registry = createHookRegistry();
    registry.register('PreCompact', async () => {
      return { decision: 'block' as const, reason: 'test block' };
    });

    const query = new AnthropicDirectQuery({
      client: new MockAnthropicForAutoCompact() as unknown as Anthropic,
      authMode: 'api-key',
      promptStream: singleTurnStream('test message'),
      toolDispatcher: noopAutoCompactDispatcher,
      initialMessages: makeMinimalHistory(),
      model: 'claude-sonnet-5',
      maxTokens: 4096,
      tools: null,
      userSystem: null,
      systemPrefix: null,
      autoCompactThreshold: 0.9,
      hookRegistry: registry,
    });

    const compactSpy = vi.spyOn(query, 'compact');
    const events: import('../../provider.js').ProviderEvent[] = [];

    for await (const ev of query) {
      events.push(ev);
    }

    // Hook blocked compaction — compact() must NOT have been called.
    expectIntegration(compactSpy).not.toHaveBeenCalled();
    // Session still completed normally (not an error event).
    const completed = events.find((e) => e.type === 'turn.completed');
    expectIntegration(completed).toBeDefined();
  });
});
