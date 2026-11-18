/**
 * Drift guard: fast-uri override range in pnpm-workspace.yaml (#5057).
 *
 * The CI audit gate runs --audit-level=critical, so the 11 moderate/low
 * fast-uri CVEs (fixed in 3.1.4–3.1.9) would not be caught automatically.
 * This test asserts the floor is >=3.1.9 and the range is capped below 4
 * (staying inside ajv's ^3.0.1 range) as an override-drift guard.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const workspaceYaml = path.join(repoRoot, 'pnpm-workspace.yaml');

/** Minimum patched version: all 11 CVEs have a confirmed 3.x backport in 3.1.9. */
const FAST_URI_FLOOR = [3, 1, 9] as const;
/** Upper-bound cap: must stay below 4 to remain inside ajv's declared `^3.0.1` range. */
const FAST_URI_CAP_MAJOR = 4;

/** Parse a semver triple from a string like "3.1.9" → [3, 1, 9]. */
function parseSemver(s: string): [number, number, number] | null {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(s.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/** Returns -1 / 0 / 1 for a < b, a === b, a > b. */
function cmpSemver(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) < (b[i] ?? 0)) return -1;
    if ((a[i] ?? 0) > (b[i] ?? 0)) return 1;
  }
  return 0;
}

/**
 * Extract the fast-uri override range string from pnpm-workspace.yaml without
 * pulling in a YAML parser dependency.  Looks for a line like:
 *   fast-uri: ">=3.1.9 <4"
 * or the unquoted equivalent.
 */
function parseFastUriRange(yamlText: string): string | null {
  // Match `fast-uri:` followed by an optional quoted or unquoted range value.
  const m = /^\s*fast-uri:\s*["']?([^"'\n]+?)["']?\s*$/m.exec(yamlText);
  return m?.[1]?.trim() ?? null;
}

describe('fast-uri override range drift guard', () => {
  it('pnpm-workspace.yaml exists and is readable', () => {
    expect(() => fs.readFileSync(workspaceYaml, 'utf8')).not.toThrow();
  });

  it('pnpm-workspace.yaml contains a fast-uri override entry', () => {
    const yaml = fs.readFileSync(workspaceYaml, 'utf8');
    const range = parseFastUriRange(yaml);
    expect(range, 'No fast-uri entry found under overrides: in pnpm-workspace.yaml').not.toBeNull();
  });

  it('fast-uri override floor is >= 3.1.9 (all 11 CVEs patched)', () => {
    const yaml = fs.readFileSync(workspaceYaml, 'utf8');
    const range = parseFastUriRange(yaml)!;

    // Expect a range like ">=3.1.9 <4" — extract the >= lower-bound.
    const floorMatch = />=\s*(\d+\.\d+\.\d+)/.exec(range);
    expect(
      floorMatch,
      `fast-uri override "${range}" does not contain a >=X.Y.Z floor — ` +
        'expected format: ">=3.1.9 <4"',
    ).not.toBeNull();

    const floor = parseSemver(floorMatch![1]!);
    expect(
      floor,
      `Could not parse semver from fast-uri floor "${floorMatch![1]}"`,
    ).not.toBeNull();

    expect(
      cmpSemver(floor!, [...FAST_URI_FLOOR]),
      `fast-uri floor ${floorMatch![1]} is below the required minimum 3.1.9. ` +
        'All 11 CVEs (GHSA-v2hh-gcrm-f6hx … GHSA-333x-w4r6-6crp) are only ' +
        'fully patched from 3.1.9. Raise the floor in pnpm-workspace.yaml.',
    ).toBeGreaterThanOrEqual(0);
  });

  it('fast-uri override is capped below major version 4 (stays inside ajv ^3 range)', () => {
    const yaml = fs.readFileSync(workspaceYaml, 'utf8');
    const range = parseFastUriRange(yaml)!;

    // Expect an upper-bound like "<4" or "<4.0.0".
    const capMatch = /<\s*(\d+)(?:\.\d+)*/.exec(range);
    expect(
      capMatch,
      `fast-uri override "${range}" does not contain an upper-bound cap (e.g. "<4"). ` +
        'Without the cap, pnpm may resolve to fast-uri >=4 which is outside ' +
        "ajv's declared ^3.0.1 range.",
    ).not.toBeNull();

    const capMajor = Number(capMatch![1]);
    expect(
      capMajor,
      `fast-uri cap major is ${capMajor} but must be <= ${FAST_URI_CAP_MAJOR}. ` +
        "Raising it beyond 4 risks breaking ajv's ^3 compatibility constraint.",
    ).toBeLessThanOrEqual(FAST_URI_CAP_MAJOR);
  });

  it('parseFastUriRange handles quoted and unquoted values', () => {
    expect(parseFastUriRange('fast-uri: ">=3.1.9 <4"\n')).toBe('>=3.1.9 <4');
    expect(parseFastUriRange("fast-uri: '>=3.1.9 <4'\n")).toBe('>=3.1.9 <4');
    expect(parseFastUriRange('fast-uri: >=3.1.9 <4\n')).toBe('>=3.1.9 <4');
    expect(parseFastUriRange('other-pkg: ">=1.0.0"\n')).toBeNull();
  });

  it('parseSemver handles well-formed and malformed inputs', () => {
    expect(parseSemver('3.1.9')).toEqual([3, 1, 9]);
    expect(parseSemver('0.0.1')).toEqual([0, 0, 1]);
    expect(parseSemver('3.1')).toBeNull();
    expect(parseSemver('')).toBeNull();
    expect(parseSemver('abc')).toBeNull();
  });
});
