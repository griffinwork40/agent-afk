/**
 * Tests for the Telegram streaming inactivity watchdog — API-round-in-flight
 * suspension. Validates that the watchdog does not fire a false timeout while
 * the provider is making a new `messages.create` API call between tool rounds.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  computeMaxApiRoundInflightMs,
  API_ROUND_INFLIGHT_HEADROOM_MS,
  MAX_TOOL_INFLIGHT_MS,
  NEXT_EVENT_TIMEOUT_MS,
  TOOL_INFLIGHT_RECHECK_MS,
  makeNextWithTimeout,
  type WatchdogState,
} from './streaming.watchdog.js';
import { StreamTimeoutError } from './stream-timeout-error.js';
import {
  TTFB_MAX_ATTEMPTS,
  ttfbAttemptTimeoutMs,
} from '../agent/providers/anthropic-direct/loop/retry-budget.js';
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
  it('computeMaxApiRoundInflightMs returns a positive number at the default config', () => {
    expect(computeMaxApiRoundInflightMs()).toBeGreaterThan(0);
  });

  it('computeMaxApiRoundInflightMs equals formula result at the default TTFB config', () => {
    // Formula: TTFB_MAX_ATTEMPTS × ttfbAttemptTimeoutMs(configured) + headroom.
    // At default (180 s): 3 × 120 s + 60 s = 420 s — matches the old hardcoded
    // constant so callers that relied on the previous value are unaffected.
    const expected =
      TTFB_MAX_ATTEMPTS * ttfbAttemptTimeoutMs(DEFAULT_MODEL_TTFB_TIMEOUT_MS) +
      API_ROUND_INFLIGHT_HEADROOM_MS;
    expect(computeMaxApiRoundInflightMs()).toBe(expected);
  });

  it('computeMaxApiRoundInflightMs exceeds the provider TTFB worst case', () => {
    // Must always exceed TTFB_MAX_ATTEMPTS × per-attempt bound so the provider's
    // retry logic gets a chance to recover before the Telegram watchdog fires.
    const ttfbWorstCase =
      TTFB_MAX_ATTEMPTS * ttfbAttemptTimeoutMs(DEFAULT_MODEL_TTFB_TIMEOUT_MS);
    expect(computeMaxApiRoundInflightMs()).toBeGreaterThan(ttfbWorstCase);
  });

  it('computeMaxApiRoundInflightMs scales with a raised TTFB config', () => {
    // At operator-raised 300 s: 3 × 200 s + 60 s = 660 s — not the old 420 s.
    const raisedTtfb = 300_000;
    const expected =
      TTFB_MAX_ATTEMPTS * ttfbAttemptTimeoutMs(raisedTtfb) +
      API_ROUND_INFLIGHT_HEADROOM_MS;
    expect(expected).toBe(660_000);
    // Sanity: raised value must be larger than the default-config value.
    expect(expected).toBeGreaterThan(computeMaxApiRoundInflightMs());
  });

  it('computeMaxApiRoundInflightMs result is less than MAX_TOOL_INFLIGHT_MS', () => {
    // API calls should not be allowed to hang longer than a tool execution.
    expect(computeMaxApiRoundInflightMs()).toBeLessThan(MAX_TOOL_INFLIGHT_MS);
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

describe('makeNextWithTimeout — apiRoundInFlight behavioral tests', () => {
  it('suspends the watchdog while apiRoundInFlight=true, then fires past computeMaxApiRoundInflightMs()', async () => {
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

      // Advance only the remaining budget to reach computeMaxApiRoundInflightMs()
      // (measured from apiRoundSince). The clock has already moved by
      // 2 × (NEXT_EVENT_TIMEOUT_MS + 1), so we need only the difference.
      // This keeps the assertion tight: an implementation granting even one
      // extra inactivity window would cause the test to fail instead of pass.
      const elapsed = 2 * (NEXT_EVENT_TIMEOUT_MS + 1);
      const remaining = computeMaxApiRoundInflightMs() - elapsed;
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
