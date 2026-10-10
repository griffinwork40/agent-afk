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

const { usageLimitNoTimestampPause, usageLimitResetPause, joinUsageLimitWait } = await import('./usage-limit-pause.js');
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

function makeCtx(autoResume: boolean, clientToken: string | null = 'tok-a'): RetryTierContext {
  const markStale = vi.fn();
  const forceRefresh = vi.fn<[], Promise<{ accountId: string; oldAccountId: string; swapped: boolean } | null>>();
  let waitPromise: Promise<'aborted' | 'timer' | 'hot-swap'> | null = null;
  return {
    authMode: 'oauth',
    surface: 'repl',
    autoResumeOnUsageLimit: autoResume,
    tokenRefresher: undefined,
    getClient: () => ({}) as never,
    getClientToken: () => clientToken ?? undefined,
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
  // resetAllMocks (not clearAllMocks) so that mockResolvedValueOnce /
  // mockReturnValueOnce queues from the previous test do not survive into
  // the next one. clearAllMocks only resets call history; it leaves queued
  // once-entries intact, so a test that sets
  //   waitForHotSwapMock.mockResolvedValueOnce('timer')
  // can poison the next test's waitForHotSwap call with an already-resolved
  // promise, causing runHotSwapParkLoop's finally-block to clear the wait
  // slot before the next test's synchronous assertions can observe it
  // (issue #3463).
  vi.resetAllMocks();
  loadClaudeCodeOauthTokenMock.mockReturnValue('tok-a');
  parseAccountIdentifierMock.mockImplementation((t) => `acct:${t}`);
  emitSessionPhaseMock.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// joinUsageLimitWait
// ---------------------------------------------------------------------------

describe('joinUsageLimitWait', () => {
  it('passes through the owner result', async () => {
    const signal = new AbortController().signal;
    await expect(joinUsageLimitWait(Promise.resolve('hot-swap'), signal)).resolves.toBe('hot-swap');
    await expect(joinUsageLimitWait(Promise.resolve('timer'), signal)).resolves.toBe('timer');
  });

  it('preserves terminal owner abort while our signal is live', async () => {
    const signal = new AbortController().signal;
    await expect(joinUsageLimitWait(Promise.resolve('aborted'), signal)).resolves.toBe('aborted');
  });

  it('resolves aborted immediately on OUR abort, without waiting for the owner', async () => {
    const ac = new AbortController();
    const never = new Promise<'timer'>(() => {});
    const joined = joinUsageLimitWait(never, ac.signal);
    ac.abort();
    await expect(joined).resolves.toBe('aborted');
  });

  it('resolves aborted when our signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(joinUsageLimitWait(Promise.resolve('timer'), ac.signal)).resolves.toBe('aborted');
  });
});

type WaitResult = 'timer' | 'hot-swap' | 'aborted';
function deferred() {
  let resolve!: (value: WaitResult) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<WaitResult>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

for (const family of ['no-ts', 'far-reset', 'timestamped'] as const) {
  describe(`${family} shared wait contract`, () => {
    function park(ctx: RetryTierContext, input: RunTurnInput, next = nextOk()) {
      const pending: ProviderEvent = { type: 'error', error: makeError() };
      return family === 'no-ts'
        ? usageLimitNoTimestampPause(ctx, input, () => false, next, pending)
        : usageLimitResetPause(ctx, input, () => false, next, pending,
          new Date(Date.now() + (family === 'far-reset' ? TWO_HOURS_MS + 60_000 : 60_000)));
    }
    function mockWait(promise: Promise<WaitResult>) {
      (family === 'timestamped' ? waitForResetMock : waitForHotSwapMock).mockReturnValue(promise);
    }

    it.each(['timer', 'hot-swap', 'aborted'] as const)('joins pending %s without clearing the owner', async (result) => {
      const ctx = makeCtx(true);
      const wait = deferred();
      ctx.setUsageLimitWait(wait.promise);
      const refresh = vi.spyOn(ctx, 'forceClientRefresh').mockResolvedValue({ accountId: 'acct:new', oldAccountId: 'acct:old', swapped: true });
      let calls = 0;
      const next: TierGenerator = async function* () { calls++; yield cleanDone; };
      const gen = park(ctx, makeInput(), next);
      expect((await gen.next()).value).toMatchObject({ type: 'paused' });
      let settled = false;
      const pending = drain(gen).then((events) => { settled = true; return events; });
      await Promise.resolve();
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(calls).toBe(0);
      wait.resolve(result);
      const events = await pending;
      expect(ctx.getUsageLimitWait()).toBe(wait.promise);
      expect(waitForHotSwapMock).not.toHaveBeenCalled();
      expect(waitForResetMock).not.toHaveBeenCalled();
      expect(calls).toBe(result === 'aborted' ? 0 : 1);
      expect(refresh).toHaveBeenCalledTimes(result === 'hot-swap' ? 1 : 0);
      expect(events.map((e) => e.type)).toEqual(result === 'aborted' ? [] : ['resumed', 'turn.completed']);
      if (result === 'aborted') expect(emitSessionPhaseMock.mock.calls.some((c) => c[1]?.phase === 'usage_limit_resume')).toBe(false);
    });

    it.each([false, true])('owner cleanup preserves replacement=%s', async (replace) => {
      const ctx = makeCtx(true);
      const wait = deferred();
      const replacement = deferred().promise;
      mockWait(wait.promise);
      const gen = park(ctx, makeInput());
      await gen.next();
      const pending = drain(gen);
      await Promise.resolve();
      expect(ctx.getUsageLimitWait()).toBe(wait.promise);
      if (replace) ctx.setUsageLimitWait(replacement);
      wait.resolve('aborted');
      expect(await pending).toEqual([]);
      expect(ctx.getUsageLimitWait()).toBe(replace ? replacement : null);
    });

    it.each([false, true])('propagates rejected wait (joined=%s)', async (joined) => {
      const ctx = makeCtx(true);
      const wait = deferred();
      if (joined) ctx.setUsageLimitWait(wait.promise);
      else mockWait(wait.promise);
      const gen = park(ctx, makeInput());
      await gen.next();
      const failure = new Error('wait failed');
      const pending = expect(drain(gen)).rejects.toBe(failure);
      wait.reject(failure);
      await pending;
      expect(ctx.getUsageLimitWait()).toBe(joined ? wait.promise : null);
    });

    it.each(['timer', 'success', 'null', 'rejected'] as const)('preserves header rotation for %s refresh', async (mode) => {
      const ctx = makeCtx(true);
      const fresh = { id: 'fresh' } as never;
      ctx.getClient = () => fresh;
      const input = makeInput();
      const old = input.client;
      const rotation = vi.spyOn(ctx, 'rotateHeaders').mockImplementation((adopted) => {
        expect(adopted.client).toBe(mode === 'success' ? fresh : old);
        return { 'x-request-id': 'rotated' };
      });
      const failure = new Error('refresh failed');
      const refresh = vi.spyOn(ctx, 'forceClientRefresh');
      if (mode === 'rejected') refresh.mockRejectedValue(failure);
      else refresh.mockResolvedValue(mode === 'success' ? { accountId: 'acct:new', oldAccountId: 'acct:old', swapped: true } : null);
      mockWait(Promise.resolve(mode === 'timer' ? 'timer' : 'hot-swap'));
      if (mode === 'rejected') {
        await expect(drain(park(ctx, input))).rejects.toBe(failure);
        expect(rotation).not.toHaveBeenCalled();
      } else {
        await drain(park(ctx, input));
        expect(rotation).toHaveBeenCalledTimes(1);
        expect(input.headers).toEqual({ 'x-request-id': 'rotated' });
        expect(refresh).toHaveBeenCalledTimes(mode === 'timer' ? 0 : 1);
      }
    });

    it('labels pause and same-account resume from the active token without exposing credentials', async () => {
      const active = 'synthetic-active-secret';
      const stored = 'synthetic-store-secret';
      loadClaudeCodeOauthTokenMock.mockReturnValue(stored);
      parseAccountIdentifierMock.mockImplementation((token) => token === active ? 'account-A' : 'account-B');
      mockWait(Promise.resolve('timer'));
      const events = await drain(park(makeCtx(true, active), makeInput()));
      expect(events[0]).toMatchObject({ type: 'paused', accountId: 'account-A' });
      expect(events[1]).toMatchObject({ type: 'resumed', accountId: 'account-A' });
      expect(loadClaudeCodeOauthTokenMock).not.toHaveBeenCalled();
      const payload = JSON.stringify([events, emitSessionPhaseMock.mock.calls]);
      expect(payload).not.toContain(active);
      expect(payload).not.toContain(stored);
    });

    if (family !== 'timestamped') it('does not look up omitted account identity on fail-fast', async () => {
      await drain(park(makeCtx(false, null), makeInput()));
      expect(loadClaudeCodeOauthTokenMock).not.toHaveBeenCalled();
      expect(parseAccountIdentifierMock).not.toHaveBeenCalled();
    });
  });
}

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

  it('names the account the LIVE CLIENT uses, not the store, in the paused event', async () => {
    // The operator ran `claude login` (store = tok-b) but the session's client
    // still holds tok-a: the panel must say which account is actually limited.
    loadClaudeCodeOauthTokenMock.mockReturnValue('tok-b');
    waitForHotSwapMock.mockResolvedValue('aborted');
    const ctx = makeCtx(true, 'tok-a');
    const events = await drain(
      usageLimitNoTimestampPause(ctx, makeInput(), () => false, nextOk(), { type: 'error', error: makeError() }),
    );
    expect(events[0]).toMatchObject({ type: 'paused', accountId: 'acct:tok-a' });
  });

  it('returns api-key sentinel when the client token is unknown (api-key mode)', async () => {
    // liveAccountId no longer reads the store when getClientToken() is undefined.
    // Passing null clientToken (api-key mode) should yield the 'api-key' sentinel.
    loadClaudeCodeOauthTokenMock.mockReturnValue('tok-b');
    waitForHotSwapMock.mockResolvedValue('aborted');
    const ctx = makeCtx(true, null);
    const events = await drain(
      usageLimitNoTimestampPause(ctx, makeInput(), () => false, nextOk(), { type: 'error', error: makeError() }),
    );
    expect(events[0]).toMatchObject({ type: 'paused', accountId: 'api-key' });
    expect(loadClaudeCodeOauthTokenMock).not.toHaveBeenCalled();
  });

  it('joins a concurrent in-flight wait and probes, instead of ending the turn silently', async () => {
    // Regression: an in-flight wait used to map to 'aborted', so the park
    // loop returned with NO event: no resume, no error, no output.
    const ctx = makeCtx(true);
    ctx.setUsageLimitWait(Promise.resolve('timer'));
    let calls = 0;
    const next: TierGenerator = async function* () { calls++; yield cleanDone; };
    const events = await drain(
      usageLimitNoTimestampPause(ctx, makeInput(), () => false, next, { type: 'error', error: makeError() }),
    );
    expect(waitForHotSwapMock).not.toHaveBeenCalled();
    expect(calls).toBe(1);
    expect(events.map((e) => e.type)).toEqual(['paused', 'resumed', 'turn.completed']);
  });

  it('treats the wait OWNER being aborted as terminal', async () => {
    const ctx = makeCtx(true);
    ctx.setUsageLimitWait(Promise.resolve('aborted'));
    let calls = 0;
    const next: TierGenerator = async function* () { calls++; yield cleanDone; };
    const events = await drain(
      usageLimitNoTimestampPause(ctx, makeInput(), () => false, next, { type: 'error', error: makeError() }),
    );
    expect(calls).toBe(0);
    expect(events.map((e) => e.type)).toEqual(['paused']);
  });

  it('does not falsely resume when the re-limited probe emits its throttle signal first', async () => {
    // Regression (witness bda55f9e, 2026-10-08): the probe's own 429 pushes a
    // live `rate_limit` event (tracing-fetch → throttle-signals) BEFORE the
    // `error`. The peek treated it as "limit lifted", emitted `resumed`, and
    // leaked the raw 429 instead of staying parked.
    vi.useFakeTimers();
    waitForHotSwapMock.mockResolvedValue('timer');
    const ctx = makeCtx(true);
    const input = makeInput();
    const pending: ProviderEvent = { type: 'error', error: makeError() };
    let calls = 0;
    const throttleThenLimited: TierGenerator = async function* () {
      calls++;
      if (calls === 1) {
        yield { type: 'rate_limit', sessionId: 's1', status: 429, attempt: 1, retryAfterMs: 219_324_000 };
        yield { type: 'error', error: makeReLimitedError() };
        return;
      }
      yield cleanDone;
    };

    const promise = drain(
      usageLimitNoTimestampPause(ctx, input, () => false, throttleThenLimited, pending),
    );
    await vi.advanceTimersByTimeAsync(200);
    const events = await promise;

    expect(calls).toBe(2);
    expect(events.map((e) => e.type)).toEqual(['paused', 'resumed', 'turn.completed']);
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
