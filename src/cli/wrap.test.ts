/**
 * Tests for src/cli/wrap.ts — ANSI-aware wrapping.
 */

import { describe, it, expect } from 'vitest';
import chalk from 'chalk';
import { wrapToWidth } from './wrap.js';

describe('wrapToWidth', () => {
  it('returns short text unchanged', () => {
    expect(wrapToWidth('hello', 80)).toBe('hello');
  });

  it('wraps long plain text across lines', () => {
    const s = 'one two three four five six seven eight';
    const out = wrapToWidth(s, 10);
    expect(out.split('\n').length).toBeGreaterThan(1);
    expect(out).toContain('one');
  });

  it('wraps chalk-colored strings without throwing', () => {
    const colored = chalk.red('redword') + ' ' + 'plain ' + chalk.green('greenword');
    const out = wrapToWidth(colored, 8);
    expect(out).toContain('redword');
    expect(out.split('\n').length).toBeGreaterThan(1);
  });

  it('does not throw for width 0 or Infinity', () => {
    expect(() => wrapToWidth('abc', 0)).not.toThrow();
    expect(wrapToWidth('abc', 0)).toBe('abc');
    expect(() => wrapToWidth('abc', Number.POSITIVE_INFINITY)).not.toThrow();
    expect(wrapToWidth('abc', Number.POSITIVE_INFINITY)).toBe('abc');
    expect(() => wrapToWidth('abc', Number.NaN)).not.toThrow();
    expect(wrapToWidth('abc', Number.NaN)).toBe('abc');
  });
});
