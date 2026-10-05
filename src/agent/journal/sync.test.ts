import { describe, it, expect } from 'vitest';
import { JournalSync } from './sync.js';
import type { JournalAdapter, JournalMessage, JournalMarkLabel, JournalTruncateReason, MessageJournal } from './types.js';

type Rec = { kind: 'append'; index: number; text: string } | { kind: 'truncate'; length: number; reason?: JournalTruncateReason };

class FakeJournal implements MessageJournal {
  records: Rec[] = [];
  arr: JournalMessage[] = [];
  constructor(initial: JournalMessage[] = []) { this.arr = [...initial]; }
  get length(): number { return this.arr.length; }
  append(index: number, message: JournalMessage): void {
    expect(index).toBe(this.arr.length);
    this.arr.push(message);
    const b = message.content[0];
    this.records.push({ kind: 'append', index, text: b && b.type === 'text' ? b.text : '' });
  }
  truncate(length: number, reason?: JournalTruncateReason): void {
    this.arr.length = length;
    this.records.push({ kind: 'truncate', length, ...(reason ? { reason } : {}) });
  }
  mark(_l: JournalMarkLabel): void {}
  forSubagent(): MessageJournal { return new FakeJournal(); }
  flush(): Promise<void> { return Promise.resolve(); }
  close(): Promise<void> { return Promise.resolve(); }
}

type Msg = { role: 'user' | 'assistant' | 'system'; text: string };
const adapter: JournalAdapter<Msg> = {
  toJournal: (m) => (m.role === 'system' ? null : { role: m.role, content: [{ type: 'text', text: m.text }] }),
  fromJournalMessages: (ms) => ms.map((m) => ({ role: m.role, text: m.content[0]?.type === 'text' ? m.content[0].text : '' })),
};
const u = (text: string): Msg => ({ role: 'user', text });
const a = (text: string): Msg => ({ role: 'assistant', text });
const texts = (j: FakeJournal) => j.arr.map((m) => (m.content[0]?.type === 'text' ? m.content[0].text : ''));

describe('JournalSync', () => {
  it('is a no-op without a journal', () => {
    const s = new JournalSync<Msg>(undefined, adapter);
    expect(s.enabled).toBe(false);
    s.sync([u('x')]);
  });

  it('appends only new messages on successive syncs', () => {
    const j = new FakeJournal();
    const s = new JournalSync(j, adapter);
    const arr: Msg[] = [u('1')];
    s.sync(arr);
    arr.push(a('2'), u('3'));
    s.sync(arr);
    s.sync(arr);
    expect(j.records).toEqual([
      { kind: 'append', index: 0, text: '1' },
      { kind: 'append', index: 1, text: '2' },
      { kind: 'append', index: 2, text: '3' },
    ]);
  });

  it('represents compaction (new objects) as truncate + re-append', () => {
    const j = new FakeJournal();
    const s = new JournalSync(j, adapter);
    const arr: Msg[] = [u('1'), a('2'), u('3')];
    s.sync(arr);
    arr.splice(0, arr.length, u('summary'), a('ok'));
    s.sync(arr, { reason: 'compact' });
    expect(j.records.slice(3)).toEqual([
      { kind: 'truncate', length: 0, reason: 'compact' },
      { kind: 'append', index: 0, text: 'summary' },
      { kind: 'append', index: 1, text: 'ok' },
    ]);
    expect(texts(j)).toEqual(['summary', 'ok']);
  });

  it('represents rewind (shrink) as a truncate at the divergence', () => {
    const j = new FakeJournal();
    const s = new JournalSync(j, adapter);
    const arr: Msg[] = [u('1'), a('2'), u('3'), a('4')];
    s.sync(arr);
    arr.splice(2);
    s.sync(arr);
    expect(j.records.at(-1)).toEqual({ kind: 'truncate', length: 2, reason: 'resync' });
    expect(texts(j)).toEqual(['1', '2']);
  });

  it('represents a mid-array insertion (orphan repair) as truncate + re-append of the tail', () => {
    const j = new FakeJournal();
    const s = new JournalSync(j, adapter);
    const m1 = u('1'), m2 = a('2'), m3 = u('3');
    const arr: Msg[] = [m1, m2, m3];
    s.sync(arr);
    arr.splice(2, 0, u('repair'));
    s.sync(arr, { reason: 'repair' });
    expect(texts(j)).toEqual(['1', '2', 'repair', '3']);
  });

  it('skips null-mapped messages while keeping indices dense', () => {
    const j = new FakeJournal();
    const s = new JournalSync(j, adapter);
    const arr: Msg[] = [{ role: 'system', text: 'sys' }, u('1'), a('2')];
    s.sync(arr);
    arr.splice(2);
    s.sync(arr);
    expect(texts(j)).toEqual(['1']);
    expect(j.records.at(-1)).toEqual({ kind: 'truncate', length: 1, reason: 'resync' });
  });

  it('seed with a matching resume array writes nothing', () => {
    const j = new FakeJournal([{ role: 'user', content: [{ type: 'text', text: '1' }] }]);
    const s = new JournalSync(j, adapter);
    const arr: Msg[] = [u('1')];
    s.seed(arr);
    expect(j.records).toEqual([]);
    arr.push(a('2'));
    s.sync(arr);
    expect(j.records).toEqual([{ kind: 'append', index: 1, text: '2' }]);
  });

  it('a fresh runtime over a non-empty journal (e.g. /clear) resyncs to empty first', () => {
    const j = new FakeJournal([{ role: 'user', content: [{ type: 'text', text: 'old' }] }]);
    const s = new JournalSync(j, adapter);
    s.sync([u('new')]);
    expect(j.records).toEqual([
      { kind: 'truncate', length: 0, reason: 'resync' },
      { kind: 'append', index: 0, text: 'new' },
    ]);
  });

  it('seed with a mismatched array rewrites the journal', () => {
    const j = new FakeJournal([{ role: 'user', content: [{ type: 'text', text: 'a' }] }]);
    const s = new JournalSync(j, adapter);
    s.seed([u('x'), a('y')]);
    expect(texts(j)).toEqual(['x', 'y']);
  });

  it('invalidateFrom re-appends from the index after an in-place edit', () => {
    const j = new FakeJournal();
    const s = new JournalSync(j, adapter);
    const arr: Msg[] = [u('1'), a('2'), u('3'), a('4')];
    s.sync(arr);
    arr[2]!.text = '3-cleared'; // in-place: invisible to the by-reference diff
    s.sync(arr);
    expect(texts(j)).toEqual(['1', '2', '3', '4']);
    s.invalidateFrom(2);
    s.sync(arr, { reason: 'compact' });
    expect(j.records.slice(4)).toEqual([
      { kind: 'truncate', length: 2, reason: 'compact' },
      { kind: 'append', index: 2, text: '3-cleared' },
      { kind: 'append', index: 3, text: '4' },
    ]);
    expect(texts(j)).toEqual(['1', '2', '3-cleared', '4']);
  });

  it('invalidateFrom clamps out-of-range indices and maps skipped messages correctly', () => {
    const j = new FakeJournal();
    const s = new JournalSync(j, adapter);
    const arr: Msg[] = [{ role: 'system', text: 'sys' }, u('1'), a('2')];
    s.sync(arr);
    s.invalidateFrom(99); // past the end: nothing to re-append
    s.sync(arr);
    expect(j.records.filter((r) => r.kind === 'truncate')).toEqual([]);
    s.invalidateFrom(-5); // negative clamps to 0
    s.sync(arr);
    expect(j.records.filter((r) => r.kind === 'truncate')).toEqual([{ kind: 'truncate', length: 0, reason: 'resync' }]);
    expect(texts(j)).toEqual(['1', '2']);
  });

  it('snapshot returns the last-synced conversation in journal form', () => {
    const s0 = new JournalSync<Msg>(undefined, adapter);
    expect(s0.snapshot()).toEqual([]);
    const j = new FakeJournal();
    const s = new JournalSync(j, adapter);
    const arr: Msg[] = [{ role: 'system', text: 'sys' }, u('1'), a('2')];
    s.sync(arr);
    arr.push(u('3')); // not synced yet
    expect(s.snapshot().map((m) => m.content[0])).toEqual([{ type: 'text', text: '1' }, { type: 'text', text: '2' }]);
    s.sync(arr);
    expect(s.snapshot()).toHaveLength(3);
  });
});
