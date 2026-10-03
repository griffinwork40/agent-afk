/**
 * Pure-function tests for the `anthropic-direct` provider's translator.
 *
 * Covers the five contract cases:
 *  1. Text-only stream — delta.text events + assistant text in turn-result.
 *  2. Tool-use stream — tool.use event + parsed input on turn-result.
 *  3. Thinking deltas — delta.reasoning events + thinking block on turn-result.
 *  4. Inline error — error event yielded, no turn-result, no rethrow.
 *  5. Usage carried through to turn-result.
 */

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import { translateMessageStream } from './translate.js';
import type { TranslateOutput } from './types.js';
import { _resetWarnCountForTest } from './input-transformations.js';

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

async function collect(
  stream: AsyncIterable<TranslateOutput>,
): Promise<TranslateOutput[]> {
  const out: TranslateOutput[] = [];
  for await (const x of stream) out.push(x);
  return out;
}

const SESSION_ID = 'sess_test_1';

function baseUsage(): {
  cache_creation: null;
  cache_creation_input_tokens: null;
  cache_read_input_tokens: null;
  inference_geo: null;
  input_tokens: number;
  output_tokens: number;
} {
  return {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    inference_geo: null,
    input_tokens: 10,
    output_tokens: 0,
  };
}

function messageStart(
  usageOverride?: Record<string, unknown>,
): RawMessageStreamEvent {
  return {
    type: 'message_start',
    message: {
      id: 'msg_test',
      type: 'message',
      role: 'assistant',
      model: 'claude-test',
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { ...baseUsage(), ...(usageOverride ?? {}) },
    },
  } as unknown as RawMessageStreamEvent;
}

function messageStop(): RawMessageStreamEvent {
  return { type: 'message_stop' } as unknown as RawMessageStreamEvent;
}

function messageDelta(
  stopReason: string | null,
  outputTokens = 5,
): RawMessageStreamEvent {
  return {
    type: 'message_delta',
    delta: { stop_reason: stopReason, stop_sequence: null },
    usage: {
      cache_creation_input_tokens: null,
      cache_read_input_tokens: null,
      input_tokens: null,
      output_tokens: outputTokens,
      server_tool_use: null,
    },
  } as unknown as RawMessageStreamEvent;
}

function textBlockStart(index: number): RawMessageStreamEvent {
  return {
    type: 'content_block_start',
    index,
    content_block: { type: 'text', text: '', citations: null },
  } as unknown as RawMessageStreamEvent;
}

function textDelta(index: number, text: string): RawMessageStreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'text_delta', text },
  } as unknown as RawMessageStreamEvent;
}

function blockStop(index: number): RawMessageStreamEvent {
  return {
    type: 'content_block_stop',
    index,
  } as unknown as RawMessageStreamEvent;
}

function toolUseStart(
  index: number,
  id: string,
  name: string,
): RawMessageStreamEvent {
  return {
    type: 'content_block_start',
    index,
    content_block: { type: 'tool_use', id, name, input: {} },
  } as unknown as RawMessageStreamEvent;
}

function inputJsonDelta(index: number, partial: string): RawMessageStreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'input_json_delta', partial_json: partial },
  } as unknown as RawMessageStreamEvent;
}

function thinkingStart(index: number): RawMessageStreamEvent {
  return {
    type: 'content_block_start',
    index,
    content_block: { type: 'thinking', thinking: '', signature: '' },
  } as unknown as RawMessageStreamEvent;
}

function thinkingDelta(index: number, thinking: string): RawMessageStreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'thinking_delta', thinking },
  } as unknown as RawMessageStreamEvent;
}

function signatureDelta(index: number, signature: string): RawMessageStreamEvent {
  return {
    type: 'content_block_delta',
    index,
    delta: { type: 'signature_delta', signature },
  } as unknown as RawMessageStreamEvent;
}

function redactedThinkingStart(index: number, data: string): RawMessageStreamEvent {
  return {
    type: 'content_block_start',
    index,
    content_block: { type: 'redacted_thinking', data },
  } as unknown as RawMessageStreamEvent;
}

describe('anthropic-direct translateMessageStream', () => {
  it('text-only stream emits delta.text events and an end_turn turn-result', async () => {
    const events: RawMessageStreamEvent[] = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, 'Hello '),
      textDelta(0, 'world'),
      blockStop(0),
      messageDelta('end_turn'),
      messageStop(),
    ];

    const out = await collect(
      translateMessageStream(fromArray(events), { sessionId: SESSION_ID }),
    );

    const textDeltas = out.filter(
      (o) => o.kind === 'event' && o.event.type === 'delta.text',
    );
    expect(textDeltas).toHaveLength(2);
    expect(textDeltas[0]).toEqual({
      kind: 'event',
      event: { type: 'delta.text', text: 'Hello ', sessionId: SESSION_ID },
    });
    expect(textDeltas[1]).toEqual({
      kind: 'event',
      event: { type: 'delta.text', text: 'world', sessionId: SESSION_ID },
    });

    const last = out[out.length - 1];
    expect(last).toBeDefined();
    if (!last || last.kind !== 'turn-result') {
      throw new Error('expected last output to be turn-result');
    }
    expect(last.result.stopReason).toBe('end_turn');
    expect(last.result.text).toBe('Hello world');
    expect(last.result.assistantBlocks).toHaveLength(1);
    expect(last.result.assistantBlocks[0]).toEqual({
      type: 'text',
      text: 'Hello world',
    });
    expect(last.result.toolUseBlocks).toHaveLength(0);
  });

  it('tool-use stream emits tool.use.start on content_block_start before tool.use on block_stop', async () => {
    const events: RawMessageStreamEvent[] = [
      messageStart(),
      toolUseStart(0, 'toolu_1', 'get_weather'),
      inputJsonDelta(0, '{"city":'),
      inputJsonDelta(0, ' "SF"}'),
      blockStop(0),
      messageDelta('tool_use'),
      messageStop(),
    ];

    const out = await collect(
      translateMessageStream(fromArray(events), { sessionId: SESSION_ID }),
    );

    const startEvents = out.filter(
      (o) => o.kind === 'event' && o.event.type === 'tool.use.start',
    );
    expect(startEvents).toHaveLength(1);
    const startEvt = startEvents[0];
    if (!startEvt || startEvt.kind !== 'event' || startEvt.event.type !== 'tool.use.start') {
      throw new Error('expected tool.use.start event');
    }
    expect(startEvt.event.toolUseId).toBe('toolu_1');
    expect(startEvt.event.toolName).toBe('get_weather');
    expect(startEvt.event.sessionId).toBe(SESSION_ID);

    const startIdx = out.indexOf(startEvt);
    const useEvents = out.filter(
      (o) => o.kind === 'event' && o.event.type === 'tool.use',
    );
    expect(useEvents).toHaveLength(1);
    const useIdx = out.indexOf(useEvents[0]!);
    expect(startIdx).toBeLessThan(useIdx);
  });

  it('tool-use stream emits a tool.use event and parsed input on turn-result', async () => {
    const events: RawMessageStreamEvent[] = [
      messageStart(),
      toolUseStart(0, 'toolu_1', 'get_weather'),
      inputJsonDelta(0, '{"city":'),
      inputJsonDelta(0, ' "SF"}'),
      blockStop(0),
      messageDelta('tool_use'),
      messageStop(),
    ];

    const out = await collect(
      translateMessageStream(fromArray(events), { sessionId: SESSION_ID }),
    );

    const toolEvents = out.filter(
      (o) => o.kind === 'event' && o.event.type === 'tool.use',
    );
    expect(toolEvents).toHaveLength(1);
    const toolEvt = toolEvents[0];
    if (!toolEvt || toolEvt.kind !== 'event' || toolEvt.event.type !== 'tool.use') {
      throw new Error('expected tool.use event');
    }
    expect(toolEvt.event.summary).toBe('get_weather');
    expect(toolEvt.event.toolUseIds).toEqual(['toolu_1']);
    expect(toolEvt.event.sessionId).toBe(SESSION_ID);

    const last = out[out.length - 1];
    if (!last || last.kind !== 'turn-result') {
      throw new Error('expected turn-result at end');
    }
    expect(last.result.stopReason).toBe('tool_use');
    expect(last.result.toolUseBlocks).toHaveLength(1);
    const tu = last.result.toolUseBlocks[0];
    expect(tu).toBeDefined();
    if (!tu) throw new Error('expected tool-use block');
    expect(tu.id).toBe('toolu_1');
    expect(tu.name).toBe('get_weather');
    expect(tu.input).toEqual({ city: 'SF' });
    expect(last.result.assistantBlocks).toHaveLength(1);
  });

  it('thinking deltas emit delta.reasoning and produce a thinking block', async () => {
    const events: RawMessageStreamEvent[] = [
      messageStart(),
      thinkingStart(0),
      thinkingDelta(0, 'hmm'),
      signatureDelta(0, 'sig-xyz'),
      blockStop(0),
      messageDelta('end_turn'),
      messageStop(),
    ];

    const out = await collect(
      translateMessageStream(fromArray(events), { sessionId: SESSION_ID }),
    );

    const reasoningEvents = out.filter(
      (o) => o.kind === 'event' && o.event.type === 'delta.reasoning',
    );
    expect(reasoningEvents).toHaveLength(1);
    const re = reasoningEvents[0];
    if (!re || re.kind !== 'event' || re.event.type !== 'delta.reasoning') {
      throw new Error('expected delta.reasoning event');
    }
    expect(re.event.text).toBe('hmm');

    const textEvents = out.filter(
      (o) => o.kind === 'event' && o.event.type === 'delta.text',
    );
    expect(textEvents).toHaveLength(0);

    const last = out[out.length - 1];
    if (!last || last.kind !== 'turn-result') {
      throw new Error('expected turn-result at end');
    }
    const block = last.result.assistantBlocks[0];
    expect(block).toEqual({
      type: 'thinking',
      thinking: 'hmm',
      signature: 'sig-xyz',
    });
  });

  it('empty thinking blocks (no deltas) are filtered out of turn-result', async () => {
    const events: RawMessageStreamEvent[] = [
      messageStart(),
      thinkingStart(0),
      // No thinking_delta — block stays empty
      signatureDelta(0, 'sig-abc'),
      blockStop(0),
      textBlockStart(1),
      textDelta(1, 'hello'),
      blockStop(1),
      messageDelta('end_turn'),
      messageStop(),
    ];

    const out = await collect(
      translateMessageStream(fromArray(events), { sessionId: SESSION_ID }),
    );

    const last = out[out.length - 1];
    if (!last || last.kind !== 'turn-result') {
      throw new Error('expected turn-result at end');
    }
    expect(last.result.assistantBlocks).toHaveLength(1);
    expect(last.result.assistantBlocks[0]).toEqual({
      type: 'text',
      text: 'hello',
    });
  });

  it('thinking block with content but no signature is filtered out', async () => {
    const events: RawMessageStreamEvent[] = [
      messageStart(),
      thinkingStart(0),
      thinkingDelta(0, 'some thoughts'),
      // No signature_delta — signature stays ''
      blockStop(0),
      textBlockStart(1),
      textDelta(1, 'hello'),
      blockStop(1),
      messageDelta('end_turn'),
      messageStop(),
    ];

    const out = await collect(
      translateMessageStream(fromArray(events), { sessionId: SESSION_ID }),
    );

    const last = out[out.length - 1];
    if (!last || last.kind !== 'turn-result') {
      throw new Error('expected turn-result at end');
    }
    expect(last.result.assistantBlocks).toHaveLength(1);
    expect(last.result.assistantBlocks[0]).toEqual({
      type: 'text',
      text: 'hello',
    });
  });

  it('preserves a redacted_thinking block verbatim in turn-result', async () => {
    const events: RawMessageStreamEvent[] = [
      messageStart(),
      redactedThinkingStart(0, 'ENCRYPTED_PAYLOAD'),
      blockStop(0),
      textBlockStart(1),
      textDelta(1, 'done'),
      blockStop(1),
      messageDelta('end_turn'),
      messageStop(),
    ];

    const out = await collect(
      translateMessageStream(fromArray(events), { sessionId: SESSION_ID }),
    );

    const last = out[out.length - 1];
    if (!last || last.kind !== 'turn-result') {
      throw new Error('expected turn-result at end');
    }
    expect(last.result.assistantBlocks).toEqual([
      { type: 'redacted_thinking', data: 'ENCRYPTED_PAYLOAD' },
      { type: 'text', text: 'done' },
    ]);
  });

  it('redacted_thinking followed by tool_use leads the assistant turn with the reasoning block (regression: must not be dropped)', async () => {
    // Regression for the session-wedge bug: a security-adjacent prompt makes
    // the server emit redacted_thinking, then the model calls tools. When
    // extended thinking is enabled, the continuation request 400s unless the
    // assistant turn LEADS with a thinking/redacted_thinking block. Dropping
    // the redacted block (the pre-fix behavior) produced a tool_use-only turn
    // that 400'd on every subsequent request — permanently wedging the session.
    const events: RawMessageStreamEvent[] = [
      messageStart(),
      redactedThinkingStart(0, 'OPAQUE'),
      blockStop(0),
      toolUseStart(1, 'toolu_9', 'web_scrape'),
      inputJsonDelta(1, '{"url":"https://x"}'),
      blockStop(1),
      messageDelta('tool_use'),
      messageStop(),
    ];

    const out = await collect(
      translateMessageStream(fromArray(events), { sessionId: SESSION_ID }),
    );

    const last = out[out.length - 1];
    if (!last || last.kind !== 'turn-result') {
      throw new Error('expected turn-result at end');
    }
    // The reasoning block must come FIRST, before the tool_use.
    const blocks = last.result.assistantBlocks;
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toEqual({ type: 'redacted_thinking', data: 'OPAQUE' });
    expect(blocks[1]).toMatchObject({ type: 'tool_use', id: 'toolu_9', name: 'web_scrape' });
    expect(last.result.toolUseBlocks).toHaveLength(1);
  });

  it('error mid-stream yields an error event, no turn-result, and does not throw', async () => {
    async function* throwing(): AsyncIterable<RawMessageStreamEvent> {
      yield messageStart();
      yield textBlockStart(0);
      throw new Error('boom');
    }

    const out = await collect(
      translateMessageStream(throwing(), { sessionId: SESSION_ID }),
    );

    expect(out.length).toBeGreaterThan(0);
    const last = out[out.length - 1];
    expect(last).toBeDefined();
    if (!last || last.kind !== 'event' || last.event.type !== 'error') {
      throw new Error('expected last output to be error event');
    }
    expect(last.event.error).toBeInstanceOf(Error);
    expect(last.event.error.message).toBe('boom');

    const turnResults = out.filter((o) => o.kind === 'turn-result');
    expect(turnResults).toHaveLength(0);
  });

  it('carries usage through to turn-result (input + cache_read from start, output from delta)', async () => {
    const events: RawMessageStreamEvent[] = [
      messageStart({
        input_tokens: 100,
        output_tokens: 0,
        cache_read_input_tokens: 50,
      }),
      textBlockStart(0),
      textDelta(0, 'ok'),
      blockStop(0),
      messageDelta('end_turn', 25),
      messageStop(),
    ];

    const out = await collect(
      translateMessageStream(fromArray(events), { sessionId: SESSION_ID }),
    );

    const last = out[out.length - 1];
    if (!last || last.kind !== 'turn-result') {
      throw new Error('expected turn-result at end');
    }
    expect(last.result.usage).not.toBeNull();
    const u = last.result.usage;
    if (!u) throw new Error('usage must be non-null');
    expect(u.input_tokens).toBe(100);
    expect(u.output_tokens).toBe(25);
    expect(u.cache_read_input_tokens).toBe(50);
  });

  it('stream ending with no message_stop and no stop_reason surfaces an error (P0: no silent truncation)', async () => {
    // Regression guard for the parent-facing "silent truncation" gap: when a
    // model stream is cut off before completion (e.g. an intermediary gracefully
    // closing the connection mid-response), neither `message_stop` nor a
    // `message_delta` stop_reason arrives. Before the fix, translate yielded a
    // `turn-result` with stopReason=null carrying the partial text, so the turn
    // was delivered as a clean, complete answer. It must surface an error so the
    // partial is never silently presented as final.
    async function* cutOff(): AsyncIterable<RawMessageStreamEvent> {
      yield messageStart();
      yield textBlockStart(0);
      yield textDelta(0, 'Partial answer that got ');
      // stream ends here — NO message_delta, NO message_stop
    }

    const out = await collect(
      translateMessageStream(cutOff(), { sessionId: SESSION_ID }),
    );

    // The partial text still streams as a delta event...
    const textDeltas = out.filter(
      (o) => o.kind === 'event' && o.event.type === 'delta.text',
    );
    expect(textDeltas).toHaveLength(1);

    // ...but the turn must NOT resolve as a (silent) turn-result.
    const turnResults = out.filter((o) => o.kind === 'turn-result');
    expect(turnResults).toHaveLength(0);

    // It surfaces as an error event instead.
    const last = out[out.length - 1];
    if (!last || last.kind !== 'event' || last.event.type !== 'error') {
      throw new Error('expected an error event when the stream ends without a terminal signal');
    }
    expect(last.event.error).toBeInstanceOf(Error);
    expect(last.event.error.message).toMatch(/message_stop|incomplete|cut off/i);
  });

  it('stream that loses only message_stop but has a real stop_reason still yields a turn-result', async () => {
    // Negative guard: the incomplete-detection must NOT false-positive when the
    // model DID signal completion (message_delta carried a stop_reason) and only
    // the framing `message_stop` event was lost. That turn is substantively
    // complete and must resolve normally.
    const events: RawMessageStreamEvent[] = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, 'Complete answer'),
      blockStop(0),
      messageDelta('end_turn'),
      // NO message_stop
    ];

    const out = await collect(
      translateMessageStream(fromArray(events), { sessionId: SESSION_ID }),
    );

    const last = out[out.length - 1];
    if (!last || last.kind !== 'turn-result') {
      throw new Error('expected a turn-result when a real stop_reason was received');
    }
    expect(last.result.stopReason).toBe('end_turn');
    expect(last.result.text).toBe('Complete answer');
  });
});

// ── input_transformations: drop_block observable handling (Fable 5.1) ────
//
// Real wire shape per https://platform.claude.com/docs/en/build-with-claude/preserved-thinking:
//   input_transformations: Array<{
//     type: 'thinking_dropped' | 'thinking_mismatch_allowed' | string;
//     path: string;          // e.g. 'messages.1.content.0'
//     reason: 'prefix_binding_mismatch' | 'model_binding_mismatch'
//           | 'organization_binding_mismatch' | string;
//   }>
//
// 'thinking_dropped'          → block was removed before the model saw it.
// 'thinking_mismatch_allowed' → block failed prefix check but was NOT dropped
//                               (older account, no enforcement). Must NOT warn.
// Placement: message_start.message.input_transformations (all drops for this request).
//            message_delta (final event, server-side fallback serving model entries).
// Unknown type/reason values: ignored per spec.

describe('translateMessageStream: input_transformations (thinking drop_block)', () => {
  beforeEach(() => {
    _resetWarnCountForTest();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('emits console.warn when message_start carries thinking_dropped with prefix_binding_mismatch', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Real wire shape: type:'thinking_dropped', path:'messages.1.content.0', reason:'prefix_binding_mismatch'
    const events: RawMessageStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_test_drop',
          type: 'message',
          role: 'assistant',
          model: 'claude-fable-5-1',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...baseUsage() },
          input_transformations: [
            { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' },
          ],
        },
      } as unknown as RawMessageStreamEvent,
      textBlockStart(0),
      textDelta(0, 'Answer without prior reasoning'),
      blockStop(0),
      messageDelta('end_turn'),
      messageStop(),
    ];

    await collect(translateMessageStream(fromArray(events), { sessionId: SESSION_ID }));

    expect(warnSpy).toHaveBeenCalledOnce();
    const msg: string = warnSpy.mock.calls[0]![0] as string;
    // Must mention drop_block and the count
    expect(msg).toContain('drop_block');
    expect(msg).toContain('1 thinking block');
    // Must mention 'omitted' — accurate, avoids certainty about what happens next
    expect(msg).toContain('omitted');
    // Must mention reason
    expect(msg).toContain('prefix_binding_mismatch');
    // Must NOT claim drops are always prefix-related (reason is shown, not assumed)
    // Must NOT claim reasoning is regenerated or not lost (unknown)
    expect(msg).not.toContain('regenerated');
    expect(msg).not.toContain('not lost');
    expect(msg).not.toContain('cache stamp');
    // Must NOT log path values (structural internal metadata, unvalidated)
    expect(msg).not.toContain('messages.1.content.0');
    // Must NOT contain thinking text or signature
    expect(msg).not.toContain('thinking_delta');
    expect(msg).not.toContain('signature');
  });

  it('warns for model_binding_mismatch (dropped due to model switch, not prefix)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const events: RawMessageStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_model_mismatch',
          type: 'message',
          role: 'assistant',
          model: 'claude-fable-5-1',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...baseUsage() },
          input_transformations: [
            { type: 'thinking_dropped', path: 'messages.3.content.0', reason: 'model_binding_mismatch' },
          ],
        },
      } as unknown as RawMessageStreamEvent,
      textBlockStart(0),
      textDelta(0, 'ok'),
      blockStop(0),
      messageDelta('end_turn'),
      messageStop(),
    ];

    await collect(translateMessageStream(fromArray(events), { sessionId: SESSION_ID }));

    expect(warnSpy).toHaveBeenCalledOnce();
    const msg: string = warnSpy.mock.calls[0]![0] as string;
    expect(msg).toContain('model_binding_mismatch');
    // Must NOT claim "prefix" — this is a model-switch drop, not a prefix edit
    expect(msg).not.toContain('prefix mismatch');
  });

  it('warns for organization_binding_mismatch (block from different account)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const events: RawMessageStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_org_mismatch',
          type: 'message',
          role: 'assistant',
          model: 'claude-fable-5-1',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...baseUsage() },
          input_transformations: [
            { type: 'thinking_dropped', path: 'messages.2.content.0', reason: 'organization_binding_mismatch' },
          ],
        },
      } as unknown as RawMessageStreamEvent,
      textBlockStart(0),
      textDelta(0, 'ok'),
      blockStop(0),
      messageDelta('end_turn'),
      messageStop(),
    ];

    await collect(translateMessageStream(fromArray(events), { sessionId: SESSION_ID }));

    expect(warnSpy).toHaveBeenCalledOnce();
    const msg: string = warnSpy.mock.calls[0]![0] as string;
    expect(msg).toContain('organization_binding_mismatch');
  });

  it('counts multiple dropped blocks with mixed known reasons in one warn', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const events: RawMessageStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_multi',
          type: 'message',
          role: 'assistant',
          model: 'claude-fable-5-1',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...baseUsage() },
          input_transformations: [
            { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' },
            { type: 'thinking_dropped', path: 'messages.3.content.0', reason: 'model_binding_mismatch' },
          ],
        },
      } as unknown as RawMessageStreamEvent,
      textBlockStart(0),
      textDelta(0, 'ok'),
      blockStop(0),
      messageDelta('end_turn'),
      messageStop(),
    ];

    await collect(translateMessageStream(fromArray(events), { sessionId: SESSION_ID }));

    expect(warnSpy).toHaveBeenCalledOnce();
    const msg: string = warnSpy.mock.calls[0]![0] as string;
    expect(msg).toContain('2 thinking block');
  });

  it('does NOT warn for thinking_mismatch_allowed (block NOT dropped — older account, allowed through)', async () => {
    // 'thinking_mismatch_allowed' means the block failed the prefix check but
    // was NOT removed (older account, no enforcement). The model still read it.
    // Per spec: this is NOT a drop and must not produce a warning.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const events: RawMessageStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_mismatch_allowed',
          type: 'message',
          role: 'assistant',
          model: 'claude-fable-5-1',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...baseUsage() },
          input_transformations: [
            { type: 'thinking_mismatch_allowed', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' },
          ],
        },
      } as unknown as RawMessageStreamEvent,
      textBlockStart(0),
      textDelta(0, 'ok'),
      blockStop(0),
      messageDelta('end_turn'),
      messageStop(),
    ];

    await collect(translateMessageStream(fromArray(events), { sessionId: SESSION_ID }));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn for unknown type values (forward-compat: ignore unrecognised types)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const events: RawMessageStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_unknown_type',
          type: 'message',
          role: 'assistant',
          model: 'claude-fable-5-1',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...baseUsage() },
          input_transformations: [
            // Hypothetical future type — must be silently ignored
            { type: 'thinking_future_type', path: 'messages.1.content.0', reason: 'some_reason' },
          ],
        },
      } as unknown as RawMessageStreamEvent,
      textBlockStart(0),
      textDelta(0, 'ok'),
      blockStop(0),
      messageDelta('end_turn'),
      messageStop(),
    ];

    await collect(translateMessageStream(fromArray(events), { sessionId: SESSION_ID }));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns for thinking_dropped even with an unknown reason (counted as unknown_reason)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const events: RawMessageStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_unknown_reason',
          type: 'message',
          role: 'assistant',
          model: 'claude-fable-5-1',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...baseUsage() },
          input_transformations: [
            { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'future_unknown_reason' },
          ],
        },
      } as unknown as RawMessageStreamEvent,
      textBlockStart(0),
      textDelta(0, 'ok'),
      blockStop(0),
      messageDelta('end_turn'),
      messageStop(),
    ];

    await collect(translateMessageStream(fromArray(events), { sessionId: SESSION_ID }));
    // A drop is a drop even with an unknown reason — must still warn
    expect(warnSpy).toHaveBeenCalledOnce();
    const msg: string = warnSpy.mock.calls[0]![0] as string;
    expect(msg).toContain('unknown_reason');
    // Must NOT log the raw unknown reason string (unvalidated)
    expect(msg).not.toContain('future_unknown_reason');
  });

  it('does NOT warn when input_transformations is absent (normal non-Fable stream)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const events: RawMessageStreamEvent[] = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, 'Normal text'),
      blockStop(0),
      messageDelta('end_turn'),
      messageStop(),
    ];

    await collect(translateMessageStream(fromArray(events), { sessionId: SESSION_ID }));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('does NOT warn when input_transformations is an empty array', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const events: RawMessageStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_empty',
          type: 'message',
          role: 'assistant',
          model: 'claude-fable-5-1',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...baseUsage() },
          input_transformations: [],
        },
      } as unknown as RawMessageStreamEvent,
      textBlockStart(0),
      textDelta(0, 'ok'),
      blockStop(0),
      messageDelta('end_turn'),
      messageStop(),
    ];

    await collect(translateMessageStream(fromArray(events), { sessionId: SESSION_ID }));
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warn cap: stops warning after MAX_WARN_COUNT=10, final warn includes cap note', async () => {
    // Reset is handled by beforeEach. Run 11 streams with dropped blocks;
    // only 10 warns should fire — the 11th is silently suppressed.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const makeDropStream = () => [
      {
        type: 'message_start',
        message: {
          id: 'msg_cap',
          type: 'message',
          role: 'assistant',
          model: 'claude-fable-5-1',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...baseUsage() },
          input_transformations: [
            { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' },
          ],
        },
      } as unknown as RawMessageStreamEvent,
      textBlockStart(0),
      textDelta(0, 'x'),
      blockStop(0),
      messageDelta('end_turn'),
      messageStop(),
    ];

    for (let i = 0; i < 11; i++) {
      await collect(translateMessageStream(fromArray(makeDropStream()), { sessionId: SESSION_ID }));
    }

    // Exactly 10 warns, not 11
    expect(warnSpy).toHaveBeenCalledTimes(10);
    // The 10th (last) warn should include the cap note
    const lastMsg: string = warnSpy.mock.calls[9]![0] as string;
    expect(lastMsg).toContain('further drops will not be logged');
  });

  it('also warns when message_delta carries input_transformations (server-side fallback path)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Server-side fallback: message_start has no drops; message_delta carries them.
    const events: RawMessageStreamEvent[] = [
      messageStart(),
      textBlockStart(0),
      textDelta(0, 'fallback response'),
      blockStop(0),
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 5, cache_creation_input_tokens: null, cache_read_input_tokens: null, input_tokens: null, server_tool_use: null },
        input_transformations: [
          { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'model_binding_mismatch' },
        ],
      } as unknown as RawMessageStreamEvent,
      messageStop(),
    ];

    await collect(translateMessageStream(fromArray(events), { sessionId: SESSION_ID }));

    expect(warnSpy).toHaveBeenCalledOnce();
    const msg: string = warnSpy.mock.calls[0]![0] as string;
    expect(msg).toContain('message_delta');
    expect(msg).toContain('model_binding_mismatch');
  });

  it('still yields a valid turn-result after a drop_block warn (stream continues normally)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const events: RawMessageStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_drop_continue',
          type: 'message',
          role: 'assistant',
          model: 'claude-fable-5-1',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...baseUsage() },
          input_transformations: [
            { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' },
          ],
        },
      } as unknown as RawMessageStreamEvent,
      textBlockStart(0),
      textDelta(0, 'Answer after drop'),
      blockStop(0),
      messageDelta('end_turn'),
      messageStop(),
    ];

    const out = await collect(translateMessageStream(fromArray(events), { sessionId: SESSION_ID }));
    const last = out[out.length - 1];
    if (!last || last.kind !== 'turn-result') throw new Error('expected turn-result');
    expect(last.result.text).toBe('Answer after drop');
    expect(last.result.stopReason).toBe('end_turn');
  });

  it('malformed entry (non-object, null, missing fields) is safely skipped without throwing', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const events: RawMessageStreamEvent[] = [
      {
        type: 'message_start',
        message: {
          id: 'msg_malformed',
          type: 'message',
          role: 'assistant',
          model: 'claude-fable-5-1',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { ...baseUsage() },
          // Mix of malformed entries and a real drop
          input_transformations: [
            null,
            'string entry',
            42,
            undefined,
            { type: 'thinking_dropped', path: 'messages.1.content.0', reason: 'prefix_binding_mismatch' },
          ],
        },
      } as unknown as RawMessageStreamEvent,
      textBlockStart(0),
      textDelta(0, 'ok'),
      blockStop(0),
      messageDelta('end_turn'),
      messageStop(),
    ];

    // Must not throw; must warn once for the real drop
    const out = await collect(translateMessageStream(fromArray(events), { sessionId: SESSION_ID }));
    expect(warnSpy).toHaveBeenCalledOnce();
    const last = out[out.length - 1];
    expect(last?.kind).toBe('turn-result');
  });
});
