// Unit coverage for the per-round retry budget.
//
// The predicates (isTransientServerError / isOverloadedErrorEvent) are pinned
// end-to-end by ../loop.retry.test.ts. What is tested HERE is the budget object
// itself — the contract that was previously three loose `let`s in runTurn reset
// by an unnamed side effect. Once the stream consumer (which spends the budget)
// and the retry handler (which reads it) live in separate modules, this reset
// discipline is the seam that keeps "each round gets a fresh allowance" true.

import { describe, it, expect } from 'vitest';
import {
  OVERLOAD_MAX_RETRIES,
  RoundRetryBudget,
  STREAM_INCOMPLETE_MAX_RETRIES,
  TTFB_LEGACY_ATTEMPTS,
  TTFB_MAX_ATTEMPTS,
  TTFB_MAX_RETRIES,
  ttfbAttemptTimeoutMs,
} from './retry-budget.js';

describe('RoundRetryBudget', () => {
  it('starts with every budget unspent', () => {
    const b = new RoundRetryBudget();
    expect(b.overloadRetries).toBe(0);
    expect(b.streamIncompleteRetries).toBe(0);
    expect(b.ttfbRetries).toBe(0);
    expect(b.canRetryOverload()).toBe(true);
    expect(b.canRetryStreamIncomplete()).toBe(true);
    expect(b.canRetryTtfb()).toBe(true);
  });

  it('permits exactly OVERLOAD_MAX_RETRIES overload retries, then refuses', () => {
    const b = new RoundRetryBudget();
    for (let i = 0; i < OVERLOAD_MAX_RETRIES; i++) {
      expect(b.canRetryOverload()).toBe(true);
      b.overloadRetries += 1;
    }
    expect(b.canRetryOverload()).toBe(false);
  });

  it('permits exactly STREAM_INCOMPLETE_MAX_RETRIES clean-close re-drives, then refuses', () => {
    const b = new RoundRetryBudget();
    for (let i = 0; i < STREAM_INCOMPLETE_MAX_RETRIES; i++) {
      expect(b.canRetryStreamIncomplete()).toBe(true);
      b.streamIncompleteRetries += 1;
    }
    expect(b.canRetryStreamIncomplete()).toBe(false);
  });

  it('permits exactly TTFB_MAX_RETRIES first-byte re-drives, then refuses', () => {
    const b = new RoundRetryBudget();
    for (let i = 0; i < TTFB_MAX_RETRIES; i++) {
      expect(b.canRetryTtfb()).toBe(true);
      b.ttfbRetries += 1;
    }
    expect(b.canRetryTtfb()).toBe(false);
  });

  it('reset() releases all three budgets together — the per-round scope invariant', () => {
    const b = new RoundRetryBudget();
    b.overloadRetries = OVERLOAD_MAX_RETRIES;
    b.streamIncompleteRetries = STREAM_INCOMPLETE_MAX_RETRIES;
    b.ttfbRetries = TTFB_MAX_RETRIES;
    expect(b.canRetryOverload()).toBe(false);
    expect(b.canRetryStreamIncomplete()).toBe(false);
    expect(b.canRetryTtfb()).toBe(false);

    b.reset();

    expect(b.overloadRetries).toBe(0);
    expect(b.streamIncompleteRetries).toBe(0);
    expect(b.ttfbRetries).toBe(0);
    expect(b.canRetryOverload()).toBe(true);
    expect(b.canRetryStreamIncomplete()).toBe(true);
    expect(b.canRetryTtfb()).toBe(true);
  });

  it('keeps the three budgets independent — spending one does not touch the others', () => {
    const b = new RoundRetryBudget();
    b.overloadRetries = OVERLOAD_MAX_RETRIES;
    expect(b.canRetryOverload()).toBe(false);
    expect(b.canRetryStreamIncomplete()).toBe(true);
    expect(b.canRetryTtfb()).toBe(true);
  });

  // Invariant guard: the counted TTFB budget is admissible ONLY because the
  // per-attempt bound shrinks by the factor the attempt count grows. These
  // re-derive the product rather than trusting the comment in retry-budget.ts,
  // so raising TTFB_MAX_RETRIES (or loosening ttfbAttemptTimeoutMs) without
  // re-deriving the division fails loudly instead of silently tripling the
  // worst case — the exact regression this fix exists to avoid.
  describe('TTFB worst-case wall-time bound', () => {
    // The configured per-round budgets that matter: the code default, this
    // operator's override, and awkward values that stress the flooring.
    const CONFIGURED = [180_000, 300_000, 120_000, 1, 2, 3, 7, 45_000, 999_999];

    it('never exceeds the pre-count worst case for any realistic budget', () => {
      for (const configured of CONFIGURED.filter((b) => b >= TTFB_MAX_ATTEMPTS)) {
        const before = TTFB_LEGACY_ATTEMPTS * configured;
        const after = TTFB_MAX_ATTEMPTS * ttfbAttemptTimeoutMs(configured);
        expect(after).toBeLessThanOrEqual(before);
      }
    });

    it('overshoots by at most the 1ms timer floor on a sub-3ms budget', () => {
      // The documented carve-out: below TTFB_MAX_ATTEMPTS ms there is not 1ms
      // per attempt to divide, so the floor wins and the product may exceed the
      // legacy figure — by at most TTFB_MAX_ATTEMPTS ms. Asserted rather than
      // excluded so the boundary stays honest and visible.
      for (const configured of [1, 2]) {
        const before = TTFB_LEGACY_ATTEMPTS * configured;
        const after = TTFB_MAX_ATTEMPTS * ttfbAttemptTimeoutMs(configured);
        expect(after).toBeLessThanOrEqual(before + TTFB_MAX_ATTEMPTS);
      }
      // Exactly at the threshold the strict bound already holds.
      expect(TTFB_MAX_ATTEMPTS * ttfbAttemptTimeoutMs(TTFB_MAX_ATTEMPTS)).toBeLessThanOrEqual(
        TTFB_LEGACY_ATTEMPTS * TTFB_MAX_ATTEMPTS,
      );
    });

    it('buys MORE attempts than the pre-count regime', () => {
      expect(TTFB_MAX_ATTEMPTS).toBeGreaterThan(TTFB_LEGACY_ATTEMPTS);
    });

    it('pins the arithmetic at the code default and the operator override', () => {
      // 180s default: 3 × 120s = 360s, exactly the old 2 × 180s.
      expect(ttfbAttemptTimeoutMs(180_000)).toBe(120_000);
      expect(TTFB_MAX_ATTEMPTS * 120_000).toBe(TTFB_LEGACY_ATTEMPTS * 180_000);
      // 300s operator override: 3 × 200s = 600s, exactly the old 2 × 300s.
      expect(ttfbAttemptTimeoutMs(300_000)).toBe(200_000);
      expect(TTFB_MAX_ATTEMPTS * 200_000).toBe(TTFB_LEGACY_ATTEMPTS * 300_000);
    });

    it('shrinks the per-attempt bound below the configured per-round budget', () => {
      // The point of the trade: a long bound is only justified when you get one
      // shot. With a budget, each attempt must be strictly cheaper.
      expect(ttfbAttemptTimeoutMs(180_000)).toBeLessThan(180_000);
      expect(ttfbAttemptTimeoutMs(300_000)).toBeLessThan(300_000);
    });

    it('preserves the =0 disable escape hatch through the derivation', () => {
      // armFirstByteTimeout treats <= 0 as "disabled"; the division must not
      // manufacture a live timer from an explicit opt-out.
      expect(ttfbAttemptTimeoutMs(0)).toBe(0);
      expect(ttfbAttemptTimeoutMs(-1)).toBe(0);
      expect(ttfbAttemptTimeoutMs(Number.NaN)).toBe(0);
    });

    it('never floors a positive budget to a watchdog-disabling 0', () => {
      // A tiny budget must TIGHTEN the bound, never silently disable it — the
      // failure mode where `Math.floor` turns 2ms into 0 and unbounds the call.
      for (const configured of [1, 2, 3, 4]) {
        expect(ttfbAttemptTimeoutMs(configured)).toBeGreaterThan(0);
      }
    });
  });

  it('keeps the clean-close budget strictly below the overload budget', () => {
    // Invariant documented on STREAM_INCOMPLETE_MAX_RETRIES: a re-drive here
    // burns a partial generation, so it must stay cheaper than an overload
    // retry. A future tuning change that inverts this should fail loudly.
    expect(STREAM_INCOMPLETE_MAX_RETRIES).toBeLessThan(OVERLOAD_MAX_RETRIES);
  });
});
