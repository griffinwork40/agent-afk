import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { JournalLifecycle, isForkConfig } from './journal-lifecycle.js';
import { loadJournalMessages, readJournalRecords } from '../journal/index.js';
import { useTmpAfkHome, user } from '../journal/__test-utils__/helpers.js';
import { getSessionJournalPath, getSubagentJournalPath } from '../../paths.js';
import type { AgentConfig } from '../types.js';

useTmpAfkHome();

describe('JournalLifecycle', () => {
  it('never pins the previous runtime id before arm() (non-cli /clear mints a new id)', async () => {
    let live: string | undefined = 'old-id';
    const lc = new JournalLifecycle(() => live);
    const config = lc.open({ model: 'sonnet' });
    config.messageJournal!.append(0, user('buffered'));
    await config.messageJournal!.flush();
    expect(fs.existsSync(getSessionJournalPath('old-id'))).toBe(false);

    live = 'new-id';
    lc.arm(config);
    await lc.close();
    expect(loadJournalMessages('new-id')).toEqual([user('buffered')]);
  });

  it('resolves to the configured (resumed) id before arm()', async () => {
    const lc = new JournalLifecycle(() => undefined);
    const config = lc.open({ model: 'sonnet', sessionId: 'resumed-id' });
    config.messageJournal!.append(0, user('x'));
    await lc.close();
    expect(loadJournalMessages('resumed-id')).toEqual([user('x')]);
  });

  it('reset: closeForReset + stripForReset + open builds a fresh journal; markCleared folds to empty', async () => {
    const lc = new JournalLifecycle(() => 'cli-id');
    const first = lc.open({ model: 'sonnet' });
    lc.arm(first);
    first.messageJournal!.append(0, user('before'));
    await lc.closeForReset();
    const stripped = lc.stripForReset(first);
    expect(stripped).not.toHaveProperty('messageJournal');
    const second = lc.open(stripped);
    lc.arm(second);
    expect(second.messageJournal).not.toBe(first.messageJournal);
    lc.markCleared();
    await lc.close();
    expect(loadJournalMessages('cli-id')).toBeNull();
    expect(readJournalRecords('cli-id').some((r) => r.kind === 'mark' && r.label === 'clear')).toBe(true);
  });

  it('closeForReset freezes the old gate: an unresolved subagent journal pins the PRE-clear id', async () => {
    let live: string | undefined = 'old-id';
    const lc = new JournalLifecycle(() => live);
    const config = lc.open({ model: 'sonnet' });
    lc.arm(config);
    // Forked before /clear; its writer has not resolved an id yet.
    const child = config.messageJournal!.forSubagent('sub-1');
    await lc.closeForReset();
    live = 'new-id'; // non-cli surface mints a new id after the reset
    child.append(0, user('pre-clear work'));
    await child.flush();
    expect(fs.existsSync(getSubagentJournalPath('old-id', 'sub-1'))).toBe(true);
    expect(fs.existsSync(getSubagentJournalPath('new-id', 'sub-1'))).toBe(false);
  });

  it('a gate closed before any id resolved stays unresolved (never adopts a later id)', async () => {
    let live: string | undefined;
    const lc = new JournalLifecycle(() => live);
    const config = lc.open({ model: 'sonnet' });
    lc.arm(config);
    const child = config.messageJournal!.forSubagent('sub-2');
    await lc.close();
    live = 'later-id';
    child.append(0, user('x'));
    await child.flush();
    expect(fs.existsSync(getSubagentJournalPath('later-id', 'sub-2'))).toBe(false);
  });

  it('forks and injected journals are never replaced', () => {
    const lc = new JournalLifecycle(() => 'x');
    expect(lc.open({ model: 'sonnet', isSubagentFork: true }).messageJournal).toBeUndefined();
    expect(isForkConfig({ model: 'sonnet', parentSessionId: 'p' } as AgentConfig)).toBe(true);
    const injected = lc.open({ model: 'sonnet' }).messageJournal!;
    const lc2 = new JournalLifecycle(() => 'x');
    const cfg = lc2.open({ model: 'sonnet', messageJournal: injected });
    expect(cfg.messageJournal).toBe(injected);
    expect(lc2.stripForReset(cfg).messageJournal).toBe(injected);
  });
});
