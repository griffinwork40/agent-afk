/**
 * Unit tests for `scripts/check-test-typecheck.ts` argument parsing.
 *
 * The local `parseArgs` function previously had a parsing drift from
 * `parseGrowthArgs`: it silently accepted a known flag as a `--reason` value
 * and silently accepted a trailing bare `--reason`. Both are now rejected via
 * the shared `parseGrowthArgs` helper (issue #3267).
 *
 * The argument tests retain the historical inline `parseArgs` contract.
 * Diagnostic tests import the production detection helper directly; the
 * script's isMain() guard makes importing it safe.
 *
 * These tests are complementary to `tests/growth-args.test.ts`, which covers
 * `parseGrowthArgs` in isolation.  These tests cover the _glue_: the additional
 * `--allow-growth is only valid with --update` guard that is specific to this
 * script.
 */

import { describe, expect, it } from 'vitest';

import { computeNewBaseline, detectConfigDiagnosticLines } from '../scripts/check-test-typecheck.js';
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

// ── Option/config diagnostic guard (production implementation) ────────────────

describe('check-test-typecheck option/config guard', () => {
  it.each([
    'error TS18002: The files list in config file tsconfig.test.json is empty.',
    'error TS18003: No inputs were found in config file tsconfig.test.json.',
  ])('detects fatal input configuration: %s', (line) => {
    expect(detectConfigDiagnosticLines(line)).toEqual([line]);
  });

  it('does not reject semantic TS18xxx diagnostics', () => {
    const line = "tests/a.ts(1,1): error TS18004: No value exists in scope for the shorthand property 'a'.";
    expect(detectConfigDiagnosticLines(line)).toEqual([]);
  });
  it('detects a TS6059 rootDir line', () => {
    const line =
      "tests/foo.test.ts(1,1): error TS6059: File 'tests/foo.test.ts' is not under 'rootDir' 'src'.";
    expect(detectConfigDiagnosticLines(line)).toHaveLength(1);
  });

  it('detects multiple TS6xxx lines in multi-line output', () => {
    const output = [
      "tests/a.test.ts(1,1): error TS6059: File 'tests/a.test.ts' is not under 'rootDir' 'src'.",
      "tests/b.test.ts(1,1): error TS6059: File 'tests/b.test.ts' is not under 'rootDir' 'src'.",
      "src/c.ts(5,3): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.",
    ].join('\n');
    expect(detectConfigDiagnosticLines(output)).toHaveLength(2);
  });

  it('does not flag non-TS6xxx errors (TS2345, TS2322, etc.)', () => {
    const output = [
      "src/a.ts(1,1): error TS2345: Argument of type 'string' is not assignable.",
      "src/b.ts(2,3): error TS2322: Type 'number' is not assignable to type 'string'.",
    ].join('\n');
    expect(detectConfigDiagnosticLines(output)).toHaveLength(0);
  });

  it('does not flag warning or info lines that mention TS6xxx in prose', () => {
    // Prose mention in a comment — should not match because the pattern requires
    // the "error TS6NNN:" prefix.
    const line = '  // See TS6059 for details about rootDir';
    expect(detectConfigDiagnosticLines(line)).toHaveLength(0);
  });

  it('handles empty tsc output without throwing', () => {
    expect(detectConfigDiagnosticLines('')).toHaveLength(0);
  });
});

// ── computeNewBaseline — reason-carry contract ────────────────────────────────
//
// Exercises the pure helper extracted from runUpdate without invoking tsc.
// The four cases match the JSDoc contract on computeNewBaseline.

const prev = (errors: number, reason?: string) =>
  ({ errors, reason, fileExisted: true });

describe('computeNewBaseline — reason-carry contract', () => {
  it('stamps the new reason when allowGrowth is true and a reason is provided', () => {
    const result = computeNewBaseline(prev(5, 'old reason'), 8, true, 'intentional growth');
    expect(result).toEqual({ errors: 8, reason: 'intentional growth' });
  });

  it('does not stamp reason when allowGrowth is true but reason is empty', () => {
    const result = computeNewBaseline(prev(5), 8, true, '');
    expect(result).toEqual({ errors: 8 });
  });

  it('carries previous.reason forward when count is unchanged and growth is not allowed', () => {
    // This is the merge path: unionTypecheck wrote {errors:9, reason:"approved"},
    // then lint:tests:update runs without --allow-growth and measures the same 9.
    const result = computeNewBaseline(prev(9, 'approved'), 9, false, '');
    expect(result).toEqual({ errors: 9, reason: 'approved' });
  });

  it('drops reason when count shrinks (growth it justified is gone)', () => {
    const result = computeNewBaseline(prev(9, 'approved'), 7, false, '');
    expect(result).toEqual({ errors: 7 });
  });

  it('drops reason when count shrinks even if previous had a reason', () => {
    const result = computeNewBaseline(prev(20, 'big approved backlog'), 1, false, '');
    expect(result).toEqual({ errors: 1 });
  });

  it('does not carry reason when previous has none and count is unchanged', () => {
    const result = computeNewBaseline(prev(5), 5, false, '');
    expect(result).toEqual({ errors: 5 });
  });

  it('works when fileExisted is false (first-time write)', () => {
    const result = computeNewBaseline({ errors: 0, fileExisted: false }, 3, false, '');
    expect(result).toEqual({ errors: 3 });
  });
});
