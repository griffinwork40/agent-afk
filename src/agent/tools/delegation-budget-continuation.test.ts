/**
 * Tests for ContinuationBudget — coordinator-controlled continuation chain limits.
 *
 * Covers:
 *  - chain round limits and continuation count limits
 *  - concurrent allocation (atomic reservation)
 *  - cancellation / release of unspent rounds
 *  - fail-closed on unsupported paths (exceeds remaining)
 *  - conservative documented defaults
 *  - refusal message generation
 *
 * @module agent/tools/delegation-budget-continuation.test
 */

import { describe, it, expect } from 'vitest';
import {
  ContinuationBudget,
  CONTINUATION_BUDGET_DEFAULTS,
  buildContinuationRefusalMessage,
} from './delegation-budget.js';

describe('ContinuationBudget', () => {
  describe('defaults', () => {
    it('uses documented conservative defaults', () => {
      expect(CONTINUATION_BUDGET_DEFAULTS.maxChainRounds).toBe(200);
      expect(CONTINUATION_BUDGET_DEFAULTS.maxContinuations).toBe(3);
    });

    it('initializes with defaults when no config provided', () => {
      const budget = new ContinuationBudget();
      expect(budget.remainingRounds).toBe(200);
      expect(budget.remainingContinuations).toBe(3);
    });
  });

  describe('canContinue', () => {
    it('allows a first continuation within budget', () => {
      const budget = new ContinuationBudget({ maxChainRounds: 100, maxContinuations: 2 });
      const result = budget.canContinue(50);
      expect(result.allowed).toBe(true);
    });

    it('refuses when requested rounds exceed remaining', () => {
      const budget = new ContinuationBudget({ maxChainRounds: 50, maxContinuations: 3 });
      const result = budget.canContinue(51);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('requested_rounds_exceed_remaining');
    });

    it('refuses when max continuations already reached', () => {
      const budget = new ContinuationBudget({ maxChainRounds: 300, maxContinuations: 1 });
      budget.allocate(50); // use the 1 allowed continuation
      const result = budget.canContinue(50);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('max_continuations_reached');
    });

    it('refuses when chain rounds fully exhausted', () => {
      const budget = new ContinuationBudget({ maxChainRounds: 50, maxContinuations: 10 });
      budget.allocate(50); // exhaust all rounds
      const result = budget.canContinue(1);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('max_chain_rounds_exhausted');
    });
  });

  describe('allocate', () => {
    it('grants rounds atomically', () => {
      const budget = new ContinuationBudget({ maxChainRounds: 100, maxContinuations: 3 });
      const alloc = budget.allocate(50);
      expect(alloc).not.toBeNull();
      expect(alloc!.grantedRounds).toBe(50);
      expect(budget.remainingRounds).toBe(50);
      expect(budget.remainingContinuations).toBe(2);
    });

    it('returns null (fail-closed) when rounds exceed remaining', () => {
      const budget = new ContinuationBudget({ maxChainRounds: 30, maxContinuations: 3 });
      const alloc = budget.allocate(31);
      expect(alloc).toBeNull();
      // Budget is not mutated on failure
      expect(budget.remainingRounds).toBe(30);
      expect(budget.remainingContinuations).toBe(3);
    });

    it('returns null when max continuations reached', () => {
      const budget = new ContinuationBudget({ maxChainRounds: 300, maxContinuations: 1 });
      budget.allocate(50);
      const alloc = budget.allocate(50);
      expect(alloc).toBeNull();
    });

    it('supports concurrent allocations (two forks)', () => {
      const budget = new ContinuationBudget({ maxChainRounds: 100, maxContinuations: 3 });
      const a1 = budget.allocate(40);
      const a2 = budget.allocate(40);
      expect(a1).not.toBeNull();
      expect(a2).not.toBeNull();
      expect(budget.remainingRounds).toBe(20);
      // A third allocation for 21 rounds must fail (only 20 remain)
      const a3 = budget.allocate(21);
      expect(a3).toBeNull();
    });
  });

  describe('release (unspent rounds returned)', () => {
    it('returns unspent rounds to the pool', () => {
      const budget = new ContinuationBudget({ maxChainRounds: 100, maxContinuations: 3 });
      const alloc = budget.allocate(50)!;
      // Child only used 30 of the 50 granted
      const released = alloc.release(30);
      expect(released).toBe(20); // 50 - 30 = 20 returned
      expect(budget.remainingRounds).toBe(70); // 100 - 50 + 20 = 70
    });

    it('idempotent: double release is a no-op', () => {
      const budget = new ContinuationBudget({ maxChainRounds: 100, maxContinuations: 3 });
      const alloc = budget.allocate(50)!;
      alloc.release(40);
      const secondRelease = alloc.release(40); // duplicate call
      expect(secondRelease).toBe(0); // no-op
      expect(budget.remainingRounds).toBe(60); // only released once
    });

    it('release(0) on fork failure returns full grant', () => {
      const budget = new ContinuationBudget({ maxChainRounds: 100, maxContinuations: 3 });
      const alloc = budget.allocate(50)!;
      // Fork failed before child ran — return all 50
      const released = alloc.release(0);
      expect(released).toBe(50);
      expect(budget.remainingRounds).toBe(100);
    });

    it('clamped: actual rounds capped to granted (no negative release)', () => {
      const budget = new ContinuationBudget({ maxChainRounds: 100, maxContinuations: 3 });
      const alloc = budget.allocate(50)!;
      // Child claims to have used MORE than granted (shouldn't happen but safe)
      const released = alloc.release(60); // 50 - 60 = -10 → clamped to 0
      expect(released).toBe(0);
    });
  });

  describe('chain limits / cancellation', () => {
    it('exhausts chain rounds across multiple continuations', () => {
      const budget = new ContinuationBudget({ maxChainRounds: 100, maxContinuations: 5 });
      const a1 = budget.allocate(40);
      const a2 = budget.allocate(40);
      expect(a1).not.toBeNull();
      expect(a2).not.toBeNull();
      // 80 granted, 20 remain
      const a3 = budget.allocate(21); // exceeds remaining
      expect(a3).toBeNull();
      // But 20 rounds is fine
      const a4 = budget.allocate(20);
      expect(a4).not.toBeNull();
      expect(budget.remainingRounds).toBe(0);
    });

    it('continuation count and round limits are independent', () => {
      const budget = new ContinuationBudget({ maxChainRounds: 300, maxContinuations: 2 });
      budget.allocate(50);
      budget.allocate(50);
      // Rounds still available but continuation count reached
      const result = budget.canContinue(50);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('max_continuations_reached');
    });
  });

  describe('snapshot', () => {
    it('returns read-only telemetry snapshot', () => {
      const budget = new ContinuationBudget({ maxChainRounds: 100, maxContinuations: 3 });
      budget.allocate(30);
      const snap = budget.snapshot();
      expect(snap.roundsGranted).toBe(30);
      expect(snap.continuationsDispatched).toBe(1);
      expect(snap.config.maxChainRounds).toBe(100);
      expect(snap.config.maxContinuations).toBe(3);
    });
  });
});

describe('buildContinuationRefusalMessage', () => {
  it('returns empty string for allowed', () => {
    expect(buildContinuationRefusalMessage({ allowed: true })).toBe('');
  });

  it('returns a message for max_chain_rounds_exhausted', () => {
    const msg = buildContinuationRefusalMessage({
      allowed: false,
      reason: 'max_chain_rounds_exhausted',
      detail: 'All 100 chain rounds have been allocated.',
    });
    expect(msg).toContain('exhausted');
    expect(msg).toContain('100 chain rounds');
  });

  it('returns a message for max_continuations_reached', () => {
    const msg = buildContinuationRefusalMessage({
      allowed: false,
      reason: 'max_continuations_reached',
      detail: '3 continuations already dispatched (max 3).',
    });
    expect(msg).toContain('3 continuations');
  });

  it('returns a message for requested_rounds_exceed_remaining', () => {
    const msg = buildContinuationRefusalMessage({
      allowed: false,
      reason: 'requested_rounds_exceed_remaining',
      detail: 'Requested 60 rounds but only 20 remain.',
    });
    expect(msg).toContain('60 rounds');
    expect(msg).toContain('20 remain');
  });
});
