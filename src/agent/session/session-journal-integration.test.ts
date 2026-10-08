/**
 * Integration: AgentSession × message journal lifecycle.
 *
 * The mock provider does not journal messages itself (providers own
 * `JournalSync`), so these tests assert the SESSION's part of the contract:
 * which journal reaches `config.messageJournal`, that forks never get a
 * top-level journal, and that close / reset / resume leave the right records.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import { AgentSession } from './agent-session.js';
import { createMockProvider } from '../__fixtures__/mock-provider.js';
import { createMessageJournal, readJournalRecords, loadJournalMessages, type MessageJournal } from '../journal/index.js';
import { useTmpAfkHome, user, assistant } from '../journal/__test-utils__/helpers.js';
import { getSessionJournalPath, getSubagentJournalPath } from '../../paths.js';
import type { AgentConfig } from '../types.js';

useTmpAfkHome();

/** A provider that records the config each query was built with. */
function capturingProvider(sessionId: string): { provider: ReturnType<typeof createMockProvider>; configs: AgentConfig[] } {
  const provider = createMockProvider({ sessionId });
  const configs: AgentConfig[] = [];
  const query = provider.query.bind(provider);
  provider.query = (args) => {
    configs.push(args.config);
    return query(args);
  };
  return { provider, configs };
}

async function drainTurn(session: AgentSession, text: string): Promise<void> {
  for await (const event of session.sendMessageStream(text)) {
    if (event.type === 'done' || event.type === 'error') break;
  }
}

describe('AgentSession message journal', () => {
  it('wires a journal for a top-level session and writes it under the provider session id', async () => {
    const { provider, configs } = capturingProvider('journal-top-1');
    const session = new AgentSession({ model: 'sonnet', provider });
    await session.waitForInitialization();

    const journal = configs[0]?.messageJournal;
    expect(journal).toBeDefined();
    expect(session.messageJournal).toBe(journal);

    // Stand in for the provider's JournalSync.
    journal!.append(0, user('hi'));
    journal!.append(1, assistant('hello'));
    await drainTurn(session, 'hi');
    await session.close();

    expect(loadJournalMessages('journal-top-1')).toEqual([user('hi'), assistant('hello')]);
    const meta = readJournalRecords('journal-top-1')[0];
    expect(meta).toMatchObject({ kind: 'meta', sessionId: 'journal-top-1', model: 'sonnet', provider: 'mock-provider' });
  });

  it('does not build a journal for a fork (isSubagentFork / parentSessionId)', async () => {
    for (const extra of [{ isSubagentFork: true as const }, { parentSessionId: 'parent-x' }]) {
      const { provider, configs } = capturingProvider('journal-fork-parent');
      const session = new AgentSession({ model: 'sonnet', provider, ...extra });
      await session.waitForInitialization();
      expect(configs[0]?.messageJournal).toBeUndefined();
      expect(session.messageJournal).toBeUndefined();
      await drainTurn(session, 'child work');
      await session.close();
    }
    expect(fs.existsSync(getSessionJournalPath('journal-fork-parent'))).toBe(false);
  });

  it('a fork keeps its subagent journal and closes it on close', async () => {
    const parent = createMessageJournal({ getSessionId: () => 'journal-parent-2' });
    const child = parent.forSubagent('sub-1');
    const { provider, configs } = capturingProvider('journal-parent-2');
    const session = new AgentSession({ model: 'sonnet', provider, isSubagentFork: true, messageJournal: child });
    await session.waitForInitialization();
    expect(configs[0]?.messageJournal).toBe(child);
    child.append(0, user('task'));
    await session.close();

    expect(fs.existsSync(getSubagentJournalPath('journal-parent-2', 'sub-1'))).toBe(true);
    expect(fs.existsSync(getSessionJournalPath('journal-parent-2'))).toBe(false);
    expect(loadJournalMessages('journal-parent-2', { subagentId: 'sub-1' })).toEqual([user('task')]);
  });

  it('/clear closes the journal, hands the new runtime a fresh one, and folds to empty', async () => {
    const { provider, configs } = capturingProvider('journal-reset-1');
    const session = new AgentSession({ model: 'sonnet', provider });
    await session.waitForInitialization();
    const first = configs[0]!.messageJournal!;
    first.append(0, user('before'));
    await drainTurn(session, 'before');

    await session.reset();
    const second = configs.at(-1)!.messageJournal as MessageJournal;
    expect(configs.length).toBe(2);
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    expect(session.messageJournal).toBe(second);
    // Post-reset records buffer until the rebuilt runtime's session.init
    // resolves the id (the gate never lets them pin the pre-clear id).
    await session.waitForInitialization();
    await second.flush();

    const labels = readJournalRecords('journal-reset-1').map((r) => (r.kind === 'mark' ? `mark:${r.label}` : r.kind));
    expect(labels).toContain('mark:clear');
    expect(loadJournalMessages('journal-reset-1')).toBeNull();

    second.append(0, user('after'));
    await session.close();
    expect(loadJournalMessages('journal-reset-1')).toEqual([user('after')]);
  });

  it('strips resumeMessages on /clear and marks resume at construction', async () => {
    const { provider, configs } = capturingProvider('journal-resume-1');
    const session = new AgentSession({
      model: 'sonnet',
      provider,
      resume: 'journal-resume-1',
      sessionId: 'journal-resume-1',
      resumeMessages: [user('old')],
    });
    await session.waitForInitialization();
    expect(configs[0]?.resumeMessages).toEqual([user('old')]);
    await session.messageJournal?.flush();
    expect(readJournalRecords('journal-resume-1').some((r) => r.kind === 'mark' && r.label === 'resume')).toBe(true);

    await session.reset();
    expect(configs.at(-1)).not.toHaveProperty('resumeMessages');
    await session.close();
  });

  it('keeps a caller-injected journal across /clear and does not close it', async () => {
    const injected = createMessageJournal({ getSessionId: () => 'journal-injected-1' });
    const { provider, configs } = capturingProvider('journal-injected-1');
    const session = new AgentSession({ model: 'sonnet', provider, messageJournal: injected });
    await session.waitForInitialization();
    await session.reset();
    expect(configs.at(-1)?.messageJournal).toBe(injected);
    await session.close();
    injected.append(0, user('still open'));
    await injected.close();
    expect(loadJournalMessages('journal-injected-1')).toEqual([user('still open')]);
  });
});
