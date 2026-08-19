/**
 * Tests for the Telegram streaming inactivity watchdog — API-round-in-flight
 * suspension. Validates that the watchdog does not fire a false timeout while
 * the provider is making a new `messages.create` API call between tool rounds.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  MAX_API_ROUND_HEADROOM_MS,
  MAX_TOOL_INFLIGHT_MS,
  NEXT_EVENT_TIMEOUT_MS,
  TOOL_INFLIGHT_RECHECK_MS,
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

      void resolveSecond; // silence unused var warning
    } finally {
      vi.useRealTimers();
    }
  }, 20_000);
});
