/**
 * Regression suite for #2228 — on-screen committed-band rows split on narrow
 * were never re-joined on widen. `reflowBandSplit` (band-reflow.ts) previously
 * re-wrapped each physical row independently, so narrow-width break points
 * survived a widen unchanged. The fix groups physical rows that belong to the
 * same logical line (isHead + continuation), re-wraps the `logicalText` once
 * at the new width, and emits the rejoined physical rows — exactly as the
 * scrollback flush path already did (scrollbackFlushLines in scrollback.ts).
 *
 * Pure unit tests (no @xterm/headless dependency):
 *   - 120 → 60 → 120 restores original wide wrapping
 *   - orphan continuation rows (head evicted) kept verbatim
 *   - no-meta input degrades gracefully
 *   - painted/pending boundary is preserved across the rejoin
 *   - multi-line bands (head A + continuation, head B) each re-join correctly
 */

import { describe, it, expect } from 'vitest';
import { reflowBandSplit } from './terminal-compositor.band-reflow.js';
import { buildBandMeta } from './terminal-compositor.scrollback.js';
import { hardWrapToWidth } from './wrap.js';

// 186-character logical line: wraps to 2 rows at 120, 4 rows at 60, 2 rows at 120.
const LONG = `LOGSTART_${'x'.repeat(170)}_LOGEND`;

// ─────────────────────────────────────────────────────────────────────────────
// Core #2228 case: commit at 120, narrow to 60, widen back to 120.
// ─────────────────────────────────────────────────────────────────────────────
describe('#2228 reflowBandSplit — widen re-joins split rows', () => {
  it('120 → 60 → 120: on-screen band shows original 120-col wrapping (exactly once)', () => {
    // Step 1: band committed at 120 cols.
    const band120 = hardWrapToWidth(LONG, 120).split('\n');
    const meta120 = buildBandMeta([LONG], 120);
    expect(band120.length).toBe(2);

    // Step 2: narrow to 60 — physical rows split.
    const narrow = reflowBandSplit(band120, band120.length, 60, meta120);
    expect(narrow.rows.length).toBe(hardWrapToWidth(LONG, 60).split('\n').length); // ≥ 2

    // Step 3: widen back to 120 — rows MUST rejoin to the original 120-col wrap.
    const wide = reflowBandSplit(narrow.rows, narrow.paintedRows, 120, narrow.meta);
    const expected = hardWrapToWidth(LONG, 120).split('\n');
    expect(wide.rows).toEqual(expected);
    // Exactly one head row (one logical line, re-joined).
    expect(wide.meta.filter((m) => m.isHead).length).toBe(1);
    expect(wide.meta[0]?.isHead).toBe(true);
    // logicalText intact on every sub-row.
    expect(wide.meta.every((m) => m.logicalText === LONG)).toBe(true);
    // paintedRows covers the whole band (all were painted).
    expect(wide.paintedRows).toBe(wide.rows.length);
  });

  it('single short row already fitting the width is returned unchanged', () => {
    const band = ['hello'];
    const meta = buildBandMeta(['hello'], 80);
    const res = reflowBandSplit(band, band.length, 120, meta);
    expect(res.rows).toEqual(['hello']);
    expect(res.meta).toEqual([{ logicalText: 'hello', isHead: true }]);
  });

  it('two independent logical lines both re-join correctly', () => {
    const LINE_A = `LINE_A_${'a'.repeat(115)}`;
    const LINE_B = `LINE_B_${'b'.repeat(115)}`;
    // Commit both at 120 (each wraps to 2 physical rows).
    const band120 = [
      ...hardWrapToWidth(LINE_A, 120).split('\n'),
      ...hardWrapToWidth(LINE_B, 120).split('\n'),
    ];
    const meta120 = buildBandMeta([LINE_A, LINE_B], 120);
    expect(band120.length).toBe(4); // 2 for A, 2 for B

    // Narrow to 60.
    const narrow = reflowBandSplit(band120, band120.length, 60, meta120);
    // Widen to 120.
    const wide = reflowBandSplit(narrow.rows, narrow.paintedRows, 120, narrow.meta);
    const expA = hardWrapToWidth(LINE_A, 120).split('\n');
    const expB = hardWrapToWidth(LINE_B, 120).split('\n');
    expect(wide.rows).toEqual([...expA, ...expB]);
    expect(wide.meta.filter((m) => m.isHead).length).toBe(2);
    expect(wide.meta[0]?.isHead).toBe(true);
    expect(wide.meta[expA.length]?.isHead).toBe(true);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Orphan-continuation guard: if the painted suffix starts with isHead:false
  // rows (the head was in the pending prefix or evicted off screen), those
  // orphan rows MUST be kept verbatim — re-emitting logicalText would duplicate
  // the evicted content.
  // ─────────────────────────────────────────────────────────────────────────
  it('orphan-continuation rows at slice start are re-wrapped per-physical-row, not rejoined', () => {
    // Simulate: a logical line committed at 120 spans 2 rows (head + cont).
    // The pending prefix gets the HEAD; the painted suffix gets only the CONT.
    const band120 = hardWrapToWidth(LONG, 120).split('\n');
    const meta120 = buildBandMeta([LONG], 120);
    expect(band120.length).toBe(2);
    const pendingCount = 1; // head is in pending
    const paintedCount = 1; // only the continuation is painted

    // Narrow to 60.
    const narrow = reflowBandSplit(band120, paintedCount, 60, meta120);
    // The painted suffix started with the continuation row (isHead:false) —
    // even after narrowing, the suffix must NOT re-emit the full LONG text.
    // All painted rows must NOT start with LOGSTART (they are continuations).
    const paintedRows = narrow.rows.slice(narrow.rows.length - narrow.paintedRows);
    expect(paintedRows.some((r) => r.startsWith('LOGSTART'))).toBe(false);
  });

  // ─────────────────────────────────────────────────────────────────────────
  // No-meta input: degrade to original per-row behavior.
  // ─────────────────────────────────────────────────────────────────────────
  it('omitting meta degrades to per-row re-wrap (no rejoin)', () => {
    const band60 = hardWrapToWidth(LONG, 60).split('\n');
    // No meta passed: each physical row is its own logical unit.
    const res = reflowBandSplit(band60, band60.length, 120); // no meta
    // Should re-wrap each source row at 120 (they already fit — returned as-is).
    // No consolidation: one output row per source row (or more if a source row
    // somehow exceeded 120, which it won't since they're 60-col fragments).
    expect(res.rows.length).toBe(band60.length);
    // Each row is its own logicalText.
    res.meta.forEach((m, i) => {
      expect(m.logicalText).toBe(band60[i]);
      expect(m.isHead).toBe(true);
    });
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Painted/pending boundary is preserved across the rejoin.
  // ─────────────────────────────────────────────────────────────────────────
  it('paintedRows boundary tracks the re-joined suffix correctly', () => {
    const SHORT = 'pending-short';
    // Commit SHORT + LONG at 120, only LONG rows are painted.
    const longRows120 = hardWrapToWidth(LONG, 120).split('\n');
    const band0 = [SHORT, ...longRows120];
    const meta0 = buildBandMeta([SHORT, LONG], 120);
    const painted0 = longRows120.length; // suffix = LONG's rows

    // Narrow to 60.
    const narrow = reflowBandSplit(band0, painted0, 60, meta0);
    const expectedNarrowPainted = hardWrapToWidth(LONG, 60).split('\n').length;
    expect(narrow.paintedRows).toBe(expectedNarrowPainted);

    // Widen to 120 — LONG must rejoin back to 2 rows; SHORT stays 1 pending row.
    const wide = reflowBandSplit(narrow.rows, narrow.paintedRows, 120, narrow.meta);
    expect(wide.paintedRows).toBe(longRows120.length); // 2 rows for LONG at 120
    expect(wide.rows.length - wide.paintedRows).toBe(1); // 1 pending row for SHORT
    expect(wide.rows[0]).toBe(SHORT);
    expect(wide.rows.slice(1)).toEqual(longRows120);
  });
});
