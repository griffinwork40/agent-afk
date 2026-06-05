/**
 * Pure-render tests for the autocomplete dropdown helpers.
 *
 * Covers `formatHintRow`, the tooltip row that surfaces "when to use" guidance
 * beneath the dropdown for the highlighted candidate. The reader composes
 * this row with the rest of the dropdown frame; tests here verify only that
 * the helper returns the right string shape, never writes to stdout, and
 * collapses cleanly when the hint is absent or empty.
 */

import { describe, it, expect } from 'vitest';
import { formatHintRow } from './dropdown.js';
import { stripAnsi } from '../display.js';

describe('formatHintRow', () => {
  it('returns null when hint is undefined', () => {
    expect(formatHintRow(undefined, 80)).toBeNull();
  });

  it('returns null when hint is empty after trim', () => {
    expect(formatHintRow('', 80)).toBeNull();
    expect(formatHintRow('   ', 80)).toBeNull();
  });

  it('formats a hint with the leading-glyph chrome', () => {
    const row = formatHintRow('When you want a sanity check', 80);
    expect(row).not.toBeNull();
    expect(stripAnsi(row!)).toBe('    ↳ When you want a sanity check');
  });

  it('truncates long hints to fit the column budget', () => {
    // "↳ " + content must fit in `maxWidth - 4` (leading spaces).
    // The 6-col fixed chrome ("    ↳ ") leaves maxWidth - 6 for content.
    const long = 'A very long tooltip body that exceeds the column budget many times over';
    const row = formatHintRow(long, 30);
    expect(row).not.toBeNull();
    const plain = stripAnsi(row!);
    // Hard upper bound: must not exceed `maxWidth` overall.
    expect(plain.length).toBeLessThanOrEqual(30);
    // Truncation marker `…` lands somewhere in the body.
    expect(plain).toContain('…');
  });

  it('returns null when the width budget is so small no content fits', () => {
    expect(formatHintRow('anything', 4)).toBeNull();
  });
});
