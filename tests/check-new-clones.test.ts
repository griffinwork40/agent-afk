/**
 * Tests for the clone-gate diff-overlap logic in scripts/check-new-clones.ts.
 *
 * These unit-test the filtering heuristic: a "new" clone whose fragments do
 * NOT overlap any line added in the PR diff is a synchronized edit to an
 * existing grandfathered pair and must be allowed through.
 *
 * Also tests parseDiffOutput and hasMergeBase from scripts/lib/clone-gate.ts,
 * which implement the shallow-clone fallback path (two-dot diff when
 * merge-base is absent).
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
import { parseDiffOutput, hasMergeBase, fragmentOverlapsAdded, CloneFile } from '../scripts/lib/clone-gate.js';

// vi.mock must be top-level (hoisted by vitest).
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));

// Import AFTER vi.mock so the mock is in place.
const { execFileSync } = await import('node:child_process');
const mockExec = vi.mocked(execFileSync);

// ── Filtering logic under test ────────────────────────────────────────────────
// fragmentOverlapsAdded is imported from scripts/lib/clone-gate.ts (the source
// of truth shared with the script) so this test cannot silently drift from the
// real implementation.

interface Clone {
  firstFile: CloneFile;
  secondFile: CloneFile;
  isNew: boolean;
}

function filterGenuineNewClones(
  newClones: Clone[],
  added: Map<string, Set<number>>,
): Clone[] {
  return newClones.filter(
    (c) =>
      fragmentOverlapsAdded(c.firstFile, added) ||
      fragmentOverlapsAdded(c.secondFile, added),
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeClone(
  file1: string,
  start1: number,
  end1: number,
  file2: string,
  start2: number,
  end2: number,
): Clone {
  return {
    firstFile: {
      name: file1,
      start: start1,
      end: end1,
      startLoc: { line: start1 },
      endLoc: { line: end1 },
    },
    secondFile: {
      name: file2,
      start: start2,
      end: end2,
      startLoc: { line: start2 },
      endLoc: { line: end2 },
    },
    isNew: true,
  };
}

// ── Tests: diff-overlap filter ────────────────────────────────────────────────

describe('check-new-clones diff-overlap filter', () => {
  it('allows synchronized edits to existing clone pairs (false-positive case)', () => {
    // Two files already share a clone at lines 10-30. The PR edits both halves
    // identically at line 20, but those edits are to EXISTING code — no new
    // lines are added. jscpd reports a "new" fingerprint, but neither fragment
    // overlaps added lines.
    const added = new Map<string, Set<number>>();
    // The diff adds lines only in a completely different file.
    added.set('src/unrelated.ts', new Set([5, 6, 7]));

    const clones = [makeClone('src/a.ts', 10, 30, 'src/b.ts', 10, 30)];
    const genuine = filterGenuineNewClones(clones, added);

    expect(genuine).toHaveLength(0);
  });

  it('catches a genuinely new clone overlapping added lines', () => {
    const added = new Map<string, Set<number>>();
    added.set('src/new-file.ts', new Set([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));

    const clones = [makeClone('src/new-file.ts', 1, 10, 'src/old.ts', 50, 60)];
    const genuine = filterGenuineNewClones(clones, added);

    expect(genuine).toHaveLength(1);
  });

  it('catches a clone when only the second fragment overlaps added lines', () => {
    const added = new Map<string, Set<number>>();
    added.set('src/target.ts', new Set([55, 56, 57]));

    const clones = [
      makeClone('src/source.ts', 10, 20, 'src/target.ts', 50, 60),
    ];
    const genuine = filterGenuineNewClones(clones, added);

    expect(genuine).toHaveLength(1);
  });

  it('allows a clone where neither fragment overlaps any added line', () => {
    const added = new Map<string, Set<number>>();
    // Added lines are far away from the clone ranges.
    added.set('src/a.ts', new Set([100, 101]));
    added.set('src/b.ts', new Set([200, 201]));

    const clones = [makeClone('src/a.ts', 10, 30, 'src/b.ts', 10, 30)];
    const genuine = filterGenuineNewClones(clones, added);

    expect(genuine).toHaveLength(0);
  });

  it('handles partial overlap at fragment boundary', () => {
    const added = new Map<string, Set<number>>();
    // Only the last line of the first fragment was added.
    added.set('src/a.ts', new Set([30]));

    const clones = [makeClone('src/a.ts', 20, 30, 'src/b.ts', 40, 50)];
    const genuine = filterGenuineNewClones(clones, added);

    expect(genuine).toHaveLength(1);
  });

  it('returns empty when no clones are provided', () => {
    const added = new Map<string, Set<number>>();
    added.set('src/a.ts', new Set([1, 2, 3]));

    const genuine = filterGenuineNewClones([], added);
    expect(genuine).toHaveLength(0);
  });

  it('returns empty when diff has no added lines', () => {
    const added = new Map<string, Set<number>>();

    const clones = [makeClone('src/a.ts', 10, 30, 'src/b.ts', 10, 30)];
    const genuine = filterGenuineNewClones(clones, added);

    expect(genuine).toHaveLength(0);
  });
});

// ── Tests: parseDiffOutput ────────────────────────────────────────────────────

describe('parseDiffOutput', () => {
  it('parses a standard unified diff into added line sets', () => {
    const raw = [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -10,0 +11,3 @@',
      '+line 11',
      '+line 12',
      '+line 13',
    ].join('\n');

    const map = parseDiffOutput(raw);
    expect(map.get('src/foo.ts')).toEqual(new Set([11, 12, 13]));
  });

  it('handles a single-line hunk (no comma in @@ count)', () => {
    // When count is omitted in the @@ header, it means exactly 1 line.
    const raw = [
      '--- a/src/bar.ts',
      '+++ b/src/bar.ts',
      '@@ -5 +5 @@',
      '+added',
    ].join('\n');

    const map = parseDiffOutput(raw);
    expect(map.get('src/bar.ts')).toEqual(new Set([5]));
  });

  it('accumulates added lines across multiple hunks in one file', () => {
    const raw = [
      '--- a/src/multi.ts',
      '+++ b/src/multi.ts',
      '@@ -1,0 +2,2 @@',
      '+a',
      '+b',
      '@@ -20,0 +22,1 @@',
      '+c',
    ].join('\n');

    const map = parseDiffOutput(raw);
    expect(map.get('src/multi.ts')).toEqual(new Set([2, 3, 22]));
  });

  it('handles multiple files in one diff', () => {
    const raw = [
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -0,0 +1,2 @@',
      '+x',
      '+y',
      '--- a/src/b.ts',
      '+++ b/src/b.ts',
      '@@ -0,0 +1,1 @@',
      '+z',
    ].join('\n');

    const map = parseDiffOutput(raw);
    expect(map.get('src/a.ts')).toEqual(new Set([1, 2]));
    expect(map.get('src/b.ts')).toEqual(new Set([1]));
  });

  it('returns an empty map for an empty diff', () => {
    const map = parseDiffOutput('');
    expect(map.size).toBe(0);
  });

  it('skips hunks with count=0 (deletion-only hunks)', () => {
    // +5,0 means 0 lines added starting at line 5.
    const raw = [
      '--- a/src/del.ts',
      '+++ b/src/del.ts',
      '@@ -5,3 +5,0 @@',
      '-gone1',
      '-gone2',
      '-gone3',
    ].join('\n');

    const map = parseDiffOutput(raw);
    // count=0 → loop runs 0 times → set exists but is empty (no lines added)
    const lines = map.get('src/del.ts');
    expect(lines === undefined || lines.size === 0).toBe(true);
  });
});

// ── Tests: hasMergeBase (shallow-clone fallback) ──────────────────────────────

describe('hasMergeBase', () => {
  afterEach(() => {
    mockExec.mockReset();
  });

  it('returns true when git merge-base succeeds (full clone)', () => {
    mockExec.mockReturnValue('abc123\n');
    expect(hasMergeBase('origin/main')).toBe(true);
    expect(mockExec).toHaveBeenCalledWith(
      'git',
      ['merge-base', 'origin/main', 'HEAD'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });

  it('returns false when git merge-base throws (shallow clone — no merge base)', () => {
    // Simulates: fatal: origin/main...HEAD: no merge base
    mockExec.mockImplementation(() => {
      throw new Error('fatal: origin/main...HEAD: no merge base');
    });
    expect(hasMergeBase('origin/main')).toBe(false);
  });
});
