/**
 * Tests for the Telegram streaming inactivity watchdog.
 *
 * Covers:
 * - FIRST_EVENT_TIMEOUT_MS fires on initial silence
 * - NEXT_EVENT_TIMEOUT_MS fires on between-event silence
 * - tool-in-flight suspension (pauses watchdog while inFlightTools.size > 0)
 * - paused-window extension (pausedUntil + PAUSE_SLACK_MS)
 * - apiRoundInFlight suspension
 * - armProgressGateTimer one-shot behavior
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  FIRST_EVENT_TIMEOUT_MS,
  MAX_API_ROUND_HEADROOM_MS,
  MAX_TOOL_INFLIGHT_MS,
  NEXT_EVENT_TIMEOUT_MS,
  PAUSE_SLACK_MS,
  PROGRESS_START_DELAY_MS,
  TOOL_INFLIGHT_RECHECK_MS,
  armProgressGateTimer,
  makeNextWithTimeout,
  resolveMaxApiRoundInflightMs,
  type WatchdogState,
} from './streaming.watchdog.js';
import { StreamTimeoutError } from './stream-timeout-error.js';
import { TTFB_MAX_ATTEMPTS, ttfbAttemptTimeoutMs } from '../agent/providers/anthropic-direct/loop/retry-budget.js';
import { DEFAULT_MODEL_TTFB_TIMEOUT_MS } from '../agent/providers/shared/first-byte-timeout.js';

/** Build a minimal WatchdogState with apiRoundInFlight pre-set to true. */
function makeState(overrides: Partial<WatchdogState> = {}): WatchdogState {
  return {
    receivedAny: true,
    timedOut: false,
    lastActivityAt: Date.now(),
    inFlightTools: new Set(),
    toolInFlightSince: null,
    pausedUntil: null,
    apiRoundInFlight: false,
    apiRoundSince: null,
    ...overrides,
  };
}

/** Async iterator that hangs forever until `release` is called. */
function makeHangingIter(): { iter: AsyncIterator<never>; release: () => void } {
  let release: () => void = () => {};
  const hang = new Promise<void>((res) => { release = res; });
  const iter: AsyncIterator<never> = {
    next: () => hang.then(() => ({ value: undefined as never, done: true })),
  };
  return { iter, release };
}

describe('WatchdogState — apiRoundInFlight fields', () => {
  it('resolveMaxApiRoundInflightMs returns a positive number', () => {
    expect(resolveMaxApiRoundInflightMs()).toBeGreaterThan(0);
  });

  it('resolveMaxApiRoundInflightMs default matches the old hardcoded 420_000', () => {
    // Default: AFK_MODEL_TTFB_TIMEOUT_MS unset → 180_000
    // ttfbAttemptTimeoutMs(180_000) = floor(180_000 × 2 / 3) = 120_000
    // TTFB_MAX_ATTEMPTS (3) × 120_000 + 60_000 headroom = 420_000
    const expected =
      TTFB_MAX_ATTEMPTS * ttfbAttemptTimeoutMs(DEFAULT_MODEL_TTFB_TIMEOUT_MS) +
      MAX_API_ROUND_HEADROOM_MS;
    expect(resolveMaxApiRoundInflightMs()).toBe(expected);
    expect(resolveMaxApiRoundInflightMs()).toBe(420_000);
  });

  it('resolveMaxApiRoundInflightMs exceeds the provider TTFB worst case (3 × 120s)', () => {
    // The provider-level TTFB budget is 3 attempts × 120s = 360s worst case.
    // The watchdog ceiling must exceed this so the provider's retry logic gets
    // a chance to recover before the Telegram watchdog fires.
    expect(resolveMaxApiRoundInflightMs()).toBeGreaterThan(360_000);
  });

  it('resolveMaxApiRoundInflightMs is less than MAX_TOOL_INFLIGHT_MS (default config)', () => {
    // API calls should not be allowed to hang longer than a tool execution.
    expect(resolveMaxApiRoundInflightMs()).toBeLessThan(MAX_TOOL_INFLIGHT_MS);
  });

  it('resolveMaxApiRoundInflightMs scales proportionally for a high TTFB timeout', () => {
    // With AFK_MODEL_TTFB_TIMEOUT_MS = 300_000:
    //   ttfbAttemptTimeoutMs(300_000) = floor(300_000 × 2 / 3) = 200_000
    //   TTFB_MAX_ATTEMPTS (3) × 200_000 + 60_000 = 660_000
    const highTtfb = 300_000;
    const expected =
      TTFB_MAX_ATTEMPTS * ttfbAttemptTimeoutMs(highTtfb) + MAX_API_ROUND_HEADROOM_MS;
    expect(expected).toBe(660_000);
    // And it must be strictly greater than the default ceiling.
    expect(expected).toBeGreaterThan(420_000);
  });

  it('TOOL_INFLIGHT_RECHECK_MS is a reasonable recheck cadence', () => {
    expect(TOOL_INFLIGHT_RECHECK_MS).toBeGreaterThanOrEqual(5_000);
    expect(TOOL_INFLIGHT_RECHECK_MS).toBeLessThanOrEqual(60_000);
  });

  it('WatchdogState interface accepts apiRoundInFlight fields', () => {
    const state: WatchdogState = {
      receivedAny: true,
      timedOut: false,
      lastActivityAt: Date.now(),
      inFlightTools: new Set(),
      toolInFlightSince: null,
      pausedUntil: null,
      apiRoundInFlight: true,
      apiRoundSince: Date.now(),
    };
    expect(state.apiRoundInFlight).toBe(true);
    expect(state.apiRoundSince).toBeTypeOf('number');
  });
});

describe('makeNextWithTimeout — first-event timeout (FIRST_EVENT_TIMEOUT_MS)', () => {
  it('fires StreamTimeoutError after FIRST_EVENT_TIMEOUT_MS of silence on first call', async () => {
    vi.useFakeTimers();
    try {
      const { iter } = makeHangingIter();
      // receivedAny=false → windowMs = FIRST_EVENT_TIMEOUT_MS
      const state = makeState({ receivedAny: false });
      const next = makeNextWithTimeout(iter, state);
      const p = next();

      // Just before the deadline: not fired yet.
      await vi.advanceTimersByTimeAsync(FIRST_EVENT_TIMEOUT_MS - 1);
      let settled = false;
      void p.catch(() => { settled = true; });
      expect(settled).toBe(false);

      // Exactly at the deadline: fires.
      const rejection = expect(p).rejects.toBeInstanceOf(StreamTimeoutError);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it('first-event error message distinguishes "first message" from subsequent timeouts', async () => {
    vi.useFakeTimers();
    try {
      const { iter } = makeHangingIter();
      const state = makeState({ receivedAny: false });
      const next = makeNextWithTimeout(iter, state);
      const p = next();

      const rejection = p.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(FIRST_EVENT_TIMEOUT_MS + 1);
      const err = await rejection;
      expect(err).toBeInstanceOf(StreamTimeoutError);
      expect((err as StreamTimeoutError).message).toContain('first message');
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it('does NOT fire before FIRST_EVENT_TIMEOUT_MS elapses', async () => {
    vi.useFakeTimers();
    try {
      const { iter } = makeHangingIter();
      const state = makeState({ receivedAny: false });
      const next = makeNextWithTimeout(iter, state);
      const p = next();

      let settled = false;
      void p.then(() => { settled = true; }, () => { settled = true; });

      await vi.advanceTimersByTimeAsync(FIRST_EVENT_TIMEOUT_MS - 100);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it('resolves cleanly when iterator yields before the first-event timeout', async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (v: IteratorResult<never>) => void;
      const iter: AsyncIterator<never> = {
        next: () => new Promise<IteratorResult<never>>((res) => { resolve = res; }),
      };
      const state = makeState({ receivedAny: false });
      const next = makeNextWithTimeout(iter, state);
      const p = next();

      // Yield the event before the timeout fires.
      await vi.advanceTimersByTimeAsync(FIRST_EVENT_TIMEOUT_MS / 2);
      resolve({ value: undefined as never, done: true });
      const result = await p;
      expect(result.done).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it('uses NEXT_EVENT_TIMEOUT_MS (not FIRST) once receivedAny=true', async () => {
    vi.useFakeTimers();
    try {
      const { iter } = makeHangingIter();
      // receivedAny=true → windowMs = NEXT_EVENT_TIMEOUT_MS
      const state = makeState({ receivedAny: true });
      const next = makeNextWithTimeout(iter, state);
      const p = next();

      // Advance past FIRST_EVENT_TIMEOUT_MS — must NOT fire on the first-event path.
      // (FIRST_EVENT_TIMEOUT_MS < NEXT_EVENT_TIMEOUT_MS, so this distinguishes them.)
      let settled = false;
      void p.then(() => { settled = true; }, () => { settled = true; });
      await vi.advanceTimersByTimeAsync(FIRST_EVENT_TIMEOUT_MS + 1);
      expect(settled).toBe(false);

      // Advance the remaining gap to NEXT_EVENT_TIMEOUT_MS.
      const rejection = expect(p).rejects.toBeInstanceOf(StreamTimeoutError);
      await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS - FIRST_EVENT_TIMEOUT_MS);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);
});

describe('makeNextWithTimeout — between-event timeout (NEXT_EVENT_TIMEOUT_MS)', () => {
  it('fires StreamTimeoutError after NEXT_EVENT_TIMEOUT_MS of silence', async () => {
    vi.useFakeTimers();
    try {
      const { iter } = makeHangingIter();
      const state = makeState({ receivedAny: true });
      const next = makeNextWithTimeout(iter, state);
      const p = next();

      await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS - 1);
      let settled = false;
      void p.catch(() => { settled = true; });
      expect(settled).toBe(false);

      const rejection = expect(p).rejects.toBeInstanceOf(StreamTimeoutError);
      await vi.advanceTimersByTimeAsync(1);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it('between-event error message omits "first message" wording', async () => {
    vi.useFakeTimers();
    try {
      const { iter } = makeHangingIter();
      const state = makeState({ receivedAny: true });
      const next = makeNextWithTimeout(iter, state);
      const p = next();

      const rejection = p.catch((e: unknown) => e);
      await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS + 1);
      const err = await rejection;
      expect(err).toBeInstanceOf(StreamTimeoutError);
      expect((err as StreamTimeoutError).message).not.toContain('first message');
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it('re-arming: updating lastActivityAt resets the countdown', async () => {
    vi.useFakeTimers();
    try {
      const { iter } = makeHangingIter();
      const state = makeState({ receivedAny: true });
      const next = makeNextWithTimeout(iter, state);
      const p = next();

      let settled = false;
      void p.then(() => { settled = true; }, () => { settled = true; });

      // Advance almost to the timeout.
      await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS - 100);
      expect(settled).toBe(false);

      // Simulate sub-agent sink activity updating lastActivityAt.
      state.lastActivityAt = Date.now();

      // Advance another full window — the watchdog re-reads lastActivityAt
      // on each arm() invocation, so this advances from the new baseline
      // and the deadline should not have fired yet.
      await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS - 100);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it('sets state.timedOut=true when the watchdog fires', async () => {
    vi.useFakeTimers();
    try {
      const { iter } = makeHangingIter();
      const state = makeState({ receivedAny: true });
      expect(state.timedOut).toBe(false);
      const next = makeNextWithTimeout(iter, state);
      const p = next();

      // Attach rejection handler BEFORE advancing timers so the unhandled-
      // rejection warning is never emitted.
      const rejection = expect(p).rejects.toBeInstanceOf(StreamTimeoutError);
      await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS + 1);
      await rejection;

      expect(state.timedOut).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);
});

describe('makeNextWithTimeout — tool-in-flight suspension', () => {
  it('suspends watchdog while inFlightTools.size > 0, within MAX_TOOL_INFLIGHT_MS', async () => {
    vi.useFakeTimers();
    try {
      const { iter } = makeHangingIter();
      const toolInFlightSince = Date.now();
      const state = makeState({
        receivedAny: true,
        inFlightTools: new Set(['tool-abc']),
        toolInFlightSince,
      });
      const next = makeNextWithTimeout(iter, state);
      const p = next();

      let settled = false;
      void p.then(() => { settled = true; }, () => { settled = true; });

      // Past the normal window — watchdog would have fired without tool-in-flight.
      await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS + TOOL_INFLIGHT_RECHECK_MS);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it('fires past MAX_TOOL_INFLIGHT_MS even when a tool is still in flight (wedged tool)', async () => {
    vi.useFakeTimers();
    try {
      const { iter } = makeHangingIter();
      const toolInFlightSince = Date.now(); // fake epoch = 0 ms
      const state = makeState({
        receivedAny: true,
        inFlightTools: new Set(['tool-abc']),
        toolInFlightSince,
      });
      const next = makeNextWithTimeout(iter, state);
      const p = next();

      let settled = false;
      void p.then(() => { settled = true; }, () => { settled = true; });

      // The ceiling check is: Date.now() - toolInFlightSince < MAX_TOOL_INFLIGHT_MS.
      // toolInFlightSince=0, so ceiling is at MAX_TOOL_INFLIGHT_MS total clock time.
      // Advance to just before that ceiling to confirm suspension is still active.
      const justBeforeCeiling = MAX_TOOL_INFLIGHT_MS - TOOL_INFLIGHT_RECHECK_MS;
      await vi.advanceTimersByTimeAsync(justBeforeCeiling);
      expect(settled).toBe(false);

      // Past the ceiling — watchdog must fire.
      const rejection = expect(p).rejects.toBeInstanceOf(StreamTimeoutError);
      await vi.advanceTimersByTimeAsync(TOOL_INFLIGHT_RECHECK_MS * 2);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it('resumes normal watchdog after all tools complete (inFlightTools.size = 0)', async () => {
    vi.useFakeTimers();
    try {
      const { iter } = makeHangingIter();
      const toolInFlightSince = Date.now();
      const state = makeState({
        receivedAny: true,
        inFlightTools: new Set(['tool-abc']),
        toolInFlightSince,
      });
      const next = makeNextWithTimeout(iter, state);
      const p = next();

      let settled = false;
      void p.then(() => { settled = true; }, () => { settled = true; });

      // Advance past normal window — suspended while tool runs.
      await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS + 1);
      expect(settled).toBe(false);

      // Tool completes — simulate streaming.ts clearing the set.
      state.inFlightTools.delete('tool-abc');
      state.toolInFlightSince = null;
      state.lastActivityAt = Date.now();

      // Now a full NEXT_EVENT_TIMEOUT_MS of silence should fire.
      const rejection = expect(p).rejects.toBeInstanceOf(StreamTimeoutError);
      await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS + TOOL_INFLIGHT_RECHECK_MS);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it('toolInFlightSince=null disables suspension even when inFlightTools.size > 0', async () => {
    // Defensive: if the set is non-empty but toolInFlightSince is null the
    // implementation must NOT suspend indefinitely — it should fall through to
    // the apiRoundInFlight check and then reject.
    vi.useFakeTimers();
    try {
      const { iter } = makeHangingIter();
      const state = makeState({
        receivedAny: true,
        inFlightTools: new Set(['tool-abc']),
        toolInFlightSince: null, // inconsistent but defensive
      });
      const next = makeNextWithTimeout(iter, state);
      const p = next();

      const rejection = expect(p).rejects.toBeInstanceOf(StreamTimeoutError);
      await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS + TOOL_INFLIGHT_RECHECK_MS);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);
});

describe('makeNextWithTimeout — paused-window extension (pausedUntil)', () => {
  it('extends deadline to pausedUntil + PAUSE_SLACK_MS when pausedUntil is set', async () => {
    vi.useFakeTimers();
    try {
      const { iter } = makeHangingIter();
      const pauseMs = 120_000; // 120 s pause window
      const pausedUntil = new Date(Date.now() + pauseMs);
      const state = makeState({
        receivedAny: true,
        pausedUntil,
      });
      const next = makeNextWithTimeout(iter, state);
      const p = next();

      let settled = false;
      void p.then(() => { settled = true; }, () => { settled = true; });

      // Advance past normal NEXT_EVENT_TIMEOUT_MS — must NOT fire because
      // the window is extended to (pausedUntil - now) + PAUSE_SLACK_MS.
      await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS + 1);
      expect(settled).toBe(false);

      // Advance past the pause itself but NOT past the slack — still alive.
      await vi.advanceTimersByTimeAsync(pauseMs - NEXT_EVENT_TIMEOUT_MS - 1 + PAUSE_SLACK_MS - 1);
      expect(settled).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it('extended window is at least NEXT_EVENT_TIMEOUT_MS even for a near-expiry pausedUntil', async () => {
    // pausedUntil is 1 ms in the future — the extension formula's Math.max
    // ensures the window never shrinks below NEXT_EVENT_TIMEOUT_MS.
    vi.useFakeTimers();
    try {
      const { iter } = makeHangingIter();
      const pausedUntil = new Date(Date.now() + 1);
      const state = makeState({
        receivedAny: true,
        pausedUntil,
      });
      const next = makeNextWithTimeout(iter, state);
      const p = next();

      let settled = false;
      void p.then(() => { settled = true; }, () => { settled = true; });

      // The window must be at least NEXT_EVENT_TIMEOUT_MS, so advance to just
      // before that — must not fire yet.
      await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS - 1);
      expect(settled).toBe(false);

      const rejection = expect(p).rejects.toBeInstanceOf(StreamTimeoutError);
      await vi.advanceTimersByTimeAsync(2);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it('pausedUntil=null uses the standard receivedAny path', async () => {
    vi.useFakeTimers();
    try {
      const { iter } = makeHangingIter();
      const state = makeState({ receivedAny: true, pausedUntil: null });
      const next = makeNextWithTimeout(iter, state);
      const p = next();

      // Should fire at exactly NEXT_EVENT_TIMEOUT_MS.
      const rejection = expect(p).rejects.toBeInstanceOf(StreamTimeoutError);
      await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS + 1);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);
});

describe('makeNextWithTimeout — apiRoundInFlight behavioral tests', () => {
  it('suspends the watchdog while apiRoundInFlight=true, then fires past resolveMaxApiRoundInflightMs()', async () => {
    // Install fake timers FIRST so that Date.now() inside makeState returns the
    // fake epoch (0 ms). This makes apiRoundSince deterministically equal to the
    // fake clock's origin, and the elapsed-time arithmetic below exact.
    vi.useFakeTimers();
    try {
      const { iter } = makeHangingIter();
      const state = makeState({
        apiRoundInFlight: true,
        apiRoundSince: Date.now(), // fake epoch = 0 ms
      });
      const next = makeNextWithTimeout(iter, state);
      const p = next();

      let settled = false;
      void p.then(() => { settled = true; }, () => { settled = true; });

      // Advance past NEXT_EVENT_TIMEOUT_MS — watchdog must NOT fire because
      // apiRoundInFlight=true suspends it.
      await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS + 1);
      expect(settled).toBe(false);

      // Advance well past NEXT_EVENT_TIMEOUT_MS again — still suspended.
      await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS + 1);
      expect(settled).toBe(false);

      // Advance only the remaining budget to reach resolveMaxApiRoundInflightMs()
      // (measured from apiRoundSince). The clock has already moved by
      // 2 × (NEXT_EVENT_TIMEOUT_MS + 1), so we need only the difference.
      // This keeps the assertion tight: an implementation granting even one
      // extra inactivity window would cause the test to fail instead of pass.
      const elapsed = 2 * (NEXT_EVENT_TIMEOUT_MS + 1);
      const remaining = resolveMaxApiRoundInflightMs() - elapsed;
      const rejection = expect(p).rejects.toBeInstanceOf(StreamTimeoutError);
      await vi.advanceTimersByTimeAsync(remaining);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);

  it('resumes normal watchdog cadence after a subsequent event clears apiRoundInFlight', async () => {
    vi.useFakeTimers();
    try {
      let releaseFirst: () => void = () => {};
      // First call resolves immediately (simulates the subsequent event that
      // clears apiRoundInFlight); second call hangs forever (never resolved).
      let callCount = 0;
      const iter: AsyncIterator<never> = {
        next: () => {
          callCount++;
          if (callCount === 1) {
            return new Promise<IteratorResult<never>>((res) => { releaseFirst = () => res({ value: undefined as never, done: false }); });
          }
          return new Promise<IteratorResult<never>>(() => {});
        },
      };

      const state = makeState({
        apiRoundInFlight: true,
        apiRoundSince: Date.now(),
      });

      // --- First call: simulate "subsequent event arrives" ---
      const next = makeNextWithTimeout(iter, state);
      const firstCall = next();
      releaseFirst();
      await firstCall;

      // Caller (streaming.ts) would clear apiRoundInFlight on event receipt.
      state.apiRoundInFlight = false;
      state.apiRoundSince = null;
      state.lastActivityAt = Date.now();

      // --- Second call: watchdog should now run on normal NEXT_EVENT_TIMEOUT_MS ---
      const secondCall = next();
      let settled = false;
      void secondCall.then(() => { settled = true; }, () => { settled = true; });

      // Before the normal timeout: not fired.
      await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS - 1);
      expect(settled).toBe(false);

      // Past NEXT_EVENT_TIMEOUT_MS: fires with StreamTimeoutError (no suspension).
      const rejection = expect(secondCall).rejects.toBeInstanceOf(StreamTimeoutError);
      await vi.advanceTimersByTimeAsync(2);
      await rejection;

    } finally {
      vi.useRealTimers();
    }
  }, 20_000);
});

// ---------------------------------------------------------------------------
// makeNextWithTimeout — first-event and between-event timeout behavior
// ---------------------------------------------------------------------------

describe('makeNextWithTimeout — FIRST_EVENT_TIMEOUT_MS (no events received)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('fires FIRST_EVENT_TIMEOUT_MS of silence when no event has arrived yet', async () => {
    vi.useFakeTimers();
    const { iter } = makeHangingIter();
    const state = makeState({ receivedAny: false });
    const next = makeNextWithTimeout(iter, state);
    const p = next();

    let settled = false;
    void p.then(() => { settled = true; }, () => { settled = true; });

    // One millisecond before the first-event deadline — must not fire.
    await vi.advanceTimersByTimeAsync(FIRST_EVENT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    // Crossing the deadline fires a StreamTimeoutError.
    const rejection = expect(p).rejects.toBeInstanceOf(StreamTimeoutError);
    await vi.advanceTimersByTimeAsync(2);
    await rejection;
  }, 15_000);

  it('error message on first-event timeout mentions "Request timed out" (cold start)', async () => {
    vi.useFakeTimers();
    const { iter } = makeHangingIter();
    const state = makeState({ receivedAny: false });
    const p = makeNextWithTimeout(iter, state)();

    const rejection = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(FIRST_EVENT_TIMEOUT_MS + 1);
    const err = await rejection;
    expect(err).toBeInstanceOf(StreamTimeoutError);
    expect((err as StreamTimeoutError).message).toMatch(/request timed out/i);
  }, 15_000);

  it('resolves normally when an event arrives before FIRST_EVENT_TIMEOUT_MS', async () => {
    vi.useFakeTimers();
    let resolve!: (r: IteratorResult<never>) => void;
    const iter: AsyncIterator<never> = {
      next: () => new Promise<IteratorResult<never>>((res) => { resolve = res; }),
    };
    const state = makeState({ receivedAny: false });
    const p = makeNextWithTimeout(iter, state)();

    // Advance most of the window, then deliver the event.
    await vi.advanceTimersByTimeAsync(FIRST_EVENT_TIMEOUT_MS - 100);
    resolve({ value: undefined as never, done: false });
    await expect(p).resolves.toEqual({ value: undefined, done: false });
  }, 15_000);
});

describe('makeNextWithTimeout — NEXT_EVENT_TIMEOUT_MS (subsequent events)', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('fires after NEXT_EVENT_TIMEOUT_MS of silence when receivedAny=true', async () => {
    vi.useFakeTimers();
    const { iter } = makeHangingIter();
    // receivedAny=true → uses NEXT_EVENT_TIMEOUT_MS (180 s), not FIRST (90 s)
    const state = makeState({ receivedAny: true });
    const next = makeNextWithTimeout(iter, state);
    const p = next();

    let settled = false;
    void p.then(() => { settled = true; }, () => { settled = true; });

    // Should NOT fire at FIRST_EVENT_TIMEOUT_MS (90s) since receivedAny=true.
    await vi.advanceTimersByTimeAsync(FIRST_EVENT_TIMEOUT_MS + 1);
    expect(settled).toBe(false);

    // Past NEXT_EVENT_TIMEOUT_MS it fires.
    const rejection = expect(p).rejects.toBeInstanceOf(StreamTimeoutError);
    await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS - FIRST_EVENT_TIMEOUT_MS);
    await rejection;
  }, 15_000);

  it('error message on between-event timeout mentions "Response timed out"', async () => {
    vi.useFakeTimers();
    const { iter } = makeHangingIter();
    const state = makeState({ receivedAny: true });
    const p = makeNextWithTimeout(iter, state)();

    const rejection = p.catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS + 1);
    const err = await rejection;
    expect(err).toBeInstanceOf(StreamTimeoutError);
    expect((err as StreamTimeoutError).message).toMatch(/response timed out/i);
  }, 15_000);

  it('re-arming: bumping lastActivityAt resets the window so the watchdog does not fire', async () => {
    vi.useFakeTimers();
    const { iter } = makeHangingIter();
    const state = makeState({ receivedAny: true, lastActivityAt: Date.now() });
    const next = makeNextWithTimeout(iter, state);
    const p = next();

    let settled = false;
    void p.then(() => { settled = true; }, () => { settled = true; });

    // Advance to just before the deadline, then re-arm by bumping lastActivityAt.
    await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS - 1);
    state.lastActivityAt = Date.now(); // simulate sink activity re-arming the watchdog
    // Advance another full window — should still not fire because the window reset.
    await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// makeNextWithTimeout — tool-in-flight suspension
// ---------------------------------------------------------------------------

describe('makeNextWithTimeout — tool-in-flight suspension', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('suspends the watchdog while inFlightTools.size > 0 (past NEXT_EVENT_TIMEOUT_MS)', async () => {
    vi.useFakeTimers();
    const { iter } = makeHangingIter();
    const state = makeState({
      receivedAny: true,
      inFlightTools: new Set(['tool-1']),
      toolInFlightSince: Date.now(),
    });
    const p = makeNextWithTimeout(iter, state)();

    let settled = false;
    void p.then(() => { settled = true; }, () => { settled = true; });

    // Advance well past NEXT_EVENT_TIMEOUT_MS — tool still in flight → suspended.
    await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS + 1);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS + 1);
    expect(settled).toBe(false);
  }, 15_000);

  it('fires past MAX_TOOL_INFLIGHT_MS even while inFlightTools.size > 0 (wedged tool)', async () => {
    vi.useFakeTimers();
    const { iter } = makeHangingIter();
    const state = makeState({
      receivedAny: true,
      inFlightTools: new Set(['tool-1']),
      toolInFlightSince: Date.now(), // fake epoch = 0
    });
    const p = makeNextWithTimeout(iter, state)();

    // Advance past NEXT_EVENT_TIMEOUT_MS but still within MAX_TOOL_INFLIGHT_MS.
    await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS + 1);

    // Now advance past MAX_TOOL_INFLIGHT_MS — the watchdog must eventually fire.
    const rejection = expect(p).rejects.toBeInstanceOf(StreamTimeoutError);
    // MAX_TOOL_INFLIGHT_MS (660s) measured from toolInFlightSince=0.
    // Clock has moved NEXT_EVENT_TIMEOUT_MS + 1 ms already; advance the rest.
    const elapsed = NEXT_EVENT_TIMEOUT_MS + 1;
    await vi.advanceTimersByTimeAsync(MAX_TOOL_INFLIGHT_MS - elapsed + TOOL_INFLIGHT_RECHECK_MS + 1);
    await rejection;
  }, 20_000);

  it('resumes normal timeout once inFlightTools is cleared', async () => {
    vi.useFakeTimers();
    let resolve!: (r: IteratorResult<never>) => void;
    let callCount = 0;
    const iter: AsyncIterator<never> = {
      next: () => {
        callCount++;
        if (callCount === 1) {
          // First call resolves, simulating the tool_result event arriving.
          return new Promise<IteratorResult<never>>((res) => { resolve = res; });
        }
        return new Promise<IteratorResult<never>>(() => {}); // hangs forever
      },
    };

    const state = makeState({
      receivedAny: true,
      inFlightTools: new Set(['tool-1']),
      toolInFlightSince: Date.now(),
    });

    // First call resolves (tool_result clears the in-flight set).
    const next = makeNextWithTimeout(iter, state);
    const firstCall = next();
    resolve({ value: undefined as never, done: false });
    await firstCall;

    // Caller clears inFlightTools (as streaming.ts does on tool_result).
    state.inFlightTools.clear();
    state.toolInFlightSince = null;
    state.lastActivityAt = Date.now();

    // Second call: no tool in flight, so NEXT_EVENT_TIMEOUT_MS applies.
    const secondCall = next();
    let settled = false;
    void secondCall.then(() => { settled = true; }, () => { settled = true; });

    await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    const rejection = expect(secondCall).rejects.toBeInstanceOf(StreamTimeoutError);
    await vi.advanceTimersByTimeAsync(2);
    await rejection;
  }, 15_000);
});

// ---------------------------------------------------------------------------
// makeNextWithTimeout — pausedUntil window extension
// ---------------------------------------------------------------------------

describe('makeNextWithTimeout — pausedUntil + PAUSE_SLACK_MS extension', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('extends the window to (pausedUntil - now) + PAUSE_SLACK_MS when pausedUntil is set', async () => {
    vi.useFakeTimers();
    const { iter } = makeHangingIter();

    // Set pausedUntil to 60s from "now" (fake epoch).
    const pauseDurationMs = 60_000;
    const pausedUntil = new Date(Date.now() + pauseDurationMs);
    const state = makeState({ receivedAny: true, pausedUntil });

    // windowMs = max(NEXT_EVENT_TIMEOUT_MS, pauseDurationMs + PAUSE_SLACK_MS)
    //           = max(180_000, 60_000 + 90_000) = max(180_000, 150_000) = 180_000
    // Tiny pause: NEXT_EVENT_TIMEOUT_MS wins.
    const p = makeNextWithTimeout(iter, state)();
    let settled = false;
    void p.then(() => { settled = true; }, () => { settled = true; });

    // Just under NEXT_EVENT_TIMEOUT_MS — not fired.
    await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS - 1);
    expect(settled).toBe(false);

    const rejection = expect(p).rejects.toBeInstanceOf(StreamTimeoutError);
    await vi.advanceTimersByTimeAsync(2);
    await rejection;
  }, 15_000);

  it('extends the window beyond NEXT_EVENT_TIMEOUT_MS when pausedUntil is far in the future', async () => {
    vi.useFakeTimers();
    const { iter } = makeHangingIter();

    // A rate-limit pause of 300s — far beyond NEXT_EVENT_TIMEOUT_MS (180s).
    const pauseDurationMs = 300_000;
    const pausedUntil = new Date(Date.now() + pauseDurationMs);
    const state = makeState({ receivedAny: true, pausedUntil });

    // windowMs = max(180_000, 300_000 + 90_000) = 390_000
    // Initial setTimeout fires at exactly 390_000 ms from start.
    const p = makeNextWithTimeout(iter, state)();
    let settled = false;
    void p.then(() => { settled = true; }, () => { settled = true; });

    // At NEXT_EVENT_TIMEOUT_MS — should NOT fire (window is 390s).
    await vi.advanceTimersByTimeAsync(NEXT_EVENT_TIMEOUT_MS + 1);
    expect(settled).toBe(false);

    // Advance to 1 ms BEFORE the total extended window:
    // total elapsed so far = NEXT_EVENT_TIMEOUT_MS + 1; need extendedWindow - 1 total.
    // extendedWindow = pauseDurationMs + PAUSE_SLACK_MS = 390_000
    // remaining to reach (extendedWindow - 1) = (390_000 - 1) - (NEXT_EVENT_TIMEOUT_MS + 1)
    const extendedWindow = pauseDurationMs + PAUSE_SLACK_MS; // 390_000
    const alreadyElapsed = NEXT_EVENT_TIMEOUT_MS + 1;
    const toJustBefore = extendedWindow - 1 - alreadyElapsed; // = 209_998
    await vi.advanceTimersByTimeAsync(toJustBefore);
    expect(settled).toBe(false);

    // Cross the extended window — fires.
    const rejection = expect(p).rejects.toBeInstanceOf(StreamTimeoutError);
    await vi.advanceTimersByTimeAsync(2);
    await rejection;
  }, 20_000);

  it('PAUSE_SLACK_MS is a positive constant giving meaningful headroom', () => {
    expect(PAUSE_SLACK_MS).toBeGreaterThan(0);
    expect(PAUSE_SLACK_MS).toBeGreaterThanOrEqual(10_000);
  });
});

// ---------------------------------------------------------------------------
// armProgressGateTimer
// ---------------------------------------------------------------------------

describe('armProgressGateTimer', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('fires onOpen after the specified remainingMs', async () => {
    vi.useFakeTimers();
    let opened = false;
    const handle = armProgressGateTimer(500, () => { opened = true; }, () => false);
    await vi.advanceTimersByTimeAsync(499);
    expect(opened).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(opened).toBe(true);
    clearTimeout(handle);
  });

  it('does NOT fire onOpen when isTurnEnded returns true', async () => {
    vi.useFakeTimers();
    let opened = false;
    const handle = armProgressGateTimer(100, () => { opened = true; }, () => true);
    await vi.advanceTimersByTimeAsync(200);
    expect(opened).toBe(false);
    clearTimeout(handle);
  });

  it('treats remainingMs ≤ 0 as immediate (fires on next tick)', async () => {
    vi.useFakeTimers();
    let opened = false;
    const handle = armProgressGateTimer(-10, () => { opened = true; }, () => false);
    await vi.advanceTimersByTimeAsync(0);
    expect(opened).toBe(true);
    clearTimeout(handle);
  });

  it('returns a timer handle that can be cleared to cancel the callback', async () => {
    vi.useFakeTimers();
    let opened = false;
    const handle = armProgressGateTimer(200, () => { opened = true; }, () => false);
    clearTimeout(handle);
    await vi.advanceTimersByTimeAsync(500);
    expect(opened).toBe(false);
  });

  it('PROGRESS_START_DELAY_MS is the expected default gate delay (5 000 ms)', () => {
    expect(PROGRESS_START_DELAY_MS).toBe(5_000);
  });

  it('PAUSE_SLACK_MS is exported and equals 90 000 ms', () => {
    expect(PAUSE_SLACK_MS).toBe(90_000);
  });
});
