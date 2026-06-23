import { describe, it, expect } from 'vitest';
import { decideCommitMode, capBandModel, type CommitModeInput } from './commit-mode.js';

/**
 * Pure-logic coverage for the commitAbove routing decision — no terminal,
 * headless or otherwise. Shared geometry mirrors the production overflow-gap
 * scenario: a 24-row terminal with a 2-row status footer and the content
 * ceiling at row 1 → overflowTargetBottom = 24-1-2 = 21, maxBandModel = 21-1 = 20.
 */
function base(overrides: Partial<CommitModeInput> = {}): CommitModeInput {
  return {
    prevTopRow: 10,
    frameTop: 10,
    anchorFloor: 1,
    anchorRow: 1,
    lineCount: 2,
    textLines: ['line-a', 'line-b'],
    rows: 24,
    extraRows: 2,
    committedBand: [],
    committedBandBottomRow: 0,
    committedBandPaintedRows: 0,
    ...overrides,
  };
}

describe('decideCommitMode', () => {
  it('derives maxBandModel/overflowTargetBottom from rows, extraRows, anchorFloor', () => {
    const m = decideCommitMode(base());
    expect(m.overflowTargetBottom).toBe(21);
    expect(m.maxBandModel).toBe(20);
  });

  it('fits path: a small block under a known (prevTopRow>1) frame', () => {
    const m = decideCommitMode(base({ prevTopRow: 10, frameTop: 10, lineCount: 2 }));
    expect(m.fitsAboveFrame).toBe(true);
    expect(m.useBandHold).toBe(false);
  });

  it('BLOCKER-1 guard: fitsAboveFrame is false when prevTopRow<=1 (frame fills the viewport)', () => {
    // Caller passes the fallback frameTop (max(1, rows-1-extraRows)=21) when prevTopRow<=1.
    const m = decideCommitMode(base({ prevTopRow: 1, frameTop: 21, lineCount: 2 }));
    expect(m.fitsAboveFrame).toBe(false);
  });

  it('H1 (review #649): a small block committed at prevTopRow<=1 is HELD, not dropped', () => {
    // Band-hold routing is deliberately NOT gated on prevTopRow>1: the block
    // fits the collapsed screen, so it must be held and painted on collapse.
    const m = decideCommitMode(base({ prevTopRow: 1, frameTop: 21, lineCount: 2 }));
    expect(m.fitsAboveFrame).toBe(false);
    expect(m.useBandHold).toBe(true);
  });

  it('band-hold: overflows the current tall-frame room but fits the collapsed screen', () => {
    // frameTop=3 → only room=2 above the frame; a 5-line block does not fit now
    // but 5 <= maxBandModel(20) fits once the overlay collapses.
    const m = decideCommitMode(
      base({ prevTopRow: 3, frameTop: 3, lineCount: 5, textLines: ['1', '2', '3', '4', '5'] }),
    );
    expect(m.fitsAboveFrame).toBe(false);
    expect(m.useBandHold).toBe(true);
    expect(m.overflowRun).toHaveLength(5);
  });

  it('legacy overflow: a block taller than the collapsed screen (no pending band) takes neither flag', () => {
    const tall = Array.from({ length: 25 }, (_, i) => `row${i}`);
    const m = decideCommitMode(base({ prevTopRow: 3, frameTop: 3, lineCount: 25, textLines: tall }));
    expect(m.fitsAboveFrame).toBe(false);
    expect(m.useBandHold).toBe(false); // → caller falls through to the legacy archive path
  });

  it('review #649 P1: overflowHasPending forces band-hold even when the merged run exceeds maxBandModel', () => {
    // A full pending band (20 rows) contiguous with a tall frame (frameTop=2,
    // room=1) plus a 2-row commit → merged run = 22 > maxBandModel = 20. The
    // override keeps useBandHold true so Phase 1 archives the genuine overflow
    // as REAL content instead of the fits path scrolling unpainted blanks.
    const band = Array.from({ length: 20 }, (_, i) => `band${i}`);
    const m = decideCommitMode(
      base({
        prevTopRow: 2,
        frameTop: 2,
        lineCount: 2,
        textLines: ['new-a', 'new-b'],
        committedBand: band,
        committedBandBottomRow: 1, // === frameTop - 1 → contiguous
      }),
    );
    expect(m.overflowPriorContiguous).toBe(true);
    expect(m.overflowHasPending).toBe(true);
    expect(m.overflowRun).toHaveLength(22);
    expect(m.overflowRun.length > m.maxBandModel).toBe(true);
    expect(m.useBandHold).toBe(true); // without the override this would be false
  });

  it('overflowHasPending uses the exact painted-row count, not the room geometry proxy (#255 two-block follow-up)', () => {
    // Deferred #255 follow-up. Under a single intervening repaint the frame top
    // can grow so `room` (frameTop - anchorFloor = 7) exceeds the band length
    // (5) WHILE pending rows remain (only 3 of 5 painted). The OLD proxy
    // `committedBand.length > room` reads 5 > 7 = FALSE → routes to the fits
    // path, which scrolls the 2 unpainted rows into scrollback as BLANKS (the
    // drop). The EXACT signal `committedBand.length > committedBandPaintedRows`
    // reads 5 > 3 = TRUE → stays on band-hold and archives REAL content.
    const band = ['b0', 'b1', 'b2', 'b3', 'b4'];
    const m = decideCommitMode(
      base({
        prevTopRow: 8,
        frameTop: 8, // room = 8 - 1 = 7
        lineCount: 2,
        textLines: ['new-a', 'new-b'],
        committedBand: band,
        committedBandBottomRow: 7, // === frameTop - 1 → contiguous
        committedBandPaintedRows: 3, // 2 of 5 rows still pending
      }),
    );
    // Prove this geometry is exactly where the proxy and the exact signal DIVERGE.
    expect(m.room).toBe(7);
    expect(band.length > m.room).toBe(false); // the old proxy → "no pending" (wrong)
    expect(m.overflowPriorContiguous).toBe(true);
    expect(m.overflowHasPending).toBe(true); // the exact signal → pending (right)
    expect(m.useBandHold).toBe(true); // would route to the fits path under the proxy
  });

  it('merges the prior band into the run only when verifiably contiguous', () => {
    const band = ['x', 'y'];
    const merged = decideCommitMode(
      base({
        prevTopRow: 3,
        frameTop: 3,
        lineCount: 2,
        textLines: ['a', 'b'],
        committedBand: band,
        committedBandBottomRow: 2, // === frameTop - 1
      }),
    );
    expect(merged.overflowPriorContiguous).toBe(true);
    expect(merged.overflowRun).toEqual(['x', 'y', 'a', 'b']);

    const split = decideCommitMode(
      base({
        prevTopRow: 3,
        frameTop: 3,
        lineCount: 2,
        textLines: ['a', 'b'],
        committedBand: band,
        committedBandBottomRow: 99, // !== frameTop - 1 → not contiguous
      }),
    );
    expect(split.overflowPriorContiguous).toBe(false);
    expect(split.overflowRun).toEqual(['a', 'b']);
  });

  it('does not merge when anchorRow>1 (a mid-commit anchor-evict could have moved the band)', () => {
    const m = decideCommitMode(
      base({
        prevTopRow: 3,
        frameTop: 3,
        lineCount: 2,
        textLines: ['a', 'b'],
        anchorRow: 2,
        committedBand: ['x', 'y'],
        committedBandBottomRow: 2,
      }),
    );
    expect(m.overflowPriorContiguous).toBe(false);
    expect(m.overflowRun).toEqual(['a', 'b']);
  });
});

describe('capBandModel', () => {
  it('keeps the newest `max` rows when the run is over cap', () => {
    expect(capBandModel(['a', 'b', 'c', 'd'], 2)).toEqual(['c', 'd']);
  });

  it('returns the run unchanged (same reference) when it already fits', () => {
    const run = ['a', 'b'];
    expect(capBandModel(run, 5)).toBe(run);
  });

  it('handles an empty run', () => {
    expect(capBandModel([], 3)).toEqual([]);
  });

  it('max=0 drops the whole run', () => {
    expect(capBandModel(['a', 'b'], 0)).toEqual([]);
  });
});
