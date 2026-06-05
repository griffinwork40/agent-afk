/**
 * Tests for the line-based diff generator.
 *
 * @module utils/diff.test
 */
import { describe, expect, it } from 'vitest';
import { computeLineDiff } from './diff.js';

describe('computeLineDiff', () => {
  it('returns null for identical inputs', () => {
    expect(computeLineDiff('a\nb\nc', 'a\nb\nc')).toBeNull();
    expect(computeLineDiff('', '')).toBeNull();
  });

  it('handles a single-line edit', () => {
    const diff = computeLineDiff('hello\nworld', 'hello\nthere');
    expect(diff).not.toBeNull();
    expect(diff!.addedLines).toBe(1);
    expect(diff!.removedLines).toBe(1);
    expect(diff!.hunks).toHaveLength(1);
    const h = diff!.hunks[0]!;
    expect(h.oldStart).toBe(1);
    expect(h.newStart).toBe(1);
    // Expect: ` hello`, `-world`, `+there`
    const kinds = h.lines.map((l) => l.kind);
    expect(kinds).toEqual([' ', '-', '+']);
  });

  it('emits an all-additions hunk for new files', () => {
    const diff = computeLineDiff('', 'a\nb\nc');
    expect(diff).not.toBeNull();
    expect(diff!.addedLines).toBe(3);
    expect(diff!.removedLines).toBe(0);
    expect(diff!.hunks[0]!.lines.every((l) => l.kind === '+')).toBe(true);
  });

  it('emits an all-deletions hunk for full removals', () => {
    const diff = computeLineDiff('a\nb\nc', '');
    expect(diff).not.toBeNull();
    expect(diff!.addedLines).toBe(0);
    expect(diff!.removedLines).toBe(3);
    expect(diff!.hunks[0]!.lines.every((l) => l.kind === '-')).toBe(true);
  });

  it('splits into multiple hunks when changes are far apart', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'o'].join('\n');
    // Change line 1 and line 15 — far enough apart that no shared context
    // covers both, so we expect 2 hunks.
    const after = ['A', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l', 'm', 'n', 'O'].join('\n');
    const diff = computeLineDiff(before, after);
    expect(diff).not.toBeNull();
    expect(diff!.hunks).toHaveLength(2);
    expect(diff!.addedLines).toBe(2);
    expect(diff!.removedLines).toBe(2);
  });

  it('merges adjacent edits into a single hunk', () => {
    const before = 'a\nb\nc\nd\ne';
    const after = 'a\nB\nC\nd\ne';
    const diff = computeLineDiff(before, after);
    expect(diff).not.toBeNull();
    expect(diff!.hunks).toHaveLength(1);
  });

  it('produces correct 1-based start indices', () => {
    const before = ['x', 'y', 'z', 'old', 'a', 'b'].join('\n');
    const after = ['x', 'y', 'z', 'new', 'a', 'b'].join('\n');
    const diff = computeLineDiff(before, after);
    expect(diff!.hunks[0]!.oldStart).toBe(1); // includes leading context
    expect(diff!.hunks[0]!.newStart).toBe(1);
  });

  it('handles CRLF line endings', () => {
    const diff = computeLineDiff('a\r\nb\r\nc', 'a\r\nB\r\nc');
    expect(diff).not.toBeNull();
    expect(diff!.addedLines).toBe(1);
    expect(diff!.removedLines).toBe(1);
  });

  it('caps context to 3 lines on each side', () => {
    // 10 leading same, 1 change, 10 trailing same — expect prefix=3 + 1 change + suffix=3.
    const lines = Array.from({ length: 21 }, (_, i) => `line${i}`);
    const before = lines.join('\n');
    const modified = [...lines];
    modified[10] = 'CHANGED';
    const after = modified.join('\n');
    const diff = computeLineDiff(before, after);
    expect(diff!.hunks).toHaveLength(1);
    const h = diff!.hunks[0]!;
    // 3 context + 1 del + 1 add + 3 context = 8 lines
    expect(h.lines).toHaveLength(8);
    expect(h.lines.filter((l) => l.kind === ' ')).toHaveLength(6);
    expect(h.lines.filter((l) => l.kind === '+')).toHaveLength(1);
    expect(h.lines.filter((l) => l.kind === '-')).toHaveLength(1);
  });

  it('bails out gracefully on oversized inputs (> MAX_DIFF_CELLS)', () => {
    // ~2001 × 2001 = ~4M+ cells — should exceed the MAX_DIFF_CELLS guard.
    // The function must return a valid DiffPayload (not throw) and should
    // produce a coarse all-delete-then-all-insert result.
    const bigBefore = Array.from({ length: 2001 }, (_, i) => `old${i}`).join('\n');
    const bigAfter = Array.from({ length: 2001 }, (_, i) => `new${i}`).join('\n');

    // Must not throw and must not allocate ~100MB.
    let diff: ReturnType<typeof computeLineDiff>;
    expect(() => {
      diff = computeLineDiff(bigBefore, bigAfter);
    }).not.toThrow();

    // Result should be non-null (before !== after) and structurally valid.
    expect(diff!).not.toBeNull();
    expect(diff!.addedLines).toBeGreaterThan(0);
    expect(diff!.removedLines).toBeGreaterThan(0);
    // Hunks array must be non-empty.
    expect(diff!.hunks.length).toBeGreaterThan(0);
  });

  it('emits @@ -1,N +1,M @@ (not -0 / +0) when the first line is changed', () => {
    // Regression: buildHunks previously computed oldStart/newStart as
    // `oldIdx - prefixCount` which could yield 0 when the change touches
    // line 1 and there is no prefix context. Both sides must be ≥ 1.
    const result = computeLineDiff('old first line\nother line\n', 'new first line\nother line\n');
    expect(result).not.toBeNull();
    expect(result!.hunks[0]!.oldStart).toBe(1);
    expect(result!.hunks[0]!.newStart).toBe(1);
  });

  // ── C1: trailing same-run must be capped at CONTEXT_LINES (3) ────────────
  it('C1: trailing context is capped at 3 lines even when distance <= 2*CONTEXT_LINES', () => {
    // Build: 1 change on line 1, followed by exactly 5 same lines (within
    // 2*CONTEXT_LINES=6 range). Before C1 fix the else-branch would emit all
    // 5 same lines as "interior context" instead of capping at 3.
    // After fix: hunk should have 1 del + 1 add + 3 trailing context = 5 lines.
    const before = ['OLD', 'a', 'b', 'c', 'd', 'e'].join('\n');
    const after  = ['NEW', 'a', 'b', 'c', 'd', 'e'].join('\n');
    const diff = computeLineDiff(before, after);
    expect(diff).not.toBeNull();
    expect(diff!.hunks).toHaveLength(1);
    const h = diff!.hunks[0]!;
    const contextLines = h.lines.filter(l => l.kind === ' ');
    // Must be capped at CONTEXT_LINES (3) — NOT 5.
    expect(contextLines).toHaveLength(3);
  });

  it('C1: trailing context capped at 3 when last change has ≤ 6 trailing sames', () => {
    // Single change in the middle, 2 trailing same lines (well within 2*CONTEXT_LINES).
    // Hunk must cap trailing at min(2, 3) = 2, not leak all 2 as interior context.
    const before = ['x', 'y', 'OLD', 'p', 'q'].join('\n');
    const after  = ['x', 'y', 'NEW', 'p', 'q'].join('\n');
    const diff = computeLineDiff(before, after);
    expect(diff).not.toBeNull();
    const h = diff!.hunks[0]!;
    // prefix: 2 (x,y) but capped to CONTEXT_LINES=3, trailing: 2 (p,q)
    const trailingContext = h.lines.slice(h.lines.findLastIndex(l => l.kind !== ' ') + 1);
    // All trailing context lines must be ' ', and there must be ≤ 3 of them.
    expect(trailingContext.every(l => l.kind === ' ')).toBe(true);
    expect(trailingContext.length).toBeLessThanOrEqual(3);
  });

  // ── C2: splitLines — no spurious empty-line diff for newline-terminated files ──
  it('C2: diffing "a\\n" vs "a" produces no spurious deletions', () => {
    // Before C2 fix: splitLines('a\n') → ['a',''] vs splitLines('a') → ['a']
    // causing a spurious empty-line deletion.
    const diff = computeLineDiff('a\n', 'a');
    // Should be null (identical effective content) or at worst have no removals.
    if (diff !== null) {
      // If non-null, must not include an empty-string removal.
      const removals = diff.hunks.flatMap(h => h.lines.filter(l => l.kind === '-'));
      expect(removals.every(l => l.text !== '')).toBe(true);
    }
  });

  it('C2: intentional blank trailing lines are preserved in the diff', () => {
    // "a\n\n" has two newlines → two logical lines: ['a', ''].
    // Changing to "a\n" (one newline → ['a']) should still produce a removal.
    const diff = computeLineDiff('a\n\n', 'a\n');
    expect(diff).not.toBeNull();
    expect(diff!.removedLines).toBe(1);
  });

  it('C2: both sides newline-terminated → null diff (no spurious changes)', () => {
    expect(computeLineDiff('a\nb\n', 'a\nb\n')).toBeNull();
  });

  // ── P2: boundary cell count must trigger the bail-out (>=, not >) ────────
  it('P2: exact MAX_DIFF_CELLS boundary triggers the coarse fallback', () => {
    // MAX_DIFF_CELLS = 4_000_000. We need (m+1)*(n+1) == 4_000_000.
    // 2000 * 2000 = 4_000_000 → m=1999, n=1999. This is the exact boundary.
    const m = 1999;
    const n = 1999;
    const bigBefore = Array.from({ length: m }, (_, i) => `old${i}`).join('\n');
    const bigAfter  = Array.from({ length: n }, (_, i) => `new${i}`).join('\n');
    // Must not throw and must return the coarse all-del/all-add result.
    let diff: ReturnType<typeof computeLineDiff>;
    expect(() => { diff = computeLineDiff(bigBefore, bigAfter); }).not.toThrow();
    expect(diff!).not.toBeNull();
    // Coarse path: every old line deleted, every new line added.
    const removals = diff!.hunks.flatMap(h => h.lines.filter(l => l.kind === '-'));
    const additions = diff!.hunks.flatMap(h => h.lines.filter(l => l.kind === '+'));
    expect(removals).toHaveLength(m);
    expect(additions).toHaveLength(n);
  });
});
