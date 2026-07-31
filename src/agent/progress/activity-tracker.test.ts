/**
 * Tests for the surface-agnostic activity/stall tracker.
 *
 * The high-value property is the absence of FALSE POSITIVES: reporting a child as
 * stalled when it is merely finished (or when a late event arrives) would erode
 * trust in the exact signal this exists to provide.
 */

import { describe, it, expect } from 'vitest';
import { ActivityTracker } from './activity-tracker.js';

const T0 = 1_700_000_000_000;

describe('ActivityTracker', () => {
  it('reports undefined silence for a child it has never seen', () => {
    expect(new ActivityTracker().silentMs('nope', T0)).toBeUndefined();
  });

  it('measures silence from the last observed event', () => {
    const t = new ActivityTracker();
    t.note({ subagentId: 'a', at: T0 });
    expect(t.silentMs('a', T0 + 5_000)).toBe(5_000);
  });

  it('never reports negative silence when clocks disagree', () => {
    const t = new ActivityTracker();
    t.note({ subagentId: 'a', at: T0 });
    expect(t.silentMs('a', T0 - 10_000)).toBe(0);
  });

  it('resets the silence clock on each new event', () => {
    const t = new ActivityTracker();
    t.note({ subagentId: 'a', at: T0 });
    t.note({ subagentId: 'a', at: T0 + 9_000 });
    expect(t.silentMs('a', T0 + 10_000)).toBe(1_000);
  });

  it('retains a known agentType when a later event omits it', () => {
    const t = new ActivityTracker();
    t.note({ subagentId: 'a', agentType: 'research-agent', at: T0 });
    t.note({ subagentId: 'a', at: T0 + 100 });
    expect(t.snapshot(T0 + 100)[0]?.agentType).toBe('research-agent');
  });

  describe('stalled()', () => {
    it('returns nothing when every child is fresh', () => {
      const t = new ActivityTracker();
      t.note({ subagentId: 'a', at: T0 });
      expect(t.stalled(30_000, T0 + 1_000)).toEqual([]);
    });

    it('returns children at or beyond the threshold, quietest first', () => {
      const t = new ActivityTracker();
      t.note({ subagentId: 'quiet', at: T0 });
      t.note({ subagentId: 'quieter', at: T0 - 20_000 });
      t.note({ subagentId: 'fresh', at: T0 + 39_000 });
      const stalled = t.stalled(30_000, T0 + 40_000);
      expect(stalled.map((s) => s.subagentId)).toEqual(['quieter', 'quiet']);
    });

    it('EXCLUDES settled children — finished is not stalled', () => {
      // The false positive that would matter most: a completed wave reported as
      // hung. Nothing about a settled child should ever surface as an alarm.
      const t = new ActivityTracker();
      t.note({ subagentId: 'a', at: T0 });
      t.note({ subagentId: 'a', at: T0, settled: true });
      expect(t.stalled(1_000, T0 + 600_000)).toEqual([]);
    });

    it('honors the caller-supplied threshold rather than a baked-in one', () => {
      // Each surface owns its own cutoff (REPL 30s, Telegram 60s), which is why
      // the tracker reports raw elapsed silence.
      const t = new ActivityTracker();
      t.note({ subagentId: 'a', at: T0 });
      expect(t.stalled(30_000, T0 + 45_000)).toHaveLength(1);
      expect(t.stalled(60_000, T0 + 45_000)).toHaveLength(0);
    });
  });

  describe('settled semantics', () => {
    it('keeps a settled child settled despite a late trailing event', () => {
      // A resurrected child would restart the silence clock and mask a wave that
      // has genuinely finished.
      const t = new ActivityTracker();
      t.note({ subagentId: 'a', at: T0, settled: true });
      t.note({ subagentId: 'a', at: T0 + 5_000 });
      const snap = t.snapshot(T0 + 5_000).find((s) => s.subagentId === 'a');
      expect(snap?.settled).toBe(true);
      expect(snap?.lastActivityAt).toBe(T0);
    });

    it('counts only unsettled children as running', () => {
      const t = new ActivityTracker();
      t.note({ subagentId: 'a', at: T0 });
      t.note({ subagentId: 'b', at: T0 });
      t.note({ subagentId: 'b', at: T0, settled: true });
      expect(t.runningCount()).toBe(1);
    });
  });

  it('snapshot() orders most-recently-active first', () => {
    const t = new ActivityTracker();
    t.note({ subagentId: 'old', at: T0 });
    t.note({ subagentId: 'new', at: T0 + 10_000 });
    expect(t.snapshot(T0 + 10_000).map((s) => s.subagentId)).toEqual(['new', 'old']);
  });

  it('forget() and reset() drop tracking', () => {
    const t = new ActivityTracker();
    t.note({ subagentId: 'a', at: T0 });
    t.note({ subagentId: 'b', at: T0 });
    t.forget('a');
    expect(t.silentMs('a', T0)).toBeUndefined();
    expect(t.runningCount()).toBe(1);
    t.reset();
    expect(t.runningCount()).toBe(0);
  });
});
