/**
 * Unit tests for the SOFT wall-clock deadline policy.
 *
 * Pure module, so these are direct value assertions — no fake timers, no
 * session, no provider. The `now` injection on `softDeadlineExpired` is what
 * keeps the time-dependent half testable without a clock.
 */

import { describe, expect, it } from 'vitest';
import {
  SOFT_DEADLINE_MAX_RESERVE_MS,
  SOFT_DEADLINE_MIN_BUDGET_MS,
  SOFT_DEADLINE_MIN_RESERVE_MS,
  SOFT_DEADLINE_NOTE,
  SOFT_DEADLINE_RESERVE_FRACTION,
  SOFT_DEADLINE_WIND_DOWN,
  resolveSoftDeadlineMs,
  softDeadlineExpired,
} from './soft-deadline.js';

describe('resolveSoftDeadlineMs', () => {
  it('returns 0 for an unbounded budget (undefined / 0)', () => {
    // The top-level-session case: a human owns the turn, so there is no
    // wall-clock budget to carve a reserve out of.
    expect(resolveSoftDeadlineMs(undefined)).toBe(0);
    expect(resolveSoftDeadlineMs(0)).toBe(0);
  });

  it('returns 0 for non-finite and negative budgets', () => {
    expect(resolveSoftDeadlineMs(Number.NaN)).toBe(0);
    expect(resolveSoftDeadlineMs(Number.POSITIVE_INFINITY)).toBe(0);
    expect(resolveSoftDeadlineMs(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(resolveSoftDeadlineMs(-1)).toBe(0);
    expect(resolveSoftDeadlineMs(-60_000)).toBe(0);
  });

  it('returns 0 at or below the minimum-budget floor', () => {
    // Below ~2 min there is no split leaving both working time and a usable
    // synthesis reserve, so short-budget forks keep the prior hard-abort
    // behaviour byte-for-byte.
    expect(resolveSoftDeadlineMs(1)).toBe(0);
    expect(resolveSoftDeadlineMs(1_000)).toBe(0);
    expect(resolveSoftDeadlineMs(60_000)).toBe(0);
    expect(resolveSoftDeadlineMs(SOFT_DEADLINE_MIN_BUDGET_MS)).toBe(0);
  });

  it('arms just above the floor, clamping the reserve to its minimum', () => {
    // 120_001 × 0.15 = 18_000.15 — below MIN_RESERVE, so the reserve clamps up
    // to 30s. The result is small but positive: the budget is bounded, so a
    // wind-down is better than a hard kill.
    const budget = SOFT_DEADLINE_MIN_BUDGET_MS + 1;
    expect(resolveSoftDeadlineMs(budget)).toBe(budget - SOFT_DEADLINE_MIN_RESERVE_MS);
  });

  it('clamps the reserve at the LOW end (raw fraction below the floor)', () => {
    // 150s × 0.15 = 22.5s < 30s floor → reserve is 30s, not 22.5s.
    const budget = 150_000;
    expect(budget * SOFT_DEADLINE_RESERVE_FRACTION).toBeLessThan(SOFT_DEADLINE_MIN_RESERVE_MS);
    expect(resolveSoftDeadlineMs(budget)).toBe(120_000);
  });

  it('clamps the reserve at the HIGH end (raw fraction above the ceiling)', () => {
    // 60 min × 0.15 = 9 min > 5 min ceiling → reserve is 5 min, so extra
    // headroom is not stolen from working time on a long budget.
    const budget = 60 * 60_000;
    expect(budget * SOFT_DEADLINE_RESERVE_FRACTION).toBeGreaterThan(SOFT_DEADLINE_MAX_RESERVE_MS);
    expect(resolveSoftDeadlineMs(budget)).toBe(budget - SOFT_DEADLINE_MAX_RESERVE_MS);
  });

  it('uses the raw fraction when it falls between the clamps', () => {
    // 8 min × 0.15 = 72s, inside [30s, 5min] → used as-is.
    const budget = 8 * 60_000;
    expect(resolveSoftDeadlineMs(budget)).toBe(budget - 72_000);
  });

  it('resolves the 45-minute subagent default to 40 minutes', () => {
    // The headline case: SUBAGENT_DEFAULT_TIMEOUT_MS. 45 × 0.15 = 6.75 min,
    // clamped to the 5-min ceiling → wind-down at 40 min, hard abort at 45.
    expect(resolveSoftDeadlineMs(45 * 60_000)).toBe(40 * 60_000);
  });

  it('always returns an integer strictly inside the hard budget', () => {
    for (const budget of [120_001, 150_000, 480_000, 2_700_000, 3_600_000]) {
      const soft = resolveSoftDeadlineMs(budget);
      expect(Number.isInteger(soft)).toBe(true);
      expect(soft).toBeGreaterThan(0);
      expect(soft).toBeLessThan(budget);
    }
  });
});

describe('softDeadlineExpired', () => {
  it('never fires when the deadline is 0 (off)', () => {
    // Mirrors how a maxIterations of 0 never fires in shouldWindDown.
    expect(softDeadlineExpired(0, 0, Number.MAX_SAFE_INTEGER)).toBe(false);
    expect(softDeadlineExpired(1_000, 0, 999_999_999)).toBe(false);
  });

  it('is false strictly before the deadline', () => {
    expect(softDeadlineExpired(1_000, 5_000, 5_999)).toBe(false);
  });

  it('fires exactly AT the deadline (boundary is >=)', () => {
    expect(softDeadlineExpired(1_000, 5_000, 6_000)).toBe(true);
  });

  it('is true after the deadline', () => {
    expect(softDeadlineExpired(1_000, 5_000, 6_001)).toBe(true);
    expect(softDeadlineExpired(0, 40 * 60_000, 41 * 60_000)).toBe(true);
  });

  it('honors an injected `now` rather than the real clock', () => {
    // A turn that started "in the future" relative to the injected now has not
    // expired — proof the predicate reads the argument, not Date.now().
    expect(softDeadlineExpired(Date.now() + 60_000, 1, 0)).toBe(false);
  });

  it('defaults `now` to the real clock', () => {
    // Started far enough in the past that any real clock value is past it.
    expect(softDeadlineExpired(Date.now() - 10_000, 1_000)).toBe(true);
    expect(softDeadlineExpired(Date.now(), 60_000)).toBe(false);
  });
});

describe('policy constants', () => {
  it('names the TIME trigger distinctly from the ROUND trigger', () => {
    // The stopReason must not collide with TOOL_USE_LOOP_CAPPED — the whole
    // point is that "ran out of clock" and "ran out of rounds" stay separable.
    expect(SOFT_DEADLINE_WIND_DOWN).toBe('soft_deadline_wind_down');
    expect(SOFT_DEADLINE_WIND_DOWN).not.toBe('tool_use_loop_capped');
  });

  it('words the note around time, not tools', () => {
    expect(SOFT_DEADLINE_NOTE).toContain('time budget');
    expect(SOFT_DEADLINE_NOTE).not.toContain('tool-use budget');
  });
});
