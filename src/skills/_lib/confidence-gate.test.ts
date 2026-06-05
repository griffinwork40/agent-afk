import { describe, it, expect } from 'vitest';
import { shouldAutoVerify } from './confidence-gate.js';

describe('shouldAutoVerify', () => {
  describe('confidence threshold', () => {
    it('verifies when confidence is below 0.5 (low)', () => {
      const result = shouldAutoVerify({ confidence: 0.3 });
      expect(result.verify).toBe(true);
      expect(result.reason).toContain('low confidence');
    });

    it('verifies at the low-confidence boundary (0.49)', () => {
      const result = shouldAutoVerify({ confidence: 0.49 });
      expect(result.verify).toBe(true);
    });

    it('skips when confidence is medium and no gaps or boundary flag', () => {
      const result = shouldAutoVerify({ confidence: 0.6 });
      expect(result.verify).toBe(false);
    });

    it('skips when confidence is high and no gaps or boundary flag', () => {
      const result = shouldAutoVerify({ confidence: 0.95 });
      expect(result.verify).toBe(false);
    });

    it('treats confidence exactly 0.5 as medium (skip by default)', () => {
      const result = shouldAutoVerify({ confidence: 0.5 });
      expect(result.verify).toBe(false);
    });
  });

  describe('coverage_gaps', () => {
    it('verifies when coverage_gaps is non-empty, regardless of confidence', () => {
      const result = shouldAutoVerify({
        confidence: 0.95,
        coverage_gaps: ['could not read src/foo.ts'],
      });
      expect(result.verify).toBe(true);
      expect(result.reason).toContain('coverage gap');
    });

    it('skips when coverage_gaps is empty array', () => {
      const result = shouldAutoVerify({ confidence: 0.8, coverage_gaps: [] });
      expect(result.verify).toBe(false);
    });

    it('skips when coverage_gaps is undefined', () => {
      const result = shouldAutoVerify({ confidence: 0.8 });
      expect(result.verify).toBe(false);
    });
  });

  describe('boundary_flag', () => {
    it('verifies when boundary_flag is set, regardless of confidence', () => {
      const result = shouldAutoVerify({
        confidence: 0.95,
        boundary_flag: 'hit read-only tool limit',
      });
      expect(result.verify).toBe(true);
      expect(result.reason).toContain('boundary');
    });

    it('skips when boundary_flag is undefined', () => {
      const result = shouldAutoVerify({ confidence: 0.8 });
      expect(result.verify).toBe(false);
    });

    it('skips when boundary_flag is empty string', () => {
      const result = shouldAutoVerify({ confidence: 0.8, boundary_flag: '' });
      expect(result.verify).toBe(false);
    });
  });

  describe('precedence', () => {
    it('reports low confidence when both low confidence and gaps present', () => {
      const result = shouldAutoVerify({
        confidence: 0.2,
        coverage_gaps: ['some gap'],
      });
      expect(result.verify).toBe(true);
      expect(result.reason).toContain('low confidence');
    });

    it('reports boundary when high confidence + boundary flag', () => {
      const result = shouldAutoVerify({
        confidence: 0.95,
        boundary_flag: 'search timed out',
      });
      expect(result.verify).toBe(true);
      expect(result.reason).toContain('boundary');
    });
  });

  describe('reason content', () => {
    it('provides a human-readable skip reason for high confidence', () => {
      const result = shouldAutoVerify({ confidence: 0.9 });
      expect(result.verify).toBe(false);
      expect(result.reason.length).toBeGreaterThan(0);
    });
  });
});
