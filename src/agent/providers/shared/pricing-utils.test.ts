/**
 * Unit tests for shared pricing utilities.
 *
 * These tests exercise {@link lookupPricing} and {@link clampPositive}
 * directly, independently of any provider's pricing table or token maths.
 * They are the load-bearing regression surface for the shared module — the
 * provider-level pricing tests cover the integration path.
 *
 * @module agent/providers/shared/pricing-utils.test
 */

import { describe, it, expect } from 'vitest';
import { clampPositive, lookupPricing } from './pricing-utils.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

interface FakePricing {
  rate: number;
}

const DATE_SUFFIX = /-\d{4}-\d{2}-\d{2}$/;

const FAKE_MAP: ReadonlyMap<string, FakePricing> = new Map([
  ['model-a', { rate: 1.0 }],
  ['model-b', { rate: 2.0 }],
]);

// ---------------------------------------------------------------------------
// lookupPricing
// ---------------------------------------------------------------------------

describe('lookupPricing — exact hit', () => {
  it('returns the row when the id is in the map verbatim', () => {
    expect(lookupPricing('model-a', FAKE_MAP, DATE_SUFFIX)).toEqual({ rate: 1.0 });
  });

  it('returns the correct row for every key in the map', () => {
    for (const [model, expected] of FAKE_MAP.entries()) {
      expect(lookupPricing(model, FAKE_MAP, DATE_SUFFIX)).toEqual(expected);
    }
  });
});

describe('lookupPricing — suffix-stripped hit', () => {
  it('strips a dashed YYYY-MM-DD suffix and retries', () => {
    // 'model-a-2024-08-06' is not in the map, but 'model-a' is.
    expect(lookupPricing('model-a-2024-08-06', FAKE_MAP, DATE_SUFFIX)).toEqual({ rate: 1.0 });
  });

  it('handles the strip-and-retry for a different table entry', () => {
    expect(lookupPricing('model-b-2026-01-15', FAKE_MAP, DATE_SUFFIX)).toEqual({ rate: 2.0 });
  });
});

describe('lookupPricing — miss', () => {
  it('returns undefined when the id has no table entry, even after stripping', () => {
    expect(lookupPricing('model-c-2024-08-06', FAKE_MAP, DATE_SUFFIX)).toBeUndefined();
  });

  it('returns undefined when the id is entirely unknown', () => {
    expect(lookupPricing('totally-unknown', FAKE_MAP, DATE_SUFFIX)).toBeUndefined();
  });
});

describe('lookupPricing — base === model guard (no infinite recursion)', () => {
  it('returns undefined without retrying when the suffix does not match', () => {
    // 'model-a' has no DATE_SUFFIX; strip leaves it unchanged, so the guard
    // fires and undefined is returned rather than re-querying the same key.
    const singleEntryMap: ReadonlyMap<string, FakePricing> = new Map([
      // Intentionally absent to make the base-guard branch observable.
    ]);
    expect(lookupPricing('model-a', singleEntryMap, DATE_SUFFIX)).toBeUndefined();
  });

  it('does not loop when the stripped base equals the original model', () => {
    // No suffix ⇒ replace() returns the same string ⇒ guard returns undefined.
    const result = lookupPricing('model-a', FAKE_MAP, /-NEVER-MATCHES-THIS$/);
    // 'model-a' is in FAKE_MAP but the pattern never fires; the exact hit path
    // still returns correctly — the guard only matters on exact-miss.
    expect(result).toEqual({ rate: 1.0 }); // exact hit happens first
  });

  it('returns undefined on exact miss when suffix does not match (guard path)', () => {
    const result = lookupPricing('model-c', FAKE_MAP, /-NEVER-MATCHES-THIS$/);
    // Exact miss, suffix does not match ⇒ base === lowered ⇒ guard returns undefined.
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// clampPositive
// ---------------------------------------------------------------------------

describe('clampPositive', () => {
  it('passes through a positive finite number unchanged', () => {
    expect(clampPositive(42)).toBe(42);
    expect(clampPositive(0.001)).toBe(0.001);
    expect(clampPositive(1_000_000)).toBe(1_000_000);
  });

  it('passes through zero unchanged', () => {
    expect(clampPositive(0)).toBe(0);
  });

  it('clamps a negative number to 0', () => {
    expect(clampPositive(-1)).toBe(0);
    expect(clampPositive(-0.0001)).toBe(0);
    expect(clampPositive(-Infinity)).toBe(0);
  });

  it('clamps NaN to 0', () => {
    expect(clampPositive(NaN)).toBe(0);
  });

  it('clamps positive Infinity to 0', () => {
    // Infinity is not finite, so it is treated as an invalid wire value.
    expect(clampPositive(Infinity)).toBe(0);
  });
});
