// Pins the platform fact that makes `clampTimerDelayMs` load-bearing: Node does
// NOT saturate an over-ceiling setTimeout delay, it coerces it to 1ms. Without
// the clamp, "raise the timeout" silently becomes "abort immediately".

import { describe, it, expect, vi } from 'vitest';
import { clampTimerDelayMs, MAX_TIMER_DELAY_MS } from './timer-limits.js';

describe('MAX_TIMER_DELAY_MS', () => {
  it('is the 32-bit signed ceiling Node enforces on timer delays', () => {
    expect(MAX_TIMER_DELAY_MS).toBe(2 ** 31 - 1);
  });
});

describe('clampTimerDelayMs', () => {
  it('passes through values at or below the ceiling unchanged', () => {
    expect(clampTimerDelayMs(0)).toBe(0);
    expect(clampTimerDelayMs(180_000)).toBe(180_000);
    expect(clampTimerDelayMs(1_200_000)).toBe(1_200_000);
    expect(clampTimerDelayMs(MAX_TIMER_DELAY_MS)).toBe(MAX_TIMER_DELAY_MS);
  });

  it('clamps above-ceiling values DOWN to the ceiling (never up, never to 1)', () => {
    expect(clampTimerDelayMs(MAX_TIMER_DELAY_MS + 1)).toBe(MAX_TIMER_DELAY_MS);
    // The value an operator plausibly reaches for when told to "raise" a bound.
    expect(clampTimerDelayMs(3_000_000_000)).toBe(MAX_TIMER_DELAY_MS);
    expect(clampTimerDelayMs(Number.MAX_SAFE_INTEGER)).toBe(MAX_TIMER_DELAY_MS);
  });

  it('does not clamp the lower end — 0 stays 0 so disable escape hatches survive', () => {
    expect(clampTimerDelayMs(0)).toBe(0);
  });
});

describe('the overflow this clamp defends against', () => {
  it('fires an UNCLAMPED over-ceiling delay almost immediately, but a clamped one never', () => {
    vi.useFakeTimers();
    try {
      const unclamped = vi.fn();
      const clamped = vi.fn();
      // Verbatim what Node does with an over-ceiling delay: coerce to 1ms.
      setTimeout(unclamped, MAX_TIMER_DELAY_MS + 1);
      setTimeout(clamped, clampTimerDelayMs(MAX_TIMER_DELAY_MS + 1));

      vi.advanceTimersByTime(50);
      // The bug: asking for ~24.9 days got you ~1ms.
      expect(unclamped).toHaveBeenCalled();
      // The fix: asking for more than the ceiling gets you the ceiling.
      expect(clamped).not.toHaveBeenCalled();

      vi.advanceTimersByTime(MAX_TIMER_DELAY_MS);
      expect(clamped).toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
