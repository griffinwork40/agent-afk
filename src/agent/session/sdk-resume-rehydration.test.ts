/**
 * SDK resume rehydration via journal (feat/sdk-resume-rehydrates-journal).
 *
 * Contract: when `AgentSession` is constructed with `resume` and no explicit `resumeMessages`/`resumeHistory`, the on-disk message journal
 * is loaded automatically — matching the CLI's `resumeConfigFor()` behaviour.
 *
 * Guards verified here:
 *   1. Baseline: `resume` with no journal present is still a no-op (no crash).
 *   2. `resume` with a journal present auto-seeds `resumeMessages`.
 *   3. Explicit `resumeMessages` wins over the auto-load (no double-load).
 *   4. `persistSession: false` opts out of the auto-load.
 *   5. `AFK_MESSAGE_JOURNAL_DISABLED=1` is a no-op.
 *   6. Fork configs (`isSubagentFork` / `parentSessionId`) are not auto-seeded.
 *   7. `sessionId` alone (without `resume`) does NOT trigger the load.
 *   8. Explicit `resumeHistory` wins over the auto-load.
 *   9. A corrupt journal the reader accepts but cannot hydrate (nested
 *      `tool_result.content: [null]`) does not throw from the constructor.
 */
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { AgentSession } from './agent-session.js';
import { createMockProvider } from '../__fixtures__/mock-provider.js';
import { createMessageJournal, loadJournalMessages } from '../journal/index.js';
import { useTmpAfkHome, user, assistant } from '../journal/__test-utils__/helpers.js';
import type { AgentConfig } from '../types.js';
import { getSessionJournalPath, getSessionLedgerDir } from '../../paths.js';

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

/** Write a small journal for the given session id and return its messages. */
async function seedJournal(sessionId: string): Promise<void> {
  const journal = createMessageJournal({ getSessionId: () => sessionId });
  journal.append(0, user('prior user message'));
  journal.append(1, assistant('prior assistant reply'));
  await journal.close();
}

describe('SDK resume rehydration via journal', () => {
  it('no-ops when resume points to a session with no journal', async () => {
    const { provider, configs } = capturingProvider('sdk-resume-no-journal');
    const session = new AgentSession({
      model: 'sonnet',
      provider,
      resume: 'sdk-resume-no-journal',
      sessionId: 'sdk-resume-no-journal',
    });
    await session.waitForInitialization();
    expect(configs[0]).not.toHaveProperty('resumeMessages');
    await session.close();
  });

  it('auto-seeds resumeMessages from the journal when resume is set', async () => {
    const sid = 'sdk-resume-from-journal-1';
    await seedJournal(sid);

    const { provider, configs } = capturingProvider(sid);
    const session = new AgentSession({
      model: 'sonnet',
      provider,
      resume: sid,
      sessionId: sid,
    });
    await session.waitForInitialization();

    const seeded = configs[0]?.resumeMessages;
    expect(seeded).toBeDefined();
    expect(seeded).toEqual([user('prior user message'), assistant('prior assistant reply')]);
    await session.close();
  });

  it('does not auto-seed when sessionId alone is set (no explicit resume)', async () => {
    const sid = 'sdk-resume-sessionid-only';
    await seedJournal(sid);

    const { provider, configs } = capturingProvider(sid);
    const session = new AgentSession({
      model: 'sonnet',
      provider,
      sessionId: sid,
    });
    await session.waitForInitialization();

    expect(configs[0]).not.toHaveProperty('resumeMessages');
    await session.close();
  });

  it('explicit resumeHistory wins over the auto-load', async () => {
    const sid = 'sdk-resume-history-wins';
    await seedJournal(sid);

    const { provider, configs } = capturingProvider(sid);
    const history = [{ user: 'caller user turn', assistant: 'caller assistant turn' }];
    const session = new AgentSession({
      model: 'sonnet',
      provider,
      resume: sid,
      sessionId: sid,
      resumeHistory: history,
    });
    await session.waitForInitialization();

    expect(configs[0]).not.toHaveProperty('resumeMessages');
    expect(configs[0]?.resumeHistory).toEqual(history);
    await session.close();
  });

  it('explicit resumeMessages wins over the auto-load (no double-load)', async () => {
    const sid = 'sdk-resume-explicit-wins';
    await seedJournal(sid);

    const explicit = [user('explicit message')];
    const { provider, configs } = capturingProvider(sid);
    const session = new AgentSession({
      model: 'sonnet',
      provider,
      resume: sid,
      sessionId: sid,
      resumeMessages: explicit,
    });
    await session.waitForInitialization();

    // The caller's value must be preserved verbatim — not overwritten or merged.
    expect(configs[0]?.resumeMessages).toBe(explicit);
    await session.close();
  });

  it('persistSession: false opts out of auto-load', async () => {
    const sid = 'sdk-resume-no-persist';
    await seedJournal(sid);

    const { provider, configs } = capturingProvider(sid);
    const session = new AgentSession({
      model: 'sonnet',
      provider,
      resume: sid,
      sessionId: sid,
      persistSession: false,
    });
    await session.waitForInitialization();

    expect(configs[0]).not.toHaveProperty('resumeMessages');
    await session.close();
  });

  it('AFK_MESSAGE_JOURNAL_DISABLED=1 is a no-op (auto-load skipped)', async () => {
    const sid = 'sdk-resume-journal-disabled';
    await seedJournal(sid);

    // Temporarily set the disable flag.
    const prev = process.env['AFK_MESSAGE_JOURNAL_DISABLED']; // audit-env-access: allow — test isolation
    process.env['AFK_MESSAGE_JOURNAL_DISABLED'] = '1'; // audit-env-access: allow — test isolation
    try {
      const { provider, configs } = capturingProvider(sid);
      const session = new AgentSession({
        model: 'sonnet',
        provider,
        resume: sid,
        sessionId: sid,
      });
      await session.waitForInitialization();
      expect(configs[0]).not.toHaveProperty('resumeMessages');
      await session.close();
    } finally {
      if (prev === undefined) delete process.env['AFK_MESSAGE_JOURNAL_DISABLED']; // audit-env-access: allow — test isolation
      else process.env['AFK_MESSAGE_JOURNAL_DISABLED'] = prev; // audit-env-access: allow — test isolation
    }
  });

  it('isSubagentFork: true is not auto-seeded (fork rehydrates from parent provider)', async () => {
    const sid = 'sdk-resume-fork-skip';
    await seedJournal(sid);

    const { provider, configs } = capturingProvider(sid);
    const session = new AgentSession({
      model: 'sonnet',
      provider,
      resume: sid,
      sessionId: sid,
      isSubagentFork: true,
    });
    await session.waitForInitialization();
    expect(configs[0]).not.toHaveProperty('resumeMessages');
    await session.close();
  });

  it('parentSessionId set is not auto-seeded (subagent fork path)', async () => {
    const sid = 'sdk-resume-parent-sid-skip';
    await seedJournal(sid);

    const { provider, configs } = capturingProvider(sid);
    const session = new AgentSession({
      model: 'sonnet',
      provider,
      resume: sid,
      sessionId: sid,
      parentSessionId: 'parent-xyz',
    });
    await session.waitForInitialization();
    expect(configs[0]).not.toHaveProperty('resumeMessages');
    await session.close();
  });

  it('corrupt nested tool_result content does not throw from the constructor', async () => {
    const sid = 'sdk-resume-corrupt-nested';
    // Valid JSON, valid version and record shape: `isBlock` accepts a
    // tool_result whose content is an array, but `hydratePart(null)` throws.
    const corrupt = {
      v: 1,
      ts: 1,
      kind: 'append',
      index: 0,
      message: { role: 'user', content: [{ type: 'tool_result', toolUseId: 'tu-1', content: [null] }] },
    };
    fs.mkdirSync(getSessionLedgerDir(sid), { recursive: true });
    fs.writeFileSync(getSessionJournalPath(sid), `${JSON.stringify(corrupt)}\n`);
    // Precondition: the new isResultPart guard catches `content: [null]` at
    // parse time, so the record is silently skipped and the reader returns null
    // (empty fold) rather than throwing. The test still exercises the
    // constructor-side boundary: the constructor must not throw and must not
    // seed resumeMessages when the journal yields nothing usable.
    expect(loadJournalMessages(sid)).toBeNull();

    const { provider, configs } = capturingProvider(sid);
    let session: AgentSession | undefined;
    expect(() => {
      session = new AgentSession({ model: 'sonnet', provider, resume: sid, sessionId: sid });
    }).not.toThrow();
    await session!.waitForInitialization();
    expect(configs[0]).not.toHaveProperty('resumeMessages');
    await session!.close();
  });

  it('journal is still present on disk after auto-seeded resume (not consumed/deleted)', async () => {
    const sid = 'sdk-resume-journal-preserved';
    await seedJournal(sid);

    const { provider } = capturingProvider(sid);
    const session = new AgentSession({
      model: 'sonnet',
      provider,
      resume: sid,
      sessionId: sid,
    });
    await session.waitForInitialization();
    await session.close();

    // The on-disk journal must still be readable after resume.
    const msgs = loadJournalMessages(sid);
    expect(msgs).toEqual([user('prior user message'), assistant('prior assistant reply')]);
  });
});
