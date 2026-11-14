// Unit tests for the post-first-byte stall-watchdog resolver (issue #762).
// The arm/fire/dispose behaviour is exercised end-to-end through the provider
// loop in `anthropic-direct/loop.stall.test.ts`; this file covers the env
// resolver, whose failure mode is silent misconfiguration rather than a hang.
// suspend() / resumeTimer() unit tests are also here (issue #4693).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  DEFAULT_MODEL_STALL_TIMEOUT_MS,
  resolveStallTimeoutMs,
  armStreamStallWatchdog,
} from './stream-stall-timeout.js';
import { MAX_TIMER_DELAY_MS } from './timer-limits.js';

describe('resolveStallTimeoutMs', () => {
  const KEY = 'AFK_MODEL_STALL_TIMEOUT_MS';
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env[KEY];
    delete process.env[KEY];
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[KEY];
    else process.env[KEY] = saved;
  });

  it('defaults to 20 minutes when unset', () => {
    expect(resolveStallTimeoutMs()).toBe(DEFAULT_MODEL_STALL_TIMEOUT_MS);
    expect(DEFAULT_MODEL_STALL_TIMEOUT_MS).toBe(1_200_000);
  });

  it('defaults when empty / whitespace', () => {
    process.env[KEY] = '   ';
    expect(resolveStallTimeoutMs()).toBe(DEFAULT_MODEL_STALL_TIMEOUT_MS);
  });

  it('returns 0 (disabled) when set to 0 — the escape hatch', () => {
    process.env[KEY] = '0';
    expect(resolveStallTimeoutMs()).toBe(0);
  });

  it('honours an explicit positive override', () => {
    process.env[KEY] = '90000';
    expect(resolveStallTimeoutMs()).toBe(90_000);
  });

  it('falls back to the default on non-numeric or negative input', () => {
    process.env[KEY] = 'abc';
    expect(resolveStallTimeoutMs()).toBe(DEFAULT_MODEL_STALL_TIMEOUT_MS);
    process.env[KEY] = '-1';
    expect(resolveStallTimeoutMs()).toBe(DEFAULT_MODEL_STALL_TIMEOUT_MS);
  });

  it('clamps an above-ceiling override to the platform timer maximum', () => {
    // The trap this closes: `stallTimeoutError()` tells the operator to "Raise
    // AFK_MODEL_STALL_TIMEOUT_MS". Following that past 2^31-1 would, unclamped,
    // make Node coerce the delay to 1ms and abort every round a few
    // milliseconds after its first content token — the inverse of the request.
    process.env[KEY] = '3000000000';
    expect(resolveStallTimeoutMs()).toBe(MAX_TIMER_DELAY_MS);
    process.env[KEY] = String(MAX_TIMER_DELAY_MS + 1);
    expect(resolveStallTimeoutMs()).toBe(MAX_TIMER_DELAY_MS);
    process.env[KEY] = String(MAX_TIMER_DELAY_MS);
    expect(resolveStallTimeoutMs()).toBe(MAX_TIMER_DELAY_MS);
  });
});

// ---------------------------------------------------------------------------
// armStreamStallWatchdog — suspend() / resumeTimer() (issue #4693)
// ---------------------------------------------------------------------------

describe('armStreamStallWatchdog suspend/resumeTimer', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('suspend() stops the timer from firing', () => {
    const base = new AbortController();
    const handle = armStreamStallWatchdog(base.signal, 1_000);
    // Arm the watchdog with a progress call.
    handle.progress();
    // Suspend before the timeout fires.
    handle.suspend();
    // Advance past the full window — the signal must NOT abort.
    vi.advanceTimersByTime(2_000);
    expect(base.signal.aborted).toBe(false);
    expect(handle.timedOut()).toBe(false);
    handle.dispose();
  });

  it('resumeTimer() re-arms from zero after suspend()', () => {
    const base = new AbortController();
    const fired: number[] = [];
    const handle = armStreamStallWatchdog(base.signal, 1_000, () => { fired.push(Date.now()); });
    handle.progress();
    // Advance halfway, then suspend.
    vi.advanceTimersByTime(500);
    handle.suspend();
    // Advance well past original deadline — still no fire.
    vi.advanceTimersByTime(1_500);
    expect(fired).toHaveLength(0);
    // Resume: a fresh 1 s window starts from now.
    handle.resumeTimer();
    vi.advanceTimersByTime(999);
    expect(fired).toHaveLength(0); // not yet
    vi.advanceTimersByTime(2);     // push past the 1 s mark
    expect(fired).toHaveLength(1); // now it fired
    handle.dispose();
  });

  it('resumeTimer() is a no-op when not suspended', () => {
    const base = new AbortController();
    const handle = armStreamStallWatchdog(base.signal, 1_000);
    handle.progress();
    // resumeTimer without a prior suspend — must not throw or double-arm.
    expect(() => handle.resumeTimer()).not.toThrow();
    vi.advanceTimersByTime(2_000);
    // The timer fired normally (timedOut = true); signal should be aborted.
    expect(handle.timedOut()).toBe(true);
    handle.dispose();
  });

  it('suspend() is idempotent', () => {
    const base = new AbortController();
    const handle = armStreamStallWatchdog(base.signal, 1_000);
    handle.progress();
    handle.suspend();
    expect(() => handle.suspend()).not.toThrow(); // second call must not throw
    vi.advanceTimersByTime(2_000);
    expect(handle.timedOut()).toBe(false);
    handle.dispose();
  });
});
