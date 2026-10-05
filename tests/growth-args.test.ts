/**
 * Unit tests for `scripts/lib/growth-args.ts` — the shared pure parser for
 * `--allow-growth` / `--reason` CLI flags.
 *
 * Mirrors the style of `tests/size-ratchet-update-guard.test.ts`.
 *
 * Acceptance criteria from issue #2238:
 *   - --reason without --allow-growth → error.
 *   - --allow-growth without --reason (or empty reason) → error.
 *   - --reason followed by a known flag → error (missing value).
 *   - --reason "<unknown --foo text>" → accepted (legitimate reason text).
 *   - Normal happy path (both present, valid reason) → success.
 *   - Neither flag → success with allowGrowth=false, reason=''.
 */

import { describe, expect, it } from 'vitest';

import { parseGrowthArgs } from '../scripts/lib/growth-args.js';

/** The flag set both size scripts declare. */
const KNOWN_FLAGS = ['--check', '--update-baseline', '--changed-vs', '--list', '--allow-growth', '--reason'];

// ---------------------------------------------------------------------------
// Error cases
// ---------------------------------------------------------------------------

describe('parseGrowthArgs — error cases', () => {
  it('returns error when --reason is given without --allow-growth', () => {
    const result = parseGrowthArgs(['--update-baseline', '--reason', 'some reason'], KNOWN_FLAGS);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/--reason has no effect without --allow-growth/);
  });

  it('returns error when --allow-growth is given without --reason', () => {
    const result = parseGrowthArgs(['--update-baseline', '--allow-growth'], KNOWN_FLAGS);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/--allow-growth requires --reason/);
  });

  it('returns error when --allow-growth is given with empty --reason', () => {
    // Simulates someone passing an empty string — shouldn't happen from the shell
    // but the API must guard it.
    const result = parseGrowthArgs(['--update-baseline', '--allow-growth', '--reason', ''], KNOWN_FLAGS);
    // An empty string is not in KNOWN_FLAGS, so reasonIdx+1 is ''; allowGrowth is true; reason is ''.
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/--allow-growth requires --reason/);
  });

  it('returns error when --reason value is a known flag (missing value)', () => {
    // User typed: --allow-growth --reason --check
    const result = parseGrowthArgs(['--update-baseline', '--allow-growth', '--reason', '--check'], KNOWN_FLAGS);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/--reason requires a non-empty value/);
  });

  it('returns error when --reason value is --allow-growth (a known flag)', () => {
    const result = parseGrowthArgs(['--update-baseline', '--reason', '--allow-growth'], KNOWN_FLAGS);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/--reason requires a non-empty value/);
  });

  it('returns error when --reason appears at the end of argv with no value', () => {
    const result = parseGrowthArgs(['--update-baseline', '--allow-growth', '--reason'], KNOWN_FLAGS);
    expect(result).toHaveProperty('error');
    expect((result as { error: string }).error).toMatch(/--reason requires a non-empty value/);
  });
});

// ---------------------------------------------------------------------------
// Accepted: --reason text that starts with -- but is NOT a known flag
// ---------------------------------------------------------------------------

describe('parseGrowthArgs — unknown -- text accepted as reason', () => {
  it('accepts a reason that starts with -- when it is not a known flag', () => {
    const result = parseGrowthArgs(
      ['--update-baseline', '--allow-growth', '--reason', '--foo is why'],
      KNOWN_FLAGS,
    );
    expect(result).not.toHaveProperty('error');
    expect(result).toMatchObject({ allowGrowth: true, reason: '--foo is why' });
  });

  it('accepts a reason like "--intentional: merged complex path"', () => {
    const result = parseGrowthArgs(
      ['--update-baseline', '--allow-growth', '--reason', '--intentional: merged complex path'],
      KNOWN_FLAGS,
    );
    expect(result).not.toHaveProperty('error');
    expect(result).toMatchObject({ allowGrowth: true, reason: '--intentional: merged complex path' });
  });
});

// ---------------------------------------------------------------------------
// Happy path
// ---------------------------------------------------------------------------

describe('parseGrowthArgs — happy path', () => {
  it('returns allowGrowth=true and the reason on a normal invocation', () => {
    const result = parseGrowthArgs(
      ['--update-baseline', '--allow-growth', '--reason', 'intentional: new feature ship'],
      KNOWN_FLAGS,
    );
    expect(result).toMatchObject({ allowGrowth: true, reason: 'intentional: new feature ship' });
  });

  it('returns allowGrowth=false, reason="" when neither flag is present', () => {
    const result = parseGrowthArgs(['--update-baseline'], KNOWN_FLAGS);
    expect(result).toMatchObject({ allowGrowth: false, reason: '' });
  });

  it('returns allowGrowth=false, reason="" for an empty argv', () => {
    const result = parseGrowthArgs([], KNOWN_FLAGS);
    expect(result).toMatchObject({ allowGrowth: false, reason: '' });
  });

  it('returns allowGrowth=true with a multi-word reason', () => {
    const result = parseGrowthArgs(
      ['--allow-growth', '--reason', 'this is a long reason with spaces'],
      KNOWN_FLAGS,
    );
    expect(result).toMatchObject({ allowGrowth: true, reason: 'this is a long reason with spaces' });
  });
});
