/**
 * Unit tests for the two usage-limit park-and-replay paths in usage-limit-pause.ts.
 *
 * Coverage:
 *  - far-reset + autoResume=true: parks (emits `paused`, no resetsAt, with
 *    waitDeadline), resumes on hot-swap (client refreshed, replay streamed, `resumed`)
 *  - far-reset + autoResume=true: no swap within cap → surfaces error after 2h
 *  - far-reset + autoResume=false: surfaces error immediately (unchanged behavior)
 *  - abort during far-reset park: returns without replay
 *  - no-ts: parks, resumes on hot-swap (waitDeadline set)
 *  - no-ts + autoResume=false: surfaces error immediately (unchanged)
 *  - within-2h reset + autoResume=true: waits for timer, resumes
 *  - within-2h reset + autoResume=false: surfaces error immediately (unchanged)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProviderEvent } from '../../../provider.js';
import type { RetryTierContext, TierGenerator } from './retry-context.js';
import type { RunTurnInput } from '../types.js';

// ---------------------------------------------------------------------------
// Module-level mocks
// ---------------------------------------------------------------------------

const loadClaudeCodeOauthTokenMock = vi.hoisted(() => vi.fn<[], string | undefined>());
const parseAccountIdentifierMock = vi.hoisted(() => vi.fn<[string], string>());
const waitForHotSwapMock = vi.hoisted(() => vi.fn<[unknown], Promise<'aborted' | 'hot-swap' | 'timer'>>());
const waitForResetMock = vi.hoisted(() => vi.fn<[unknown], Promise<'aborted' | 'timer' | 'hot-swap'>>());
const emitSessionPhaseMock = vi.hoisted(() => vi.fn());

vi.mock('../../../auth/keychain.js', () => ({
  loadClaudeCodeOauthToken: loadClaudeCodeOauthTokenMock,
  parseAccountIdentifier: parseAccountIdentifierMock,
}));
vi.mock('../usage-limit.js', () => ({
  classifyUsageLimitError: (err: Error & { status?: number }) => {
    if ((err as { __reLimited?: boolean }).__reLimited) {
      return { kind: 'oauth-limit-no-ts' };
    }
    return null;
  },
  waitForHotSwap: waitForHotSwapMock,
  waitForReset: waitForResetMock,
}));
vi.mock('../../../trace/emit.js', () => ({
  emitSessionPhase: emitSessionPhaseMock,
}));

const { usageLimitNoTimestampPause, usageLimitResetPause } = await import('./usage-limit-pause.js');
const { TWO_HOURS_MS } = await import('./retry-constants.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const FAKE_ACCOUNT = 'acct:test';
const cleanDone: ProviderEvent = { type: 'turn.completed', usage: { stopReason: 'end_turn' }, sessionId: 's1' };

function makeError(msg = 'usage limit hit'): Error {
  return new Error(msg);
}

function makeReLimitedError(): Error & { __reLimited: boolean } {
  const e = new Error('re-limited') as Error & { __reLimited: boolean };
  e.__reLimited = true;
  return e;
}

function makeCtx(autoResume: boolean): RetryTierContext {
  const markStale = vi.fn();
  const forceRefresh = vi.fn<[], Promise<{ accountId: string; oldAccountId: string; swapped: boolean } | null>>();
  let waitPromise: Promise<'aborted' | 'timer' | 'hot-swap'> | null = null;
  return {
    authMode: 'oauth',
    surface: 'repl',
    autoResumeOnUsageLimit: autoResume,
    tokenRefresher: undefined,
    getClient: () => ({}) as never,
    rotateHeaders: () => ({}),
    forceClientRefresh: forceRefresh as never,
    getUsageLimitWait: () => waitPromise,
    setUsageLimitWait: (p) => { waitPromise = p as never; },
    markCredentialSnapshotStale: markStale,
    _markStale: markStale,
    _forceRefresh: forceRefresh,
  } as RetryTierContext & { _markStale: typeof markStale; _forceRefresh: typeof forceRefresh };
}

function makeInput(): RunTurnInput {
  return {
    client: {} as never,
    messages: [{ role: 'user', content: 'hi' }],
    system: null,
    tools: null,
    toolDispatcher: {} as never,
    model: 'claude-test',
    maxTokens: 1024,
    headers: {},
    signal: new AbortController().signal,
    ctx: { sessionId: 's1' } as never,
  };
}

async function drain(gen: AsyncGenerator<ProviderEvent>): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

/** next() that yields a clean stream */
function nextOk(): TierGenerator {
  return async function* () {
    yield cleanDone;
  };
}

/** next() that yields a re-limited error first, then cleans up */
function nextReLimited(): TierGenerator {
  let calls = 0;
  return async function* () {
    calls++;
    if (calls === 1) {
      const e = makeReLimitedError();
      yield { type: 'error', error: e };
    } else {
      yield cleanDone;
    }
  };
}

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
  loadClaudeCodeOauthTokenMock.mockReturnValue('tok-a');
  parseAccountIdentifierMock.mockImplementation((t) => `acct:${t}`);
  emitSessionPhaseMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// usageLimitNoTimestampPause
// ---------------------------------------------------------------------------

describe('usageLimitNoTimestampPause', () => {
  it('emits paused with no resetsAt and no waitDeadline, then errors when autoResume=false', async () => {
    const ctx = makeCtx(false);
    const input = makeInput();
    const pending: ProviderEvent = { type: 'error', error: makeError() };

    const events = await drain(
      usageLimitNoTimestampPause(ctx, input, () => false, nextOk(), pending),
    );

    expect(events[0]).toMatchObject({ type: 'paused', reason: 'usage-limit', autoResume: false });
    expect((events[0] as Extract<ProviderEvent, { type: 'paused' }>).resetsAt).toBeUndefined();
    // Fail-fast never parks, so it must not advertise a park window.
    expect((events[0] as Extract<ProviderEvent, { type: 'paused' }>).waitDeadline).toBeUndefined();
    expect(events[1]).toMatchObject({ type: 'error' });
    expect(events).toHaveLength(2);
    expect((ctx as RetryTierContext & { _markStale: ReturnType<typeof vi.fn> })._markStale).toHaveBeenCalled();
  });

  it('parks and resumes on hot-swap when autoResume=true', async () => {
    vi.useFakeTimers();
    waitForHotSwapMock.mockResolvedValue('hot-swap');
    const ctx = makeCtx(true);
    (ctx as RetryTierContext & { _forceRefresh: ReturnType<typeof vi.fn> })._forceRefresh.mockResolvedValue({
      accountId: 'acct:tok-b',
      oldAccountId: 'acct:tok-a',
      swapped: true,
    });
    const input = makeInput();
    const pending: ProviderEvent = { type: 'error', error: makeError() };

    const promise = drain(
      usageLimitNoTimestampPause(ctx, input, () => false, nextOk(), pending),
    );
    await vi.advanceTimersByTimeAsync(100);
    const events = await promise;

    expect(events[0]).toMatchObject({ type: 'paused', reason: 'usage-limit', autoResume: true });
    const paused = events[0] as Extract<ProviderEvent, { type: 'paused' }>;
    expect(paused.resetsAt).toBeUndefined();
    expect(paused.waitDeadline).toBeInstanceOf(Date);
    expect(events[1]).toMatchObject({ type: 'resumed', hotSwapped: true });
    expect(events[2]).toMatchObject({ type: 'turn.completed' });
  });

  it('re-limits once then succeeds on second probe', async () => {
    vi.useFakeTimers();
    waitForHotSwapMock
      .mockResolvedValueOnce('timer')
      .mockResolvedValueOnce('timer');
    const ctx = makeCtx(true);
    const input = makeInput();
    const pending: ProviderEvent = { type: 'error', error: makeError() };

    const promise = drain(
      usageLimitNoTimestampPause(ctx, input, () => false, nextReLimited(), pending),
    );
    await vi.advanceTimersByTimeAsync(200);
    const events = await promise;

    // paused, then resumed after second probe
    expect(events[0]?.type).toBe('paused');
    expect(events[1]?.type).toBe('resumed');
    expect(events[2]?.type).toBe('turn.completed');
  });

  it('surfaces error after cap with no hot-swap', async () => {
    vi.useFakeTimers();
    // Always timer result (no hot-swap, limit never lifts)
    waitForHotSwapMock.mockImplementation(() => {
      // Advance time so the cap check fires
      vi.advanceTimersByTime(TWO_HOURS_MS + 1);
      return Promise.resolve('timer' as const);
    });
    const ctx = makeCtx(true);
    const input = makeInput();
    const pending: ProviderEvent = { type: 'error', error: makeError() };
    const alwaysReLimited: TierGenerator = async function* () {
      const e = makeReLimitedError();
      yield { type: 'error', error: e };
    };

    const events = await drain(
      usageLimitNoTimestampPause(ctx, input, () => false, alwaysReLimited, pending),
    );

    expect(events[0]?.type).toBe('paused');
    expect(events[events.length - 1]?.type).toBe('error');
    expect((ctx as RetryTierContext & { _markStale: ReturnType<typeof vi.fn> })._markStale).toHaveBeenCalled();
  });

  it('returns without replay when aborted', async () => {
    vi.useFakeTimers();
    waitForHotSwapMock.mockResolvedValue('aborted');
    const ctx = makeCtx(true);
    const input = makeInput();
    const pending: ProviderEvent = { type: 'error', error: makeError() };

    const promise = drain(
      usageLimitNoTimestampPause(ctx, input, () => false, nextOk(), pending),
    );
    await vi.advanceTimersByTimeAsync(100);
    const events = await promise;

    // paused, then nothing (aborted)
    expect(events[0]?.type).toBe('paused');
    expect(events).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// usageLimitResetPause — far-reset cases
// ---------------------------------------------------------------------------

describe('usageLimitResetPause — far-reset', () => {
  function farResetsAt(): Date {
    return new Date(Date.now() + TWO_HOURS_MS + 60_000);
  }

  it('far-reset + autoResume=false: surfaces the error immediately with no paused (unchanged behavior)', async () => {
    const ctx = makeCtx(false);
    const input = makeInput();
    const pending: ProviderEvent = { type: 'error', error: makeError() };

    const events = await drain(
      usageLimitResetPause(ctx, input, () => false, nextOk(), pending, farResetsAt()),
    );

    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('error');
    expect(waitForHotSwapMock).not.toHaveBeenCalled();
    expect((ctx as RetryTierContext & { _markStale: ReturnType<typeof vi.fn> })._markStale).toHaveBeenCalled();
  });

  it('far-reset + autoResume=true: emits paused with no resetsAt and waitDeadline', async () => {
    vi.useFakeTimers();
    waitForHotSwapMock.mockResolvedValue('hot-swap');
    const ctx = makeCtx(true);
    (ctx as RetryTierContext & { _forceRefresh: ReturnType<typeof vi.fn> })._forceRefresh.mockResolvedValue({
      accountId: 'acct:tok-b',
      oldAccountId: 'acct:tok-a',
      swapped: true,
    });
    const input = makeInput();
    const pending: ProviderEvent = { type: 'error', error: makeError() };

    const promise = drain(
      usageLimitResetPause(ctx, input, () => false, nextOk(), pending, farResetsAt()),
    );
    await vi.advanceTimersByTimeAsync(100);
    const events = await promise;

    expect(events[0]).toMatchObject({ type: 'paused', reason: 'usage-limit', autoResume: true });
    const paused = events[0] as Extract<ProviderEvent, { type: 'paused' }>;
    // Must NOT show the real far resetsAt (days away)
    expect(paused.resetsAt).toBeUndefined();
    // Must have waitDeadline ≈ now + 2h
    expect(paused.waitDeadline).toBeInstanceOf(Date);
    expect(events[1]).toMatchObject({ type: 'resumed', hotSwapped: true });
    expect(events[2]).toMatchObject({ type: 'turn.completed' });
  });

  it('far-reset + autoResume=true: no swap within cap surfaces error', async () => {
    vi.useFakeTimers();
    waitForHotSwapMock.mockImplementation(() => {
      vi.advanceTimersByTime(TWO_HOURS_MS + 1);
      return Promise.resolve('timer' as const);
    });
    const ctx = makeCtx(true);
    const input = makeInput();
    const pending: ProviderEvent = { type: 'error', error: makeError() };
    const alwaysReLimited: TierGenerator = async function* () {
      const e = makeReLimitedError();
      yield { type: 'error', error: e };
    };

    const events = await drain(
      usageLimitResetPause(ctx, input, () => false, alwaysReLimited, pending, farResetsAt()),
    );

    expect(events[0]?.type).toBe('paused');
    expect(events[events.length - 1]?.type).toBe('error');
    expect((ctx as RetryTierContext & { _markStale: ReturnType<typeof vi.fn> })._markStale).toHaveBeenCalled();
  });

  it('far-reset + autoResume=true: abort returns without replay', async () => {
    vi.useFakeTimers();
    waitForHotSwapMock.mockResolvedValue('aborted');
    const ctx = makeCtx(true);
    const input = makeInput();
    const pending: ProviderEvent = { type: 'error', error: makeError() };

    const promise = drain(
      usageLimitResetPause(ctx, input, () => false, nextOk(), pending, farResetsAt()),
    );
    await vi.advanceTimersByTimeAsync(100);
    const events = await promise;

    expect(events[0]?.type).toBe('paused');
    expect(events).toHaveLength(1);
  });

  it('far-reset trace emits farReset:true in metadata', async () => {
    vi.useFakeTimers();
    waitForHotSwapMock.mockResolvedValue('aborted');
    const ctx = makeCtx(true);
    const input = makeInput();
    const pending: ProviderEvent = { type: 'error', error: makeError() };
    const rs = farResetsAt();

    const promise = drain(
      usageLimitResetPause(ctx, input, () => false, nextOk(), pending, rs),
    );
    await vi.advanceTimersByTimeAsync(100);
    await promise;

    const phaseCall = emitSessionPhaseMock.mock.calls.find(
      (c) => c[1]?.phase === 'usage_limit_pause',
    );
    expect(phaseCall).toBeDefined();
    expect(phaseCall![1].metadata).toMatchObject({ farReset: true, hasResetTimestamp: true });
  });
});

// ---------------------------------------------------------------------------
// usageLimitResetPause — within-2h cases (behavior unchanged)
// ---------------------------------------------------------------------------

describe('usageLimitResetPause — within-2h', () => {
  function nearResetsAt(): Date {
    return new Date(Date.now() + 30 * 60_000);
  }

  it('within-2h + autoResume=true: waits for timer then resumes', async () => {
    vi.useFakeTimers();
    waitForResetMock.mockResolvedValue('timer');
    const ctx = makeCtx(true);
    const input = makeInput();
    const pending: ProviderEvent = { type: 'error', error: makeError() };

    const promise = drain(
      usageLimitResetPause(ctx, input, () => false, nextOk(), pending, nearResetsAt()),
    );
    await vi.advanceTimersByTimeAsync(100);
    const events = await promise;

    expect(events[0]).toMatchObject({ type: 'paused', reason: 'usage-limit', autoResume: true });
    const paused = events[0] as Extract<ProviderEvent, { type: 'paused' }>;
    expect(paused.resetsAt).toBeInstanceOf(Date);
    expect(events[1]).toMatchObject({ type: 'resumed', hotSwapped: false });
    expect(events[2]).toMatchObject({ type: 'turn.completed' });
  });

  it('within-2h + autoResume=false: surfaces error immediately', async () => {
    const ctx = makeCtx(false);
    const input = makeInput();
    const pending: ProviderEvent = { type: 'error', error: makeError() };

    const events = await drain(
      usageLimitResetPause(ctx, input, () => false, nextOk(), pending, nearResetsAt()),
    );

    expect(events).toHaveLength(2); // paused + error
    expect(events[0]?.type).toBe('paused');
    expect(events[1]?.type).toBe('error');
    expect((ctx as RetryTierContext & { _markStale: ReturnType<typeof vi.fn> })._markStale).toHaveBeenCalled();
  });
});
