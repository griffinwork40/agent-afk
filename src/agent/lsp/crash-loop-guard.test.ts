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
