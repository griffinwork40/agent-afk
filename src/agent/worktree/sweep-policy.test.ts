/**
 * Unit tests for `resolveSweepPolicy`.
 *
 * Verifies the precedence: flag > config > env > default.
 */

import { describe, it, expect } from 'vitest';
import {
  resolveSweepPolicy,
  SWEEP_POLICY_DEFAULTS,
} from './sweep-policy.js';

describe('resolveSweepPolicy', () => {
  describe('defaults', () => {
    it('returns engine defaults when no inputs are supplied', () => {
      const result = resolveSweepPolicy({});
      expect(result.maxAgeDaysClean).toBe(SWEEP_POLICY_DEFAULTS.maxAgeDaysClean);
      expect(result.maxAgeDaysDirty).toBe(SWEEP_POLICY_DEFAULTS.maxAgeDaysDirty);
    });

    it('returns engine defaults when env strings are empty', () => {
      const result = resolveSweepPolicy({
        env: { maxAgeDaysClean: '', maxAgeDaysDirty: '' },
      });
      expect(result.maxAgeDaysClean).toBe(SWEEP_POLICY_DEFAULTS.maxAgeDaysClean);
      expect(result.maxAgeDaysDirty).toBe(SWEEP_POLICY_DEFAULTS.maxAgeDaysDirty);
    });

    it('returns engine defaults when env strings are undefined', () => {
      const result = resolveSweepPolicy({
        env: { maxAgeDaysClean: undefined, maxAgeDaysDirty: undefined },
      });
      expect(result.maxAgeDaysClean).toBe(SWEEP_POLICY_DEFAULTS.maxAgeDaysClean);
      expect(result.maxAgeDaysDirty).toBe(SWEEP_POLICY_DEFAULTS.maxAgeDaysDirty);
    });
  });

  describe('env layer', () => {
    it('uses env values when no flag or config is present', () => {
      const result = resolveSweepPolicy({
        env: { maxAgeDaysClean: '7', maxAgeDaysDirty: '21' },
      });
      expect(result.maxAgeDaysClean).toBe(7);
      expect(result.maxAgeDaysDirty).toBe(21);
    });

    it('ignores non-numeric env strings and falls back to default', () => {
      const result = resolveSweepPolicy({
        env: { maxAgeDaysClean: 'abc', maxAgeDaysDirty: 'xyz' },
      });
      expect(result.maxAgeDaysClean).toBe(SWEEP_POLICY_DEFAULTS.maxAgeDaysClean);
      expect(result.maxAgeDaysDirty).toBe(SWEEP_POLICY_DEFAULTS.maxAgeDaysDirty);
    });

    it('can resolve clean from env while dirty falls back to default', () => {
      const result = resolveSweepPolicy({
        env: { maxAgeDaysClean: '5' },
      });
      expect(result.maxAgeDaysClean).toBe(5);
      expect(result.maxAgeDaysDirty).toBe(SWEEP_POLICY_DEFAULTS.maxAgeDaysDirty);
    });
  });

  describe('config layer', () => {
    it('config overrides env', () => {
      const result = resolveSweepPolicy({
        config: { maxAgeDaysClean: 10, maxAgeDaysDirty: 20 },
        env: { maxAgeDaysClean: '5', maxAgeDaysDirty: '8' },
      });
      expect(result.maxAgeDaysClean).toBe(10);
      expect(result.maxAgeDaysDirty).toBe(20);
    });

    it('config overrides default when env is absent', () => {
      const result = resolveSweepPolicy({
        config: { maxAgeDaysClean: 3, maxAgeDaysDirty: 6 },
      });
      expect(result.maxAgeDaysClean).toBe(3);
      expect(result.maxAgeDaysDirty).toBe(6);
    });

    it('partial config: only clean set, dirty falls through to env', () => {
      const result = resolveSweepPolicy({
        config: { maxAgeDaysClean: 3 },
        env: { maxAgeDaysDirty: '25' },
      });
      expect(result.maxAgeDaysClean).toBe(3);
      expect(result.maxAgeDaysDirty).toBe(25);
    });
  });

  describe('flag (override) layer', () => {
    it('flag overrides config', () => {
      const result = resolveSweepPolicy({
        overrides: { maxAgeDaysClean: 1, maxAgeDaysDirty: 2 },
        config: { maxAgeDaysClean: 10, maxAgeDaysDirty: 20 },
      });
      expect(result.maxAgeDaysClean).toBe(1);
      expect(result.maxAgeDaysDirty).toBe(2);
    });

    it('flag overrides env', () => {
      const result = resolveSweepPolicy({
        overrides: { maxAgeDaysClean: 1, maxAgeDaysDirty: 2 },
        env: { maxAgeDaysClean: '7', maxAgeDaysDirty: '14' },
      });
      expect(result.maxAgeDaysClean).toBe(1);
      expect(result.maxAgeDaysDirty).toBe(2);
    });

    it('flag overrides default when nothing else is set', () => {
      const result = resolveSweepPolicy({
        overrides: { maxAgeDaysClean: 99, maxAgeDaysDirty: 100 },
      });
      expect(result.maxAgeDaysClean).toBe(99);
      expect(result.maxAgeDaysDirty).toBe(100);
    });

    it('partial override: only clean flag, dirty falls through to config', () => {
      const result = resolveSweepPolicy({
        overrides: { maxAgeDaysClean: 1 },
        config: { maxAgeDaysClean: 10, maxAgeDaysDirty: 20 },
      });
      expect(result.maxAgeDaysClean).toBe(1);
      expect(result.maxAgeDaysDirty).toBe(20);
    });
  });

  describe('full precedence chain', () => {
    it('flag wins over all other layers', () => {
      const result = resolveSweepPolicy({
        overrides: { maxAgeDaysClean: 1, maxAgeDaysDirty: 2 },
        config: { maxAgeDaysClean: 10, maxAgeDaysDirty: 20 },
        env: { maxAgeDaysClean: '5', maxAgeDaysDirty: '8' },
      });
      expect(result.maxAgeDaysClean).toBe(1);
      expect(result.maxAgeDaysDirty).toBe(2);
    });

    it('config wins over env and default', () => {
      const result = resolveSweepPolicy({
        config: { maxAgeDaysClean: 10, maxAgeDaysDirty: 20 },
        env: { maxAgeDaysClean: '5', maxAgeDaysDirty: '8' },
      });
      expect(result.maxAgeDaysClean).toBe(10);
      expect(result.maxAgeDaysDirty).toBe(20);
    });

    it('env wins over default only', () => {
      const result = resolveSweepPolicy({
        env: { maxAgeDaysClean: '5', maxAgeDaysDirty: '8' },
      });
      expect(result.maxAgeDaysClean).toBe(5);
      expect(result.maxAgeDaysDirty).toBe(8);
    });
  });
});
