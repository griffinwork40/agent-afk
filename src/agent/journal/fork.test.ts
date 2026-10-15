import * as fs from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { getSessionBlobsDir, getSessionJournalPath, getSessionLedgerDir } from '../../paths.js';
import { assistant, useTmpAfkHome, user } from './__test-utils__/helpers.js';
import { forkJournal } from './fork.js';
import { foldJournal, loadJournalMessages, readJournalRecords } from './reader.js';
import { SPILL_TEXT_BYTES } from './spill.js';
import { createMessageJournal } from './writer.js';

useTmpAfkHome();
afterEach(() => vi.unstubAllEnvs());

describe('forkJournal', () => {
  it('writes meta(forkedFrom) + mark(fork) + the folded conversation, sharing blobs', async () => {
    const big = 'z'.repeat(SPILL_TEXT_BYTES + 1);
    const j = createMessageJournal({ getSessionId: () => 'src', meta: { provider: 'openai', model: 'gpt' } });
    j.append(0, user('a'));
    j.append(1, assistant('dropped'));
    j.truncate(1, 'rewind');
    j.append(1, { role: 'assistant', content: [{ type: 'text', text: big }] });
    await j.close();

    expect(forkJournal('src', 'dst')).toBe(true);
    const recs = readJournalRecords('dst');
    expect(recs.map((r) => r.kind)).toEqual(['meta', 'mark', 'append', 'append']);
    expect(recs[0]).toMatchObject({ sessionId: 'dst', provider: 'openai', model: 'gpt', forkedFrom: { sessionId: 'src', length: 2 } });
    expect(recs[1]).toMatchObject({ label: 'fork' });
    expect(fs.existsSync(getSessionBlobsDir('dst'))).toBe(false); // refs point at src's blobs
    expect(loadJournalMessages('dst')).toEqual(loadJournalMessages('src'));
    expect(loadJournalMessages('dst')![1]).toEqual({ role: 'assistant', content: [{ type: 'text', text: big }] });
    if (process.platform !== 'win32') expect(fs.statSync(getSessionJournalPath('dst')).mode & 0o777).toBe(0o600);

    // The new session's writer resumes at the forked length.
    const d = createMessageJournal({ getSessionId: () => 'dst' });
    expect(d.length).toBe(2);
    d.append(2, user('next'));
    await d.flush();
    expect(foldJournal(readJournalRecords('dst')).messages).toHaveLength(3);
  });

  it('returns false for a missing source, unsafe ids, same id, existing dst, or disabled', async () => {
    expect(forkJournal('none', 'dst')).toBe(false);
    expect(fs.existsSync(getSessionLedgerDir('dst'))).toBe(false);
    const j = createMessageJournal({ getSessionId: () => 's1' });
    j.append(0, user('a'));
    await j.close();
    expect(forkJournal('../s1', 'dst')).toBe(false);
    expect(forkJournal('s1', '../dst')).toBe(false);
    expect(forkJournal('s1', 's1')).toBe(false);
    expect(forkJournal('s1', 'd2')).toBe(true);
    expect(forkJournal('s1', 'd2')).toBe(false);
    vi.stubEnv('AFK_MESSAGE_JOURNAL_DISABLED', '1');
    expect(forkJournal('s1', 'd3')).toBe(false);
  });

  it('forks an empty-fold journal and returns false on I/O error', async () => {
    const j = createMessageJournal({ getSessionId: () => 'cleared' });
    j.append(0, user('a'));
    j.truncate(0, 'clear');
    await j.close();
    expect(forkJournal('cleared', 'c2')).toBe(true);
    expect(readJournalRecords('c2').map((r) => r.kind)).toEqual(['meta', 'mark']);

    fs.writeFileSync(getSessionLedgerDir('blocked'), 'file in the way');
    expect(forkJournal('cleared', 'blocked')).toBe(false);
  });
});
