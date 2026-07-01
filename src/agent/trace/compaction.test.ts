/**
 * Tests for the `compaction` trace event emitted from
 * {@link AnthropicDirectQuery#compact}.
 *
 * The compaction event captures the pre-compaction transcript inline
 * (via the `preCompactionMessages` field on CompactionPayloadInput).
 * A production writer is expected to sidecar this slice and rewrite the
 * payload into its persisted form; for these unit tests we use the
 * InMemoryTraceWriter which preserves the input form verbatim.
 *
 * Scope: PR #2 commit 7. Only the manual trigger is exercised today —
 * auto-compaction triggers ('token_threshold', 'turn_count') will be
 * wired when the source code adds those code paths.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type { MessageParam, RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import type { ProviderUserTurn } from '../provider.js';
import { AnthropicDirectQuery } from '../providers/anthropic-direct/query.js';
import type { ToolDispatcher } from '../providers/anthropic-direct/tool-dispatcher.js';
import { InMemoryTraceWriter } from './writer.js';

const messagesCreateMock = vi.fn();

class MockAnthropic {
  public messages: { create: typeof messagesCreateMock };
  constructor() {
    this.messages = { create: messagesCreateMock };
  }
}

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

/** Minimal RawMessageStreamEvent sequence producing the summary text. */
function summaryStream(text: string): RawMessageStreamEvent[] {
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
      delta: { type: 'text_delta', text },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_stop',
      index: 0,
    } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 30 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

/** Build a history with N fresh user turns alternating user/assistant. */
function makeHistory(turns: number): MessageParam[] {
  const out: MessageParam[] = [];
  for (let i = 0; i < turns; i++) {
    out.push({ role: 'user', content: `user message ${i}` });
    out.push({ role: 'assistant', content: `assistant reply ${i}` });
  }
  return out;
}

const emptyPromptStream: AsyncIterable<ProviderUserTurn> = (async function* () {})();

const noopToolDispatcher: ToolDispatcher = {
  get toolDefs() {
    return [];
  },
  async execute() {
    return { content: '', isError: false };
  },
};

function buildQuery(opts: {
  writer?: InMemoryTraceWriter;
  initialMessages: MessageParam[];
}): AnthropicDirectQuery {
  return new AnthropicDirectQuery({
    client: new MockAnthropic() as unknown as Anthropic,
    authMode: 'api-key',
    promptStream: emptyPromptStream,
    toolDispatcher: noopToolDispatcher,
    initialMessages: opts.initialMessages,
    model: 'claude-sonnet-5',
    maxTokens: 4096,
    tools: null,
    userSystem: null,
    systemPrefix: null,
    ...(opts.writer ? { traceWriter: opts.writer } : {}),
  });
}

describe('compaction trace event', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    messagesCreateMock.mockImplementation(() =>
      fromArray(summaryStream('## Summary\n\nPrior context compressed.')),
    );
  });

  it('emits one compaction event with the pre-compaction slice and summary', async () => {
    // Need enough history that findCompactionBoundary returns > 0.
    // Default keepLastN=3, so we need at least 4+ fresh user turns.
    const history = makeHistory(6);
    const writer = new InMemoryTraceWriter();
    const query = buildQuery({ writer, initialMessages: history });

    const result = await query.compact();
    await new Promise((r) => setImmediate(r));

    expect(result.compacted).toBe(true);
    const ev = writer.events.find((e) => e.kind === 'compaction');
    expect(ev?.kind).toBe('compaction');
    if (ev?.kind !== 'compaction') throw new Error('unreachable');
    // The persisted form rewrites preCompactionMessages into a sidecar
    // ref. Top-level fields stay verbatim.
    expect(ev.payload.trigger).toBe('manual');
    expect(ev.payload.summary).toBe('## Summary\n\nPrior context compressed.');
    expect(ev.payload.keepLastNConfig).toBeGreaterThanOrEqual(1);
    expect(ev.payload.messagesBefore).toBe(history.length);
    expect(ev.payload.messagesAfter).toBeLessThan(history.length);
    expect(typeof ev.payload.tokensSavedEstimate).toBe('number');
    expect(ev.payload.tokensSavedEstimate).toBeGreaterThanOrEqual(0);
    // Persisted sidecar ref carries path + size + sha256.
    expect(ev.payload.preCompactionMessagesRef.path).toMatch(/^in-memory:\/\//);
    expect(ev.payload.preCompactionMessagesRef.sizeBytes).toBeGreaterThan(0);
    expect(ev.payload.preCompactionMessagesRef.sha256).toMatch(/^[0-9a-f]{64}$/);

    // The inline pre-compaction slice is preserved via the test side-channel.
    const inline = writer.getInlineCompactionPayload(ev.seq);
    expect(inline).toBeDefined();
    expect(Array.isArray(inline!.preCompactionMessages)).toBe(true);
    expect(inline!.preCompactionMessages.length).toBeGreaterThan(0);
    expect(inline!.preCompactionMessages.length).toBeLessThan(history.length);
  });

  it('does not emit when compaction is a no-op (nothing to summarize)', async () => {
    // Exactly 2 fresh user turns with keepLastN=2: findCompactionBoundary
    // returns 0 (kept tail starts at message 0 — nothing older to summarize).
    // compact() returns `compacted: false` with `reason: 'nothing-to-summarize'`.
    // No trace event should fire for a no-op compaction.
    const history = makeHistory(2);
    const writer = new InMemoryTraceWriter();
    const query = buildQuery({ writer, initialMessages: history });

    const result = await query.compact();
    await new Promise((r) => setImmediate(r));

    expect(result.compacted).toBe(false);
    expect(result.reason).toBe('nothing-to-summarize');
    expect(writer.events.filter((e) => e.kind === 'compaction')).toHaveLength(0);
  });

  it('does not emit on an empty-summary response', async () => {
    // Provider returns an empty summary string. compact() returns
    // `compacted: false` with `reason: 'empty-summary'`. The compaction
    // event must not fire — there's nothing to record about a no-op
    // compaction.
    messagesCreateMock.mockImplementation(() => fromArray(summaryStream('')));
    const history = makeHistory(6);
    const writer = new InMemoryTraceWriter();
    const query = buildQuery({ writer, initialMessages: history });

    const result = await query.compact();
    await new Promise((r) => setImmediate(r));

    expect(result.compacted).toBe(false);
    expect(writer.events.filter((e) => e.kind === 'compaction')).toHaveLength(0);
  });

  it('does nothing when traceWriter is absent (graceful no-op)', async () => {
    const history = makeHistory(6);
    // No writer.
    const query = buildQuery({ initialMessages: history });

    const result = await query.compact();
    expect(result.compacted).toBe(true);
    // No throw despite the absence of a writer.
  });
});
