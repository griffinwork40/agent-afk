/**
 * Unit tests for `scripts/lib/engines-node-floor.ts`.
 *
 * These run inside `pnpm test` (vitest) so the logic is exercised on every PR
 * and during auto-release's `pnpm lint && pnpm test` gate — not just in the
 * `Check engines.node floor` workflow step.
 */

import { describe, expect, it } from 'vitest';

import {
  compareSemver,
  nodeFloorStatus,
  parseNodeFloor,
} from '../scripts/lib/engines-node-floor.js';

// ---------------------------------------------------------------------------
// parseNodeFloor
// ---------------------------------------------------------------------------

describe('parseNodeFloor', () => {
  it('parses a standard >=X.Y.Z range', () => {
    expect(parseNodeFloor('>=22.13.0')).toEqual([22, 13, 0]);
    expect(parseNodeFloor('>=22.0.0')).toEqual([22, 0, 0]);
    expect(parseNodeFloor('>=18.17.0')).toEqual([18, 17, 0]);
  });

  it('strips surrounding whitespace before parsing', () => {
    expect(parseNodeFloor('  >=22.0.0  ')).toEqual([22, 0, 0]);
  });

  it('returns null for caret / tilde / star ranges', () => {
    expect(parseNodeFloor('^22.0.0')).toBeNull();
    expect(parseNodeFloor('~22.0.0')).toBeNull();
    expect(parseNodeFloor('*')).toBeNull();
  });

  it('returns null for upper-bound-only ranges', () => {
    expect(parseNodeFloor('<=22.0.0')).toBeNull();
    expect(parseNodeFloor('<22.0.0')).toBeNull();
  });

  it('returns null for a range with an exact lower and upper bound', () => {
    expect(parseNodeFloor('>=18.0.0 <20.0.0')).toBeNull();
  });

  it('returns null for an empty string', () => {
    expect(parseNodeFloor('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// compareSemver
// ---------------------------------------------------------------------------

describe('compareSemver', () => {
  it('returns 0 for equal triples', () => {
    expect(compareSemver([22, 0, 0], [22, 0, 0])).toBe(0);
    expect(compareSemver([22, 13, 0], [22, 13, 0])).toBe(0);
  });

  it('returns 1 when the first triple is higher (major)', () => {
    expect(compareSemver([23, 0, 0], [22, 0, 0])).toBe(1);
  });

  it('returns -1 when the first triple is lower (major)', () => {
    expect(compareSemver([22, 0, 0], [23, 0, 0])).toBe(-1);
  });

  it('compares by minor when majors are equal', () => {
    expect(compareSemver([22, 13, 0], [22, 0, 0])).toBe(1);
    expect(compareSemver([22, 0, 0], [22, 13, 0])).toBe(-1);
  });

  it('compares by patch when major and minor are equal', () => {
    expect(compareSemver([22, 13, 1], [22, 13, 0])).toBe(1);
    expect(compareSemver([22, 13, 0], [22, 13, 1])).toBe(-1);
  });
});

// ---------------------------------------------------------------------------
// nodeFloorStatus — the main decision gate
// ---------------------------------------------------------------------------

describe('nodeFloorStatus', () => {
  // Scenario from issue #2821 / PR #2566: >=22.0.0 → >=22.13.0
  it('returns raised when the floor is bumped (minor)', () => {
    expect(nodeFloorStatus('>=22.0.0', '>=22.13.0')).toBe('raised');
  });

  it('returns raised when the floor is bumped (major)', () => {
    expect(nodeFloorStatus('>=18.0.0', '>=22.0.0')).toBe('raised');
  });

  it('returns raised when the floor is bumped (patch)', () => {
    expect(nodeFloorStatus('>=22.13.0', '>=22.13.1')).toBe('raised');
  });

  it('returns same-or-lower when the floor is unchanged', () => {
    expect(nodeFloorStatus('>=22.13.0', '>=22.13.0')).toBe('same-or-lower');
  });

  it('returns same-or-lower when the floor is lowered', () => {
    expect(nodeFloorStatus('>=22.13.0', '>=22.0.0')).toBe('same-or-lower');
  });

  it('returns unparseable when the old range is not a simple >=X.Y.Z', () => {
    expect(nodeFloorStatus('^22.0.0', '>=22.13.0')).toBe('unparseable');
  });

  it('returns unparseable when the new range is not a simple >=X.Y.Z', () => {
    expect(nodeFloorStatus('>=22.0.0', '^22.13.0')).toBe('unparseable');
  });

  it('returns unparseable when both ranges are non-standard', () => {
    expect(nodeFloorStatus('*', '*')).toBe('unparseable');
  });
});
