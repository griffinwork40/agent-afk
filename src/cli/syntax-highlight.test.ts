/**
 * Tests for src/cli/syntax-highlight.ts
 *
 * Verifies code-block syntax highlighting wraps emphasize correctly:
 *   - emits ANSI escapes for known languages
 *   - preserves the original code text under strip-ansi
 *   - falls back gracefully on unknown language
 *   - respects chalk.level === 0 (NO_COLOR / non-TTY)
 *   - is idempotent (cache-friendly)
 *   - bypasses for very long inputs
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { highlightCode } from './syntax-highlight.js';
import { applyTheme } from './theme.js';

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

describe('highlightCode', () => {
  let originalLevel: typeof chalk.level;

  beforeEach(() => {
    originalLevel = chalk.level;
    chalk.level = 3;
  });

  afterEach(() => {
    chalk.level = originalLevel;
  });

  it('returns ANSI-escape-bearing output for known TypeScript code', () => {
    const out = highlightCode('const x: number = 1;', 'typescript');
    // Either contains an ESC[…m sequence, or strip-ansi differs from input.
    const hasAnsi = ANSI_RE.test(out);
    ANSI_RE.lastIndex = 0; // reset the global regex state
    expect(hasAnsi || stripAnsi(out) !== out).toBe(true);
  });

  it('preserves the original code under strip-ansi', () => {
    const src = 'const x = 1;';
    const out = highlightCode(src, 'typescript');
    expect(stripAnsi(out)).toBe(src);
  });

  it('falls back to plain input on unknown language', () => {
    const out = highlightCode('garbage', 'definitelynotalanguage');
    expect(out).toBe('garbage');
  });

  it('returns plain input when chalk.level === 0', () => {
    chalk.level = 0;
    const out = highlightCode('foo', 'typescript');
    expect(out).toBe('foo');
  });

  it('is idempotent — repeated calls return identical strings', () => {
    const a = highlightCode('const y = 2;', 'typescript');
    const b = highlightCode('const y = 2;', 'typescript');
    expect(a).toBe(b);
  });

  it('bypasses highlighting for inputs longer than 2048 chars', () => {
    const big = 'x'.repeat(3000);
    const out = highlightCode(big, 'typescript');
    expect(out).toBe(big);
  });

  it('re-highlights with new tones after a theme swap (cache invalidation actually changes rendered output)', () => {
    // applyTheme() calls clearHighlightCache() so a swap doesn't serve a
    // stale cache hit, but nothing previously asserted the highlighted
    // OUTPUT actually differs afterward — only that the cache didn't short-
    // circuit. This closes that gap: same snippet, dark then light, must
    // render distinct ANSI. See PR #643 review (nice-to-have item).
    try {
      const snippet = 'const x: number = 1; // hi';
      applyTheme('dark');
      const dark = highlightCode(snippet, 'typescript');
      applyTheme('light');
      const light = highlightCode(snippet, 'typescript');
      expect(light).not.toBe(dark);
      // Sanity: both still round-trip the original text under strip-ansi.
      expect(stripAnsi(dark)).toBe(stripAnsi(light));
    } finally {
      applyTheme('dark'); // restore the default so later tests/files see dark
    }
  });
});
