/**
 * Unit tests for `scripts/check-test-typecheck.ts` argument parsing.
 *
 * The local `parseArgs` function previously had a parsing drift from
 * `parseGrowthArgs`: it silently accepted a known flag as a `--reason` value
 * and silently accepted a trailing bare `--reason`. Both are now rejected via
 * the shared `parseGrowthArgs` helper (issue #3267).
 *
 * Because `check-test-typecheck.ts` calls `main()` at import time (it is a
 * shebang script), we cannot import it directly.  Instead we re-implement
 * the `parseArgs` contract inline — the same pattern used by
 * `tests/check-terminal-width.test.ts` for its scan logic — and assert the
 * exact behaviour the fix must preserve.
 *
 * These tests are complementary to `tests/growth-args.test.ts`, which covers
 * `parseGrowthArgs` in isolation.  These tests cover the _glue_: the additional
 * `--allow-growth is only valid with --update` guard that is specific to this
 * script.
 */

import { describe, expect, it } from 'vitest';

import { parseGrowthArgs } from '../scripts/lib/growth-args.js';

// ── Mirror of KNOWN_FLAGS from scripts/check-test-typecheck.ts ───────────────

const KNOWN_FLAGS = ['--check', '--update', '--allow-growth', '--reason'] as const;

// ── Mirror of parseArgs from scripts/check-test-typecheck.ts ─────────────────

interface ParsedArgs {
  mode: 'check' | 'update';
  allowGrowth: boolean;
  reason: string;
}

function parseArgs(argv: string[]): ParsedArgs | { error: string } {
  const args = argv.slice(2);
  const isUpdate = args.includes('--update');

  if (args.includes('--allow-growth') && !isUpdate) {
    return { error: '--allow-growth is only valid with --update' };
  }

  const growth = parseGrowthArgs(args, KNOWN_FLAGS);
  if ('error' in growth) return growth;

  return { mode: isUpdate ? 'update' : 'check', allowGrowth: growth.allowGrowth, reason: growth.reason };
}

// ── Error cases ───────────────────────────────────────────────────────────────

describe('check-test-typecheck parseArgs — error cases', () => {
  it('rejects --reason at end of argv with no value', () => {
    const result = parseArgs(['node', 'script.ts', '--update', '--allow-growth', '--reason']);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/--reason requires a non-empty value/);
  });

  it('rejects --reason followed by a known flag (missing value)', () => {
    // User typed: --update --allow-growth --reason --check
    const result = parseArgs(['node', 'script.ts', '--update', '--allow-growth', '--reason', '--check']);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/--reason requires a non-empty value/);
  });

  it('rejects --reason followed by --update (another known flag)', () => {
    // User typed: --allow-growth --reason --update
    const result = parseArgs(['node', 'script.ts', '--allow-growth', '--reason', '--update']);
    expect(result).toHaveProperty('error');
    // parseGrowthArgs fires first: --reason value is a known flag
    expect((result as { error: string }).error).toMatch(/--reason requires a non-empty value/);
  });

  it('rejects --allow-growth without --update', () => {
    const result = parseArgs(['node', 'script.ts', '--allow-growth', '--reason', 'some reason']);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/--allow-growth is only valid with --update/);
  });

  it('rejects --allow-growth without --reason', () => {
    const result = parseArgs(['node', 'script.ts', '--update', '--allow-growth']);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/--allow-growth requires --reason/);
  });

  it('rejects --reason without --allow-growth', () => {
    const result = parseArgs(['node', 'script.ts', '--update', '--reason', 'some reason']);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/--reason has no effect without --allow-growth/);
  });
});

// ── Happy path ────────────────────────────────────────────────────────────────

describe('check-test-typecheck parseArgs — happy path', () => {
  it('returns check mode with no growth flags', () => {
    const result = parseArgs(['node', 'script.ts']);
    expect(result).toMatchObject({ mode: 'check', allowGrowth: false, reason: '' });
  });

  it('returns check mode with --check', () => {
    const result = parseArgs(['node', 'script.ts', '--check']);
    expect(result).toMatchObject({ mode: 'check', allowGrowth: false, reason: '' });
  });

  it('returns update mode with --update and no growth flags', () => {
    const result = parseArgs(['node', 'script.ts', '--update']);
    expect(result).toMatchObject({ mode: 'update', allowGrowth: false, reason: '' });
  });

  it('returns update mode with --allow-growth and valid --reason', () => {
    const result = parseArgs(['node', 'script.ts', '--update', '--allow-growth', '--reason', 'intentional growth']);
    expect(result).toMatchObject({ mode: 'update', allowGrowth: true, reason: 'intentional growth' });
  });
});

// ── TS6xxx option/config diagnostic guard ─────────────────────────────────────
//
// Mirror of the ERROR_TS6_RE constant and ts6Lines detection logic from
// scripts/check-test-typecheck.ts.  We test the regex and detection inline
// because the script cannot be imported (shebang + main() at module scope).

const ERROR_TS6_RE = /^.*error TS6\d+:/m;

function detectTs6Lines(output: string): string[] {
  return output.split('\n').filter((l) => ERROR_TS6_RE.test(l));
}

describe('check-test-typecheck TS6xxx guard', () => {
  it('detects a TS6059 rootDir line', () => {
    const line =
      "tests/foo.test.ts(1,1): error TS6059: File 'tests/foo.test.ts' is not under 'rootDir' 'src'.";
    expect(detectTs6Lines(line)).toHaveLength(1);
  });

  it('detects multiple TS6xxx lines in multi-line output', () => {
    const output = [
      "tests/a.test.ts(1,1): error TS6059: File 'tests/a.test.ts' is not under 'rootDir' 'src'.",
      "tests/b.test.ts(1,1): error TS6059: File 'tests/b.test.ts' is not under 'rootDir' 'src'.",
      "src/c.ts(5,3): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
    ].join('\n');
    expect(detectTs6Lines(output)).toHaveLength(2);
  });

  it('does not flag non-TS6xxx errors (TS2345, TS2322, etc.)', () => {
    const output = [
      "src/a.ts(1,1): error TS2345: Argument of type 'string' is not assignable.",
      "src/b.ts(2,3): error TS2322: Type 'number' is not assignable to type 'string'.",
    ].join('\n');
    expect(detectTs6Lines(output)).toHaveLength(0);
  });

  it('does not flag warning or info lines that mention TS6xxx in prose', () => {
    // Prose mention in a comment — should not match because the pattern requires
    // the "error TS6NNN:" prefix.
    const line = '  // See TS6059 for details about rootDir';
    expect(detectTs6Lines(line)).toHaveLength(0);
  });

  it('handles empty tsc output without throwing', () => {
    expect(detectTs6Lines('')).toHaveLength(0);
  });
});
