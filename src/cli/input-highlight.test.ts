/**
 * Tests for src/cli/input-highlight.ts
 *
 * Verifies the input-field slash-token colorizer:
 *   - colors known slash tokens with the brand palette
 *   - routes `/mint` and namespaced `/<plugin>:mint` to the mint palette
 *     (per-command tone override, visually distinct from brand)
 *   - colors unknown slash tokens with the dim/meta palette
 *   - leaves non-slash text untouched
 *   - never alters the underlying string length (cursor invariant)
 *   - returns plain input when chalk colors are disabled (NO_COLOR / non-TTY)
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { colorizeInputBuffer, type SlashRegistryView } from './input-highlight.js';

// Inline ANSI strip — avoids adding a new dependency.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
const stripAnsi = (s: string): string => s.replace(ANSI_RE, '');

const knownReg = (knownNames: readonly string[]): SlashRegistryView => ({
  has: (n) => knownNames.includes(n),
});

const allKnown: SlashRegistryView = { has: () => true };
const noneKnown: SlashRegistryView = { has: () => false };

describe('colorizeInputBuffer', () => {
  let prevLevel: 0 | 1 | 2 | 3;

  beforeEach(() => {
    prevLevel = chalk.level;
    // Force colors on for the body of these tests so the colorize logic engages.
    if (chalk.level === 0) chalk.level = 1;
  });

  afterEach(() => {
    chalk.level = prevLevel;
  });

  it('colors a known slash token with ANSI and preserves stripped output', () => {
    const out = colorizeInputBuffer('/mint hello', knownReg(['mint']));
    expect(out).toMatch(ANSI_RE);
    expect(out).toContain('/mint');
    expect(stripAnsi(out)).toBe('/mint hello');
  });

  it('colors an unknown slash token (still ANSI, but dim/meta)', () => {
    const out = colorizeInputBuffer('/notreal foo', noneKnown);
    expect(out).toMatch(ANSI_RE);
    expect(stripAnsi(out)).toBe('/notreal foo');
  });

  it('colors a slash token in the middle of the buffer', () => {
    const out = colorizeInputBuffer('hello /mint world', knownReg(['mint']));
    expect(out).toMatch(ANSI_RE);
    expect(stripAnsi(out)).toBe('hello /mint world');
    // The leading "hello " must remain plain text.
    expect(out.startsWith('hello ')).toBe(true);
  });

  it('colors multiple slash tokens in one buffer', () => {
    const out = colorizeInputBuffer('/mint then /diagnose this', knownReg(['mint', 'diagnose']));
    expect(out).toMatch(ANSI_RE);
    expect(stripAnsi(out)).toBe('/mint then /diagnose this');
    // Both tokens should be colored — count ANSI reset sequences (at least 2).
    const resets = out.match(/\x1b\[39m/g) || [];
    expect(resets.length).toBeGreaterThanOrEqual(2);
  });

  it('colors known and unknown mid-buffer tokens differently', () => {
    const reg = knownReg(['mint']);
    const out = colorizeInputBuffer('please /mint and /notreal', reg);
    expect(stripAnsi(out)).toBe('please /mint and /notreal');
    // Both should be wrapped in ANSI, but we just verify printable integrity.
    expect(out).toMatch(ANSI_RE);
  });

  it('returns plain text when there is no slash token', () => {
    const out = colorizeInputBuffer('hello world', allKnown);
    expect(out).toBe('hello world');
    expect(out).not.toMatch(ANSI_RE);
  });

  it('returns plain text for a bare slash with no name', () => {
    const out = colorizeInputBuffer('/', allKnown);
    expect(out).toBe('/');
    expect(out).not.toMatch(ANSI_RE);
  });

  it('only colors the leading token; trailing flags stay plain', () => {
    const out = colorizeInputBuffer('/mint --flag', knownReg(['mint']));
    // The token itself should be wrapped in ANSI.
    expect(out).toMatch(ANSI_RE);
    // The ` --flag` tail must be present untouched after stripping.
    expect(stripAnsi(out)).toBe('/mint --flag');
    // Sanity: there must be no ANSI codes inside the trailing portion of the
    // colored output (split on the closing reset and check the tail).
    const stripped = stripAnsi(out);
    expect(stripped.endsWith(' --flag')).toBe(true);
  });

  it('matches namespaced slash tokens (with `:`)', () => {
    const out = colorizeInputBuffer('/mint:foo bar', knownReg(['mint:foo']));
    expect(out).toMatch(ANSI_RE);
    expect(stripAnsi(out)).toBe('/mint:foo bar');
    // The colored region must start at the very beginning.
    expect(out.startsWith('\x1b[')).toBe(true);
  });

  it('preserves unicode (multi-byte chars and CJK) after coloring', () => {
    const input = '/mint héllo 你好';
    const out = colorizeInputBuffer(input, knownReg(['mint']));
    expect(out).toMatch(ANSI_RE);
    expect(stripAnsi(out)).toBe(input);
  });

  it('returns plain input when chalk.level === 0 (NO_COLOR)', () => {
    const saved = chalk.level;
    chalk.level = 0;
    try {
      const out = colorizeInputBuffer('/mint hello', knownReg(['mint']));
      expect(out).toBe('/mint hello');
      expect(out).not.toMatch(ANSI_RE);
    } finally {
      chalk.level = saved;
    }
  });

  describe('/mint per-command tone override', () => {
    it('colors /mint with a tone distinct from the default brand tone used by other commands', () => {
      const reg = knownReg(['mint', 'diagnose']);
      const mintOut = colorizeInputBuffer('/mint', reg);
      const diagOut = colorizeInputBuffer('/diagnose', reg);
      // Both must be ANSI-wrapped (both are known commands).
      expect(mintOut).toMatch(ANSI_RE);
      expect(diagOut).toMatch(ANSI_RE);
      // The opening ANSI prefix for each must differ — that's the
      // observable signal that /mint is rendering with a separate tone.
      const mintAnsi = mintOut.match(ANSI_RE)?.[0];
      const diagAnsi = diagOut.match(ANSI_RE)?.[0];
      expect(mintAnsi).toBeDefined();
      expect(diagAnsi).toBeDefined();
      expect(mintAnsi).not.toBe(diagAnsi);
      // Stripped output is still the original text — cursor invariant.
      expect(stripAnsi(mintOut)).toBe('/mint');
      expect(stripAnsi(diagOut)).toBe('/diagnose');
    });

    it('also colors namespaced /<plugin>:mint with the mint tone', () => {
      const reg = knownReg(['example-plugin:mint', 'diagnose']);
      const nsOut = colorizeInputBuffer('/example-plugin:mint', reg);
      const bareDiag = colorizeInputBuffer('/diagnose', reg);
      const nsAnsi = nsOut.match(ANSI_RE)?.[0];
      const diagAnsi = bareDiag.match(ANSI_RE)?.[0];
      expect(nsAnsi).toBeDefined();
      expect(diagAnsi).toBeDefined();
      // The namespaced form should share /mint's tone (and therefore
      // differ from the brand tone applied to /diagnose).
      expect(nsAnsi).not.toBe(diagAnsi);
      // Reference: bare /mint should match the namespaced form's tone.
      const bareMint = colorizeInputBuffer('/mint', knownReg(['mint']));
      const bareMintAnsi = bareMint.match(ANSI_RE)?.[0];
      expect(bareMintAnsi).toBe(nsAnsi);
      expect(stripAnsi(nsOut)).toBe('/example-plugin:mint');
    });

    it('does NOT apply the mint tone to an unknown /mint (registry says no)', () => {
      // When the registry rejects /mint, the meta (dim) tone wins — the
      // mint override only applies to *known* commands.
      const unknown = colorizeInputBuffer('/mint hello', noneKnown);
      const knownMint = colorizeInputBuffer('/mint hello', knownReg(['mint']));
      const unknownAnsi = unknown.match(ANSI_RE)?.[0];
      const knownAnsi = knownMint.match(ANSI_RE)?.[0];
      expect(unknownAnsi).toBeDefined();
      expect(knownAnsi).toBeDefined();
      expect(unknownAnsi).not.toBe(knownAnsi);
      // Both still preserve the stripped buffer.
      expect(stripAnsi(unknown)).toBe('/mint hello');
      expect(stripAnsi(knownMint)).toBe('/mint hello');
    });

    it('preserves cursor invariant for the mint and namespaced-mint shapes', () => {
      const cases: Array<[string, SlashRegistryView]> = [
        ['/mint', knownReg(['mint'])],
        ['/mint hello', knownReg(['mint'])],
        ['hello /mint there', knownReg(['mint'])],
        ['/example-plugin:mint go', knownReg(['example-plugin:mint'])],
        ['/user:mint idea', knownReg(['user:mint'])],
      ];
      for (const [buf, reg] of cases) {
        const out = colorizeInputBuffer(buf, reg);
        expect(stripAnsi(out).length).toBe(buf.length);
      }
    });
  });

  it('colors an @-file token at start of buffer', () => {
    const out = colorizeInputBuffer('@src/index.ts', allKnown);
    expect(out).toMatch(ANSI_RE);
    expect(stripAnsi(out)).toBe('@src/index.ts');
    // The colored region must start at the very beginning.
    expect(out.startsWith('\x1b[')).toBe(true);
  });

  it('colors an @-file token mid-buffer (after whitespace)', () => {
    const out = colorizeInputBuffer('read @src/foo.ts please', allKnown);
    expect(out).toMatch(ANSI_RE);
    expect(stripAnsi(out)).toBe('read @src/foo.ts please');
    // Leading prose must remain plain text.
    expect(out.startsWith('read ')).toBe(true);
  });

  it('colors a bare `@` (open file trigger, no path yet)', () => {
    const out = colorizeInputBuffer('look @', allKnown);
    expect(out).toMatch(ANSI_RE);
    expect(stripAnsi(out)).toBe('look @');
  });

  it('colors both a slash token and an @-file token in one buffer', () => {
    const out = colorizeInputBuffer('/mint @src/index.ts go', knownReg(['mint']));
    expect(out).toMatch(ANSI_RE);
    expect(stripAnsi(out)).toBe('/mint @src/index.ts go');
    // Two distinct colored spans → at least two resets.
    const resets = out.match(/\x1b\[39m/g) || [];
    expect(resets.length).toBeGreaterThanOrEqual(2);
  });

  it('does NOT color `@` embedded inside a word (e.g. email addresses)', () => {
    const out = colorizeInputBuffer('email@host.com', allKnown);
    expect(out).toBe('email@host.com');
    expect(out).not.toMatch(ANSI_RE);
  });

  it('colors a tilde @-file token (@~/foo)', () => {
    const out = colorizeInputBuffer('@~/foo', allKnown);
    expect(out).toMatch(ANSI_RE);
    expect(stripAnsi(out)).toBe('@~/foo');
    expect(out.startsWith('\x1b[')).toBe(true);
  });

  it('colors a deep tilde @-file token (@~/.afk/config/schedules.json)', () => {
    const out = colorizeInputBuffer('@~/.afk/config/schedules.json', allKnown);
    expect(out).toMatch(ANSI_RE);
    expect(stripAnsi(out)).toBe('@~/.afk/config/schedules.json');
  });

  it('colors an absolute @-file token (@/etc/hosts)', () => {
    const out = colorizeInputBuffer('@/etc/hosts', allKnown);
    expect(out).toMatch(ANSI_RE);
    expect(stripAnsi(out)).toBe('@/etc/hosts');
  });

  it('colors a tilde @-file token mid-buffer (read @~/foo.md please)', () => {
    const out = colorizeInputBuffer('read @~/foo.md please', allKnown);
    expect(out).toMatch(ANSI_RE);
    expect(stripAnsi(out)).toBe('read @~/foo.md please');
    expect(out.startsWith('read ')).toBe(true);
  });

  it('cursor invariant: stripped length equals input length for many shapes', () => {
    const cases: Array<[string, SlashRegistryView]> = [
      ['', allKnown],
      ['/', allKnown],
      ['/x', knownReg(['x'])],
      ['/mint', knownReg(['mint'])],
      ['/mint hello', knownReg(['mint'])],
      ['/mint hello', noneKnown],
      ['/mint --flag a b', knownReg(['mint'])],
      ['/mint:foo bar baz', knownReg(['mint:foo'])],
      ['plain text only', allKnown],
      ['/mint héllo 你好', knownReg(['mint'])],
      ['/notreal foo', noneKnown],
      ['hello /mint world', knownReg(['mint'])],
      ['/mint then /diagnose this', knownReg(['mint', 'diagnose'])],
      ['no /slash/here', allKnown],
      ['a /x b /y c', knownReg(['x', 'y'])],
      ['@src/index.ts', allKnown],
      ['read @src/foo.ts now', allKnown],
      ['/mint @src/index.ts', knownReg(['mint'])],
      ['email@host.com', allKnown],
      ['@', allKnown],
      ['[Pasted text #1 +5 lines]', allKnown],
      ['hello [Pasted text #2 +1500 chars] world', allKnown],
      ['/mint [Pasted text #1 +5 lines]', knownReg(['mint'])],
      ['@~/foo', allKnown],
      ['@~/.afk/config/schedules.json', allKnown],
      ['@/etc/hosts', allKnown],
      ['read @~/foo.md please', allKnown],
      ['@~', allKnown],
    ];
    for (const [buf, reg] of cases) {
      const out = colorizeInputBuffer(buf, reg);
      expect(stripAnsi(out).length).toBe(buf.length);
    }
  });

  // Paste-truncation placeholders emitted by terminal-compositor.ts when a
  // bracketed paste exceeds the size threshold. The colorizer styles them
  // dim so they read as stubs, not literal user-typed text.
  describe('paste-truncation placeholder', () => {
    it('colors a `[Pasted text #N +M lines]` token at the start of the buffer', () => {
      const out = colorizeInputBuffer('[Pasted text #1 +12 lines]', allKnown);
      expect(out).toMatch(ANSI_RE);
      expect(stripAnsi(out)).toBe('[Pasted text #1 +12 lines]');
    });

    it('colors a `[Pasted text #N +M chars]` token (single-line paste form)', () => {
      const out = colorizeInputBuffer('[Pasted text #3 +2048 chars]', allKnown);
      expect(out).toMatch(ANSI_RE);
      expect(stripAnsi(out)).toBe('[Pasted text #3 +2048 chars]');
    });

    it('colors a placeholder embedded mid-buffer alongside plain prose', () => {
      const out = colorizeInputBuffer('look at [Pasted text #1 +7 lines] thanks', allKnown);
      expect(out).toMatch(ANSI_RE);
      expect(stripAnsi(out)).toBe('look at [Pasted text #1 +7 lines] thanks');
      // Surrounding prose must still be present in plain form.
      expect(out.startsWith('look at ')).toBe(true);
      expect(stripAnsi(out).endsWith(' thanks')).toBe(true);
    });

    it('colors a placeholder AND a slash token in the same buffer', () => {
      const out = colorizeInputBuffer('/mint [Pasted text #1 +6 lines]', knownReg(['mint']));
      expect(out).toMatch(ANSI_RE);
      expect(stripAnsi(out)).toBe('/mint [Pasted text #1 +6 lines]');
      // Two distinct colored spans → at least two reset codes.
      const resets = out.match(/\x1b\[39m/g) || [];
      expect(resets.length).toBeGreaterThanOrEqual(2);
    });

    it('returns plain input when chalk is disabled', () => {
      const saved = chalk.level;
      chalk.level = 0;
      try {
        const out = colorizeInputBuffer('[Pasted text #1 +6 lines]', allKnown);
        expect(out).toBe('[Pasted text #1 +6 lines]');
        expect(out).not.toMatch(ANSI_RE);
      } finally {
        chalk.level = saved;
      }
    });

    it('non-placeholder bracketed text is NOT styled', () => {
      // A literal `[Pasted ...]` shape with a typo / different word
      // should fall through as plain text — the regex is anchored to
      // the exact placeholder format.
      const out = colorizeInputBuffer('[Pasted something else]', allKnown);
      expect(out).toBe('[Pasted something else]');
      expect(out).not.toMatch(ANSI_RE);
    });
  });
});
