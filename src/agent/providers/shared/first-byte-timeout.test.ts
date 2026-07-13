// Unit tests for the TTFB stall-timeout helper (issue #583).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  DEFAULT_MODEL_TTFB_TIMEOUT_MS,
  TTFB_TIMEOUT_MESSAGE,
  armFirstByteTimeout,
  isTtfbTimeoutError,
  resolveTtfbTimeoutMs,
} from './first-byte-timeout.js';

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
