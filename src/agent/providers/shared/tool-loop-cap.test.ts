import { describe, it, expect } from 'vitest';
import {
  TOOL_USE_LOOP_CAPPED,
  DEFAULT_MAX_TOOL_USE_ITERATIONS,
  WIND_DOWN_NOTE,
  formatRoundLabel,
  resolveMaxToolIterations,
  shouldWindDown,
  roundDeliveryNotice,
} from './tool-loop-cap.js';

describe('shared/tool-loop-cap', () => {
  it('exposes the shared terminal stop reason + unlimited default', () => {
    // These strings/values are contract-coupled to session/closure-reason.ts
    // (maps `tool_use_loop_capped` → `iteration_cap`) and to both provider loops.
    expect(TOOL_USE_LOOP_CAPPED).toBe('tool_use_loop_capped');
    expect(DEFAULT_MAX_TOOL_USE_ITERATIONS).toBe(0);
    expect(WIND_DOWN_NOTE.length).toBeGreaterThan(0);
    expect(WIND_DOWN_NOTE).toContain('tool-use budget');
  });

  describe('resolveMaxToolIterations', () => {
    it('treats undefined / 0 / negatives as unlimited (0)', () => {
      expect(resolveMaxToolIterations(undefined)).toBe(0);
      expect(resolveMaxToolIterations(0)).toBe(0);
      expect(resolveMaxToolIterations(-5)).toBe(0);
    });

    it('passes a positive value through with no upper ceiling, floored to an int', () => {
      expect(resolveMaxToolIterations(3)).toBe(3);
      expect(resolveMaxToolIterations(200)).toBe(200);
      expect(resolveMaxToolIterations(4.9)).toBe(4);
    });
  });

  describe('shouldWindDown', () => {
    it('never fires when the cap is unlimited (0)', () => {
      expect(shouldWindDown(0, 0)).toBe(false);
      expect(shouldWindDown(999, 0)).toBe(false);
    });

    it('fires once completed rounds reach a positive cap', () => {
      expect(shouldWindDown(2, 3)).toBe(false);
      expect(shouldWindDown(3, 3)).toBe(true);
      expect(shouldWindDown(4, 3)).toBe(true);
    });
  });

  describe('formatRoundLabel', () => {
    // Issue #857: the progress banner named the round but never its cap, so
    // "round 7" said nothing about how close the child was to winding down.
    it('renders the bare round number when the cap is unlimited (0)', () => {
      expect(formatRoundLabel(7, 0)).toBe('round 7');
    });

    it('treats a negative resolved cap the same as unlimited', () => {
      // resolveMaxToolIterations never actually returns a negative value, but
      // formatRoundLabel guards independently rather than trusting the caller.
      expect(formatRoundLabel(7, -5)).toBe('round 7');
    });

    it('renders round/cap when a real cap is in effect', () => {
      expect(formatRoundLabel(7, 50)).toBe('round 7/50');
    });

    it('renders round/cap even once the round number reaches the cap', () => {
      expect(formatRoundLabel(50, 50)).toBe('round 50/50');
    });
  });

  describe('roundDeliveryNotice', () => {
    it('returns null when budget is 0 (unlimited)', () => {
      expect(roundDeliveryNotice(0, 0)).toBeNull();
      expect(roundDeliveryNotice(5, 0)).toBeNull();
      expect(roundDeliveryNotice(47, 0)).toBeNull();
    });

    it('returns null when budget is 1', () => {
      // budget=1 means wind-down fires after the very first round — no room
      // for a "N rounds remain" warning that is still actionable.
      expect(roundDeliveryNotice(0, 1)).toBeNull();
      expect(roundDeliveryNotice(1, 1)).toBeNull();
    });

    it('fires exactly once at max(1, budget-3) for budget=2', () => {
      // budget=2: threshold = max(1, 2-3) = max(1,-1) = 1
      expect(roundDeliveryNotice(0, 2)).toBeNull();
      expect(roundDeliveryNotice(1, 2)).not.toBeNull();
      expect(roundDeliveryNotice(2, 2)).toBeNull();
    });

    it('fires exactly once at max(1, budget-3) for budget=3', () => {
      // budget=3: threshold = max(1, 0) = 1
      expect(roundDeliveryNotice(0, 3)).toBeNull();
      expect(roundDeliveryNotice(1, 3)).not.toBeNull();
      expect(roundDeliveryNotice(2, 3)).toBeNull();
      expect(roundDeliveryNotice(3, 3)).toBeNull();
    });

    it('fires exactly once at max(1, budget-3) for budget=4', () => {
      // budget=4: threshold = max(1, 1) = 1
      expect(roundDeliveryNotice(0, 4)).toBeNull();
      expect(roundDeliveryNotice(1, 4)).not.toBeNull();
      expect(roundDeliveryNotice(2, 4)).toBeNull();
      expect(roundDeliveryNotice(3, 4)).toBeNull();
      expect(roundDeliveryNotice(4, 4)).toBeNull();
    });

    it('fires exactly once at max(1, budget-3) for budget=5', () => {
      // budget=5: threshold = max(1, 2) = 2
      expect(roundDeliveryNotice(0, 5)).toBeNull();
      expect(roundDeliveryNotice(1, 5)).toBeNull();
      expect(roundDeliveryNotice(2, 5)).not.toBeNull();
      expect(roundDeliveryNotice(3, 5)).toBeNull();
      expect(roundDeliveryNotice(4, 5)).toBeNull();
      expect(roundDeliveryNotice(5, 5)).toBeNull();
    });

    it('fires exactly once at max(1, budget-3) for budget=50', () => {
      // budget=50: threshold = max(1, 47) = 47
      expect(roundDeliveryNotice(46, 50)).toBeNull();
      expect(roundDeliveryNotice(47, 50)).not.toBeNull();
      expect(roundDeliveryNotice(48, 50)).toBeNull();
      expect(roundDeliveryNotice(49, 50)).toBeNull();
      expect(roundDeliveryNotice(50, 50)).toBeNull();
    });

    it('uses singular "round remains" when exactly 1 round left', () => {
      // budget=4, threshold=1, remaining=4-1=3 ... let's pick budget=2: remaining=1
      const notice = roundDeliveryNotice(1, 2);
      expect(notice).not.toBeNull();
      expect(notice).toContain('1 tool-use round remains');
      expect(notice).not.toContain('rounds remain');
    });

    it('uses plural "rounds remain" when more than 1 round left', () => {
      // budget=50, threshold=47, remaining=50-47=3
      const notice = roundDeliveryNotice(47, 50);
      expect(notice).not.toBeNull();
      expect(notice).toContain('3 tool-use rounds remain');
      expect(notice).not.toContain('1 tool-use round remains');
    });

    it('notice contains the budget total', () => {
      const notice = roundDeliveryNotice(47, 50);
      expect(notice).toContain('of 50');
    });

    it('notice contains the Budget notice prefix', () => {
      const notice = roundDeliveryNotice(47, 50);
      expect(notice).toMatch(/^\[Budget notice:/);
    });

    it('returns null on rounds before and after the single fire round', () => {
      for (let r = 0; r < 46; r++) {
        expect(roundDeliveryNotice(r, 50)).toBeNull();
      }
      for (let r = 48; r <= 55; r++) {
        expect(roundDeliveryNotice(r, 50)).toBeNull();
      }
    });
  });
});
