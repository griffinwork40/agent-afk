import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { SegmentTracker, type SegmentStep } from './session-ledger-segments.js';
import { SessionLedgerWriter, readLedger } from './session-ledger.js';
import type { OutputEvent } from './types/session-types.js';

const text = (content: string): OutputEvent => ({ type: 'chunk', chunk: { type: 'content', content } });
const thinking = (content: string): OutputEvent => ({ type: 'chunk', chunk: { type: 'thinking', content } });
const tool = (pending = false): OutputEvent => ({
  type: 'chunk',
  chunk: { type: 'tool_use_detail', toolUseId: 't1', toolName: 'bash', toolInput: 'ls', ...(pending ? { pending: true as const } : {}) },
} as OutputEvent);
const message = (content: string): OutputEvent => ({ type: 'message', message: { role: 'assistant', content, timestamp: new Date() } });
const done = { type: 'done' } as OutputEvent;

function records(steps: SegmentStep[]) {
  return steps.flatMap((s) => (s.op === 'record' ? [s.payload] : []));
}
function run(events: OutputEvent[], tracker = new SegmentTracker()) {
  return records(events.flatMap((e) => tracker.observe(e)));
}

describe('SegmentTracker', () => {
  it('orders assistant{0} -> tool seal -> assistant{1} (anthropic-direct: deltas, no tool-round message)', () => {
    const tracker = new SegmentTracker();
    expect(records([...tracker.observe(text('ALP')), ...tracker.observe(text('HA'))])).toEqual([]);
    expect(records(tracker.observe(tool()))).toEqual([{ kind: 'assistant', seg: 0, text: 'ALPHA' }]);
    tracker.observe(text('OMEGA'));
    expect(records(tracker.observe(message('OMEGA')))).toEqual([{ kind: 'assistant', seg: 1, text: 'OMEGA' }]);
    expect(records(tracker.observe(done))).toEqual([]);
  });

  it('a pending tool chunk does not seal; wind-down (pending chunk then message) records once', () => {
    expect(run([text('partial'), tool(true)])).toEqual([]);
    expect(run([text('wind'), tool(true), message('wind down answer'), done]))
      .toEqual([{ kind: 'assistant', seg: 0, text: 'wind down answer' }]);
  });

  it('the assistant message is authoritative (truncation notice appended)', () => {
    expect(run([text('abc'), message('abc\n\n… [notice]'), done]))
      .toEqual([{ kind: 'assistant', seg: 0, text: 'abc\n\n… [notice]' }]);
  });

  it('openai-compatible turn shape: a textless final round re-emitting pre-tool text records once', () => {
    expect(run([text('before tool'), tool(), message('before tool'), done]))
      .toEqual([{ kind: 'assistant', seg: 0, text: 'before tool' }]);
    expect(run([text('before'), tool(), text('after'), message('after'), done]))
      .toEqual([{ kind: 'assistant', seg: 0, text: 'before' }, { kind: 'assistant', seg: 1, text: 'after' }]);
  });

  it('done and error flush open text', () => {
    expect(run([text('cut off'), done])).toEqual([{ kind: 'assistant', seg: 0, text: 'cut off' }]);
    expect(run([text('cut'), { type: 'error', error: 'boom' } as unknown as OutputEvent]))
      .toEqual([{ kind: 'assistant', seg: 0, text: 'cut' }]);
  });

  it('coalesces thinking deltas into one record sealed by the first text delta', () => {
    expect(run([thinking('a'), thinking('b'), thinking('c'), text('answer'), message('answer')]))
      .toEqual([{ kind: 'thinking', seg: 0, text: 'abc' }, { kind: 'assistant', seg: 1, text: 'answer' }]);
  });

  it('keeps assistant text whole far past the old 8k cap', () => {
    const long = 'x'.repeat(20_000);
    expect(run([text(long), message(long)])[0]).toEqual({ kind: 'assistant', seg: 0, text: long });
  });

  it('beginTurn flushes an aborted turn and resets numbering', () => {
    const tracker = new SegmentTracker();
    run([text('one'), tool(), text('interrupted')], tracker);
    expect(records(tracker.beginTurn())).toEqual([{ kind: 'assistant', seg: 1, text: 'interrupted' }]);
    expect(run([text('fresh'), done], tracker)).toEqual([{ kind: 'assistant', seg: 0, text: 'fresh' }]);
  });

  it('emits contiguous delta offsets and resets the buffer on stream_retry', () => {
    const tracker = new SegmentTracker();
    expect(tracker.observe(text('ab'))).toEqual([{ op: 'delta', seg: 0, part: 'text', offset: 0, text: 'ab' }]);
    expect(tracker.observe(text('cd'))).toEqual([{ op: 'delta', seg: 0, part: 'text', offset: 2, text: 'cd' }]);
    expect(tracker.observe({ type: 'stream_retry' } as OutputEvent)).toEqual([{ op: 'reset', seg: 0, part: 'text' }]);
    expect(tracker.openSegments()).toEqual([{ seg: 0, part: 'text', text: '' }]);
  });
});

describe('SessionLedgerWriter segment routing', () => {
  beforeEach(() => { vi.stubEnv('AFK_STATE_DIR', fs.mkdtempSync(path.join(os.tmpdir(), 'afk-segments-'))); });
  afterEach(() => vi.unstubAllEnvs());

  it('writes pre-tool text before the tool card and never double-records', async () => {
    const id = `segments-${Date.now()}`;
    const writer = new SessionLedgerWriter(id);
    writer.recordUser('go');
    for (const e of [text('ALPHA'), tool(true), tool(), text('OMEGA'), message('OMEGA'), done]) writer.recordEvent(e);
    await writer.close('close');
    const out: string[] = [];
    for await (const r of readLedger(id)) out.push(r.kind === 'assistant' ? `assistant${r.seg}:${r.text}` : r.kind);
    expect(out).toEqual(['user', 'assistant0:ALPHA', 'tool', 'assistant1:OMEGA', 'done', 'closed']);
  });
});
