/**
 * Tests for `src/whatif/mde.ts`.
 *
 * Validates the MDE formula (worst-case p=0.5, two-sided 95% CI) and the
 * inverse nForMde helper.
 */

import { describe, expect, it } from 'vitest';
import { mde, nForMde, formatMde } from './mde.js';

// ---------------------------------------------------------------------------
// mde(n)
// ---------------------------------------------------------------------------

describe('mde', () => {
  it('n=20 → ~31pp (matches 1.96*sqrt(0.5/20))', () => {
    const result = mde(20);
    // 1.96 * sqrt(0.5/20) = 1.96 * sqrt(0.025) ≈ 1.96 * 0.1581 ≈ 0.3099
    expect(result).toBeCloseTo(0.3099, 3);
  });

  it('n=200 → ~9.8pp (matches 1.96*sqrt(0.5/200))', () => {
    const result = mde(200);
    // 1.96 * sqrt(0.5/200) = 1.96 * sqrt(0.0025) = 1.96 * 0.05 = 0.098
    expect(result).toBeCloseTo(0.098, 3);
  });

  it('larger n → smaller MDE (more power)', () => {
    expect(mde(200)).toBeLessThan(mde(20));
    expect(mde(1000)).toBeLessThan(mde(200));
  });

  it('n=1 → MDE close to 1.96*sqrt(0.5) ≈ 1.386 (clamped logically, >1 fine)', () => {
    const result = mde(1);
    expect(result).toBeCloseTo(1.96 * Math.sqrt(0.5), 4);
  });

  it('n=0 → returns 1 (sentinel: undetectable)', () => {
    expect(mde(0)).toBe(1);
  });

  it('negative n → returns 1 (sentinel: undetectable)', () => {
    expect(mde(-5)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// nForMde(target)
// ---------------------------------------------------------------------------

describe('nForMde', () => {
  it('10pp target → needs ~193 episodes (ceil(0.5*(1.96/0.10)^2))', () => {
    // 0.5 * (1.96 / 0.10)^2 = 0.5 * (19.6)^2 = 0.5 * 384.16 = 192.08 → ceil = 193
    expect(nForMde(0.10)).toBe(193);
  });

  it('25pp target (≈ 20 episodes per arm achievable)', () => {
    // result should be ≤ 20 since mde(20) ≈ 0.31 > 0.25
    // 0.5*(1.96/0.25)^2 = 0.5*(7.84)^2 = 0.5*61.47 = 30.74 → ceil = 31
    expect(nForMde(0.25)).toBe(31);
  });

  it('nForMde is inverse of mde: mde(nForMde(target)) ≤ target', () => {
    for (const target of [0.05, 0.10, 0.15, 0.20, 0.25, 0.30]) {
      const n = nForMde(target);
      const achieved = mde(n);
      // After ceiling, achieved MDE should be ≤ target (by construction).
      expect(achieved).toBeLessThanOrEqual(target + 1e-9);
    }
  });

  it('target=0 → Infinity', () => {
    expect(nForMde(0)).toBe(Infinity);
  });

  it('negative target → Infinity', () => {
    expect(nForMde(-0.1)).toBe(Infinity);
  });

  it('returns a positive integer for valid targets', () => {
    const n = nForMde(0.10);
    expect(Number.isInteger(n)).toBe(true);
    expect(n).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// formatMde
// ---------------------------------------------------------------------------

describe('formatMde', () => {
  it('0.31 → "31pp"', () => {
    expect(formatMde(0.31)).toBe('31pp');
  });

  it('0.098 → "10pp" (rounds to nearest integer)', () => {
    expect(formatMde(0.098)).toBe('10pp');
  });

  it('0.25 → "25pp"', () => {
    expect(formatMde(0.25)).toBe('25pp');
  });
});
