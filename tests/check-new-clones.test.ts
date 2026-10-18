/**
 * Tests for the clone-gate diff-overlap logic in scripts/check-new-clones.ts.
 *
 * These unit-test the filtering heuristic: a "new" clone whose fragments do
 * NOT overlap any line added in the PR diff is a synchronized edit to an
 * existing grandfathered pair and must be allowed through.
 */

import { describe, expect, it } from 'vitest';

// ── Inline the pure logic under test ──────────────────────────────────────────
// We replicate the two pure functions from the script to avoid needing to
// spawn git or jscpd. The script is the source of truth; this test validates
// the algorithmic contract.

interface CloneFile {
  name: string;
  start: number;
  end: number;
  startLoc: { line: number };
  endLoc: { line: number };
}

interface Clone {
  firstFile: CloneFile;
  secondFile: CloneFile;
  isNew: boolean;
}

function fragmentOverlapsAdded(
  frag: CloneFile,
  added: Map<string, Set<number>>,
): boolean {
  const lines = added.get(frag.name);
  if (!lines) return false;
  const startLine = frag.startLoc.line;
  const endLine = frag.endLoc.line;
  for (let l = startLine; l <= endLine; l++) {
    if (lines.has(l)) return true;
  }
  return false;
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

// ── Tests ─────────────────────────────────────────────────────────────────────

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
