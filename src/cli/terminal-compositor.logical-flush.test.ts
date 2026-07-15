/**
 * Unit tests for the #540 axis-2 logical-line scrollback-flush primitives:
 * BandRowMeta construction, prefix→scrollback line translation (whole logical
 * lines vs straddler/orphan verbatim rows), the logical-boundary snap, the
 * archive-escape builder, and reflowBandSplit's meta propagation.
 *
 * These are the pure core of the fix that makes committed content reach native
 * scrollback as SOFT-WRAPPABLE logical lines (which the terminal reflows cleanly
 * on a width change) instead of pre-hard-wrapped physical rows (which fragment).
 * The end-to-end behavior is certified over a real pty by the width-resize-*
 * scenarios in tests/pty/; these lock the piece-wise invariants and the
 * duplication/loss guards that the straddle rule depends on.
 */

import { describe, it, expect } from 'vitest';
import {
  buildBandMeta,
  scrollbackFlushLines,
  snapFlushCountToLogicalBoundary,
  buildScrollbackArchiveEscape,
  type BandRowMeta,
} from './terminal-compositor.types.js';
import { reflowBandSplit } from './terminal-compositor.band-reflow.js';
import { hardWrapToWidth } from './wrap.js';

// A logical line 186 cols wide (no interior break points) — the #540 shape:
// hard-wraps to 2 physical rows at 120, 4 at 48, reflows to 1 head + N wrapped.
const LONG = `LOGSTART_${'x'.repeat(170)}_LOGEND`;

describe('buildBandMeta', () => {
  it('records one head row per short logical line', () => {
    const meta = buildBandMeta(['alpha', 'bravo', 'charlie'], 80);
    expect(meta).toEqual([
      { logicalText: 'alpha', isHead: true },
      { logicalText: 'bravo', isHead: true },
      { logicalText: 'charlie', isHead: true },
    ]);
  });

  it('records head + continuation rows for a wide logical line, 1:1 with the physical rows', () => {
    const width = 120;
    const physicalCount = hardWrapToWidth(LONG, width).split('\n').length;
    const meta = buildBandMeta([LONG], width);
    expect(meta.length).toBe(physicalCount); // 1:1 with what committedBand holds
    expect(meta[0]).toEqual({ logicalText: LONG, isHead: true });
    for (let i = 1; i < meta.length; i++) {
      expect(meta[i]).toEqual({ logicalText: LONG, isHead: false });
    }
  });

  it('treats a blank separator line as its own single head row', () => {
    const meta = buildBandMeta(['body', ''], 80);
    expect(meta).toEqual([
      { logicalText: 'body', isHead: true },
      { logicalText: '', isHead: true },
    ]);
  });

  it('stays index-aligned with the physical rows across a mix of wide + short lines', () => {
    const width = 40;
    const logical = [LONG, 'short', LONG];
    const rows = logical.flatMap((l) => hardWrapToWidth(l, width).split('\n'));
    const meta = buildBandMeta(logical, width);
    expect(meta.length).toBe(rows.length);
    // Every head index begins a run whose logicalText matches, and the count of
    // heads equals the number of logical lines.
    expect(meta.filter((m) => m.isHead).length).toBe(logical.length);
  });
});

describe('scrollbackFlushLines', () => {
  const width = 120;
  // A band of [LONG (2 rows @120), 'tail'] → physical rows + aligned meta.
  const rows = [LONG, 'tail'].flatMap((l) => hardWrapToWidth(l, width).split('\n'));
  const meta = buildBandMeta([LONG, 'tail'], width);

  it('emits a whole logical line ONCE when all its physical rows are in the prefix', () => {
    // Flush the whole band: LONG collapses back to one logical line, tail stays 1.
    const out = scrollbackFlushLines(rows, meta, rows.length);
    expect(out).toEqual([LONG, 'tail']);
  });

  it('emits straddler rows VERBATIM when a logical line spans the flush boundary', () => {
    // Flush only 1 row — the head of LONG, whose 2nd physical row is retained.
    // Emitting the whole logical line would duplicate the retained tail once it
    // reflowed, so the in-prefix physical row is emitted verbatim instead.
    const out = scrollbackFlushLines(rows, meta, 1);
    expect(out).toEqual([rows[0]]); // the physical head row, NOT the logical LONG
    expect(out[0]).not.toBe(LONG);
  });

  it('emits an orphaned continuation row (head already sliced away) verbatim', () => {
    // Simulate a band whose FIRST row is a continuation (its head was archived
    // by an earlier flush): meta[0].isHead === false.
    const orphanRows = rows.slice(1); // [LONG-row1(cont), 'tail']
    const orphanMeta = meta.slice(1);
    expect(orphanMeta[0]?.isHead).toBe(false);
    const out = scrollbackFlushLines(orphanRows, orphanMeta, 1);
    expect(out).toEqual([orphanRows[0]]); // verbatim continuation fragment
  });

  it('falls back to verbatim physical rows when meta is missing or short (never loses content)', () => {
    expect(scrollbackFlushLines(rows, undefined, rows.length)).toEqual(rows);
    expect(scrollbackFlushLines(rows, meta.slice(0, 1), rows.length)).toEqual(rows);
  });

  it('accounts for every physical row exactly once across a mixed prefix', () => {
    // [short, LONG(2 rows), short2]; flush the first 3 rows (short + both LONG
    // rows) → whole `short` + whole LONG; short2 retained.
    const logical = ['short', LONG, 'short2'];
    const r = logical.flatMap((l) => hardWrapToWidth(l, width).split('\n'));
    const m = buildBandMeta(logical, width);
    const out = scrollbackFlushLines(r, m, 3);
    expect(out).toEqual(['short', LONG]);
  });

  it('clamps count to the row array length', () => {
    const out = scrollbackFlushLines(rows, meta, 999);
    expect(out).toEqual([LONG, 'tail']);
  });
});

describe('snapFlushCountToLogicalBoundary', () => {
  const width = 120;
  const logical = [LONG, 'a', 'b']; // rows: [L0, L1, a, b]  heads at 0,2,3
  const meta = buildBandMeta(logical, width);
  const total = meta.length; // 4

  it('snaps a mid-logical-line count DOWN to the previous head (retain the straddler whole)', () => {
    // count=1 lands inside LONG (rows 0,1); the only head at/below is index 0 → snap to 0.
    expect(snapFlushCountToLogicalBoundary(meta, 1, total)).toBe(0);
  });

  it('keeps a count that already sits on a logical boundary', () => {
    // index 2 is a head ('a') → LONG (2 rows) is whole below it.
    expect(snapFlushCountToLogicalBoundary(meta, 2, total)).toBe(2);
    expect(snapFlushCountToLogicalBoundary(meta, 3, total)).toBe(3);
  });

  it('returns the full total unchanged (whole band is always a clean boundary)', () => {
    expect(snapFlushCountToLogicalBoundary(meta, total, total)).toBe(total);
    expect(snapFlushCountToLogicalBoundary(meta, 999, total)).toBe(total);
  });

  it('returns the raw count when meta is missing/short (verbatim fallback path)', () => {
    expect(snapFlushCountToLogicalBoundary(undefined, 2, total)).toBe(2);
    expect(snapFlushCountToLogicalBoundary(meta.slice(0, 1), 2, total)).toBe(2);
  });

  it('returns 0 for a non-positive count', () => {
    expect(snapFlushCountToLogicalBoundary(meta, 0, total)).toBe(0);
    expect(snapFlushCountToLogicalBoundary(meta, -3, total)).toBe(0);
  });
});

describe('buildScrollbackArchiveEscape', () => {
  it('returns empty string for no lines', () => {
    expect(buildScrollbackArchiveEscape([], 1, 24, 80)).toBe('');
  });

  it('paints at the floor, flows lines with CRLF, and scrolls the total physical height', () => {
    const esc = buildScrollbackArchiveEscape(['a', 'b'], 1, 24, 80);
    // Two 1-row lines → paint at row 1, join with \r\n, then CUP to bottom (24)
    // and scroll 2 rows.
    expect(esc).toContain('\x1b[1;1H'); // CUP to the floor
    expect(esc).toContain('\x1b[2Ka'); // erase + line a
    expect(esc).toContain('\x1b[2Kb');
    expect(esc).toContain('\r\n'); // lines flow with CRLF so each starts fresh
    expect(esc).toContain('\x1b[24;1H'); // CUP to the physical bottom margin
    expect(esc.endsWith('\n\n')).toBe(true); // scroll 2 physical rows
  });

  it('scrolls a wide logical line by its WRAPPED physical height, not 1', () => {
    const width = 120;
    const h = hardWrapToWidth(LONG, width).split('\n').length; // 2 at 120
    const esc = buildScrollbackArchiveEscape([LONG], 1, 24, width);
    // The trailing scroll is `\n` × h.
    const scrollTail = esc.slice(esc.lastIndexOf('\x1b[24;1H') + '\x1b[24;1H'.length);
    expect(scrollTail).toBe('\n'.repeat(h));
    expect(h).toBeGreaterThan(1);
  });

  it('chunks a block taller than the paint region into multiple paint+scroll passes', () => {
    // 30 one-row lines into a 24-row terminal with floor 1 → chunkMax=24, so it
    // splits into 2 chunks (24 + 6) each with its own bottom-CUP + scroll.
    const lines = Array.from({ length: 30 }, (_, i) => `row${i}`);
    const esc = buildScrollbackArchiveEscape(lines, 1, 24, 80);
    const bottomCups = esc.split('\x1b[24;1H').length - 1;
    expect(bottomCups).toBe(2); // one scroll per chunk
  });
});

describe('reflowBandSplit — meta propagation (#540)', () => {
  it('propagates logicalText through a NARROWING re-wrap and recomputes isHead', () => {
    // One logical line committed at 120 (2 physical rows), painted (suffix).
    const width0 = 120;
    const band0 = hardWrapToWidth(LONG, width0).split('\n');
    const meta0 = buildBandMeta([LONG], width0);
    expect(band0.length).toBe(2);

    // Narrow to 68: re-wrap. Physical row count grows; logicalText is preserved
    // on every sub-row; exactly one head remains.
    const res = reflowBandSplit(band0, band0.length, 68, meta0);
    expect(res.rows.length).toBe(res.meta.length); // 1:1 invariant
    expect(res.meta.every((m) => m.logicalText === LONG)).toBe(true);
    expect(res.meta.filter((m) => m.isHead).length).toBe(1);
    expect(res.meta[0]?.isHead).toBe(true);
    // paintedRows tracks the re-wrapped suffix count (whole band was painted).
    expect(res.paintedRows).toBe(res.rows.length);
  });

  it('preserves the pending/painted split point across the re-wrap', () => {
    // Band = [pendingShort, LONG(painted)]; paintedRows counts LONG's rows only.
    const width0 = 120;
    const longRows = hardWrapToWidth(LONG, width0).split('\n');
    const band0 = ['pendingShort', ...longRows];
    const meta0 = buildBandMeta(['pendingShort', LONG], width0);
    const paintedRows0 = longRows.length; // the painted SUFFIX is LONG's rows

    const res = reflowBandSplit(band0, paintedRows0, 68, meta0);
    // pending prefix is still just the one short line (1 row at any width < it);
    // painted suffix is LONG re-wrapped at 68.
    const expectedPaintedRows = hardWrapToWidth(LONG, 68).split('\n').length;
    expect(res.paintedRows).toBe(expectedPaintedRows);
    // The pending prefix's provenance is intact.
    expect(res.meta[0]).toEqual({ logicalText: 'pendingShort', isHead: true });
  });

  it('falls back to the physical row as its own logicalText when meta is omitted', () => {
    const band0 = hardWrapToWidth(LONG, 120).split('\n');
    const res = reflowBandSplit(band0, band0.length, 68); // no meta arg
    expect(res.rows.length).toBe(res.meta.length);
    // Each pre-existing physical row is treated as its own logical line: the
    // fallback records the row text as logicalText and isHead=true per source row.
    expect(res.meta.filter((m) => m.isHead).length).toBe(band0.length);
  });

  it('returns empty for an empty band', () => {
    expect(reflowBandSplit([], 0, 80, [])).toEqual({ rows: [], paintedRows: 0, meta: [] });
  });

  it('widening keeps the retained logicalText so a later flush can rejoin the line', () => {
    // Committed narrow (48 → 4 rows), then WIDEN to 110. Re-wrapping physical
    // rows independently keeps their (stale) break points on screen, but the
    // retained logicalText is the whole line — which the scrollback flush emits.
    const band0 = hardWrapToWidth(LONG, 48).split('\n');
    const meta0 = buildBandMeta([LONG], 48);
    expect(band0.length).toBe(4);
    const res = reflowBandSplit(band0, band0.length, 110, meta0);
    // Whatever the on-screen physical rows become, the logical source is intact
    // and single, so scrollbackFlushLines(res.rows, res.meta, all) === [LONG].
    const flushed = scrollbackFlushLines(res.rows, res.meta, res.rows.length);
    expect(flushed).toEqual([LONG]);
  });
});
