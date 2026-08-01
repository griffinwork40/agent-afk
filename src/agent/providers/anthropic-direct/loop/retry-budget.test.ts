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
} from './retry-budget.js';

describe('RoundRetryBudget', () => {
  it('starts with every budget unspent', () => {
    const b = new RoundRetryBudget();
    expect(b.overloadRetries).toBe(0);
    expect(b.streamIncompleteRetries).toBe(0);
    expect(b.ttfbRetried).toBe(false);
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

  it('permits the TTFB re-drive exactly once per round', () => {
    const b = new RoundRetryBudget();
    expect(b.canRetryTtfb()).toBe(true);
    b.ttfbRetried = true;
    expect(b.canRetryTtfb()).toBe(false);
  });

  it('reset() releases all three budgets together — the per-round scope invariant', () => {
    const b = new RoundRetryBudget();
    b.overloadRetries = OVERLOAD_MAX_RETRIES;
    b.streamIncompleteRetries = STREAM_INCOMPLETE_MAX_RETRIES;
    b.ttfbRetried = true;
    expect(b.canRetryOverload()).toBe(false);
    expect(b.canRetryStreamIncomplete()).toBe(false);
    expect(b.canRetryTtfb()).toBe(false);

    b.reset();

    expect(b.overloadRetries).toBe(0);
    expect(b.streamIncompleteRetries).toBe(0);
    expect(b.ttfbRetried).toBe(false);
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

  it('keeps the clean-close budget strictly below the overload budget', () => {
    // Invariant documented on STREAM_INCOMPLETE_MAX_RETRIES: a re-drive here
    // burns a partial generation, so it must stay cheaper than an overload
    // retry. A future tuning change that inverts this should fail loudly.
    expect(STREAM_INCOMPLETE_MAX_RETRIES).toBeLessThan(OVERLOAD_MAX_RETRIES);
  });
});
