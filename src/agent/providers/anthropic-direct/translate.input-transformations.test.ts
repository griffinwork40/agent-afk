import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RawMessageStreamEvent } from '@anthropic-ai/sdk/resources';
import { translateMessageStream } from './translate.js';
import { _resetNotifiedSessionsForTest } from './input-transformations.js';
import { InMemoryTraceWriter } from '../../trace/writer.js';
import { matchesWhere, parseWhere } from '../../tools/handlers/witness.query.where.js';

const PREFIX = 'prefix_binding_mismatch';
const MODEL = 'model_binding_mismatch';
const ACCOUNT = 'organization_binding_mismatch';
const drop = (reason: unknown) => ({ type: 'thinking_dropped', reason, path: 'never-log-this-path' });

async function* frames(start: unknown, delta: unknown): AsyncIterable<RawMessageStreamEvent> {
  yield {
    type: 'message_start',
    message: { id: 'msg_drop', type: 'message', role: 'assistant', model: 'claude-fable-5-2',
      content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 0 }, input_transformations: start },
  } as unknown as RawMessageStreamEvent;
  yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '', citations: [] } };
  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Still answering' } };
  yield { type: 'content_block_stop', index: 0 };
  yield { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null },
    usage: { output_tokens: 3 }, input_transformations: delta } as unknown as RawMessageStreamEvent;
  yield { type: 'message_stop' };
}

async function run(sessionId: string, start: unknown, delta?: unknown, writer?: InMemoryTraceWriter) {
  const output = [];
  for await (const value of translateMessageStream(frames(start, delta), {
    sessionId, ...(writer ? { traceWriter: writer } : {}),
  })) output.push(value);
  return output;
}

function drops(writer: InMemoryTraceWriter) {
  return writer.events.filter((event) =>
    event.kind === 'session_phase' && event.payload.phase === 'thinking_block_dropped',
  ).map((event) => event.kind === 'session_phase' ? event.payload.metadata : undefined);
}

describe('translateMessageStream: input_transformations', () => {
  beforeEach(() => {
    _resetNotifiedSessionsForTest();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => vi.restoreAllMocks());

  it('notifies once for a session across two streams, but traces reasons on both', async () => {
    const writer = new InMemoryTraceWriter();
    await run('same-session', [drop(PREFIX)], undefined, writer);
    await run('same-session', [drop(MODEL)], undefined, writer);
    expect(console.warn).toHaveBeenCalledOnce();
    expect(drops(writer)).toEqual([
      { droppedCount: 1, source: 'message_start', reason_prefix_binding_mismatch: 1 },
      { droppedCount: 1, source: 'message_start', reason_model_binding_mismatch: 1 },
    ]);
    expect(matchesWhere(writer.events[1], parseWhere({
      'payload.metadata.reason_model_binding_mismatch': 1,
    }))).toBe(true);
  });

  it('gives two sessions their own notices', async () => {
    await run('one', [drop(PREFIX)]);
    await run('two', [drop(PREFIX)]);
    expect(console.warn).toHaveBeenCalledTimes(2);
  });

  it('does not silence sessions after ten notices', async () => {
    const writer = new InMemoryTraceWriter();
    for (let i = 0; i < 12; i++) await run(`session-${i}`, [drop(PREFIX)], undefined, writer);
    expect(console.warn).toHaveBeenCalledTimes(12);
    expect(drops(writer)).toHaveLength(12);
  });

  it('bounds notice retention with FIFO eviction rather than a global warning cap', async () => {
    for (let i = 0; i < 4097; i++) await run(`session-${i}`, [drop(PREFIX)]);
    await run('session-4096', [drop(PREFIX)]);
    expect(console.warn).toHaveBeenCalledTimes(4097);
    await run('session-0', [drop(PREFIX)]);
    expect(console.warn).toHaveBeenCalledTimes(4098);
  });

  it('traces both frames with identical tally shape even on the already-warned branch', async () => {
    const writer = new InMemoryTraceWriter();
    await run('both-frames', [drop(PREFIX)], [drop(MODEL), drop(MODEL), drop(ACCOUNT)], writer);
    expect(console.warn).toHaveBeenCalledOnce();
    expect(drops(writer)).toEqual([
      { droppedCount: 1, source: 'message_start', reason_prefix_binding_mismatch: 1 },
      { droppedCount: 3, source: 'message_delta', reason_model_binding_mismatch: 2,
        reason_organization_binding_mismatch: 1 },
    ]);
  });

  it('uses plain words and searchable codes for mixed known and unknown reasons', async () => {
    const writer = new InMemoryTraceWriter();
    await run('mixed', [drop(PREFIX), drop(PREFIX), drop(MODEL), drop(ACCOUNT), drop('future_reason')], undefined, writer);
    const line = vi.mocked(console.warn).mock.calls[0]?.[0] as string;
    expect(line).toBe('[afk] Earlier reasoning from 5 thinking block(s) was not available to the model ' +
      'on this request because the request context changed (system prompt, tools, or earlier messages) ' +
      '[2 prefix_binding_mismatch]; the model changed [1 model_binding_mismatch]; ' +
      'the account changed [1 organization_binding_mismatch]; reason not recognised [1 future_reason]. ' +
      'AFK continued normally and no action is needed. Further omissions in this session are recorded in the trace only.');
    expect(line).not.toContain('never-log-this-path');
    expect(line).not.toContain('\n');
    expect(drops(writer)).toEqual([{ droppedCount: 5, source: 'message_start',
      reason_prefix_binding_mismatch: 2, reason_model_binding_mismatch: 1,
      reason_organization_binding_mismatch: 1, reason_future_reason: 1 }]);
  });

  it('supports message_delta-only fallback and continues producing a normal turn result', async () => {
    const writer = new InMemoryTraceWriter();
    const output = await run('fallback', undefined, [drop(MODEL)], writer);
    const result = output[output.length - 1];
    expect(console.warn).toHaveBeenCalledOnce();
    expect(drops(writer)).toEqual([{ droppedCount: 1, source: 'message_delta', reason_model_binding_mismatch: 1 }]);
    expect(result).toMatchObject({ kind: 'turn-result', result: { text: 'Still answering', stopReason: 'end_turn' } });
  });

  it.each([undefined, [], null, 'bad', [null, 42, 'bad', {}], [
    { type: 'thinking_mismatch_allowed', reason: PREFIX },
    { type: 'future_type', reason: PREFIX },
  ]])('ignores absent, malformed and non-drop transformations: %j', async (transformations) => {
    const writer = new InMemoryTraceWriter();
    await run('no-drops', transformations, transformations, writer);
    expect(console.warn).not.toHaveBeenCalled();
    expect(drops(writer)).toEqual([]);
  });

  it('treats prototype-property names as unknown reasons, not inherited descriptions', async () => {
    const writer = new InMemoryTraceWriter();
    await run('prototype', [drop('constructor')], undefined, writer);
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining(
      'reason not recognised [1 constructor]',
    ));
    expect(drops(writer)).toEqual([{ droppedCount: 1, source: 'message_start', reason_constructor: 1 }]);
  });

  it('does not consume the notice for non-drop frames before a delta fallback', async () => {
    const writer = new InMemoryTraceWriter();
    await run('allowed-then-drop', [{ type: 'thinking_mismatch_allowed', reason: PREFIX }], [drop(MODEL)], writer);
    expect(console.warn).toHaveBeenCalledOnce();
    expect(drops(writer)).toEqual([{ droppedCount: 1, source: 'message_delta', reason_model_binding_mismatch: 1 }]);
  });

  it('counts only drops among malformed entries and normalizes unsafe or missing reasons', async () => {
    const writer = new InMemoryTraceWriter();
    await run('unsafe', [null, 42, {}, drop(PREFIX), drop('unsafe\ntext'), drop(undefined)], undefined, writer);
    expect(drops(writer)).toEqual([{ droppedCount: 3, source: 'message_start',
      reason_prefix_binding_mismatch: 1, reason_unknown_reason: 2 }]);
    const line = vi.mocked(console.warn).mock.calls[0]?.[0] as string;
    expect(line).toContain('reason not recognised [2 unknown_reason]');
    expect(line).not.toContain('unsafe');
    expect(line).not.toContain('\n');
  });
});
