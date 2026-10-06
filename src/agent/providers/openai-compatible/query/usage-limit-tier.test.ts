/**
 * Unit tests for the openai-compatible usage/quota-limit tier (#2418).
 *
 * Tests cover:
 *   - `isQuotaLimitErrorEvent` classification (by status + retry-after magnitude)
 *   - `runIterationWithQuotaLimitPause` behavior:
 *       • clean pass-through when no quota-429 occurs
 *       • auto-resume=true: parks, sleeps retry-after, replays, emits paused/resumed
 *       • auto-resume=false: emits paused + error without replaying
 *       • abort during wait: returns null
 *       • two-hour cap: surfaces error after budget exhausted
 *       • no-retry-after fallback wait
 *       • re-limited after resume: stays paused, retries again
 *
 * All timing is controlled via fake timers — no real waits.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ProviderEvent } from '../../../provider.js';
import {
  isQuotaLimitErrorEvent,
  runIterationWithQuotaLimitPause,
  QUOTA_TRANSIENT_THRESHOLD_MS,
  __setQuotaTwoHoursMs,
  __setQuotaFallbackWaitMs,
  __setQuotaTransientThresholdMs,
} from './usage-limit-tier.js';
import type { IterationResult } from './stream-drive.js';
import { createStreamState } from '../translate.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeApiError(status: number, headers?: Record<string, string>): Error {
  const e = new Error(`http ${status}`) as Error & { status: number; headers?: unknown };
  e.status = status;
  if (headers !== undefined) e.headers = headers;
  return e;
}

function quotaErrorEvent(retryAfterSec?: number): ProviderEvent {
  const headers = retryAfterSec !== undefined
    ? { 'retry-after': String(retryAfterSec) }
    : undefined;
  return { type: 'error', error: makeApiError(429, headers) };
}

function textEvent(): ProviderEvent {
  return { type: 'assistant.message', text: 'hello', sessionId: 's1' };
}

/** A synthetic "success" IterationResult. */
function successResult(): IterationResult {
  const state = createStreamState();
  state.finishReason = 'stop';
  return { state, events: [], text: 'done', needsToolDispatch: false };
}

/** Build a simple generator that yields events and returns a result. */
function makeGen(
  events: ProviderEvent[],
  result: IterationResult | null,
): () => AsyncGenerator<ProviderEvent, IterationResult | null> {
  return function* () {
    for (const e of events) yield e;
    return result;
  } as unknown as () => AsyncGenerator<ProviderEvent, IterationResult | null>;
}

/** Collect yielded events and the return value from the tier. */
async function runTier(
  makeIteration: () => AsyncGenerator<ProviderEvent, IterationResult | null>,
  opts: Partial<Parameters<typeof runIterationWithQuotaLimitPause>[1]> = {},
): Promise<{ events: ProviderEvent[]; result: IterationResult | null }> {
  const ctrl = new AbortController();
  const tier = runIterationWithQuotaLimitPause(makeIteration, {
    autoResumeOnUsageLimit: true,
    traceWriter: undefined,
    signal: ctrl.signal,
    isClosed: () => false,
    sessionId: 'test-session',
    ...opts,
  });
  const events: ProviderEvent[] = [];
  let result: IterationResult | null = null;
  for (;;) {
    const step = await tier.next();
    if (step.done) { result = step.value; break; }
    events.push(step.value);
  }
  return { events, result };
}

// ---------------------------------------------------------------------------
// isQuotaLimitErrorEvent
// ---------------------------------------------------------------------------

describe('isQuotaLimitErrorEvent', () => {
  it('returns false for non-error events', () => {
    expect(isQuotaLimitErrorEvent({ type: 'session.init', info: {} as never })).toBe(false);
    expect(isQuotaLimitErrorEvent({ type: 'assistant.message', text: 'x', sessionId: 's' })).toBe(false);
  });

  it('returns false for non-429 error events', () => {
    expect(isQuotaLimitErrorEvent({ type: 'error', error: makeApiError(500) })).toBe(false);
    expect(isQuotaLimitErrorEvent({ type: 'error', error: makeApiError(503) })).toBe(false);
    expect(isQuotaLimitErrorEvent({ type: 'error', error: makeApiError(400) })).toBe(false);
  });

  it('returns false for 429 with short retry-after (transient rate-limit)', () => {
    // 30s — well under the 5-minute threshold
    const ev = { type: 'error' as const, error: makeApiError(429, { 'retry-after': '30' }) };
    expect(isQuotaLimitErrorEvent(ev)).toBe(false);
  });

  it('returns false for 429 at exactly the threshold', () => {
    const thresholdSec = QUOTA_TRANSIENT_THRESHOLD_MS / 1000;
    const ev = { type: 'error' as const, error: makeApiError(429, { 'retry-after': String(thresholdSec) }) };
    expect(isQuotaLimitErrorEvent(ev)).toBe(false);
  });

  it('returns true for 429 with long retry-after (quota/billing limit)', () => {
    // 10 minutes — above the 5-minute threshold
    const ev = { type: 'error' as const, error: makeApiError(429, { 'retry-after': '600' }) };
    expect(isQuotaLimitErrorEvent(ev)).toBe(true);
  });

  it('returns false for 429 with no retry-after at all (ambiguous; let connection retry handle)', () => {
    // No header → ambiguous; the connection-phase retry loop handles it with exponential backoff.
    // Only a PRESENT and LONG retry-after triggers the quota-limit park.
    const ev = { type: 'error' as const, error: makeApiError(429) };
    expect(isQuotaLimitErrorEvent(ev)).toBe(false);
  });

  it('honors retry-after-ms header (prefers over retry-after)', () => {
    // 10 min in ms
    const ev = { type: 'error' as const, error: makeApiError(429, { 'retry-after-ms': '600000' }) };
    expect(isQuotaLimitErrorEvent(ev)).toBe(true);
    // 30s in ms → transient
    const ev2 = { type: 'error' as const, error: makeApiError(429, { 'retry-after-ms': '30000' }) };
    expect(isQuotaLimitErrorEvent(ev2)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// runIterationWithQuotaLimitPause — clean pass-through
// ---------------------------------------------------------------------------

describe('runIterationWithQuotaLimitPause — clean pass-through', () => {
  it('yields events and result unchanged when no quota-429 occurs', async () => {
    const { events, result } = await runTier(
      makeGen([textEvent()], successResult()),
    );
    expect(events).toEqual([textEvent()]);
    expect(result?.text).toBe('done');
  });

  it('passes through non-quota error events (e.g. 500)', async () => {
    const errEvent: ProviderEvent = { type: 'error', error: makeApiError(500) };
    const { events, result } = await runTier(
      makeGen([errEvent], null),
    );
    expect(events).toEqual([errEvent]);
    expect(result).toBeNull();
  });

  it('passes through short-retry-after 429 (transient rate-limit)', async () => {
    // 60s retry-after → transient → pass through
    const errEvent: ProviderEvent = {
      type: 'error',
      error: makeApiError(429, { 'retry-after': '60' }),
    };
    const { events, result } = await runTier(
      makeGen([errEvent], null),
    );
    expect(events).toEqual([errEvent]);
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runIterationWithQuotaLimitPause — auto-resume=true (fake timers)
// ---------------------------------------------------------------------------

describe('runIterationWithQuotaLimitPause — auto-resume=true', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __setQuotaTwoHoursMs(null);
    __setQuotaFallbackWaitMs(null);
    __setQuotaTransientThresholdMs(null);
  });

  afterEach(() => {
    vi.useRealTimers();
    __setQuotaTwoHoursMs(null);
    __setQuotaFallbackWaitMs(null);
    __setQuotaTransientThresholdMs(null);
  });

  it('emits paused then resumed and returns the replayed result', async () => {
    // First call: quota-429 with 10min retry-after. Second: success.
    let callCount = 0;
    const factory = (): AsyncGenerator<ProviderEvent, IterationResult | null> => {
      callCount++;
      if (callCount === 1) {
        return (function* () {
          yield quotaErrorEvent(600); // 10 min
          return null;
        })() as unknown as AsyncGenerator<ProviderEvent, IterationResult | null>;
      }
      return (function* () {
        yield textEvent();
        return successResult();
      })() as unknown as AsyncGenerator<ProviderEvent, IterationResult | null>;
    };

    const tierPromise = runTier(factory);
    // Advance past 10min retry-after
    await vi.advanceTimersByTimeAsync(600_001);
    const { events, result } = await tierPromise;

    expect(callCount).toBe(2);
    const paused = events.filter((e) => e.type === 'paused');
    const resumed = events.filter((e) => e.type === 'resumed');
    expect(paused).toHaveLength(1);
    expect((paused[0] as Extract<ProviderEvent, { type: 'paused' }>).reason).toBe('usage-limit');
    expect((paused[0] as Extract<ProviderEvent, { type: 'paused' }>).autoResume).toBe(true);
    expect(resumed).toHaveLength(1);
    expect(result?.text).toBe('done');
  });

  it('waits the retry-after duration before probing (budget large enough to allow probe)', async () => {
    // threshold=500ms, budget=3000ms, retry-after=1s (1000ms):
    //   1000ms > 500ms → classified as quota (not transient).
    //   wait = Math.min(1000ms, 3000ms) = 1000ms.
    //   After sleeping 1000ms: elapsed ≈ 1000ms < budget (3000ms) → >= check false → probe fires.
    __setQuotaTransientThresholdMs(500);
    __setQuotaTwoHoursMs(3000);

    let callCount = 0;
    const factory = (): AsyncGenerator<ProviderEvent, IterationResult | null> => {
      callCount++;
      if (callCount === 1) {
        return (function* () {
          yield quotaErrorEvent(1); // 1s retry-after > 500ms threshold → quota
          return null;
        })() as unknown as AsyncGenerator<ProviderEvent, IterationResult | null>;
      }
      return (function* () {
        yield textEvent();
        return successResult();
      })() as unknown as AsyncGenerator<ProviderEvent, IterationResult | null>;
    };

    const tierPromise = runTier(factory);
    // Advance past the 1000ms sleep.
    await vi.advanceTimersByTimeAsync(2000);
    const { events, result } = await tierPromise;

    expect(callCount).toBe(2);
    expect(events.some((e) => e.type === 'paused')).toBe(true);
    expect(events.some((e) => e.type === 'resumed')).toBe(true);
    expect(result?.text).toBe('done');
  });

  it('stays paused (no second "resumed") when re-limited after first probe', async () => {
    // Use small values so timers are fast.
    // threshold=500ms: classify 1s retry-after as quota (1000ms > 500ms).
    // budget=3000ms: allows 2 full probes before cap (2×1000ms=2000ms < 3000ms).
    // wait=Math.min(1000ms, 3000ms)=1000ms.
    //   Probe 1: sleep 1000ms, elapsed≈1000ms < 3000ms → probe 2.
    //   Probe 2: sleep 1000ms, elapsed≈2000ms < 3000ms → probe 3 (success).
    //   Advances needed: 1000ms + 1000ms = 2000ms. Use 1100ms each for safety.
    __setQuotaTransientThresholdMs(500); // 1s retry-after (1000ms) > 500ms → quota
    __setQuotaTwoHoursMs(3000);          // budget: 3000ms > 2×1000ms

    let count = 0;
    const factory = (): AsyncGenerator<ProviderEvent, IterationResult | null> => {
      count++;
      if (count < 3) {
        return (function* () {
          yield quotaErrorEvent(1); // 1s retry-after → above 500ms threshold → quota
          return null;
        })() as unknown as AsyncGenerator<ProviderEvent, IterationResult | null>;
      }
      return (function* () {
        yield textEvent();
        return successResult();
      })() as unknown as AsyncGenerator<ProviderEvent, IterationResult | null>;
    };

    const tierPromise = runTier(factory);
    // 2 sleeps of 1000ms each = 2000ms total. Advance 1100ms × 2 = 2200ms.
    await vi.advanceTimersByTimeAsync(1100);
    await vi.advanceTimersByTimeAsync(1100);
    const { events, result } = await tierPromise;

    expect(count).toBe(3);
    // Only one paused event (emitted once on first quota-429)
    const paused = events.filter((e) => e.type === 'paused');
    expect(paused).toHaveLength(1);
    // Only one resumed event (emitted when the limit finally lifted on probe 3)
    const resumed = events.filter((e) => e.type === 'resumed');
    expect(resumed).toHaveLength(1);
    expect(result?.text).toBe('done');
  });

  it('surfaces error (not parks) when abort fires during wait', async () => {
    const ctrl = new AbortController();

    const factory = (): AsyncGenerator<ProviderEvent, IterationResult | null> => {
      return (function* () {
        yield quotaErrorEvent(600);
        return null;
      })() as unknown as AsyncGenerator<ProviderEvent, IterationResult | null>;
    };

    const tier = runIterationWithQuotaLimitPause(factory, {
      autoResumeOnUsageLimit: true,
      traceWriter: undefined,
      signal: ctrl.signal,
      isClosed: () => false,
      sessionId: 's',
    });

    const collectPromise = (async () => {
      const evs: ProviderEvent[] = [];
      let returnVal: IterationResult | null = null;
      for (;;) {
        const step = await tier.next();
        if (step.done) { returnVal = step.value; break; }
        evs.push(step.value);
      }
      return { evs, returnVal };
    })();

    // Let the first iteration fire, then abort mid-wait
    await vi.advanceTimersByTimeAsync(100);
    ctrl.abort();
    await vi.advanceTimersByTimeAsync(100);

    const { evs, returnVal } = await collectPromise;
    // Tier should return null (aborted) without emitting resumed or the quota error
    expect(returnVal).toBeNull();
    // paused was emitted before the abort
    expect(evs.some((e) => e.type === 'paused')).toBe(true);
    // resumed was NOT emitted (we aborted before the replay)
    expect(evs.some((e) => e.type === 'resumed')).toBe(false);
  });

  it('surfaces error after two-hour cap is exhausted', async () => {
    __setQuotaTwoHoursMs(500); // tiny budget for testing

    let callCount = 0;
    const factory = (): AsyncGenerator<ProviderEvent, IterationResult | null> => {
      callCount++;
      return (function* () {
        yield quotaErrorEvent(600); // always quota
        return null;
      })() as unknown as AsyncGenerator<ProviderEvent, IterationResult | null>;
    };

    const tierPromise = runTier(factory);
    // Sleep past the budget. Factory returns quota every time, budget will expire.
    await vi.advanceTimersByTimeAsync(600_000);
    await vi.advanceTimersByTimeAsync(600_000);
    const { events, result } = await tierPromise;

    // Result is null (error surfaced via yield, not return)
    expect(result).toBeNull();
    // A quota error was yielded when cap hit
    const errs = events.filter((e) => e.type === 'error');
    expect(errs.length).toBeGreaterThan(0);
  });

  it('caps at exact two-hour equality (>= boundary, not just >)', async () => {
    // Budget set to the same value as the wait, so elapsed === budget exactly
    // at the post-sleep re-check. With strict >, this probe would re-fire;
    // with >=, the error is surfaced without an extra iteration.
    const BUDGET = 1000;
    __setQuotaTwoHoursMs(BUDGET);
    __setQuotaFallbackWaitMs(BUDGET); // sleep exactly 1000ms = budget

    let callCount = 0;
    const factory = (): AsyncGenerator<ProviderEvent, IterationResult | null> => {
      callCount++;
      return (function* () {
        yield quotaErrorEvent(600); // always quota (no retry-after)
        return null;
      })() as unknown as AsyncGenerator<ProviderEvent, IterationResult | null>;
    };

    const tierPromise = runTier(factory);
    await vi.advanceTimersByTimeAsync(BUDGET); // advance exactly to the boundary
    const { events, result } = await tierPromise;

    expect(result).toBeNull();
    // Error must have been yielded (cap fired at equality)
    const errs = events.filter((e) => e.type === 'error');
    expect(errs.length).toBeGreaterThan(0);
    // Only one probe should have fired (the cap applied at the post-sleep check)
    expect(callCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// runIterationWithQuotaLimitPause — auto-resume=false
// ---------------------------------------------------------------------------

describe('runIterationWithQuotaLimitPause — autoResumeOnUsageLimit=false', () => {
  it('emits paused(autoResume:false) then the error event without replaying', async () => {
    let callCount = 0;
    const factory = (): AsyncGenerator<ProviderEvent, IterationResult | null> => {
      callCount++;
      return (function* () {
        yield quotaErrorEvent(600);
        return null;
      })() as unknown as AsyncGenerator<ProviderEvent, IterationResult | null>;
    };

    const { events, result } = await runTier(factory, {
      autoResumeOnUsageLimit: false,
    });

    // Exactly one call — no replay
    expect(callCount).toBe(1);
    expect(result).toBeNull();

    const paused = events.filter((e) => e.type === 'paused') as Extract<ProviderEvent, { type: 'paused' }>[];
    const errs = events.filter((e) => e.type === 'error');
    expect(paused).toHaveLength(1);
    expect(paused[0]?.autoResume).toBe(false);
    expect(errs).toHaveLength(1);
    // No resumed event when fail-fast
    expect(events.some((e) => e.type === 'resumed')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ChatGPT/Codex `usage_limit_reached` (no retry-after; reset in the body)
// ---------------------------------------------------------------------------

function chatGptLimitEvent(resetsInSec: number, status: number | undefined = 429): ProviderEvent {
  const body = {
    type: 'usage_limit_reached',
    message: 'The usage limit has been reached',
    plan_type: 'plus',
    resets_at: Math.floor(Date.now() / 1000) + resetsInSec,
    resets_in_seconds: resetsInSec,
  };
  const e = Object.assign(new Error('429 The usage limit has been reached'), {
    status,
    error: body,
    type: 'usage_limit_reached',
  });
  return { type: 'error', error: e };
}

type PausedEv = Extract<ProviderEvent, { type: 'paused' }>;

describe('runIterationWithQuotaLimitPause — ChatGPT usage_limit_reached', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
    __setQuotaTwoHoursMs(null);
    __setQuotaFallbackWaitMs(null);
  });

  it('isQuotaLimitErrorEvent matches the marker with no retry-after, with or without a status', () => {
    expect(isQuotaLimitErrorEvent(chatGptLimitEvent(600))).toBe(true);
    expect(isQuotaLimitErrorEvent(chatGptLimitEvent(600, undefined))).toBe(true);
  });

  it('parks until the body reset time, emitting paused with resetsAt, provider codex and plan', async () => {
    let calls = 0;
    const factory = (): AsyncGenerator<ProviderEvent, IterationResult | null> => {
      calls++;
      return makeGen(calls === 1 ? [chatGptLimitEvent(600)] : [textEvent()], calls === 1 ? null : successResult())();
    };
    const tierPromise = runTier(factory);
    // Not yet at the reset: still parked on the first call.
    await vi.advanceTimersByTimeAsync(599_000);
    expect(calls).toBe(1);
    await vi.advanceTimersByTimeAsync(2_000);
    const { events, result } = await tierPromise;

    expect(calls).toBe(2);
    const paused = events.filter((e): e is PausedEv => e.type === 'paused');
    expect(paused).toHaveLength(1);
    expect(paused[0]!.provider).toBe('codex');
    expect(paused[0]!.plan).toBe('plus');
    expect(paused[0]!.autoResume).toBe(true);
    expect(paused[0]!.resetsAt?.toISOString()).toBe('2026-10-03T12:10:00.000Z');
    expect(events.filter((e) => e.type === 'resumed')).toHaveLength(1);
    expect(result?.text).toBe('done');
  });

  it('a reset more than 2h away emits paused (autoResume false) then surfaces the error without sleeping', async () => {
    let calls = 0;
    const errEvent = chatGptLimitEvent(5 * 60 * 60);
    const factory = (): AsyncGenerator<ProviderEvent, IterationResult | null> => {
      calls++;
      return makeGen([errEvent], null)();
    };
    // No timer advance: the tier must settle without waiting.
    const { events, result } = await runTier(factory);

    expect(calls).toBe(1);
    expect(result).toBeNull();
    expect(events.map((e) => e.type)).toEqual(['paused', 'error']);
    const paused = events[0] as PausedEv;
    expect(paused.provider).toBe('codex');
    expect(paused.autoResume).toBe(false);
    expect(paused.resetsAt).toBeInstanceOf(Date);
  });

  it('fail-fast (autoResumeOnUsageLimit=false): paused then error, one call', async () => {
    let calls = 0;
    const factory = (): AsyncGenerator<ProviderEvent, IterationResult | null> => {
      calls++;
      return makeGen([chatGptLimitEvent(600)], null)();
    };
    const { events } = await runTier(factory, { autoResumeOnUsageLimit: false });
    expect(calls).toBe(1);
    expect(events.map((e) => e.type)).toEqual(['paused', 'error']);
    expect((events[0] as PausedEv).provider).toBe('codex');
  });

  it('a generic long-retry-after quota 429 carries no provider (unchanged shape)', async () => {
    const { events } = await runTier(makeGen([quotaErrorEvent(600)], null), { autoResumeOnUsageLimit: false });
    const paused = events[0] as PausedEv;
    expect(paused).toEqual({ type: 'paused', reason: 'usage-limit', autoResume: false });
  });
});
