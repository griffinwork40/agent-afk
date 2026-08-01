// Unit tests for the TTFB stall-timeout helper (issue #583).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_MODEL_TTFB_TIMEOUT_MS,
  SDK_HONORED_RETRY_AFTER_CEILING_MS,
  SDK_MAX_DEFAULT_BACKOFF_MS,
  TTFB_THROTTLE_SLACK_MS,
  TTFB_TIMEOUT_MESSAGE,
  armFirstByteTimeout,
  isTtfbTimeoutError,
  resolveTtfbTimeoutMs,
  throttleExtensionMs,
} from './first-byte-timeout.js';
import { MAX_TIMER_DELAY_MS } from './timer-limits.js';

describe('resolveTtfbTimeoutMs', () => {
  const KEY = 'AFK_MODEL_TTFB_TIMEOUT_MS';
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[KEY];
    delete process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('defaults to 180000 when unset', () => {
    expect(resolveTtfbTimeoutMs()).toBe(DEFAULT_MODEL_TTFB_TIMEOUT_MS);
    expect(DEFAULT_MODEL_TTFB_TIMEOUT_MS).toBe(180_000);
  });

  it('defaults when empty / whitespace', () => {
    process.env[KEY] = '   ';
    expect(resolveTtfbTimeoutMs()).toBe(DEFAULT_MODEL_TTFB_TIMEOUT_MS);
  });

  it('returns 0 (disabled) when set to 0 — the escape hatch', () => {
    process.env[KEY] = '0';
    expect(resolveTtfbTimeoutMs()).toBe(0);
  });

  it('honours an explicit positive override', () => {
    process.env[KEY] = '120000';
    expect(resolveTtfbTimeoutMs()).toBe(120_000);
  });

  it('falls back to the default on non-numeric or negative input', () => {
    process.env[KEY] = 'abc';
    expect(resolveTtfbTimeoutMs()).toBe(DEFAULT_MODEL_TTFB_TIMEOUT_MS);
    process.env[KEY] = '-5';
    expect(resolveTtfbTimeoutMs()).toBe(DEFAULT_MODEL_TTFB_TIMEOUT_MS);
  });

  it('clamps an above-ceiling override to the platform timer maximum', () => {
    // Unclamped, Node coerces such a delay to 1ms — so "raise the bound" would
    // abort every call almost immediately instead of extending it.
    process.env[KEY] = '3000000000';
    expect(resolveTtfbTimeoutMs()).toBe(MAX_TIMER_DELAY_MS);
    process.env[KEY] = String(MAX_TIMER_DELAY_MS + 1);
    expect(resolveTtfbTimeoutMs()).toBe(MAX_TIMER_DELAY_MS);
    // Exactly at the ceiling is still honoured verbatim.
    process.env[KEY] = String(MAX_TIMER_DELAY_MS);
    expect(resolveTtfbTimeoutMs()).toBe(MAX_TIMER_DELAY_MS);
  });
});

describe('isTtfbTimeoutError', () => {
  it('matches only the TTFB marker error', () => {
    expect(isTtfbTimeoutError(new Error(TTFB_TIMEOUT_MESSAGE))).toBe(true);
    expect(isTtfbTimeoutError(new Error('something else'))).toBe(false);
    expect(isTtfbTimeoutError('not an error')).toBe(false);
    expect(isTtfbTimeoutError(null)).toBe(false);
  });
});

describe('armFirstByteTimeout', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('is a no-op passthrough when timeoutMs <= 0 (returns the base signal)', () => {
    const base = new AbortController().signal;
    const h = armFirstByteTimeout(base, 0);
    expect(h.signal).toBe(base);
    expect(h.timedOut()).toBe(false);
    // No timer scheduled → advancing time does nothing.
    vi.advanceTimersByTime(1_000_000);
    expect(h.timedOut()).toBe(false);
    expect(h.signal.aborted).toBe(false);
  });

  it('aborts the linked signal and flags timedOut() after the bound', () => {
    const base = new AbortController();
    const h = armFirstByteTimeout(base.signal, 180_000);
    expect(h.signal.aborted).toBe(false);
    expect(h.timedOut()).toBe(false);
    vi.advanceTimersByTime(180_000);
    expect(h.timedOut()).toBe(true);
    expect(h.signal.aborted).toBe(true);
    // The caller's own signal is NEVER mutated by the TTFB timer.
    expect(base.signal.aborted).toBe(false);
  });

  it('firstByteSeen() cancels the timer so the signal never aborts', () => {
    const base = new AbortController();
    const h = armFirstByteTimeout(base.signal, 180_000);
    h.firstByteSeen();
    vi.advanceTimersByTime(10_000_000);
    expect(h.timedOut()).toBe(false);
    expect(h.signal.aborted).toBe(false);
  });

  it('propagates a caller abort through the linked signal without flagging timedOut()', () => {
    const base = new AbortController();
    const h = armFirstByteTimeout(base.signal, 180_000);
    base.abort(new Error('user interrupt'));
    expect(h.signal.aborted).toBe(true);
    expect(h.timedOut()).toBe(false); // it was the caller, not the timer
  });

  it('dispose() is idempotent and stops the timer', () => {
    const base = new AbortController();
    const h = armFirstByteTimeout(base.signal, 180_000);
    h.dispose();
    h.dispose();
    vi.advanceTimersByTime(1_000_000);
    expect(h.timedOut()).toBe(false);
    expect(h.signal.aborted).toBe(false);
  });
});

describe('throttleExtensionMs', () => {
  it('adds the slack to a retry-after the SDK will actually honour', () => {
    expect(throttleExtensionMs(30_000)).toBe(30_000 + TTFB_THROTTLE_SLACK_MS);
    // Just under the honoured ceiling: still taken at face value.
    expect(throttleExtensionMs(59_999)).toBe(59_999 + TTFB_THROTTLE_SLACK_MS);
  });

  it('returns undefined when the provider gave no usable window', () => {
    // Mirrors pauseWindowMs: no communicated window → caller keeps its normal
    // bound rather than extending by a guess.
    for (const bad of [undefined, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(throttleExtensionMs(bad as number | undefined)).toBeUndefined();
    }
  });

  it('clamps a hint the SDK DISCARDS to the SDK\'s own backoff ceiling', () => {
    // client.js:412 honours retry-after only while `< 60 * 1000`; at or above it
    // the hint is thrown away and calculateDefaultRetryTimeoutMillis caps the
    // wait at 8s. Granting the raw header would buy an hour of grace for an ~8s
    // park — reinstating the unbounded hang #583/#762 exist to prevent.
    const clamped = SDK_MAX_DEFAULT_BACKOFF_MS + TTFB_THROTTLE_SLACK_MS;
    expect(throttleExtensionMs(SDK_HONORED_RETRY_AFTER_CEILING_MS)).toBe(clamped);
    expect(throttleExtensionMs(120_000)).toBe(clamped);
    expect(throttleExtensionMs(3_600_000)).toBe(clamped); // the one-hour header
  });

  it('bounds total grace: a throttle can defer the watchdog, never disable it', () => {
    // Worst honoured case per throttle, and the whole-round ceiling given the
    // SDK's default maxRetries: 2 (client.js:72). If this ever stops holding, an
    // endpoint could park a dead request indefinitely.
    const worstPerThrottle = SDK_HONORED_RETRY_AFTER_CEILING_MS - 1 + TTFB_THROTTLE_SLACK_MS;
    for (const ms of [1, 59_999, 60_000, 3_600_000, Number.MAX_SAFE_INTEGER]) {
      expect(throttleExtensionMs(ms)!).toBeLessThanOrEqual(worstPerThrottle);
    }
    expect(worstPerThrottle * 2).toBeLessThan(200_000);
  });
});

describe('armFirstByteTimeout — throttle extension (TTFB false-positive fix)', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('forgives an explained park: the bound does not fire at its original deadline', () => {
    const base = new AbortController();
    const h = armFirstByteTimeout(base.signal, 180_000);
    // 100s in, the provider says "retry after 60s" — the park is explained.
    vi.advanceTimersByTime(100_000);
    h.extend(60_000);
    // Original 180s deadline passes; the request must NOT be declared a stall.
    vi.advanceTimersByTime(80_000);
    expect(h.timedOut()).toBe(false);
    expect(h.signal.aborted).toBe(false);
    // But the bound is still a bound: it fires once the granted window is spent.
    vi.advanceTimersByTime(60_001);
    expect(h.timedOut()).toBe(true);
  });

  it('adds to the ORIGINAL budget rather than restarting a full window', () => {
    // Two 20s extensions must cost 20s+20s of grace, not two fresh 180s bounds —
    // otherwise a throttling endpoint could keep a dead request alive forever.
    const base = new AbortController();
    const h = armFirstByteTimeout(base.signal, 180_000);
    h.extend(20_000);
    h.extend(20_000);
    vi.advanceTimersByTime(219_999);
    expect(h.timedOut()).toBe(false);
    vi.advanceTimersByTime(2);
    expect(h.timedOut()).toBe(true);
  });

  it('still fires on schedule when the park is UNEXPLAINED (no extension)', () => {
    const base = new AbortController();
    const h = armFirstByteTimeout(base.signal, 180_000);
    // A throttle with no retry-after yields undefined upstream, so extend is
    // never called — silence must still trip the bound.
    vi.advanceTimersByTime(180_000);
    expect(h.timedOut()).toBe(true);
  });

  it('cannot resurrect a spent timer (no-op after it has fired)', () => {
    const base = new AbortController();
    const h = armFirstByteTimeout(base.signal, 180_000);
    vi.advanceTimersByTime(180_000);
    expect(h.timedOut()).toBe(true);
    h.extend(600_000);
    // Already aborted; the extension must not un-abort or re-arm anything.
    expect(h.timedOut()).toBe(true);
    expect(h.signal.aborted).toBe(true);
  });

  it('is a no-op after dispose(), and after firstByteSeen()', () => {
    const disposed = armFirstByteTimeout(new AbortController().signal, 180_000);
    disposed.dispose();
    disposed.extend(60_000);
    vi.advanceTimersByTime(10_000_000);
    expect(disposed.timedOut()).toBe(false);

    const streaming = armFirstByteTimeout(new AbortController().signal, 180_000);
    streaming.firstByteSeen();
    streaming.extend(60_000);
    vi.advanceTimersByTime(10_000_000);
    expect(streaming.timedOut()).toBe(false);
  });

  it('is a no-op when the bound is disabled, and ignores unusable deltas', () => {
    const off = armFirstByteTimeout(new AbortController().signal, 0);
    off.extend(60_000);
    vi.advanceTimersByTime(10_000_000);
    expect(off.timedOut()).toBe(false);

    const h = armFirstByteTimeout(new AbortController().signal, 180_000);
    for (const bad of [0, -5_000, Number.NaN, Number.POSITIVE_INFINITY]) h.extend(bad);
    vi.advanceTimersByTime(180_000);
    expect(h.timedOut()).toBe(true); // deadline unmoved
  });

  it('re-arms on the remaining window, shifting the deadline by exactly the delta', () => {
    // Boundary check on the re-arm arithmetic: extending mid-flight must move the
    // deadline by the delta and no more — the new timer is scheduled for
    // (deadline - now), not for a fresh full window.
    const h = armFirstByteTimeout(new AbortController().signal, 10_000);
    vi.advanceTimersByTime(9_000);
    h.extend(1_000); // deadline: 10_000 -> 11_000
    vi.advanceTimersByTime(1_999); // now 10_999
    expect(h.timedOut()).toBe(false);
    vi.advanceTimersByTime(1); // now 11_000
    expect(h.timedOut()).toBe(true);
  });
});
