/**
 * Direct unit tests for the shared HTML helpers in `html.helpers.ts`.
 *
 * Covers:
 *   - `safeNum`: null, undefined, NaN, ±Infinity, finite integers, decimals.
 *   - `formatPct`: null, undefined, NaN, ±Infinity, zero, 0–1 fractions, >1.
 *   - `htmlEscape`: all five escapable characters, safe-character pass-through.
 *
 * These helpers are pure (no I/O, no side effects), so every assertion is
 * fully deterministic.
 *
 * @module insights/html.helpers.test
 */

import { describe, it, expect } from 'vitest';
import { safeNum, formatPct, htmlEscape } from './html.helpers.js';

// ---------------------------------------------------------------------------
// safeNum
// ---------------------------------------------------------------------------

describe('safeNum', () => {
  it('returns "0" for undefined', () => {
    expect(safeNum(undefined)).toBe('0');
  });

  it('returns "0" for null', () => {
    expect(safeNum(null)).toBe('0');
  });

  it('returns "0" for NaN', () => {
    expect(safeNum(NaN)).toBe('0');
  });

  it('returns "0" for +Infinity', () => {
    expect(safeNum(Infinity)).toBe('0');
  });

  it('returns "0" for -Infinity', () => {
    expect(safeNum(-Infinity)).toBe('0');
  });

  it('formats zero with default 0 decimals', () => {
    expect(safeNum(0)).toBe('0');
  });

  it('formats a positive integer with default 0 decimals', () => {
    expect(safeNum(42)).toBe('42');
  });

  it('formats a negative integer with default 0 decimals', () => {
    expect(safeNum(-7)).toBe('-7');
  });

  it('rounds to 0 decimals by default', () => {
    // toFixed(0) rounds half-up: 1.5 → "2"
    expect(safeNum(1.5)).toBe('2');
    expect(safeNum(1.4)).toBe('1');
  });

  it('honours the decimals parameter', () => {
    expect(safeNum(3.14159, 2)).toBe('3.14');
  });

  it('pads trailing zeros to match requested decimals', () => {
    expect(safeNum(1, 3)).toBe('1.000');
  });

  it('formats a large integer correctly', () => {
    expect(safeNum(1000000)).toBe('1000000');
  });

  it('formats a negative decimal', () => {
    expect(safeNum(-0.5, 1)).toBe('-0.5');
  });
});

// ---------------------------------------------------------------------------
// formatPct
// ---------------------------------------------------------------------------

describe('formatPct', () => {
  it('returns "N/A" for undefined', () => {
    expect(formatPct(undefined)).toBe('N/A');
  });

  it('returns "N/A" for null', () => {
    expect(formatPct(null)).toBe('N/A');
  });

  it('returns "N/A" for NaN', () => {
    expect(formatPct(NaN)).toBe('N/A');
  });

  it('returns "N/A" for +Infinity', () => {
    expect(formatPct(Infinity)).toBe('N/A');
  });

  it('returns "N/A" for -Infinity', () => {
    expect(formatPct(-Infinity)).toBe('N/A');
  });

  it('formats zero fraction as "0.0%"', () => {
    expect(formatPct(0)).toBe('0.0%');
  });

  it('formats 0.5 as "50.0%"', () => {
    expect(formatPct(0.5)).toBe('50.0%');
  });

  it('formats 1 (100%) as "100.0%"', () => {
    expect(formatPct(1)).toBe('100.0%');
  });

  it('formats 0.4 as "40.0%" (matches the guardrail-FP fixture)', () => {
    // Value used in html.test.ts fixture (falsePositiveRate: 0.4).
    expect(formatPct(0.4)).toBe('40.0%');
  });

  it('formats fractions that produce a decimal result to 1 decimal place', () => {
    expect(formatPct(1 / 3)).toBe('33.3%');
  });

  it('formats a negative fraction (e.g. -0.1 → "-10.0%")', () => {
    expect(formatPct(-0.1)).toBe('-10.0%');
  });

  it('formats fractions greater than 1 (e.g. 1.5 → "150.0%")', () => {
    expect(formatPct(1.5)).toBe('150.0%');
  });

  it('result always ends with "%"', () => {
    expect(formatPct(0.25)).toMatch(/%$/);
  });
});

// ---------------------------------------------------------------------------
// htmlEscape
// ---------------------------------------------------------------------------

describe('htmlEscape', () => {
  it('escapes &', () => {
    expect(htmlEscape('&')).toBe('&amp;');
  });

  it('escapes <', () => {
    expect(htmlEscape('<')).toBe('&lt;');
  });

  it('escapes >', () => {
    expect(htmlEscape('>')).toBe('&gt;');
  });

  it('escapes "', () => {
    expect(htmlEscape('"')).toBe('&quot;');
  });

  it("escapes '", () => {
    expect(htmlEscape("'")).toBe('&#39;');
  });

  it('leaves safe characters unchanged', () => {
    expect(htmlEscape('hello world 123')).toBe('hello world 123');
  });

  it('escapes all five characters in a combined string', () => {
    expect(htmlEscape('<a href="x" data-y=\'z\'>&</a>')).toBe(
      '&lt;a href=&quot;x&quot; data-y=&#39;z&#39;&gt;&amp;&lt;/a&gt;',
    );
  });

  it('returns empty string unchanged', () => {
    expect(htmlEscape('')).toBe('');
  });
});
