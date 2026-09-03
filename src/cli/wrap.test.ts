/**
 * Tests for src/cli/wrap.ts — ANSI-aware wrapping.
 */

import { describe, it, expect } from 'vitest';
import chalk from 'chalk';
import { wrapToWidth } from './wrap.js';

const stripAnsi = (text: string): string => text.replace(/\x1B\[[0-9;]*m/g, '');

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

  it('does not carry a boundary space onto the next line', () => {
    const text =
      'aaaa bbbb cccc dddd eeee ffff gggg hhhh iiii jjjj kkkk llll mmmm nnnn oooo pppp';

    expect(wrapToWidth(text, 24).split('\n')).toEqual([
      'aaaa bbbb cccc dddd eeee',
      'ffff gggg hhhh iiii jjjj',
      'kkkk llll mmmm nnnn oooo',
      'pppp',
    ]);
  });

  it('wraps chalk-colored strings without throwing', () => {
    const colored = chalk.red('redword') + ' ' + 'plain ' + chalk.green('greenword');
    const out = wrapToWidth(colored, 8);
    expect(out).toContain('redword');
    expect(out.split('\n').length).toBeGreaterThan(1);
  });

  it('preserves intentional indentation after leading ANSI styles', () => {
    const text = chalk.dim('  • one two three four');
    const lines = wrapToWidth(text, 12, { breakLongWords: true }).split('\n');

    expect(stripAnsi(lines[0]!)).toBe('  • one two');
    expect(stripAnsi(lines[1]!)).toBe('three four');
  });

  it('does not throw for width 0 or Infinity', () => {
    expect(() => wrapToWidth('abc', 0)).not.toThrow();
    expect(wrapToWidth('abc', 0)).toBe('abc');
    expect(() => wrapToWidth('abc', Number.POSITIVE_INFINITY)).not.toThrow();
    expect(wrapToWidth('abc', Number.POSITIVE_INFINITY)).toBe('abc');
    expect(() => wrapToWidth('abc', Number.NaN)).not.toThrow();
    expect(wrapToWidth('abc', Number.NaN)).toBe('abc');
  });

  it('leaves an over-long unbreakable token intact by default (soft wrap)', () => {
    const url = 'https://example.com/' + 'a'.repeat(60);
    const out = wrapToWidth(url, 20);
    // Soft wrap: the single long token overflows past `width` on one line.
    expect(out).toBe(url);
    expect(out.split('\n')).toHaveLength(1);
  });

  it('breaks an over-long unbreakable token when breakLongWords is set', () => {
    const url = 'https://example.com/' + 'a'.repeat(60);
    const out = wrapToWidth(url, 20, { breakLongWords: true });
    const lines = out.split('\n');
    expect(lines.length).toBeGreaterThan(1);
    // No physical line exceeds the width once long words are broken.
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(20);
    }
  });

  it('breakLongWords still wraps normal prose at word boundaries (no mid-word splits)', () => {
    const prose = 'one two three four five six seven eight nine ten';
    const out = wrapToWidth(prose, 12, { breakLongWords: true });
    // Every whole word survives un-split — only over-long tokens are broken.
    for (const word of prose.split(' ')) {
      expect(out).toContain(word);
    }
    expect(out.split('\n').length).toBeGreaterThan(1);
  });

  it('does not corrupt genuine U+E000 bytes when all 256 PUA slots are occupied (indentMarker fallback path)', () => {
    // Build a line that uses all 256 PUA code points (U+E000–U+E0FF) so that
    // the indentMarker search finds no free candidate and falls back to undefined.
    // The line must also be short enough that wrapAnsi leaves it unchanged.
    const allPua = Array.from({ length: 256 }, (_, i) => String.fromCodePoint(0xe000 + i)).join('');
    // The line starts with a leading space (so the indent-protect branch runs)
    // followed by the block of all PUA chars. We use a narrow enough line that
    // the content itself doesn't wrap (width = 512 covers everything).
    const line = ' ' + allPua;
    const out = wrapToWidth(line, 512);
    // The genuine U+E000 byte must survive untouched — it must NOT have been
    // replaced with a space by the now-skipped `.replaceAll(indentMarker ?? '\uE000', ' ')`.
    expect(out).toContain('\uE000');
    // The overall content is preserved (minus any leading-space trim wrap-ansi may apply).
    expect(out).toContain(allPua);
  });
});
