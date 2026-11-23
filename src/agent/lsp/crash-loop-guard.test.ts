/**
 * Tests for CrashLoopGuard (#4272 crash-restart loop guard).
 * Uses an injectable clock so no real timers are needed.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  CrashLoopGuard,
  CRASH_LIMIT,
  CRASH_WINDOW_MS,
  getOrCreateGuard,
  deleteGuard,
  clearGuards,
} from './crash-loop-guard.js';

// ---------------------------------------------------------------------------
// CrashLoopGuard unit tests
// ---------------------------------------------------------------------------

describe('CrashLoopGuard', () => {
  it('is not failed on construction', () => {
    const g = new CrashLoopGuard();
    expect(g.failed).toBe(false);
    expect(g.recentCrashes).toBe(0);
  });

  it('trips after CRASH_LIMIT crashes within the window', () => {
    let t = 0;
    const g = new CrashLoopGuard({ now: () => t });

    for (let i = 0; i < CRASH_LIMIT - 1; i++) {
      t += 1000;
      expect(g.recordCrash()).toBe(false);
      expect(g.failed).toBe(false);
    }
    t += 1000;
    expect(g.recordCrash()).toBe(true);
    expect(g.failed).toBe(true);
  });

  it('uses CRASH_LIMIT = 3 and CRASH_WINDOW_MS = 120000 as defaults', () => {
    expect(CRASH_LIMIT).toBe(3);
    expect(CRASH_WINDOW_MS).toBe(120_000);
  });

  it('does NOT trip when crashes are spread beyond the window', () => {
    let t = 0;
    const g = new CrashLoopGuard({ now: () => t, windowMs: 10_000 });

    // Two crashes inside the window
    t = 0;
    g.recordCrash();
    t = 5_000;
    g.recordCrash();
    expect(g.failed).toBe(false);

    // Third crash is outside the window for the first one (first rolls off)
    t = 11_000; // first crash at t=0 is now > 10 000 ms ago
    expect(g.recordCrash()).toBe(false);
    expect(g.failed).toBe(false);
    expect(g.recentCrashes).toBe(2); // only t=5000 and t=11000 are in-window
  });

  it('stays failed forever after the guard trips', () => {
    let t = 0;
    const g = new CrashLoopGuard({ now: () => t, limit: 2 });
    t = 1; g.recordCrash();
    t = 2; g.recordCrash();
    expect(g.failed).toBe(true);
    // Advance clock far beyond the window
    t = 1_000_000;
    expect(g.failed).toBe(true);
    // recordCrash while failed is a no-op but returns true
    expect(g.recordCrash()).toBe(true);
  });

  it('honours custom limit and windowMs', () => {
    let t = 0;
    const g = new CrashLoopGuard({ limit: 2, windowMs: 5_000, now: () => t });
    t = 1_000; g.recordCrash();
    expect(g.failed).toBe(false);
    t = 4_000;
    expect(g.recordCrash()).toBe(true);
    expect(g.failed).toBe(true);
  });

  it('recentCrashes reflects pruned window count (not failed)', () => {
    let t = 0;
    const g = new CrashLoopGuard({ limit: 10, windowMs: 5_000, now: () => t });
    t = 0;  g.recordCrash();
    t = 2_000; g.recordCrash();
    t = 4_000; g.recordCrash();
    expect(g.recentCrashes).toBe(3);
    // Advance so first crash rolls out
    t = 6_000;
    expect(g.recentCrashes).toBe(2);
  });

  // -------------------------------------------------------------------------
  // Window boundary tests (item 3 of #5132)
  // -------------------------------------------------------------------------

  it('a crash at exactly the window boundary is still inside the window (closed lower bound)', () => {
    // windowMs = 10_000; crash 1 at t=0, crash 3 at t=10_000.
    // cutoff for crash 3 = 10_000 - 10_000 = 0.
    // crash 1 timestamp (0) == cutoff (0) → NOT pruned → all three are in-window → guard trips.
    let t = 0;
    const g = new CrashLoopGuard({ now: () => t, windowMs: 10_000 });
    t = 0;      g.recordCrash(); // crash 1
    t = 5_000;  g.recordCrash(); // crash 2
    t = 10_000; // cutoff = 0; crash 1 is at exactly cutoff → still in window
    expect(g.recordCrash()).toBe(true); // crash 3 trips the guard
    expect(g.failed).toBe(true);
  });

  it('a crash one millisecond past the boundary has rolled out (open upper bound)', () => {
    // windowMs = 10_000; crash 1 at t=0, crash 3 at t=10_001.
    // cutoff = 10_001 - 10_000 = 1 → crash 1 (timestamp 0) < 1 → pruned.
    let t = 0;
    const g = new CrashLoopGuard({ now: () => t, windowMs: 10_000 });
    t = 0;      g.recordCrash(); // crash 1 — will roll out
    t = 5_000;  g.recordCrash(); // crash 2 — stays in
    t = 10_001; // cutoff = 1; crash 1 timestamp (0) < 1 → pruned
    expect(g.recordCrash()).toBe(false); // only 2 in window, guard does not trip
    expect(g.failed).toBe(false);
    expect(g.recentCrashes).toBe(2);
  });

  it('recentCrashes also treats the boundary as inside the window', () => {
    let t = 0;
    const g = new CrashLoopGuard({ limit: 10, windowMs: 5_000, now: () => t });
    t = 0;     g.recordCrash(); // crash at t=0
    t = 5_000; // cutoff = 0; crash at exactly cutoff → still in window
    expect(g.recentCrashes).toBe(1);
    t = 5_001; // cutoff = 1; crash timestamp (0) < 1 → pruned
    expect(g.recentCrashes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// getOrCreateGuard / clearGuards
// ---------------------------------------------------------------------------

describe('getOrCreateGuard', () => {
  beforeEach(() => clearGuards());
  afterEach(() => clearGuards());

  it('returns the same instance for the same key', () => {
    const a = getOrCreateGuard('k1');
    const b = getOrCreateGuard('k1');
    expect(a).toBe(b);
  });

  it('returns different instances for different keys', () => {
    const a = getOrCreateGuard('k1');
    const b = getOrCreateGuard('k2');
    expect(a).not.toBe(b);
  });

  it('deleteGuard removes only the targeted key', () => {
    const a = getOrCreateGuard('k1');
    getOrCreateGuard('k2');
    deleteGuard('k1');
    expect(getOrCreateGuard('k1')).not.toBe(a);
    // k2 survives
    expect(getOrCreateGuard('k2')).toBe(getOrCreateGuard('k2'));
  });

  it('clearGuards removes all entries', () => {
    const a = getOrCreateGuard('k1');
    clearGuards();
    expect(getOrCreateGuard('k1')).not.toBe(a);
  });
});
