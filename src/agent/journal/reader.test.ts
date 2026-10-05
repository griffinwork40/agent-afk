import * as fs from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { getSessionJournalPath, getSessionLedgerDir, getSubagentJournalsDir } from '../../paths.js';
import { assistant, toolResult, useTmpAfkHome, user } from './__test-utils__/helpers.js';
import {
  findToolResult,
  foldJournal,
  journalExists,
  listSubagentJournals,
  loadJournalFold,
  loadJournalMessages,
  readJournalRecords,
} from './reader.js';
import type { JournalRecord } from './types.js';
import { createMessageJournal } from './writer.js';

useTmpAfkHome();
afterEach(() => vi.unstubAllEnvs());

const ap = (index: number, text: string, ts = 1): JournalRecord => ({ v: 1, ts, kind: 'append', index, message: user(text) });
const tr = (length: number): JournalRecord => ({ v: 1, ts: 1, kind: 'truncate', length });
const txt = (ms: ReturnType<typeof foldJournal>['messages']) => ms.map((m) => (m.content[0] as { text: string }).text);

describe('foldJournal', () => {
  it('applies appends and truncates; marks and metas are inert', () => {
    const f = foldJournal([
      { v: 1, ts: 1, kind: 'meta', sessionId: 's', writerId: 'w1' },
      ap(0, 'a'),
      ap(1, 'b'),
      { v: 1, ts: 1, kind: 'mark', label: 'compact' },
      tr(0),
      ap(0, 'c'),
      { v: 1, ts: 2, kind: 'meta', sessionId: 's', writerId: 'w2' },
      ap(1, 'd'),
    ]);
    expect(txt(f.messages)).toEqual(['c', 'd']);
    expect(f.meta?.writerId).toBe('w1');
    expect(f.anomalies).toEqual([]);
  });

  it('tolerates index gaps and overlaps from concurrent writers', () => {
    const f = foldJournal([ap(0, 'a'), ap(1, 'b'), ap(1, 'b2'), ap(5, 'e'), tr(10)]);
    expect(txt(f.messages)).toEqual(['a', 'b2', 'e']);
    expect(f.anomalies).toHaveLength(3);
  });

  it('is pure (does not alias or mutate its input list)', () => {
    const recs = [ap(0, 'a'), tr(0)];
    foldJournal(recs);
    expect(recs).toHaveLength(2);
  });
});

describe('file readers', () => {
  it('skips malformed lines and reports them as an anomaly', () => {
    fs.mkdirSync(getSessionLedgerDir('bad'), { recursive: true });
    const good = JSON.stringify(ap(0, 'a'));
    const wrongVersion = JSON.stringify({ ...ap(1, 'z'), v: 2 });
    const badShape = JSON.stringify({ v: 1, ts: 1, kind: 'append', index: -1, message: user('q') });
    fs.writeFileSync(getSessionJournalPath('bad'), `${good}\nnot json\n${wrongVersion}\n${badShape}\n\n{"v":1,"ts":1,"kind":"nope"}\n`);
    expect(readJournalRecords('bad')).toHaveLength(1);
    const fold = loadJournalFold('bad')!;
    expect(txt(fold.messages)).toEqual(['a']);
    expect(fold.anomalies[0]).toBe('4 malformed line(s) skipped');
  });

  it('treats absent, unsafe, and empty journals as nothing', () => {
    expect(journalExists('nope')).toBe(false);
    expect(journalExists('../x')).toBe(false);
    expect(readJournalRecords('../x')).toEqual([]);
    expect(loadJournalMessages('nope')).toBeNull();
    expect(listSubagentJournals('../x')).toEqual([]);
    expect(findToolResult('nope', 'tu')).toBeNull();
    fs.mkdirSync(getSessionLedgerDir('empty'), { recursive: true });
    fs.writeFileSync(getSessionJournalPath('empty'), '');
    expect(journalExists('empty')).toBe(true);
    expect(loadJournalMessages('empty')).toBeNull();
  });

  it('loadJournalMessages returns null when disabled or folded empty', async () => {
    const j = createMessageJournal({ getSessionId: () => 'fold0' });
    j.append(0, user('a'));
    j.truncate(0, 'clear');
    await j.flush();
    expect(loadJournalMessages('fold0')).toBeNull();
    const k = createMessageJournal({ getSessionId: () => 'dis' });
    k.append(0, user('a'));
    await k.flush();
    expect(loadJournalMessages('dis')).toHaveLength(1);
    vi.stubEnv('AFK_MESSAGE_JOURNAL_DISABLED', '1');
    expect(loadJournalMessages('dis')).toBeNull();
  });
});

describe('subagent journals + findToolResult', () => {
  it('finds results across top-level and subagent journals, including compacted ones', async () => {
    const parent = createMessageJournal({ getSessionId: () => 'sess' });
    parent.append(0, user('go'));
    parent.append(1, toolResult('tu-top', 'top output'));
    parent.truncate(0, 'compact'); // compacted away: still findable
    parent.append(0, user('summary'));
    const child = parent.forSubagent('child-a');
    child.append(0, toolResult('tu-child', 'child output'));
    const other = parent.forSubagent('child-b');
    other.append(0, user('x'));
    await Promise.all([parent.flush(), child.flush(), other.flush()]);
    fs.writeFileSync(`${getSubagentJournalsDir('sess')}/notes.txt`, 'ignored');

    expect(listSubagentJournals('sess')).toEqual(['child-a', 'child-b']);
    expect(journalExists('sess', { subagentId: 'child-a' })).toBe(true);
    expect(loadJournalMessages('sess', { subagentId: 'child-a' })).toHaveLength(1);

    const top = findToolResult('sess', 'tu-top')!;
    expect(top.subagentId).toBeUndefined();
    expect(top.block.content).toEqual([{ type: 'text', text: 'top output' }]);
    const kid = findToolResult('sess', 'tu-child')!;
    expect(kid).toEqual({ subagentId: 'child-a', block: toolResult('tu-child', 'child output').content[0] });
    expect(findToolResult('sess', 'missing')).toBeNull();
  });

  it('newest record wins when a tool_use id appears more than once', () => {
    fs.mkdirSync(getSubagentJournalsDir('dup'), { recursive: true });
    const rec = (text: string, ts: number, index = 0): JournalRecord => ({ v: 1, ts, kind: 'append', index, message: toolResult('tu', text) });
    fs.writeFileSync(getSessionJournalPath('dup'), [rec('old', 1), rec('mid', 5, 1)].map((r) => JSON.stringify(r)).join('\n') + '\n');
    fs.writeFileSync(`${getSubagentJournalsDir('dup')}/k.jsonl`, JSON.stringify(rec('child-old', 3)) + '\n');
    expect(findToolResult('dup', 'tu')!.block.content).toEqual([{ type: 'text', text: 'mid' }]);
    fs.writeFileSync(`${getSubagentJournalsDir('dup')}/k.jsonl`, JSON.stringify(rec('child-new', 9)) + '\n');
    expect(findToolResult('dup', 'tu')).toMatchObject({ subagentId: 'k', block: { content: [{ text: 'child-new' }] } });
  });

  it('ignores assistant text when scanning', async () => {
    const j = createMessageJournal({ getSessionId: () => 'plain' });
    j.append(0, assistant('tu-1'));
    await j.flush();
    expect(findToolResult('plain', 'tu-1')).toBeNull();
  });
});
