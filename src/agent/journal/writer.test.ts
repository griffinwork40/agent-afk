import * as fs from 'node:fs';
import { describe, expect, it, vi, afterEach } from 'vitest';

import { getSessionJournalPath, getSessionLedgerDir, getSessionsDir, getSubagentJournalPath } from '../../paths.js';
import { assistant, readLines, toolResult, useTmpAfkHome, user } from './__test-utils__/helpers.js';
import { foldJournal, readJournalRecords } from './reader.js';
import { MAX_BUFFERED_RECORDS } from './journal-file.js';
import { createMessageJournal } from './writer.js';

useTmpAfkHome();

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

const texts = (sid: string) =>
  foldJournal(readJournalRecords(sid)).messages.map((m) => (m.content[0]?.type === 'text' ? m.content[0].text : '?'));

describe('createMessageJournal', () => {
  it('round-trips appends, truncates, and marks through the fold', async () => {
    const j = createMessageJournal({ getSessionId: () => 'sess-1', meta: { provider: 'anthropic', model: 'm1', cwd: '/x' } });
    j.append(0, user('a'));
    j.append(1, assistant('b'));
    j.mark('compact', { n: 1 });
    j.truncate(1, 'compact');
    j.append(1, assistant('c'));
    expect(j.length).toBe(2);
    await j.flush();

    const lines = readLines(getSessionJournalPath('sess-1'));
    expect(lines.map((l) => l['kind'])).toEqual(['meta', 'append', 'append', 'mark', 'truncate', 'append']);
    expect(lines.every((l) => l['v'] === 1 && typeof l['ts'] === 'number')).toBe(true);
    expect(lines[0]).toMatchObject({ sessionId: 'sess-1', provider: 'anthropic', model: 'm1', cwd: '/x' });
    expect(typeof lines[0]!['writerId']).toBe('string');
    const fold = foldJournal(readJournalRecords('sess-1'));
    expect(texts('sess-1')).toEqual(['a', 'c']);
    expect(fold.anomalies).toEqual([]);
    expect(fold.meta?.sessionId).toBe('sess-1');
  });

  it('buffers until the session id resolves, then writes in order', async () => {
    let id: string | undefined;
    const j = createMessageJournal({ getSessionId: () => id });
    j.append(0, user('a'));
    j.append(1, assistant('b'));
    expect(j.length).toBe(2);
    await j.flush();
    expect(fs.existsSync(getSessionsDir())).toBe(false);
    id = 'late-id';
    j.append(2, user('c'));
    await j.flush();
    expect(texts('late-id')).toEqual(['a', 'b', 'c']);
    expect(readLines(getSessionJournalPath('late-id')).filter((l) => l['kind'] === 'meta')).toHaveLength(1);
  });

  it('snapshots buffered records (later caller mutation does not leak in)', async () => {
    let id: string | undefined;
    const j = createMessageJournal({ getSessionId: () => id });
    const m = user('orig');
    j.append(0, m);
    (m.content[0] as { text: string }).text = 'mutated';
    id = 'snap';
    await j.flush();
    expect(texts('snap')).toEqual(['orig']);
  });

  it('stays buffered for an unsafe id and never throws', async () => {
    const j = createMessageJournal({ getSessionId: () => '../evil' });
    expect(() => j.append(0, user('a'))).not.toThrow();
    await j.flush();
    await j.close();
    expect(fs.existsSync(getSessionsDir())).toBe(false);
  });

  it('never throws when getSessionId throws', async () => {
    const j = createMessageJournal({
      getSessionId: () => {
        throw new Error('boom');
      },
    });
    expect(() => j.append(0, user('a'))).not.toThrow();
    expect(j.length).toBe(1);
    await expect(j.flush()).resolves.toBeUndefined();
  });

  it('drops past the buffer cap with one warning', () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const j = createMessageJournal({ getSessionId: () => undefined });
    for (let i = 0; i < MAX_BUFFERED_RECORDS + 5; i++) j.mark('resume');
    const warnings = err.mock.calls.filter((c) => String(c[0]).includes('message-journal'));
    expect(warnings).toHaveLength(1);
  });

  it('reads length from an existing file on resume and appends after it', async () => {
    const a = createMessageJournal({ getSessionId: () => 'resume-1' });
    a.append(0, user('a'));
    a.append(1, assistant('b'));
    a.append(2, user('c'));
    a.truncate(2);
    await a.close();

    const b = createMessageJournal({ getSessionId: () => 'resume-1' });
    expect(b.length).toBe(2);
    b.append(2, user('d'));
    await b.flush();
    expect(texts('resume-1')).toEqual(['a', 'b', 'd']);
    const metas = readLines(getSessionJournalPath('resume-1')).filter((l) => l['kind'] === 'meta');
    expect(metas).toHaveLength(2);
    expect(metas[0]!['writerId']).not.toBe(metas[1]!['writerId']);
  });

  it('applies buffered records on top of the on-disk length', async () => {
    const a = createMessageJournal({ getSessionId: () => 'resume-2' });
    a.append(0, user('a'));
    await a.close();
    let id: string | undefined;
    const b = createMessageJournal({ getSessionId: () => id });
    b.mark('resume');
    expect(b.length).toBe(0);
    id = 'resume-2';
    expect(b.length).toBe(1);
    await b.flush();
    expect(readJournalRecords('resume-2').map((r) => r.kind)).toEqual(['meta', 'append', 'meta', 'mark']);
  });

  it('repairs a torn tail before appending', async () => {
    fs.mkdirSync(getSessionLedgerDir('torn'), { recursive: true });
    fs.writeFileSync(getSessionJournalPath('torn'), '{"v":1,"ts":1,"kind":"append","index":0,"message":{"role":"user","content":[]}}\n{"v":1,"ts":2,"ki');
    const j = createMessageJournal({ getSessionId: () => 'torn' });
    expect(j.length).toBe(1);
    j.append(1, user('b'));
    await j.flush();
    expect(texts('torn')).toEqual(['?', 'b']);
  });

  it('close() flushes, is idempotent, and stops accepting writes', async () => {
    const j = createMessageJournal({ getSessionId: () => 'closing' });
    j.append(0, user('a'));
    await j.close();
    await j.close();
    j.append(1, user('b'));
    await j.flush();
    expect(texts('closing')).toEqual(['a']);
  });

  it('leaves no file when nothing is written', async () => {
    const j = createMessageJournal({ getSessionId: () => 'idle' });
    expect(j.length).toBe(0);
    await j.close();
    expect(fs.existsSync(getSessionJournalPath('idle'))).toBe(false);
  });

  it('uses 0700 dirs and 0600 files', async () => {
    if (process.platform === 'win32') return;
    const j = createMessageJournal({ getSessionId: () => 'modes' });
    j.append(0, user('a'));
    j.forSubagent('kid').append(0, user('k'));
    await j.flush();
    await j.forSubagent('kid').flush();
    expect(fs.statSync(getSessionJournalPath('modes')).mode & 0o777).toBe(0o600);
    expect(fs.statSync(getSessionLedgerDir('modes')).mode & 0o777).toBe(0o700);
    expect(fs.statSync(getSubagentJournalPath('modes', 'kid')).mode & 0o777).toBe(0o600);
  });

  it('returns a no-op journal when disabled', async () => {
    vi.stubEnv('AFK_MESSAGE_JOURNAL_DISABLED', '1');
    const j = createMessageJournal({ getSessionId: () => 'off' });
    j.append(0, user('a'));
    j.forSubagent('x').append(0, user('b'));
    expect(j.length).toBe(0);
    await j.close();
    expect(fs.existsSync(getSessionsDir())).toBe(false);
  });

  it('reports a disk error once to stderr and keeps going without throwing', async () => {
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    // A FILE where the session dir should be makes every mkdir fail.
    fs.mkdirSync(getSessionsDir(), { recursive: true });
    fs.writeFileSync(getSessionLedgerDir('blocked'), 'not a dir');
    const j = createMessageJournal({ getSessionId: () => 'blocked' });
    j.append(0, user('a'));
    j.append(1, user('b'));
    await expect(j.flush()).resolves.toBeUndefined();
    const warnings = err.mock.calls.filter((c) => String(c[0]).includes('message-journal'));
    expect(warnings).toHaveLength(1);
  });

  describe('forSubagent', () => {
    it('writes a separate journal sharing the lazy id, meta carries subagentId', async () => {
      let id: string | undefined;
      const parent = createMessageJournal({ getSessionId: () => id, meta: { model: 'm' } });
      const child = parent.forSubagent('sub-1');
      expect(parent.forSubagent('sub-1')).toBe(child);
      child.append(0, toolResult('tu-1', 'child out'));
      parent.append(0, user('p'));
      id = 'parent-sess';
      await child.flush();
      await parent.flush();
      const childLines = readLines(getSubagentJournalPath('parent-sess', 'sub-1'));
      expect(childLines[0]).toMatchObject({ kind: 'meta', sessionId: 'parent-sess', subagentId: 'sub-1', model: 'm' });
      expect(texts('parent-sess')).toEqual(['p']);
      expect(child.length).toBe(1);
    });

    it('rejects an unsafe subagent id without throwing', async () => {
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const parent = createMessageJournal({ getSessionId: () => 'p2' });
      const child = parent.forSubagent('../x');
      expect(() => child.append(0, user('a'))).not.toThrow();
      await child.flush();
      expect(fs.existsSync(getSessionLedgerDir('p2'))).toBe(false);
    });
  });
});

describe('JournalSync over a real journal', () => {
  it('resumes without a resync when the seed matches the on-disk fold', async () => {
    const { JournalSync } = await import('./sync.js');
    type M = { t: string };
    const adapter = {
      toJournal: (m: M) => user(m.t),
      fromJournalMessages: (ms: readonly import('./types.js').JournalMessage[]) => ms.map((m) => ({ t: (m.content[0] as { text: string }).text })),
    };
    const a = createMessageJournal({ getSessionId: () => 'sync-1' });
    const s1 = new JournalSync<M>(a, adapter);
    const arr: M[] = [{ t: 'a' }, { t: 'b' }];
    s1.sync(arr);
    await a.close();

    const b = createMessageJournal({ getSessionId: () => 'sync-1' });
    const s2 = new JournalSync<M>(b, adapter);
    const seeded = adapter.fromJournalMessages(foldJournal(readJournalRecords('sync-1')).messages);
    s2.seed(seeded);
    s2.sync([...seeded, { t: 'c' }]);
    await b.flush();
    const kinds = readJournalRecords('sync-1').map((r) => r.kind);
    expect(kinds).toEqual(['meta', 'append', 'append', 'meta', 'append']);
    expect(texts('sync-1')).toEqual(['a', 'b', 'c']);
  });
});
