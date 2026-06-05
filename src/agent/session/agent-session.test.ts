/**
 * T19 — Live AgentSession.setCwd() propagation test.
 *
 * Verifies the full chain:
 *   session.setCwd(newCwd)
 *     → ProviderQuery.setCwd(newCwd)           [on AgentSession.providerQuery]
 *       → AnthropicDirectQuery.setCwd(newCwd)  [in-place update via cwdDependentsFactory]
 *         → next turn's messages.create() system includes newCwd
 *
 * This is the real C1 fix test. The previous version (pre-fix) only tested
 * AnthropicDirectProvider.query() directly with two separate config.cwd values —
 * it did NOT exercise the live AgentSession.setCwd() path. This test does.
 *
 * Strategy: build a real AgentSession backed by AnthropicDirectProvider with a
 * stubbed Anthropic client. Send turn 1, capture the system passed to
 * messages.create, call session.setCwd(NEW_CWD), send turn 2, assert the second
 * messages.create call's system contains NEW_CWD and NOT OLD_CWD.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import type {
  ContentBlockParam,
  RawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources';
import { AgentSession } from './agent-session.js';
import { AnthropicDirectProvider, __setAnthropicClientFactory } from '../providers/anthropic-direct/index.js';

vi.mock('../../utils/debug.js', () => ({ debugLog: vi.fn() }));

// ---------------------------------------------------------------------------
// Mock Anthropic client (same pattern as plan-mode-system-payload.test.ts)
// ---------------------------------------------------------------------------

const messagesCreateMock = vi.fn();

class MockAnthropic {
  public messages: { create: typeof messagesCreateMock };
  constructor() {
    this.messages = { create: messagesCreateMock };
  }
}

function installFactory(): void {
  __setAnthropicClientFactory(
    () => new MockAnthropic() as unknown as Anthropic,
  );
}

async function* fromArray<T>(arr: T[]): AsyncIterable<T> {
  for (const x of arr) yield x;
}

/** Minimal single-turn event stream ending with end_turn. */
function makeTextStream(text: string): RawMessageStreamEvent[] {
  return [
    {
      type: 'message_start',
      message: {
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-haiku-4-5',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 5,
          output_tokens: 1,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text },
    } as unknown as RawMessageStreamEvent,
    {
      type: 'content_block_stop',
      index: 0,
    } as unknown as RawMessageStreamEvent,
    {
      type: 'message_delta',
      delta: { stop_reason: 'end_turn', stop_sequence: null },
      usage: { output_tokens: 1 },
    } as unknown as RawMessageStreamEvent,
    { type: 'message_stop' } as unknown as RawMessageStreamEvent,
  ];
}

function extractSystemText(systemArg: unknown): string {
  if (typeof systemArg === 'string') return systemArg;
  if (!Array.isArray(systemArg)) return '';
  const blocks = systemArg as ContentBlockParam[];
  return blocks
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('\n');
}

// ---------------------------------------------------------------------------

describe('AgentSession.setCwd() — live session propagation (T19)', () => {
  const OLD_CWD = '/old/workspace/path';
  const NEW_CWD = '/new/worktree/path';

  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    installFactory();
  });

  afterEach(() => {
    __setAnthropicClientFactory(null);
    vi.restoreAllMocks();
  });

  it('(T19-1) setCwd() causes the next turn to send the new cwd in the system prompt', async () => {
    // Two separate turn streams — one per sendMessage call.
    messagesCreateMock
      .mockImplementationOnce(() => fromArray(makeTextStream('first reply')))
      .mockImplementationOnce(() => fromArray(makeTextStream('second reply')));

    const provider = new AnthropicDirectProvider();
    const session = new AgentSession({
      model: 'claude-haiku-4-5',
      apiKey: 'sk-ant-oat01-test',
      cwd: OLD_CWD,
      provider,
    });

    try {
      // Turn 1: session uses OLD_CWD
      await session.sendMessage('first message');
      expect(messagesCreateMock).toHaveBeenCalledTimes(1);
      const turn1System = extractSystemText(
        (messagesCreateMock.mock.calls[0]![0] as { system?: unknown }).system,
      );
      expect(turn1System).toContain(OLD_CWD);
      expect(turn1System).toContain('Working directory');

      // setCwd: update the cwd on the live session (no reset, no history wipe).
      // The born-named worktree hook drives this on the first turn.
      session.setCwd(NEW_CWD);

      // Turn 2: session must now send NEW_CWD, not OLD_CWD.
      await session.sendMessage('second message');
      expect(messagesCreateMock).toHaveBeenCalledTimes(2);
      const turn2System = extractSystemText(
        (messagesCreateMock.mock.calls[1]![0] as { system?: unknown }).system,
      );
      expect(turn2System).toContain(NEW_CWD);
      expect(turn2System).not.toContain(OLD_CWD);
      expect(turn2System).toContain('Working directory');
    } finally {
      await session.close();
    }
  });

  it('(T19-2) session.cwd getter reflects the updated value after setCwd()', async () => {
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('ok')));

    const provider = new AnthropicDirectProvider();
    const session = new AgentSession({
      model: 'claude-haiku-4-5',
      apiKey: 'sk-ant-oat01-test',
      cwd: OLD_CWD,
      provider,
    });

    try {
      expect(session.cwd).toBe(OLD_CWD);
      session.setCwd(NEW_CWD);
      expect(session.cwd).toBe(NEW_CWD);
    } finally {
      await session.close();
    }
  });

  it('(T19-3) setCwd() does not wipe conversation history (no implicit reset)', async () => {
    messagesCreateMock
      .mockImplementationOnce(() => fromArray(makeTextStream('first reply')))
      .mockImplementationOnce(() => fromArray(makeTextStream('second reply')));

    const provider = new AnthropicDirectProvider();
    const session = new AgentSession({
      model: 'claude-haiku-4-5',
      apiKey: 'sk-ant-oat01-test',
      cwd: OLD_CWD,
      provider,
    });

    try {
      await session.sendMessage('first message');
      const historyBeforeSetCwd = session.getHistory().length;

      session.setCwd(NEW_CWD);

      // History must not have been cleared by setCwd
      expect(session.getHistory().length).toBe(historyBeforeSetCwd);
    } finally {
      await session.close();
    }
  });

  it('(T19-4) setCwd() migrates _sharedReadRoots in place (born-named cwd-update)', async () => {
    // Regression: previously, _sharedReadRoots was initialized with config.cwd
    // at first query() but never updated by setCwd. Read containment checks
    // under read_file/glob/grep would then reject paths under the post-setCwd
    // cwd because only the pre-setCwd cwd was in the roots.
    //
    // After the fix, cwdDependentsFactory swaps the prior cwd entry in
    // _sharedReadRoots/_sharedWriteRoots in place — both old and new
    // dispatchers (sharing the array reference) immediately see newCwd.
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('ok')));

    const provider = new AnthropicDirectProvider();
    const session = new AgentSession({
      model: 'claude-haiku-4-5',
      apiKey: 'sk-ant-oat01-test',
      cwd: OLD_CWD,
      provider,
    });

    try {
      await session.sendMessage('drive first turn so ensureSharedRoots fires');

      // Before setCwd: roots contain OLD_CWD only.
      const grantsBefore = provider.getGrants();
      expect(grantsBefore.readRoots).toContain(OLD_CWD);
      expect(grantsBefore.readRoots).not.toContain(NEW_CWD);

      session.setCwd(NEW_CWD);

      // After setCwd: OLD_CWD migrated to NEW_CWD in place.
      const grantsAfter = provider.getGrants();
      expect(grantsAfter.readRoots).toContain(NEW_CWD);
      expect(grantsAfter.readRoots).not.toContain(OLD_CWD);
      expect(grantsAfter.writeRoots).toContain(NEW_CWD);
      expect(grantsAfter.writeRoots).not.toContain(OLD_CWD);
    } finally {
      await session.close();
    }
  });

  it('(T19-5) setCwd() propagates new cwd to the dispatcher held by an in-flight turn (race fix)', async () => {
    // Regression: the in-flight turn captures `runInput.toolDispatcher` by
    // reference (loop.ts:419,436). Before this fix, setCwd installed a NEW
    // dispatcher but the in-flight reference still emitted OLD_CWD as
    // context.resolveBase / context.cwd — causing bash spawn to attempt
    // chdir into the deleted worktree path → ENOENT.
    //
    // After the fix, query.setCwd calls setResolveBase on the existing
    // dispatcher BEFORE installing the new one, so the in-flight reference
    // sees newCwd on its next handlerContext read.
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('ok')));

    const provider = new AnthropicDirectProvider();
    const session = new AgentSession({
      model: 'claude-haiku-4-5',
      apiKey: 'sk-ant-oat01-test',
      cwd: OLD_CWD,
      provider,
    });

    try {
      await session.sendMessage('drive first turn');

      // Capture the dispatcher reference exactly as loop.ts would, BEFORE
      // setCwd fires — simulating the in-flight tool-call race.
      const inFlightDispatcher = (
        session.getQuery() as unknown as {
          state: { toolDispatcher: { getGrants: () => { resolveBase: string | undefined } } };
        }
      ).state.toolDispatcher;
      const grantsBefore = inFlightDispatcher.getGrants();
      expect(grantsBefore.resolveBase).toBe(OLD_CWD);

      session.setCwd(NEW_CWD);

      // The SAME dispatcher reference — captured before setCwd — must now
      // emit NEW_CWD. This is what fixes the bash spawn ENOENT race.
      const grantsAfter = inFlightDispatcher.getGrants();
      expect(grantsAfter.resolveBase).toBe(NEW_CWD);
    } finally {
      await session.close();
    }
  });
});

// ---------------------------------------------------------------------------
// R2 — AgentSession.close() awaits providerQuery.close()
// ---------------------------------------------------------------------------

/**
 * R2 — Verifies that `AgentSession.close()` awaits `providerQuery.close()`.
 *
 * Before the fix, `this.providerQuery.close()` is called synchronously without
 * `await`. Any future provider with an async teardown (HTTP keep-alive flush,
 * MCP RPC drain) will silently race the iterator drain. The `reset()` path
 * already awaits it correctly — `close()` must mirror that pattern.
 *
 * Strategy: monkeypatch providerQuery.close() with a stub that records a
 * `closeStarted` flag when called AND sets `closeDone` only after resolving.
 * We record the value of `closeDone` *inside a post-close check* by appending
 * a microtask continuation immediately after `await session.close()`.
 *
 * The key invariant: if `close()` awaits `providerQuery.close()`, then
 * `closeDone` is true at the instant `session.close()` returns. If it does
 * NOT await, `closeDone` is still false at that point even though the stub
 * promise was created — the stub's `await resolve()` hasn't ticked yet.
 *
 * We prove "hasn't ticked" by inserting a multi-tick delay in the stub
 * (scheduling via setImmediate, which fires after all microtasks). By the time
 * `session.close()` runs through its own internal `await` chain and returns,
 * a setImmediate-deferred resolution has NOT yet fired. Only if `session.close()`
 * itself awaits the stub can it see the setImmediate-deferred `closeDone = true`.
 */
describe('R2 — close() awaits providerQuery.close()', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    installFactory();
  });

  afterEach(() => {
    __setAnthropicClientFactory(null);
    vi.restoreAllMocks();
  });

  it('(R2-1) close() does not return before providerQuery.close() resolves', async () => {
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('hi')));

    const provider = new AnthropicDirectProvider();
    const session = new AgentSession({
      model: 'claude-haiku-4-5',
      apiKey: 'sk-ant-oat01-test',
      cwd: '/tmp',
      provider,
    });

    let closeDone = false;
    const query = session.getQuery();

    // Stub: resolves via setImmediate (fires after all microtasks in the
    // current turn — so no amount of session.close()'s own internal awaits
    // can accidentally drain it unless session.close() explicitly awaits us).
    query.close = () =>
      new Promise<void>((resolve) => {
        setImmediate(() => {
          closeDone = true;
          resolve();
        });
      });

    await session.close();

    // After fix: session.close() awaited providerQuery.close(), so closeDone === true.
    // Before fix: session.close() returned before setImmediate fired → false.
    expect(closeDone).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// /resume + /clear regression — reset() must strip resume-context from config
// ---------------------------------------------------------------------------

/**
 * Regression: pre-fix, `AgentSession.reset()` reused `this.config` verbatim
 * when rebuilding the SDK lifecycle. After `/resume`, `this.config` carries
 * { resume, sessionId, resumeHistory } (seeded by `resumeConfigFor`), so a
 * subsequent `/clear` (which calls `reset()`) silently re-attached the new
 * provider query to the resumed session's SDK id and re-seeded its history —
 * the user saw a "cleared" REPL whose next message continued the resumed
 * conversation instead of starting fresh.
 *
 * Fix (agent-session.ts:reset()): strip resume-context fields (resume,
 * sessionId, resumeHistory, resumeSessionAt, continue, forkSession) from
 * `this.config` before calling `initSdkLifecycle()`.
 *
 * These tests assert the observable invariants:
 *   1. After reset(), `session.sessionId` is NOT the resumed sessionId — the
 *      provider mints a fresh UUID.
 *   2. The next sendMessage() does not include the resumed transcript in the
 *      messages.create payload.
 */
describe('reset() strips resume-context from config (/resume + /clear regression)', () => {
  beforeEach(() => {
    messagesCreateMock.mockReset();
    __setAnthropicClientFactory(null);
    installFactory();
  });

  afterEach(() => {
    __setAnthropicClientFactory(null);
    vi.restoreAllMocks();
  });

  it('reset() mints a fresh sessionId, not the resumed one', async () => {
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('ok')));

    const RESUMED_ID = 'resumed-session-id-from-prior-conversation';
    const provider = new AnthropicDirectProvider();
    const session = new AgentSession({
      model: 'claude-haiku-4-5',
      apiKey: 'sk-ant-oat01-test',
      cwd: '/tmp',
      provider,
      // Simulate post-/resume state: resume-context baked into config.
      resume: RESUMED_ID,
      sessionId: RESUMED_ID,
      resumeHistory: [{ user: 'prior question', assistant: 'prior reply' }],
    });

    try {
      // Drive one turn so initSessionId is observable on the session.
      await session.sendMessage('drive first turn');
      expect(session.sessionId).toBe(RESUMED_ID);

      // /clear path
      await session.reset();

      // After reset, the new SDK lifecycle must not inherit the resumed id.
      // sendMessage() drives the new query through its init phase, at which
      // point the provider emits session.init with a fresh UUID.
      await session.sendMessage('post-clear turn');

      expect(session.sessionId).not.toBe(RESUMED_ID);
      expect(session.sessionId).toBeTruthy();
    } finally {
      await session.close();
    }
  });

  it('reset() drops resumeHistory so the next messages.create does not carry the resumed transcript', async () => {
    messagesCreateMock.mockImplementation(() => fromArray(makeTextStream('ok')));

    const provider = new AnthropicDirectProvider();
    const session = new AgentSession({
      model: 'claude-haiku-4-5',
      apiKey: 'sk-ant-oat01-test',
      cwd: '/tmp',
      provider,
      resume: 'some-resumed-id',
      sessionId: 'some-resumed-id',
      resumeHistory: [
        { user: 'PRIOR_USER_MSG_SENTINEL', assistant: 'PRIOR_ASSISTANT_MSG_SENTINEL' },
      ],
    });

    try {
      // Turn 1 (still in resumed context) — must carry the resumed transcript.
      await session.sendMessage('first message after resume');
      const turn1Messages = (
        messagesCreateMock.mock.calls[0]![0] as { messages: { content: unknown }[] }
      ).messages;
      const turn1Text = JSON.stringify(turn1Messages);
      expect(turn1Text).toContain('PRIOR_USER_MSG_SENTINEL');
      expect(turn1Text).toContain('PRIOR_ASSISTANT_MSG_SENTINEL');

      // /clear
      await session.reset();

      // Turn 2 — post-clear, the resumed transcript MUST be gone.
      await session.sendMessage('first message after clear');
      const turn2Messages = (
        messagesCreateMock.mock.calls[1]![0] as { messages: { content: unknown }[] }
      ).messages;
      const turn2Text = JSON.stringify(turn2Messages);
      expect(turn2Text).not.toContain('PRIOR_USER_MSG_SENTINEL');
      expect(turn2Text).not.toContain('PRIOR_ASSISTANT_MSG_SENTINEL');
    } finally {
      await session.close();
    }
  });
});
