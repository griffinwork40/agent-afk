/**
 * Unit tests for the tmux narrowing-reflow shift arithmetic
 * (terminal-compositor.reflow-shift.ts).
 */
import { describe, it, expect } from 'vitest';
import {
  computeReflowShift,
  historyRows,
  wholeRowsInHistory,
  type ReflowLine,
} from './terminal-compositor.reflow-shift.js';

const hard = (row: number, width: number): ReflowLine => ({ row, width, hard: true });

describe('computeReflowShift', () => {
  it('a padded echo row 229 wide at 230→115 creates exactly one extra row', () => {
    expect(computeReflowShift([hard(11, 229)], 230, 115)).toBe(1);
  });

  it('sums extra rows across multiple wide rows', () => {
    // 229 → 2 rows (+1); 200 → 2 rows (+1); 229 at 70 cols → 4 rows (+3).
    expect(computeReflowShift([hard(5, 229), hard(6, 200)], 230, 115)).toBe(2);
    expect(computeReflowShift([hard(5, 229)], 230, 70)).toBe(3);
  });

  it('short and blank rows contribute 0', () => {
    expect(computeReflowShift([hard(5, 40), hard(6, 0), hard(7, 115)], 230, 115)).toBe(0);
  });

  it('centering margin counts toward the painted width', () => {
    // 60-col margin + 80-col content = 140 painted cols → 2 rows at 115.
    expect(computeReflowShift([hard(5, 60 + 80)], 230, 115)).toBe(1);
    expect(computeReflowShift([hard(5, 80)], 230, 115)).toBe(0);
  });

  it('burst 230→160→115 is computed against the burst origin (no double count)', () => {
    const lines = [hard(11, 229)];
    expect(computeReflowShift(lines, 230, 160)).toBe(1);
    // tmux rejoins its own fragments before rewrapping: final = ceil(229/115)-1.
    expect(computeReflowShift(lines, 230, 115)).toBe(1);
    expect(computeReflowShift(lines, 230, 70)).toBe(3);
  });

  it('widening or no-op width yields 0', () => {
    expect(computeReflowShift([hard(5, 229)], 230, 230)).toBe(0);
    expect(computeReflowShift([hard(5, 100)], 115, 230)).toBe(0);
  });

  it('a non-hard (possibly soft-wrapped) non-blank line makes N unknown', () => {
    expect(computeReflowShift([hard(5, 229), { row: 6, width: 230, hard: false }], 230, 115)).toBeNull();
    // A blank non-hard line is harmless.
    expect(computeReflowShift([hard(5, 229), { row: 6, width: 0, hard: false }], 230, 115)).toBe(1);
  });

  it('a full-width frame row (w === cols) is hard: reflow shift is computed, not null (#4124)', () => {
    // tmux grid_reflow calls grid_reflow_move (no GRID_LINE_WRAPPED) for lines
    // whose width equals the terminal width, so they are hard. A 230-col
    // full-width status bar above the cursor at 230→115 creates one extra row.
    expect(computeReflowShift([{ row: 5, width: 230, hard: true }], 230, 115)).toBe(1);
    // Sanity: a non-hard full-width line (should not occur from snapshotLines
    // after the fix) still makes N unknown.
    expect(computeReflowShift([{ row: 5, width: 230, hard: false }], 230, 115)).toBeNull();
  });

  it('non-positive column counts make N unknown (null → caller falls back)', () => {
    expect(computeReflowShift([hard(5, 229)], 230, 0)).toBeNull();
    expect(computeReflowShift([hard(5, 229)], 0, 115)).toBeNull();
    expect(computeReflowShift([hard(5, 229)], -1, -1)).toBeNull();
  });

  it('clamps a line width to the old column count (DECAWM-off rows clip there)', () => {
    expect(computeReflowShift([hard(5, 500)], 230, 115)).toBe(1);
  });
});

describe('historyRows', () => {
  it('nothing reaches history when the band top stays on screen', () => {
    expect(historyRows(11, 0, 1)).toBe(0);
    expect(historyRows(2, 0, 1)).toBe(0);
  });

  it('band at row 1 with N=1 pushes one physical row into history', () => {
    expect(historyRows(1, 0, 1)).toBe(1);
    expect(historyRows(1, 0, 3)).toBe(3);
  });

  it('tmux (cursor pinned, delta 0): net shift −N reaches history from row ≤ N', () => {
    expect(historyRows(2, 0, 2)).toBe(1);
    expect(historyRows(3, 0, 2)).toBe(0);
  });

  it('clamps: never negative even for a large positive delta', () => {
    expect(historyRows(1, 10, 2)).toBe(0);
  });

  it('a positive delta partially cancels N', () => {
    // max(0, 1 - (1 + 1 - 3)) = 2; max(0, 1 - (2 + 1 - 3)) = 1.
    expect(historyRows(1, 1, 3)).toBe(2);
    expect(historyRows(2, 1, 3)).toBe(1);
  });

  it('a top-pinned terminal (delta = N) pushes nothing', () => {
    expect(historyRows(1, 3, 3)).toBe(0);
  });

  it('unknown band position (0) pushes nothing', () => {
    expect(historyRows(0, 0, 5)).toBe(0);
  });
});

describe('wholeRowsInHistory (margin-inclusive, tmux units)', () => {
  const echo99 = 'x'.repeat(99);

  it('centered 99-col echo (65 margin → 164 painted) straddles the boundary at hist 1: unknown', () => {
    expect(wholeRowsInHistory([echo99, 'AFTER'], 65, 230, 115, 1)).toBeNull();
  });

  it('both tmux fragments in history: the whole row is evictable', () => {
    expect(wholeRowsInHistory([echo99, 'AFTER'], 65, 230, 115, 2)).toBe(1);
    expect(wholeRowsInHistory([echo99, 'AFTER'], 65, 230, 115, 3)).toBe(2);
  });

  it('no history rows evicts nothing; blank and short rows are one fragment each', () => {
    expect(wholeRowsInHistory([echo99], 65, 230, 115, 0)).toBe(0);
    expect(wholeRowsInHistory(['', 'ab', echo99], 65, 230, 115, 2)).toBe(2);
  });

  it('without a margin, a 99-col row fits at 115 (one fragment)', () => {
    expect(wholeRowsInHistory([echo99, 'AFTER'], 0, 230, 115, 1)).toBe(1);
  });

  it('non-positive column counts are unknown', () => {
    expect(wholeRowsInHistory([echo99], 65, 0, 115, 1)).toBeNull();
  });
});
