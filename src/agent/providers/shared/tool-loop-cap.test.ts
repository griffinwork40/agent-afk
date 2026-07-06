import { describe, it, expect } from 'vitest';
import {
  TOOL_USE_LOOP_CAPPED,
  DEFAULT_MAX_TOOL_USE_ITERATIONS,
  WIND_DOWN_NOTE,
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
});
