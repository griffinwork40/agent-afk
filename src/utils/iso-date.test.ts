/**
 * Tests for the strict ISO 8601 date validator.
 *
 * @module utils/iso-date.test
 */

import { describe, it, expect } from 'vitest';
import { isValidIsoDate } from './iso-date.js';

// ---------------------------------------------------------------------------
// Valid inputs (must return true)
// ---------------------------------------------------------------------------

describe('isValidIsoDate — valid ISO 8601 strings', () => {
  it('accepts a UTC full form (Z suffix)', () => {
    expect(isValidIsoDate('2026-06-15T12:00:00Z')).toBe(true);
  });

  it('accepts fractional seconds with Z', () => {
    expect(isValidIsoDate('2026-06-15T12:00:00.000Z')).toBe(true);
  });

  it('accepts fractional seconds with longer fraction', () => {
    expect(isValidIsoDate('2026-06-15T12:00:00.123456Z')).toBe(true);
  });

  it('accepts a positive UTC offset', () => {
    expect(isValidIsoDate('2026-06-15T12:00:00+05:30')).toBe(true);
  });

  it('accepts a negative UTC offset', () => {
    expect(isValidIsoDate('2026-06-15T12:00:00-07:00')).toBe(true);
  });

  it('accepts a date-only string', () => {
    expect(isValidIsoDate('2026-06-15')).toBe(true);
  });

  it('accepts a far-future date', () => {
    expect(isValidIsoDate('2099-12-31T23:59:59Z')).toBe(true);
  });

  it('accepts the epoch', () => {
    expect(isValidIsoDate('1970-01-01T00:00:00Z')).toBe(true);
  });

  it('accepts midnight (00:00:00Z)', () => {
    expect(isValidIsoDate('2026-01-01T00:00:00Z')).toBe(true);
  });

  it('accepts end of day (23:59:59Z)', () => {
    expect(isValidIsoDate('2026-12-31T23:59:59Z')).toBe(true);
  });

  it('accepts Date.toISOString() output', () => {
    expect(isValidIsoDate(new Date('2026-06-15T12:00:00Z').toISOString())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Non-ISO strings (must return false)
// ---------------------------------------------------------------------------

describe('isValidIsoDate — non-ISO strings rejected', () => {
  it('rejects locale-style MM/DD/YYYY', () => {
    expect(isValidIsoDate('01/02/2027')).toBe(false);
  });

  it('rejects locale-style DD-MM-YYYY', () => {
    expect(isValidIsoDate('15-06-2026')).toBe(false);
  });

  it('rejects human-readable date strings', () => {
    expect(isValidIsoDate('June 15, 2026')).toBe(false);
  });

  it('rejects relative strings', () => {
    expect(isValidIsoDate('tomorrow')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isValidIsoDate('')).toBe(false);
  });

  it('rejects plain year', () => {
    expect(isValidIsoDate('2026')).toBe(false);
  });

  it('rejects year-month only', () => {
    expect(isValidIsoDate('2026-06')).toBe(false);
  });

  it('rejects missing T separator', () => {
    expect(isValidIsoDate('2026-06-15 12:00:00Z')).toBe(false);
  });

  it('rejects missing timezone offset', () => {
    expect(isValidIsoDate('2026-06-15T12:00:00')).toBe(false);
  });

  it('rejects arbitrary text', () => {
    expect(isValidIsoDate('not-a-date')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Overflowing calendar dates (must return false)
// ---------------------------------------------------------------------------

describe('isValidIsoDate — overflowing calendar dates rejected', () => {
  it('rejects Feb 30 (always invalid)', () => {
    expect(isValidIsoDate('2026-02-30')).toBe(false);
  });

  it('rejects Feb 29 in a non-leap year', () => {
    expect(isValidIsoDate('2026-02-29')).toBe(false);
  });

  it('accepts Feb 29 in a leap year', () => {
    expect(isValidIsoDate('2024-02-29')).toBe(true);
  });

  it('rejects April 31 (April has 30 days)', () => {
    expect(isValidIsoDate('2026-04-31')).toBe(false);
  });

  it('rejects month 00', () => {
    expect(isValidIsoDate('2026-00-15')).toBe(false);
  });

  it('rejects month 13', () => {
    expect(isValidIsoDate('2026-13-01')).toBe(false);
  });

  it('rejects day 00', () => {
    expect(isValidIsoDate('2026-06-00')).toBe(false);
  });

  it('rejects Feb 30 with time component', () => {
    expect(isValidIsoDate('2026-02-30T12:00:00Z')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Non-string inputs (must return false)
// ---------------------------------------------------------------------------

describe('isValidIsoDate — non-string inputs rejected', () => {
  it('rejects null', () => {
    expect(isValidIsoDate(null)).toBe(false);
  });

  it('rejects undefined', () => {
    expect(isValidIsoDate(undefined)).toBe(false);
  });

  it('rejects a number', () => {
    expect(isValidIsoDate(1234567890)).toBe(false);
  });

  it('rejects a Date object', () => {
    expect(isValidIsoDate(new Date())).toBe(false);
  });

  it('rejects a boolean', () => {
    expect(isValidIsoDate(true)).toBe(false);
  });

  it('rejects an object', () => {
    expect(isValidIsoDate({})).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// UTC offset boundary tests (#4011 nit — the prior ?? '0' fallbacks were dead
// code since both capture groups are required by the regex; these cases
// exercise the max valid offset (+14:00) and the first invalid one (+15:00).
// ---------------------------------------------------------------------------

describe('isValidIsoDate — UTC offset boundaries', () => {
  it('accepts +14:00 (maximum valid UTC offset)', () => {
    expect(isValidIsoDate('2026-06-01T12:00:00+14:00')).toBe(true);
  });

  it('rejects +15:00 (exceeds max UTC offset allowed by regex)', () => {
    // The regex gate rejects hour component > 14, so this is structurally invalid.
    expect(isValidIsoDate('2026-06-01T12:00:00+15:00')).toBe(false);
  });

  it('accepts -12:00 (minimum valid UTC offset)', () => {
    expect(isValidIsoDate('2026-06-01T12:00:00-12:00')).toBe(true);
  });

  it('accepts +05:30 (common offset with non-zero minutes)', () => {
    expect(isValidIsoDate('2026-06-01T12:00:00+05:30')).toBe(true);
  });

  it('accepts +00:00 (explicitly zero offset)', () => {
    expect(isValidIsoDate('2026-06-01T12:00:00+00:00')).toBe(true);
  });
});
