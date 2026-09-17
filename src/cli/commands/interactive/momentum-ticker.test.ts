/**
 * Unit tests for `MomentumTicker`.
 *
 * Uses `vi.useFakeTimers()` / `vi.setSystemTime()` to control `Date.now()`
 * deterministically so rate computations are fully reproducible.
 *
 * Constants under test (re-declared here for reference — must stay in sync
 * with the values exported implicitly via behaviour):
 *   MIN_SAMPLE_MS         = 50
 *   MAX_GAP_MS            = 3_000
 *   REPAINT_INTERVAL_MS   = 300   (named REPAINT_THROTTLE_MS in the issue)
 *   EMA_ALPHA             = 0.25
 *   CHARS_PER_TOKEN       = 4
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { MomentumTicker } from './momentum-ticker.js';

// ─── constants mirrored from the implementation ──────────────────────────────
const MIN_SAMPLE_MS = 50;
const MAX_GAP_MS = 3_000;
const REPAINT_INTERVAL_MS = 300;
const EMA_ALPHA = 0.25;
const CHARS_PER_TOKEN = 4;

// ─── helpers ─────────────────────────────────────────────────────────────────

/**
 * Advance fake time by `ms` milliseconds and then call `Date.now()` to ensure
 * vitest's fake clock is settled before the next assertion.
 */
function advanceTime(ms: number): void {
  vi.advanceTimersByTime(ms);
}

/**
 * Compute the expected EMA rate for a single interval.
 *
 * @param chars      Total chars sent in the window.
 * @param elapsedMs  Window duration in milliseconds.
 * @param prevRate   Previous smoothed rate (null for the very first sample).
 */
function expectedRate(
  chars: number,
  elapsedMs: number,
  prevRate: number | null,
): number {
  const instant = (chars / CHARS_PER_TOKEN / elapsedMs) * 1_000;
  return prevRate === null ? instant : EMA_ALPHA * instant + (1 - EMA_ALPHA) * prevRate;
}

// ─── test suite ──────────────────────────────────────────────────────────────

describe('MomentumTicker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── construction ───────────────────────────────────────────────────────────

  describe('construction', () => {
    it('does not fire onRepaint during construction', () => {
      const onRepaint = vi.fn();
      new MomentumTicker(onRepaint);
      expect(onRepaint).not.toHaveBeenCalled();
    });

    it('works without an onRepaint callback (no-op constructor)', () => {
      expect(() => {
        const ticker = new MomentumTicker();
        ticker.start();
        ticker.update(100);
        ticker.stop();
      }).not.toThrow();
    });
  });

  // ── no-op before start / after stop ────────────────────────────────────────

  describe('no-op guard', () => {
    it('ignores update() before start()', () => {
      const onRepaint = vi.fn();
      const ticker = new MomentumTicker(onRepaint);

      advanceTime(500);
      ticker.update(200);
      advanceTime(500);
      ticker.update(200);

      expect(onRepaint).not.toHaveBeenCalled();
      expect(ticker.getCurrentRate()).toBeNull();
    });

    it('ignores update() after stop()', () => {
      const onRepaint = vi.fn();
      const ticker = new MomentumTicker(onRepaint);

      ticker.start();
      advanceTime(MIN_SAMPLE_MS + 1);
      ticker.update(100);
      advanceTime(REPAINT_INTERVAL_MS);
      ticker.update(100); // triggers first repaint

      ticker.stop(); // fires repaint(null)
      onRepaint.mockClear();

      advanceTime(500);
      ticker.update(999);
      expect(onRepaint).not.toHaveBeenCalled();
      expect(ticker.getCurrentRate()).toBeNull();
    });

    it('ignores update() with charCount <= 0', () => {
      const onRepaint = vi.fn();
      const ticker = new MomentumTicker(onRepaint);
      ticker.start();

      advanceTime(500);
      ticker.update(0);
      ticker.update(-5);

      expect(onRepaint).not.toHaveBeenCalled();
    });
  });

  // ── EMA rate computation ───────────────────────────────────────────────────

  describe('EMA rate computation', () => {
    it('establishes initial rate after first qualifying interval', () => {
      const onRepaint = vi.fn();
      const ticker = new MomentumTicker(onRepaint);

      ticker.start();

      // First update: seeds lastSampleMs, no rate yet.
      advanceTime(1);
      ticker.update(100);

      // Second update after MIN_SAMPLE_MS + buffer + past REPAINT_INTERVAL_MS.
      advanceTime(REPAINT_INTERVAL_MS); // 300ms — triggers both sample & repaint
      ticker.update(80);

      // Elapsed between sample 1 and sample 2 = REPAINT_INTERVAL_MS (300ms).
      // chars = 100 (pending from first update) + 80 (this update) = 180.
      const elapsedMs = REPAINT_INTERVAL_MS;
      const chars = 100 + 80;
      const rate = expectedRate(chars, elapsedMs, null);

      expect(onRepaint).toHaveBeenCalledOnce();
      expect(onRepaint.mock.calls[0][0]).toBeCloseTo(rate, 6);
    });

    it('applies EMA across multiple intervals', () => {
      const onRepaint = vi.fn();
      const ticker = new MomentumTicker(onRepaint);

      ticker.start();

      // Seed the sample clock.
      ticker.update(40);

      // Interval 1: 400ms, 160 chars → instant = 100 tok/s; EMA starts = 100.
      advanceTime(400);
      ticker.update(160);
      const rate1 = expectedRate(40 + 160, 400, null);
      // onRepaint fires because 400 >= REPAINT_INTERVAL_MS.
      expect(onRepaint).toHaveBeenCalledTimes(1);
      expect(onRepaint.mock.lastCall![0]).toBeCloseTo(rate1, 4);

      // Interval 2: another 400ms, 80 chars.
      advanceTime(400);
      ticker.update(80);
      const rate2 = expectedRate(80, 400, rate1);
      expect(onRepaint).toHaveBeenCalledTimes(2);
      expect(onRepaint.mock.lastCall![0]).toBeCloseTo(rate2, 4);
    });

    it('getCurrentRate() returns the latest smoothed rate while running', () => {
      const ticker = new MomentumTicker();
      ticker.start();
      expect(ticker.getCurrentRate()).toBeNull(); // nothing sampled yet

      ticker.update(40);
      advanceTime(400);
      ticker.update(160);

      const rate = expectedRate(40 + 160, 400, null);
      expect(ticker.getCurrentRate()).toBeCloseTo(rate, 4);
    });

    it('getCurrentRate() returns null when stopped', () => {
      const ticker = new MomentumTicker();
      ticker.start();
      ticker.update(40);
      advanceTime(400);
      ticker.update(160);
      ticker.stop();

      expect(ticker.getCurrentRate()).toBeNull();
    });
  });

  // ── MIN_SAMPLE_MS threshold ────────────────────────────────────────────────

  describe('MIN_SAMPLE_MS threshold', () => {
    it('skips rate computation when elapsed < MIN_SAMPLE_MS', () => {
      const onRepaint = vi.fn();
      const ticker = new MomentumTicker(onRepaint);
      ticker.start();

      // Seed sample clock.
      ticker.update(10);

      // Update too soon — elapsed is MIN_SAMPLE_MS - 1.
      advanceTime(MIN_SAMPLE_MS - 1);
      ticker.update(400);

      // Not enough time has passed — no rate, no repaint.
      expect(onRepaint).not.toHaveBeenCalled();
      expect(ticker.getCurrentRate()).toBeNull();
    });

    it('computes rate once MIN_SAMPLE_MS is reached', () => {
      const onRepaint = vi.fn();
      const ticker = new MomentumTicker(onRepaint);
      ticker.start();

      ticker.update(10);
      advanceTime(MIN_SAMPLE_MS); // exactly at threshold
      ticker.update(400);

      // Rate should exist now (repaint only fires once REPAINT_INTERVAL_MS too)
      const rate = expectedRate(10 + 400, MIN_SAMPLE_MS, null);
      expect(ticker.getCurrentRate()).toBeCloseTo(rate, 4);
    });
  });

  // ── MAX_GAP_MS gap discard ─────────────────────────────────────────────────

  describe('gap discard (MAX_GAP_MS)', () => {
    it('discards the interval when elapsed > MAX_GAP_MS', () => {
      const onRepaint = vi.fn();
      const ticker = new MomentumTicker(onRepaint);

      ticker.start();
      ticker.update(100); // seed
      advanceTime(MAX_GAP_MS + 1);
      ticker.update(100); // gap detected → restart window, no rate, no repaint

      // The gap branch resets lastSampleMs and pendingChars, returning early
      // without computing a rate or firing the callback.
      expect(onRepaint).not.toHaveBeenCalled();
      expect(ticker.getCurrentRate()).toBeNull();
    });

    it('resumes rate computation normally after a gap', () => {
      const onRepaint = vi.fn();
      const ticker = new MomentumTicker(onRepaint);

      ticker.start();
      ticker.update(100); // seed — initialises lastSampleMs
      advanceTime(MAX_GAP_MS + 1); // gap
      // Gap branch: pendingChars reset to 0, lastSampleMs = now; no rate.
      ticker.update(100); // only resets window — pendingChars is cleared after this

      // Now accumulate chars in the fresh window.
      advanceTime(REPAINT_INTERVAL_MS);
      // pendingChars = 0 (was reset) + 120 = 120; elapsed = REPAINT_INTERVAL_MS.
      ticker.update(120);

      const rate = expectedRate(120, REPAINT_INTERVAL_MS, null);
      expect(onRepaint).toHaveBeenCalledOnce();
      expect(onRepaint.mock.calls[0][0]).toBeCloseTo(rate, 4);
    });

    it('exactly at MAX_GAP_MS boundary does NOT discard (> not >=)', () => {
      const onRepaint = vi.fn();
      const ticker = new MomentumTicker(onRepaint);

      ticker.start();
      ticker.update(40);
      advanceTime(MAX_GAP_MS); // exactly MAX_GAP_MS — condition is >, so not a gap
      ticker.update(40);

      // Rate should be computed (elapsed == MAX_GAP_MS, not > MAX_GAP_MS).
      const rate = expectedRate(40 + 40, MAX_GAP_MS, null);
      expect(ticker.getCurrentRate()).toBeCloseTo(rate, 4);
    });
  });

  // ── REPAINT_INTERVAL_MS throttle ──────────────────────────────────────────

  describe('repaint throttle (REPAINT_INTERVAL_MS)', () => {
    it('does not fire onRepaint before REPAINT_INTERVAL_MS has elapsed', () => {
      const onRepaint = vi.fn();
      const ticker = new MomentumTicker(onRepaint);

      ticker.start();
      ticker.update(10); // seed

      // Multiple updates within REPAINT_INTERVAL_MS.
      for (let i = 0; i < 5; i++) {
        advanceTime(MIN_SAMPLE_MS + 1);
        ticker.update(100);
      }
      // Total elapsed: 5 * (MIN_SAMPLE_MS + 1) = 255ms < REPAINT_INTERVAL_MS.
      expect(onRepaint).not.toHaveBeenCalled();
    });

    it('fires onRepaint at most once per REPAINT_INTERVAL_MS', () => {
      const onRepaint = vi.fn();
      const ticker = new MomentumTicker(onRepaint);

      ticker.start();
      ticker.update(10); // seed

      // Fast updates across two full REPAINT_INTERVAL_MS windows.
      for (let i = 0; i < 20; i++) {
        advanceTime(MIN_SAMPLE_MS + 1);
        ticker.update(50);
      }
      // 20 * 51ms = 1020ms → produces exactly 3 repaints (at 306ms, 612ms, 918ms).
      expect(onRepaint.mock.calls.length).toBe(3);
    });

    it('fires again once REPAINT_INTERVAL_MS has elapsed since last repaint', () => {
      const onRepaint = vi.fn();
      const ticker = new MomentumTicker(onRepaint);

      ticker.start();
      ticker.update(10); // seed

      // First repaint window.
      advanceTime(REPAINT_INTERVAL_MS);
      ticker.update(100);
      expect(onRepaint).toHaveBeenCalledTimes(1);

      // One more update immediately — throttled.
      advanceTime(MIN_SAMPLE_MS + 1);
      ticker.update(100);
      expect(onRepaint).toHaveBeenCalledTimes(1);

      // Cross the next repaint boundary.
      advanceTime(REPAINT_INTERVAL_MS);
      ticker.update(100);
      expect(onRepaint).toHaveBeenCalledTimes(2);
    });
  });

  // ── stop() behaviour ───────────────────────────────────────────────────────

  describe('stop()', () => {
    it('fires onRepaint(null) exactly once', () => {
      const onRepaint = vi.fn();
      const ticker = new MomentumTicker(onRepaint);

      ticker.start();
      advanceTime(400);
      ticker.update(100);

      onRepaint.mockClear();
      ticker.stop();

      expect(onRepaint).toHaveBeenCalledOnce();
      expect(onRepaint.mock.calls[0][0]).toBeNull();
    });

    it('fires onRepaint(null) even when no rate was established', () => {
      const onRepaint = vi.fn();
      const ticker = new MomentumTicker(onRepaint);

      ticker.start();
      ticker.stop();

      expect(onRepaint).toHaveBeenCalledOnce();
      expect(onRepaint.mock.calls[0][0]).toBeNull();
    });

    it('calling stop() multiple times fires onRepaint(null) only once per call', () => {
      const onRepaint = vi.fn();
      const ticker = new MomentumTicker(onRepaint);

      ticker.start();
      ticker.stop();
      ticker.stop(); // second stop — ticker already stopped but stop() is unconditional

      expect(onRepaint).toHaveBeenCalledTimes(2);
      expect(onRepaint.mock.calls.every((c) => c[0] === null)).toBe(true);
    });

    it('resets all internal state so a subsequent start() is clean', () => {
      const onRepaint = vi.fn();
      const ticker = new MomentumTicker(onRepaint);

      // First turn.
      ticker.start();
      ticker.update(200); // seed
      advanceTime(400);
      ticker.update(200); // produce a rate
      ticker.stop();
      onRepaint.mockClear();

      // Second turn — state should be fully reset, prior rate discarded.
      ticker.start();
      expect(ticker.getCurrentRate()).toBeNull();

      // Seed the new turn's sample clock, then advance to produce a rate.
      ticker.update(40); // seeds lastSampleMs
      advanceTime(REPAINT_INTERVAL_MS);
      ticker.update(120);

      // Elapsed = REPAINT_INTERVAL_MS, chars seeded + new = 40 + 120 = 160.
      const rate = expectedRate(40 + 120, REPAINT_INTERVAL_MS, null);
      expect(onRepaint).toHaveBeenCalledOnce();
      expect(onRepaint.mock.calls[0][0]).toBeCloseTo(rate, 4);
    });
  });

  // ── edge cases ─────────────────────────────────────────────────────────────

  describe('edge cases', () => {
    it('handles very high char rates without overflow', () => {
      const onRepaint = vi.fn();
      const ticker = new MomentumTicker(onRepaint);

      ticker.start();
      ticker.update(1_000_000);
      advanceTime(REPAINT_INTERVAL_MS);
      ticker.update(1_000_000);

      expect(onRepaint).toHaveBeenCalledOnce();
      const rate = onRepaint.mock.calls[0][0] as number;
      expect(rate).toBeGreaterThan(0);
      expect(Number.isFinite(rate)).toBe(true);
    });

    it('accumulates pendingChars across multiple sub-MIN_SAMPLE_MS updates', () => {
      const onRepaint = vi.fn();
      const ticker = new MomentumTicker(onRepaint);

      ticker.start();
      // Seed: pendingChars += 10, lastSampleMs set, returns early.
      // pendingChars stays at 10 (NOT cleared on seed).
      ticker.update(10);

      // Three rapid updates below MIN_SAMPLE_MS each — they just accumulate.
      advanceTime(10);
      ticker.update(20); // pendingChars = 30
      advanceTime(10);
      ticker.update(30); // pendingChars = 60
      advanceTime(10);
      ticker.update(40); // pendingChars = 100; total elapsed = 30ms < MIN_SAMPLE_MS
      expect(ticker.getCurrentRate()).toBeNull();

      // Cross MIN_SAMPLE_MS and REPAINT_INTERVAL_MS at once.
      advanceTime(REPAINT_INTERVAL_MS);
      ticker.update(50); // pendingChars = 150; elapsed = 30 + REPAINT_INTERVAL_MS = 330ms

      // Total chars in window: 10 (seed) + 20 + 30 + 40 + 50 = 150; elapsed = 330ms.
      const rate = expectedRate(150, 330, null);
      expect(onRepaint).toHaveBeenCalledOnce();
      expect(onRepaint.mock.calls[0][0]).toBeCloseTo(rate, 4);
    });
  });
});
