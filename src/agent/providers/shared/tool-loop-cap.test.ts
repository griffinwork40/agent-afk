import { describe, it, expect } from 'vitest';
import {
  TOOL_USE_LOOP_CAPPED,
  DEFAULT_MAX_TOOL_USE_ITERATIONS,
  WIND_DOWN_NOTE,
  formatRoundLabel,
  resolveMaxToolIterations,
  shouldWindDown,
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
});
