import { describe, it, expect, afterEach } from 'vitest';

import { hangingWrap, boundLineToTerminal } from './bounded-line.js';
import { displayWidth, stripAnsi } from '../display.js';

/**
 * Every assertion here defends ONE invariant: no row handed to a TTY may
 * exceed the terminal width. `hangingWrap` is pure, so most cases exercise it
 * directly; `boundLineToTerminal` is covered for its TTY gate only.
 */

const originalColumns = process.stdout.columns;

afterEach(() => {
  Object.defineProperty(process.stdout, 'columns', {
    configurable: true,
    writable: true,
    value: originalColumns,
  });
});

function setColumns(n: number): void {
  Object.defineProperty(process.stdout, 'columns', {
    configurable: true,
    writable: true,
    value: n,
  });
}

/** Assert no produced row exceeds `width` display cells. */
function expectAllRowsFit(out: string, width: number): void {
  for (const row of out.split('\n')) {
    expect(
      displayWidth(row),
      `row exceeds width ${width}: ${JSON.stringify(stripAnsi(row))}`,
    ).toBeLessThanOrEqual(width);
  }
}

describe('hangingWrap', () => {
  it('passes a fitting line through byte-identical', () => {
    const line = '  ↳ short enough';
    expect(hangingWrap(line, 62)).toBe(line);
  });

  it('preserves empty and blank lines exactly', () => {
    expect(hangingWrap('', 62)).toBe('');
    expect(hangingWrap('\n\n', 62)).toBe('\n\n');
  });

  it('wraps an over-wide line and hangs the source indent on continuations', () => {
    const line = '  ↳ ' + 'word '.repeat(40).trim();
    const out = hangingWrap(line, 40);
    const rows = out.split('\n');

    expect(rows.length).toBeGreaterThan(1);
    expectAllRowsFit(out, 40);
    // Continuation rows keep the row's own indent — never column 0.
    for (const row of rows.slice(1)) {
      expect(row.startsWith('  ')).toBe(true);
      expect(row.startsWith('   ')).toBe(false);
    }
  });

  it('breaks an unbreakable token rather than overflowing', () => {
    const line = '  $ bash git cat-file -e ' + 'a'.repeat(200);
    expectAllRowsFit(hangingWrap(line, 62), 62);
  });

  it('bounds wide (CJK) and emoji graphemes by display cells, not code units', () => {
    expectAllRowsFit(hangingWrap('  ' + '漢字'.repeat(60), 40), 40);
    expectAllRowsFit(hangingWrap('  ' + '🎉'.repeat(60), 40), 40);
  });

  it('bounds a styled line without counting ANSI bytes as width', () => {
    const styled = `\x1b[2m  ↳ ${'x'.repeat(200)}\x1b[22m`;
    const out = hangingWrap(styled, 50);
    expectAllRowsFit(out, 50);
    expect(stripAnsi(out).replaceAll('\n', '').replaceAll(' ', '')).toContain('x'.repeat(50));
  });

  it('wraps each logical line of a multi-line payload independently', () => {
    const out = hangingWrap(['  a'.repeat(40), 'short', '    b'.repeat(40)].join('\n'), 30);
    expectAllRowsFit(out, 30);
    expect(out.split('\n').some((r) => r === 'short')).toBe(true);
  });

  it('drops the hanging indent when honoring it would leave < 8 content columns', () => {
    const out = hangingWrap(' '.repeat(30) + 'x'.repeat(80), 34);
    expectAllRowsFit(out, 34);
    expect(out.split('\n').length).toBeGreaterThan(1);
  });

  it('is a no-op for a non-positive or non-finite width', () => {
    const line = 'x'.repeat(200);
    expect(hangingWrap(line, 0)).toBe(line);
    expect(hangingWrap(line, -5)).toBe(line);
    expect(hangingWrap(line, Number.POSITIVE_INFINITY)).toBe(line);
    expect(hangingWrap(line, Number.NaN)).toBe(line);
  });

  it('bounds the real /worktree list table row shape at narrow widths', () => {
    // The exact composition from src/cli/slash/commands/worktree.ts (~100 cols).
    const row =
      '  ' +
      '/Users/x/Projects/open_source/agent-afk/.afk-worktrees/some-branch'.slice(-44).padEnd(45) +
      '  ' +
      'griffin'.padEnd(12) +
      '  ' +
      '3d'.padEnd(5) +
      '  ' +
      'stale-dirty'.padEnd(22) +
      '  ' +
      'warn';
    expect(displayWidth(row)).toBeGreaterThan(62);
    for (const cols of [40, 62, 80, 100, 120]) {
      expectAllRowsFit(hangingWrap(row, cols), cols);
    }
  });
});

describe('boundLineToTerminal', () => {
  it('returns non-TTY output byte-identical so pipes keep whole logical rows', () => {
    setColumns(40);
    const line = 'x'.repeat(200);
    expect(boundLineToTerminal(line, { isTTY: false })).toBe(line);
    expect(boundLineToTerminal(line, {})).toBe(line);
  });

  it('bounds TTY output to the live terminal width', () => {
    setColumns(62);
    const out = boundLineToTerminal('  ↳ ' + 'y'.repeat(200), { isTTY: true });
    expectAllRowsFit(out, 62);
  });

  it('tracks a width change between calls (resize)', () => {
    const line = '  ↳ ' + 'z '.repeat(80).trim();
    setColumns(100);
    expectAllRowsFit(boundLineToTerminal(line, { isTTY: true }), 100);
    setColumns(45);
    expectAllRowsFit(boundLineToTerminal(line, { isTTY: true }), 45);
  });
});
