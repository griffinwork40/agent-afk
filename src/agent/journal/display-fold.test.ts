import { describe, it, expect } from 'vitest';

import { COMPACT_ACK_TEXT, COMPACT_SUMMARY_HEADER } from '../providers/shared/compaction.js';
import { _testFoldForDisplay, cutAtFork, displaySegments, foldForDisplay, isCompactionPreamble, loadDisplayMessages, messageFingerprint } from './display-fold.js';
import { forkJournal } from './fork.js';
import { foldJournal, readJournalRecords } from './reader.js';
import { JournalSync } from './sync.js';
import type { JournalAdapter, JournalMessage, JournalRecord, JournalTruncateReason } from './types.js';
import { createMessageJournal } from './writer.js';
import { assistant, toolResult, useTmpAfkHome, user } from './__test-utils__/helpers.js';

const V = 1 as const;
let clock = 1_000;
const ap = (index: number, message: JournalMessage, ts = ++clock): JournalRecord => ({ v: V, ts, kind: 'append', index, message });
const tr = (length: number, reason?: JournalTruncateReason, ts = ++clock): JournalRecord => ({
  v: V,
  ts,
  kind: 'truncate',
  length,
  ...(reason ? { reason } : {}),
});
const meta = (sessionId: string, forkedFrom?: { sessionId: string; length: number }, ts = ++clock): JournalRecord => ({
  v: V,
  ts,
  kind: 'meta',
  sessionId,
  writerId: 'w',
  ...(forkedFrom ? { forkedFrom } : {}),
});

const summary = (): JournalMessage => user(`${COMPACT_SUMMARY_HEADER}\n\nearlier stuff happened`);
const ack = (): JournalMessage => assistant(COMPACT_ACK_TEXT);
const toolUse = (id: string): JournalMessage => ({ role: 'assistant', content: [{ type: 'tool_use', id, name: 'bash', input: { command: 'ls' } }] });
const texts = (ms: JournalMessage[]): string[] =>
  ms.map((m) => {
    const b = m.content[0];
    if (!b) return '';
    if (b.type === 'text') return b.text;
    if (b.type === 'tool_use') return `use:${b.id}`;
    if (b.type === 'tool_result') return `result:${b.content[0]?.type === 'text' ? b.content[0].text : ''}`;
    return b.type;
  });

describe('isCompactionPreamble / messageFingerprint', () => {
  it('recognizes the summary and ack, nothing else', () => {
    expect(isCompactionPreamble(summary())).toBe(true);
    expect(isCompactionPreamble(ack())).toBe(true);
    expect(isCompactionPreamble(user('hello'))).toBe(false);
    expect(isCompactionPreamble(assistant('Acknowledged.'))).toBe(false);
  });

  it('keys tool_result by id only so a placeholder matches its original', () => {
    expect(messageFingerprint(toolResult('t1', 'real output'))).toBe(messageFingerprint(toolResult('t1', '[tool result cleared to reclaim context — was 9 bytes]')));
    expect(messageFingerprint(toolResult('t1', 'x'))).not.toBe(messageFingerprint(toolResult('t2', 'x')));
  });

  it('ignores thinking blocks (dropped by provider switches)', () => {
    const withThinking: JournalMessage = { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'hi' }] };
    expect(messageFingerprint(withThinking)).toBe(messageFingerprint(assistant('hi')));
  });
});

describe('foldForDisplay', () => {
  it('equals the model fold for a plain append-only journal', () => {
    const recs = [meta('s'), ap(0, user('a')), ap(1, assistant('b')), ap(2, user('c'))];
    expect(texts(foldForDisplay([recs]))).toEqual(['a', 'b', 'c']);
  });

  it('keeps compaction-displaced history, hides the preamble, and does not duplicate the kept tail', () => {
    const recs = [
      ap(0, user('q1')), ap(1, assistant('a1')), ap(2, user('q2')), ap(3, assistant('a2')),
      // compaction: summary + ack replace q1/a1; q2/a2 are the kept tail
      tr(0, 'compact'), ap(0, summary()), ap(1, ack()), ap(2, user('q2')), ap(3, assistant('a2')),
      ap(4, user('q3')),
    ];
    expect(texts(foldJournal(recs).messages)).toEqual([`${COMPACT_SUMMARY_HEADER}\n\nearlier stuff happened`, COMPACT_ACK_TEXT, 'q2', 'a2', 'q3']);
    expect(texts(foldForDisplay([recs]))).toEqual(['q1', 'a1', 'q2', 'a2', 'q3']);
  });

  it('keeps the ORIGINAL tool output over a microcompaction placeholder', () => {
    const recs = [
      ap(0, user('go')), ap(1, toolUse('t1')), ap(2, toolResult('t1', 'full output')), ap(3, assistant('done')),
      tr(2, 'compact'), ap(2, toolResult('t1', '[tool result cleared to reclaim context — was 11 bytes]')), ap(3, assistant('done')),
    ];
    expect(texts(foldForDisplay([recs]))).toEqual(['go', 'use:t1', 'result:full output', 'done']);
  });

  it('drops rewound messages', () => {
    const recs = [ap(0, user('q1')), ap(1, assistant('a1')), ap(2, user('oops')), ap(3, assistant('a2')), tr(2, 'rewind'), ap(2, user('q2'))];
    expect(texts(foldForDisplay([recs]))).toEqual(['q1', 'a1', 'q2']);
  });

  it('starts over after /clear, including compaction-archived rows', () => {
    const recs = [ap(0, user('old')), tr(0, 'compact'), ap(0, summary()), ap(1, ack()), tr(0, 'clear'), ap(0, user('fresh'))];
    expect(texts(foldForDisplay([recs]))).toEqual(['fresh']);
  });

  it('gives a genuinely new identical message its own row once the re-append phase is over', () => {
    const recs = [ap(0, user('continue')), ap(1, assistant('a1')), tr(0, 'compact'), ap(0, summary()), ap(1, ack()), ap(2, assistant('a2')), ap(3, user('continue'))];
    expect(texts(foldForDisplay([recs]))).toEqual(['continue', 'a1', 'a2', 'continue']);
  });

  // M1: newest-candidate match — a rewind after compaction keeps the ORIGINAL
  // row for a message that appeared twice, not the most-recently displaced one.
  it('M1: softTruncate matches the newest pending candidate so a later rewind keeps the original row', () => {
    // History: continue(0) → a1(1) → continue(2) → a2(3).
    // Compact to 0: summary, ack, continue(2), a2(3) re-appended.
    // continue(2) pops the NEWEST pending candidate (row2 = the second continue),
    // leaving row0 (the original first continue) untouched.
    // Rewind to 2: row2 (second continue) and row3 (a2) are nulled.
    // Display: the original continue(row0) and a1(row1) survive.
    const recs = [
      ap(0, user('continue')), ap(1, assistant('a1')), ap(2, user('continue')), ap(3, assistant('a2')),
      tr(0, 'compact'),
      ap(0, summary()), ap(1, ack()), ap(2, user('continue')), ap(3, assistant('a2')),
      tr(2, 'rewind'),
    ];
    expect(texts(foldForDisplay([recs]))).toEqual(['continue', 'a1']);
  });

  // M2: mid-history insertion — a resync that inserts a tool result before the
  // kept tail must NOT duplicate q2/a2 (the orphan miss should not clear pending).
  it('M2: an orphan insertion within the pending window does not duplicate the subsequent re-append tail', () => {
    // History: q1(0) → use(X)(1) → q2(2) → a2(3).
    // Resync to 2: result(X) inserted at index 2, then q2(3) and a2(4) re-appended.
    // result(X) misses pending (it is an orphan — no prior row for it), but its
    // model index (2) is within the pending window (cap=3), so pending is kept.
    // q2 and a2 then match their original pending rows; no duplicates.
    const recs = [
      ap(0, user('q1')), ap(1, toolUse('t1')), ap(2, user('q2')), ap(3, assistant('a2')),
      tr(2, 'resync'),
      ap(2, toolResult('t1', 'result output')), ap(3, user('q2')), ap(4, assistant('a2')),
    ];
    expect(texts(foldForDisplay([recs]))).toEqual(['q1', 'use:t1', 'q2', 'a2', 'result:result output']);
  });

  it('treats an append at index < length as a soft overwrite (re-append matches)', () => {
    const recs = [ap(0, user('a')), ap(1, assistant('b')), ap(1, assistant('b')), ap(2, user('c'))];
    expect(texts(foldForDisplay([recs]))).toEqual(['a', 'b', 'c']);
  });

  it('matches a fork segment back onto the parent rows', () => {
    const parent = [ap(0, user('q1')), ap(1, assistant('a1')), tr(0, 'compact'), ap(0, summary()), ap(1, ack())];
    const fork = [meta('child', { sessionId: 'parent', length: 2 }), ap(0, summary()), ap(1, ack()), ap(2, user('q2'))];
    expect(texts(foldForDisplay([parent, fork]))).toEqual(['q1', 'a1', 'q2']);
  });

  // S1: soft-truncate reasons — compact, resync, repair, provider_switch,
  // and a bare truncate (no reason) — must all keep displaced rows in the display.
  it.each<[JournalTruncateReason | undefined, string]>([
    ['compact', 'compact'],
    ['resync', 'resync'],
    ['repair', 'repair'],
    ['provider_switch', 'provider_switch'],
    [undefined, 'no-reason (bare truncate)'],
  ])('soft-truncate reason %s keeps displaced rows and matches re-appended tail', (reason, _label) => {
    // History: q1(0) → a1(1) → q2(2) → a2(3).
    // Soft-truncate to 2 (any non-hard reason), then re-append q2 and a2.
    // Both re-appended messages should match their original rows, so the display
    // shows all four messages exactly once with no duplicates.
    const recs = [
      ap(0, user('q1')), ap(1, assistant('a1')), ap(2, user('q2')), ap(3, assistant('a2')),
      tr(2, reason),
      ap(2, user('q2')), ap(3, assistant('a2')),
      ap(4, user('q3')),
    ];
    expect(texts(foldForDisplay([recs]))).toEqual(['q1', 'a1', 'q2', 'a2', 'q3']);
  });

  // S2: all-sentinel displacement — when every displaced row is a preamble sentinel (-1),
  // pending stays empty and pendingWindowCap must reset to -1 (invariant: cap === -1 iff
  // pending is empty). The output is identical with or without the guard, so we assert the
  // internal cap directly via _testFoldForDisplay. History: PR #3077.
  it('S2: pendingWindowCap resets to -1 when all displaced rows are preamble sentinels', () => {
    // summary(-1) + ack(-1) are displaced by the compact soft-truncate to 0.
    // Both are sentinels so pending stays empty; the post-loop guard resets cap to -1.
    const recs = [ap(0, summary()), ap(1, ack()), tr(0, 'compact')];
    const { messages, pendingWindowCap } = _testFoldForDisplay(recs);
    expect(messages).toEqual([]);
    expect(pendingWindowCap).toBe(-1);
  });

  // C1: chained compact → preamble → provider_switch → re-append.
  // The compaction preamble pushes -1 entries onto `live` without consuming the
  // pending window from the compact.  A subsequent provider_switch soft-truncate
  // must NOT inherit that stale pending set: otherwise a re-appended message that
  // shares a fingerprint with a pre-compact message would silently match the wrong
  // (old) display row instead of creating its own new row.
  it('C1: compact → preamble → provider_switch → re-append does not match stale compact-phase pending', () => {
    // Phase 1: q1(0) + a1(1) in history.
    // Phase 2: compact to 0 → q1/a1 go to pending (cap=1); preamble summary(-1)+ack(-1) appended.
    // Phase 3: provider_switch to 0 → live=[] again; NEW window, stale pending cleared.
    // Phase 4: re-append user('q1') + assistant('a1') — same text as before but genuinely new
    //   messages after the switch.  They must NOT match the now-cleared stale pending and
    //   must each get their own display rows, so the final display has 4 rows total.
    const recs = [
      ap(0, user('q1')), ap(1, assistant('a1')),
      tr(0, 'compact'),
      ap(0, summary()), ap(1, ack()),
      tr(0, 'provider_switch'),
      ap(0, user('q1')),
      ap(1, assistant('a1')),
      ap(2, user('q2')),
    ];
    // Without the fix: re-appended q1/a1 wrongly consumed the stale pending entries
    // (row0/row1) from the compact phase.  user('q2') at index 2 would then exceed
    // the stale cap (1) and clear pending, making q2 a new row — but q1/a1 are
    // already double-mapped to the original rows, so q2 appears without the
    // duplicated q1/a1 prefixes: ['q1', 'a1', 'q2'].
    // With the fix: provider_switch opens a fresh window with no pending; q1/a1
    // miss → new rows; q2 → new row.  Display: ['q1', 'a1', 'q1', 'a1', 'q2'].
    expect(texts(foldForDisplay([recs]))).toEqual(['q1', 'a1', 'q1', 'a1', 'q2']);
  });
});

describe('displaySegments', () => {
  it('follows forkedFrom and cuts the parent at the fork instant', () => {
    const parent = [meta('p', undefined, 10), ap(0, user('before'), 11), ap(1, user('after-fork'), 30)];
    const child = [meta('c', { sessionId: 'p', length: 1 }, 20), ap(0, user('before'), 20)];
    const store: Record<string, JournalRecord[]> = { p: parent, c: child };
    const segs = displaySegments('c', (id) => store[id] ?? []);
    expect(segs.map((s) => s.length)).toEqual([2, 2]);
    expect(texts(foldForDisplay(segs))).toEqual(['before']);
  });

  it('cutAtFork disambiguates same-millisecond records by fork length', () => {
    const recs = [ap(0, user('a'), 5), ap(1, user('b'), 7), ap(2, user('post-fork'), 7)];
    expect(texts(foldForDisplay([cutAtFork(recs, { ts: 7, length: 2 })]))).toEqual(['a', 'b']);
    expect(cutAtFork(recs, { ts: 6, length: 1 })).toHaveLength(1);
  });

  it('stops at a missing ancestor and at a cycle', () => {
    const a = [meta('a', { sessionId: 'b', length: 0 }, 50), ap(0, user('x'), 50)];
    const b = [meta('b', { sessionId: 'a', length: 0 }, 40)];
    const store: Record<string, JournalRecord[]> = { a, b };
    expect(displaySegments('a', (id) => store[id] ?? []).length).toBe(2);
    expect(displaySegments('lonely', () => [])).toEqual([]);
  });
});

describe('loadDisplayMessages (real writer + JournalSync + forkJournal)', () => {
  useTmpAfkHome();
  const identity: JournalAdapter<JournalMessage> = { toJournal: (m) => m, fromJournalMessages: (ms) => ms };

  it('shows pre-compaction history in a fork of a compacted session', async () => {
    const j = createMessageJournal({ getSessionId: () => 'parent' });
    const sync = new JournalSync(j, identity);
    const q1 = user('q1');
    const a1 = assistant('a1');
    const q2 = user('q2');
    const a2 = assistant('a2');
    let arr: JournalMessage[] = [q1, a1, q2, a2];
    sync.sync(arr);
    // Compaction splice: new summary/ack objects, the kept tail by reference.
    arr = [summary(), ack(), q2, a2];
    sync.sync(arr, { reason: 'compact' });
    await j.flush();

    expect(texts(loadDisplayMessages('parent'))).toEqual(['q1', 'a1', 'q2', 'a2']);

    expect(forkJournal('parent', 'child')).toBe(true);
    const child = createMessageJournal({ getSessionId: () => 'child' });
    const childSync = new JournalSync(child, identity);
    childSync.seed(foldJournal(readJournalRecords('child')).messages);
    // Parent keeps going after the fork; the child must not show it.
    arr.push(user('parent-only'));
    sync.sync(arr);
    await j.close();
    const childArr = foldJournal(readJournalRecords('child')).messages;
    childArr.push(user('child-q3'));
    childSync.sync(childArr);
    await child.close();

    expect(texts(loadDisplayMessages('child'))).toEqual(['q1', 'a1', 'q2', 'a2', 'child-q3']);
  });

  it('is empty for a session with no journal', () => {
    expect(loadDisplayMessages('nope')).toEqual([]);
  });
});
