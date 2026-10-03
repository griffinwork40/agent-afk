/**
 * Tests for the shared advance remaining-round warning policy.
 *
 * Covers:
 *  - provider parity: same thresholds, same idempotence contract
 *  - warning idempotence: each threshold fires at most once per turn
 *  - tiny/unlimited budget edge cases
 *  - cap vs. completion (wind-down territory)
 *
 * @module agent/providers/shared/tool-loop-cap-warnings.test
 */

import { describe, it, expect } from 'vitest';
import { pickRoundWarning, ROUND_WARNING_THRESHOLDS } from './tool-loop-cap.js';

describe('pickRoundWarning', () => {
  describe('unlimited budget (maxIterations <= 0)', () => {
    it('never warns when cap is 0 (unbounded)', () => {
      const [text] = pickRoundWarning(5, 0, undefined);
      expect(text).toBeNull();
    });

    it('never warns when cap is negative', () => {
      const [text] = pickRoundWarning(5, -1, undefined);
      expect(text).toBeNull();
    });
  });

  describe('threshold crossing', () => {
    it('emits a warning when remaining rounds cross ≤10', () => {
      // cap=50, completed=40 → remaining=10 → threshold 10 fires
      const [text, threshold] = pickRoundWarning(40, 50, undefined);
      expect(text).not.toBeNull();
      expect(text).toContain('10 tool-use rounds remaining');
      expect(threshold).toBe(10);
    });

    it('emits a warning when remaining rounds cross ≤5', () => {
      // cap=50, completed=45 → remaining=5 → threshold 5 fires
      const [text, threshold] = pickRoundWarning(45, 50, undefined);
      expect(text).not.toBeNull();
      expect(text).toContain('5 tool-use rounds remaining');
      expect(threshold).toBe(5);
    });

    it('emits a warning when remaining rounds cross ≤2', () => {
      // cap=50, completed=48 → remaining=2 → threshold 2 fires
      const [text, threshold] = pickRoundWarning(48, 50, undefined);
      expect(text).not.toBeNull();
      expect(text).toContain('2 tool-use rounds remaining');
      expect(threshold).toBe(2);
    });

    it('emits a singular "round" for remaining=1', () => {
      const [text] = pickRoundWarning(49, 50, undefined);
      expect(text).toContain('1 tool-use round remaining');
    });
  });

  describe('idempotence: each threshold fires at most once per turn', () => {
    it('does not re-fire the ≤10 threshold once warned', () => {
      // After warning at threshold 10, subsequent rounds with remaining still ≤10
      // should not produce another warning.
      const [, t1] = pickRoundWarning(40, 50, undefined);
      expect(t1).toBe(10);
      // Next round: completed=41, remaining=9 — still ≤10 but already warned
      const [text2] = pickRoundWarning(41, 50, t1);
      expect(text2).toBeNull();
    });

    it('escalates from ≤10 to ≤5 when threshold decreases', () => {
      const [, t1] = pickRoundWarning(40, 50, undefined); // remaining=10, warns 10
      const [text2, t2] = pickRoundWarning(45, 50, t1);   // remaining=5, warns 5
      expect(text2).not.toBeNull();
      expect(text2).toContain('5 tool-use rounds remaining');
      expect(t2).toBe(5);
    });

    it('escalates from ≤5 to ≤2 when threshold decreases further', () => {
      const [, t1] = pickRoundWarning(40, 50, undefined);
      const [, t2] = pickRoundWarning(45, 50, t1);
      const [text3, t3] = pickRoundWarning(48, 50, t2); // remaining=2, warns 2
      expect(text3).not.toBeNull();
      expect(t3).toBe(2);
    });

    it('stops warning once all thresholds are exhausted', () => {
      const [, t1] = pickRoundWarning(40, 50, undefined);
      const [, t2] = pickRoundWarning(45, 50, t1);
      const [, t3] = pickRoundWarning(48, 50, t2);
      // remaining=1 — still ≤2 but threshold 2 already warned
      const [text4] = pickRoundWarning(49, 50, t3);
      expect(text4).toBeNull();
    });
  });

  describe('tiny budgets', () => {
    it('warns a 3-round cap at ≤2 remaining (1 completed)', () => {
      const [text, threshold] = pickRoundWarning(1, 3, undefined);
      // remaining=2, fits ≤2 threshold
      expect(text).not.toBeNull();
      expect(threshold).toBe(2);
    });

    it('does not warn a 1-round cap (remaining=0 at completed=1 is wind-down territory)', () => {
      const [text] = pickRoundWarning(1, 1, undefined);
      expect(text).toBeNull();
    });

    it('does not warn at remaining=0 (cap boundary — wind-down fires instead)', () => {
      const [text] = pickRoundWarning(50, 50, undefined);
      expect(text).toBeNull();
    });
  });

  describe('includes cap and remaining in warning text', () => {
    it('includes both remaining count and total cap', () => {
      const [text] = pickRoundWarning(45, 50, undefined);
      expect(text).toContain('5');
      expect(text).toContain('50');
    });
  });

  describe('provider parity: thresholds are shared policy', () => {
    it('ROUND_WARNING_THRESHOLDS constant is exported and non-empty', () => {
      expect(ROUND_WARNING_THRESHOLDS.length).toBeGreaterThan(0);
      expect(ROUND_WARNING_THRESHOLDS).toContain(10);
      expect(ROUND_WARNING_THRESHOLDS).toContain(5);
      expect(ROUND_WARNING_THRESHOLDS).toContain(2);
    });
  });
});
