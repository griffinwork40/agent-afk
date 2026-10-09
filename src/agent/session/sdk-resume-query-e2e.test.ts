/**
 * SDK resume-only query() end-to-end coverage (follow-up from #3372 / #3390).
 *
 * Gaps addressed here (not covered by sdk-resume-rehydration.test.ts):
 *
 *   1. `query()` with `resume` and no `sessionId`: the journal is seeded from
 *      the resumed session; the writer pins to the provider-issued id; the
 *      outgoing request carries the prior context as `resumeMessages`.
 *
 *   2. Tool calls and results survive the round trip: a journal containing
 *      `tool_use` + `tool_result` blocks is rehydrated into `resumeMessages`
 *      and reaches the provider unchanged.
 *
 *   3. Two sequential `query()` calls with the same `resume` id: the second
 *      call receives a `resumeMessages` that includes messages added to the
 *      journal between calls, confirming that `loadJournalMessages` reads the
 *      full accumulated journal on each request.
 *
 *   4. Corrupt-journal degraded path: `query()` with `resume` pointing at a
 *      corrupt journal completes without throwing, and a subsequent
 *      `AgentSession.sendMessage` also succeeds.
 *
 * All tests are hermetic: `useTmpAfkHome()` gives each test file a fresh
 * temp AFK_HOME so journal files never bleed across tests.
 * Session ids follow the repo convention (alphanumeric + hyphens, safe for
 * `isSafeLedgerSessionId`).
 *
 * Note on the mock provider: `createMockProvider` does not sync to the
 * message journal (that's the real provider's job, tested in
 * `journal-wiring.test.ts`). Tests here focus on the resume READER side:
 * that `seedResumeMessages` correctly loads and forwards prior journal
 * content as `resumeMessages`. Sequential-call journal growth is validated
 * by seeding additional journal entries between calls.
 */

import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';

import { AgentSession } from './agent-session.js';
import { query } from '../query.js';
import { createMockProvider } from '../__fixtures__/mock-provider.js';
import { createMessageJournal, loadJournalMessages } from '../journal/index.js';
import { useTmpAfkHome } from '../journal/__test-utils__/helpers.js';
import { getSessionJournalPath, getSessionLedgerDir } from '../../paths.js';
import type { AgentConfig } from '../types.js';

useTmpAfkHome();

// ---------------------------------------------------------------------------
// Journal seed helpers
// ---------------------------------------------------------------------------

/** Seed a minimal text-only journal for `sessionId`. */
async function seedTextJournal(sessionId: string, messages?: Array<{ role: 'user' | 'assistant'; text: string }>): Promise<void> {
  const msgs = messages ?? [
    { role: 'user' as const, text: 'prior user message' },
    { role: 'assistant' as const, text: 'prior assistant reply' },
  ];
  const journal = createMessageJournal({ getSessionId: () => sessionId });
  for (let i = 0; i < msgs.length; i++) {
    const { role, text } = msgs[i]!;
    journal.append(i, { role, content: [{ type: 'text', text }] });
  }
  await journal.close();
}

/**
 * Seed a journal containing a tool_use + tool_result exchange.
 * The four messages represent: user prompt, assistant+tool_use, tool_result
 * user message, final assistant text — exactly as a real provider journals them.
 */
async function seedToolCallJournal(sessionId: string): Promise<void> {
  const journal = createMessageJournal({ getSessionId: () => sessionId });
  journal.append(0, {
    role: 'user',
    content: [{ type: 'text', text: 'run a tool' }],
  });
  journal.append(1, {
    role: 'assistant',
    content: [
      { type: 'text', text: 'sure, invoking it' },
      { type: 'tool_use', id: 'tu-001', name: 'Bash', input: { command: 'echo hello' } },
    ],
  });
  journal.append(2, {
    role: 'user',
    content: [
      {
        type: 'tool_result',
        toolUseId: 'tu-001',
        content: [{ type: 'text', text: 'hello\n' }],
      },
    ],
  });
  journal.append(3, {
    role: 'assistant',
    content: [{ type: 'text', text: 'tool done' }],
  });
  await journal.close();
}

// ---------------------------------------------------------------------------
// Capturing provider helper
// ---------------------------------------------------------------------------

/**
 * Wrap `createMockProvider` to record the `AgentConfig` passed to each
 * `provider.query()` call, letting tests assert what `resumeMessages` the
 * provider received. The `sessionId` option controls the id the mock emits in
 * `session.init` — which becomes the journal writer's pinned id once armed.
 */
function capturingProvider(sessionId: string): {
  provider: ReturnType<typeof createMockProvider>;
  configs: AgentConfig[];
} {
  const provider = createMockProvider({ sessionId });
  const configs: AgentConfig[] = [];
  const origQuery = provider.query.bind(provider);
  provider.query = (args) => {
    configs.push(args.config);
    return origQuery(args);
  };
  return { provider, configs };
}

/** Drain all events from a query() call, returning output message texts. */
async function drainQuery(gen: AsyncGenerator<import('../types.js').OutputEvent>): Promise<string[]> {
  const texts: string[] = [];
  for await (const evt of gen) {
    if (evt.type === 'message') texts.push(evt.message.content);
  }
  return texts;
}

// ---------------------------------------------------------------------------
// Suite 1 — query() level (whole-session lifecycle per call)
// ---------------------------------------------------------------------------

describe('query() resume end-to-end', () => {
  it('resume-only (no sessionId): journal loaded; resumeMessages reach the provider', async () => {
    const priorSid = 'sdk-e2e-resume-only-prior';
    await seedTextJournal(priorSid);

    // Mock provider emits session.init with sessionId = priorSid so the new
    // writer pins to the same id as the resumed journal.
    const { provider, configs } = capturingProvider(priorSid);

    // Call query() with `resume` and WITHOUT an explicit `sessionId`.
    const texts = await drainQuery(query('hello', { provider, resume: priorSid }));

    // The provider ran and returned output.
    expect(texts.join('')).toBeTruthy();

    // resumeMessages were seeded from the on-disk journal.
    const seeded = configs[0]?.resumeMessages;
    expect(seeded).toBeDefined();
    expect(seeded).toHaveLength(2);
    expect(seeded![0]).toMatchObject({ role: 'user' });
    expect(seeded![1]).toMatchObject({ role: 'assistant' });
  });

  it('resume-only: a mark("resume") record appears in the journal after the call', async () => {
    const sid = 'sdk-e2e-resume-mark';
    await seedTextJournal(sid);

    const { provider } = capturingProvider(sid);
    await drainQuery(query('hi', { provider, resume: sid }));

    // Allow the journal write queue to flush (journal close is awaited in
    // query() already, but allow an extra tick for test-ordering safety).
    await new Promise<void>((r) => setTimeout(r, 50));

    const raw = fs.readFileSync(getSessionJournalPath(sid), 'utf8');
    const records = raw
      .split('\n')
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    const resumeMark = records.find((r) => r['kind'] === 'mark' && r['label'] === 'resume');
    expect(resumeMark).toBeDefined();
  });

  it('tool_use and tool_result blocks survive journal round-trip into resumeMessages', async () => {
    const sid = 'sdk-e2e-tool-round-trip';
    await seedToolCallJournal(sid);

    const { provider, configs } = capturingProvider(sid);
    await drainQuery(query('follow up', { provider, resume: sid }));

    const seeded = configs[0]?.resumeMessages;
    expect(seeded).toBeDefined();
    // 4 messages: user, assistant+tool_use, user/tool_result, assistant
    expect(seeded).toHaveLength(4);

    // Assistant turn contains a tool_use block.
    const assistantWithTool = seeded![1];
    expect(assistantWithTool?.role).toBe('assistant');
    const toolUseBlock = (assistantWithTool?.content as Array<{ type: string }>).find(
      (b) => b.type === 'tool_use',
    );
    expect(toolUseBlock).toBeDefined();
    expect(toolUseBlock).toMatchObject({ type: 'tool_use', id: 'tu-001', name: 'Bash' });

    // User turn contains a tool_result block.
    const toolResultMsg = seeded![2];
    expect(toolResultMsg?.role).toBe('user');
    const trBlock = (toolResultMsg?.content as Array<{ type: string; toolUseId?: string }>).find(
      (b) => b.type === 'tool_result',
    );
    expect(trBlock).toBeDefined();
    expect(trBlock).toMatchObject({ type: 'tool_result', toolUseId: 'tu-001' });
  });

  it('two sequential query() calls: second receives extended journal as resumeMessages', async () => {
    const sid = 'sdk-e2e-sequential-extend';
    // Seed the initial journal with 2 messages.
    await seedTextJournal(sid);

    // First query(): loads 2 messages as resumeMessages.
    const { provider: p1, configs: configs1 } = capturingProvider(sid);
    await drainQuery(query('turn one', { provider: p1, resume: sid }));
    expect(configs1[0]?.resumeMessages).toHaveLength(2);

    // Simulate what a real provider would have written after turn one:
    // two more messages (user turn + assistant reply) appended to the journal.
    const ext = createMessageJournal({ getSessionId: () => sid });
    ext.append(2, { role: 'user', content: [{ type: 'text', text: 'turn one prompt' }] });
    ext.append(3, { role: 'assistant', content: [{ type: 'text', text: 'turn one reply' }] });
    await ext.close();

    // The journal now has 4 messages on disk.
    expect(loadJournalMessages(sid)).toHaveLength(4);

    // Second query(): resumes with all 4 messages.
    const { provider: p2, configs: configs2 } = capturingProvider(sid);
    const texts2 = await drainQuery(query('turn two', { provider: p2, resume: sid }));

    // Provider received 4 prior messages.
    expect(configs2[0]?.resumeMessages).toHaveLength(4);
    // Session still produces output.
    expect(texts2.join('')).toBeTruthy();
  });

  it('corrupt journal: query() completes without throwing; no resumeMessages sent', async () => {
    const sid = 'sdk-e2e-corrupt-journal';
    // Well-formed JSON + record shape; isBlock accepts tool_result with an
    // array content, but hydratePart(null) throws — the reader cannot hydrate.
    const corrupt = {
      v: 1,
      ts: Date.now(),
      kind: 'append',
      index: 0,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'tu-bad', content: [null] }],
      },
    };
    fs.mkdirSync(getSessionLedgerDir(sid), { recursive: true });
    fs.writeFileSync(getSessionJournalPath(sid), `${JSON.stringify(corrupt)}\n`);

    const { provider, configs } = capturingProvider(sid);

    // Must not throw.
    const texts = await drainQuery(query('hello after corrupt', { provider, resume: sid }));

    // Degraded path: no resumeMessages (corrupt journal => empty context).
    expect(configs[0]).not.toHaveProperty('resumeMessages');
    // The session still processed the turn and returned output.
    expect(texts.join('')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// Suite 2 — AgentSession constructor + sendMessage on corrupt-journal path
// ---------------------------------------------------------------------------

describe('AgentSession corrupt-journal degraded path: send works after construction', () => {
  it('sendMessage succeeds on a session constructed with a corrupt resume journal', async () => {
    const sid = 'sdk-e2e-corrupt-send-after';
    const corrupt = {
      v: 1,
      ts: Date.now(),
      kind: 'append',
      index: 0,
      message: {
        role: 'user',
        content: [{ type: 'tool_result', toolUseId: 'tu-bad2', content: [null] }],
      },
    };
    fs.mkdirSync(getSessionLedgerDir(sid), { recursive: true });
    fs.writeFileSync(getSessionJournalPath(sid), `${JSON.stringify(corrupt)}\n`);

    const provider = createMockProvider({ sessionId: sid });
    let session: AgentSession | undefined;

    // Construction must not throw.
    expect(() => {
      session = new AgentSession({ model: 'sonnet', provider, resume: sid, sessionId: sid });
    }).not.toThrow();

    await session!.waitForInitialization();

    // sendMessage on the degraded session must succeed.
    const message = await session!.sendMessage('hello');
    expect(message.content).toBeTruthy();

    await session!.close();
  });
});
