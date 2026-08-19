/**
 * Unit tests for the picker-filter scorer.
 *
 * Covers the three scoring tiers (exact substring / subsequence / no match)
 * and the ANSI-stripping behaviour required for options produced by
 * `uniquePickLabels` in `resume.ts` (which appends `palette.dim(id)` to
 * disambiguate duplicate labels).
 */

import { describe, expect, it } from 'vitest';
import { filterOptions } from './picker-filter.js';

describe('filterOptions — empty query', () => {
  it('returns all options in original order', () => {
    const opts = ['apple', 'banana', 'cherry'];
    const results = filterOptions(opts, '');
    expect(results.map((r) => r.originalIndex)).toEqual([0, 1, 2]);
  });

  it('scores all as 100 for empty query', () => {
    const results = filterOptions(['a', 'b'], '');
    expect(results.every((r) => r.score === 100)).toBe(true);
  });
});

describe('filterOptions — exact substring match (score 100)', () => {
  it('matches case-insensitively', () => {
    const results = filterOptions(['Apple', 'BANANA', 'cherry'], 'apple');
    expect(results[0]?.originalIndex).toBe(0);
    expect(results[0]?.score).toBe(100);
  });

  it('exact match ranks above subsequence match', () => {
    // 'abc' — exact substring; 'aXbXc' — subsequence only
    const results = filterOptions(['aXbXc', 'xabcx'], 'abc');
    // 'xabcx' has exact substring 'abc'; should rank first
    const first = results[0];
    expect(first?.score).toBe(100);
    // Check the originalIndex corresponds to 'xabcx'
    expect(['aXbXc', 'xabcx'][first!.originalIndex]).toBe('xabcx');
  });

  it('excludes non-matching options', () => {
    const results = filterOptions(['apple', 'orange', 'banana'], 'xyz');
    expect(results).toHaveLength(0);
  });
});

describe('filterOptions — subsequence match (score 50–99)', () => {
  it('matches when all query chars appear in order', () => {
    const results = filterOptions(['a-p-p-l-e'], 'ale');
    expect(results).toHaveLength(1);
    const s = results[0]!.score;
    expect(s).toBeGreaterThanOrEqual(50);
    expect(s).toBeLessThan(100);
  });

  it('does not match when a char is missing', () => {
    const results = filterOptions(['abcd'], 'axd');
    expect(results).toHaveLength(0);
  });

  it('dense subsequence scores higher than sparse', () => {
    // 'abc' in 'abc123' is denser than 'a_b_c_d_e_f'
    const results = filterOptions(['abcdef', 'a_b_c_d_e_f'], 'abc');
    // Both match; denser one ('abcdef') should score higher
    const idx0 = results.findIndex((r) => r.originalIndex === 0);
    const idx1 = results.findIndex((r) => r.originalIndex === 1);
    expect(results[idx0]!.score).toBeGreaterThan(results[idx1]!.score);
  });
});

describe('filterOptions — ANSI stripping', () => {
  const ESC = '\x1b';
  const dim = (s: string): string => `${ESC}[2m${s}${ESC}[0m`;

  it('matches against visible text inside ANSI sequences', () => {
    // Mimics palette.dim(id) appended to a label
    const label = `2h ago  sonnet  3 turns  ${dim('some-uuid-1234')}`;
    const results = filterOptions([label], 'uuid');
    expect(results).toHaveLength(1);
  });

  it('does not match the raw ANSI escape bytes', () => {
    // The query 'ESC[2m' should NOT match — it's an escape sequence, not text
    const label = `plain ${dim('value')}`;
    const results = filterOptions([label], '\x1b[2m');
    // After stripping, '\x1b[2m' is gone, so the query should not match
    expect(results).toHaveLength(0);
  });

  it('visible label text still matches after stripping', () => {
    const label = `${dim('highlighted')} text`;
    const results = filterOptions([label], 'highlighted');
    expect(results).toHaveLength(1);
    expect(results[0]!.score).toBe(100); // exact substring in stripped text
  });
});

describe('filterOptions — sort order', () => {
  it('returns results sorted by descending score', () => {
    // 'abc' exact in 'abc', subsequence in 'a_b_c'
    const opts = ['a_b_c', 'abc'];
    const results = filterOptions(opts, 'abc');
    expect(results.length).toBe(2);
    expect(results[0]!.score).toBeGreaterThanOrEqual(results[1]!.score);
  });
});
