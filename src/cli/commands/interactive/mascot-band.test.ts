/**
 * Tests for MascotBand — the reacting goblin's reserved footer band (issue #336).
 *
 * The band is a co-tenant of the DECSTBM-reserved `extraRows` region shared by
 * the loop-stage rail, the background-task bar, and the verdict ledger, so the
 * load-bearing behaviour is not the art. It is:
 *   (a) a CONSTANT reservation — claimed once at start, released once at stop,
 *       never flipping with the sprite's content, which is what stops the
 *       transcript from jumping;
 *   (b) reserving before painting and clearing before releasing;
 *   (c) right-aligning the sprite without ever writing the final column;
 *   (d) painting at the row the live row-count arithmetic implies, and erasing
 *       exactly what it painted when that arithmetic moves;
 *   (e) staying completely inert unless opted in.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MascotBand, MASCOT_BAND_ROWS } from './mascot-band.js';
import { MINI_MASCOT_WIDTH } from '../../mascot-mini.js';
import { ResizeBus } from '../../terminal-size.js';
import { LoopStageBar } from './loop-stage.js';

/** A frame of the right shape, distinguishable per call for freshness pins. */
function frameOf(tag: string): string[] {
  const row = tag.repeat(MINI_MASCOT_WIDTH).slice(0, MINI_MASCOT_WIDTH);
  return [row, row, row];
}

/**
 * Minimal TTY-ish stream that records every write.
 *
 * Contract: a CUP is classified by the write that FOLLOWS it, not by its column.
 * The painter emits `CUP(row,1)` + `\x1b[2K` to erase and `CUP(row,startCol)` +
 * the sprite to paint — and at the narrowest terminal that still fits the sprite
 * those two columns are both 1, so column alone cannot tell them apart.
 */
function fakeStream(rows = 40, columns = 100) {
  const writes: string[] = [];
  const cups = (): { row: number; col: number; erase: boolean }[] =>
    writes.flatMap((w, i) => {
      const m = /^\x1b\[(\d+);(\d+)H$/.exec(w);
      if (!m?.[1] || !m[2]) return [];
      return [{ row: Number(m[1]), col: Number(m[2]), erase: writes[i + 1] === '\x1b[2K' }];
    });
  return {
    isTTY: true,
    rows,
    columns,
    write(s: string) {
      writes.push(s);
      return true;
    },
    writes,
    /** Rows targeted for an erase (CUP followed by \x1b[2K). */
    eraseRows(): number[] {
      return cups()
        .filter((c) => c.erase)
        .map((c) => c.row);
    },
    /** Where sprite content was positioned. */
    contentCups(): { row: number; col: number }[] {
      return cups()
        .filter((c) => !c.erase)
        .map(({ row, col }) => ({ row, col }));
    },
    text(): string {
      return writes.join('');
    },
    clear() {
      writes.length = 0;
    },
  } as unknown as NodeJS.WriteStream & {
    writes: string[];
    eraseRows(): number[];
    contentCups(): { row: number; col: number }[];
    text(): string;
    clear(): void;
  };
}

function band(
  stream: ReturnType<typeof fakeStream>,
  opts: { adjacent?: () => number; lines?: () => readonly string[] } = {},
) {
  const rowCounts: number[] = [];
  const b = new MascotBand({
    getLines: opts.lines ?? (() => frameOf('X')),
    getAdjacentRows: opts.adjacent ?? (() => 0),
    stream,
  });
  b.setRowCountChangeHandler((n) => rowCounts.push(n));
  return { b, rowCounts };
}

const prevEnv = { ...process.env };

beforeEach(() => {
  process.env['AFK_GOBLIN_MASCOT'] = '1';
  delete process.env['AFK_PLAIN_OUTPUT'];
  delete process.env['AFK_BANNER_PLAIN'];
});

afterEach(() => {
  vi.useRealTimers();
  process.env = { ...prevEnv };
});

describe('MascotBand opt-in gates', () => {
  it('is inert without AFK_GOBLIN_MASCOT (no reservation, no paint)', () => {
    delete process.env['AFK_GOBLIN_MASCOT'];
    const stream = fakeStream();
    const { b, rowCounts } = band(stream);
    b.start();
    b.redraw();
    expect(stream.writes).toEqual([]);
    expect(rowCounts).toEqual([]);
    expect(b.getRowCount()).toBe(0);
    b.stop();
  });

  it('is inert under AFK_PLAIN_OUTPUT even when opted in', () => {
    process.env['AFK_PLAIN_OUTPUT'] = '1';
    const stream = fakeStream();
    const { b, rowCounts } = band(stream);
    b.start();
    expect(stream.writes).toEqual([]);
    expect(rowCounts).toEqual([]);
  });

  it('is inert under AFK_BANNER_PLAIN=1 (pixel art suppressed everywhere)', () => {
    process.env['AFK_BANNER_PLAIN'] = '1';
    const stream = fakeStream();
    const { b, rowCounts } = band(stream);
    b.start();
    expect(stream.writes).toEqual([]);
    expect(rowCounts).toEqual([]);
  });

  it('is inert on a non-TTY stream (no phantom reservation on a pipe)', () => {
    const stream = fakeStream();
    (stream as unknown as { isTTY: boolean }).isTTY = false;
    const { b, rowCounts } = band(stream);
    b.start();
    expect(stream.writes).toEqual([]);
    expect(rowCounts).toEqual([]);
  });
});

describe('MascotBand constant reservation', () => {
  it('claims the band once at start() and releases once at stop()', () => {
    const stream = fakeStream();
    const { b, rowCounts } = band(stream);
    b.start();
    expect(rowCounts).toEqual([MASCOT_BAND_ROWS]);
    expect(b.getRowCount()).toBe(MASCOT_BAND_ROWS);
    b.stop();
    expect(rowCounts).toEqual([MASCOT_BAND_ROWS, 0]);
    expect(b.getRowCount()).toBe(0);
  });

  it('never changes the reservation as the sprite animates', () => {
    // This is the whole point of the shape: the transient ancestor published a
    // new count every time a tool started or finished, and the transcript jumped
    // twice per tool call. Content churn must not reach setExtraRows.
    const stream = fakeStream();
    let tick = 0;
    const { b, rowCounts } = band(stream, { lines: () => frameOf(String(tick % 10)) });
    b.start();
    for (tick = 1; tick < 30; tick++) b.redraw();
    expect(rowCounts).toEqual([MASCOT_BAND_ROWS]);
    b.stop();
    expect(rowCounts).toEqual([MASCOT_BAND_ROWS, 0]);
  });

  it('keeps the rows reserved when the mascot goes inert mid-teardown', () => {
    // LiveMascot.stop() empties the frame and asks for a repaint BEFORE the band
    // stops. Releasing rows on an empty frame would make the release happen
    // twice, out of order with the erase.
    const stream = fakeStream();
    let lines: readonly string[] = frameOf('X');
    const { b, rowCounts } = band(stream, { lines: () => lines });
    b.start();
    stream.clear();
    lines = [];
    b.redraw();
    expect(rowCounts).toEqual([MASCOT_BAND_ROWS]); // still reserved
    expect(stream.eraseRows()).toEqual([37, 38, 39]); // rows blanked in place
    expect(stream.contentCups()).toEqual([]); // nothing painted into them
    b.stop();
  });

  it('publishes the reservation BEFORE the first paint write', () => {
    // Invariant (DECSTBM): the rows must already be outside the scroll region
    // when the sprite lands in them, or the next scroll drags the art away.
    const stream = fakeStream();
    const order: string[] = [];
    const b = new MascotBand({
      getLines: () => frameOf('X'),
      getAdjacentRows: () => 0,
      stream,
    });
    b.setRowCountChangeHandler(() => order.push('reserve'));
    const origWrite = stream.write.bind(stream);
    (stream as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      order.push('write');
      return origWrite(s);
    };
    b.start();
    expect(order[0]).toBe('reserve');
    expect(order).toContain('write');
  });

  it('clears the painted rows BEFORE releasing the reservation on stop()', () => {
    const stream = fakeStream();
    const order: string[] = [];
    const b = new MascotBand({
      getLines: () => frameOf('X'),
      getAdjacentRows: () => 0,
      stream,
    });
    b.setRowCountChangeHandler((n) => order.push(`reserve:${n}`));
    b.start();
    order.length = 0;
    stream.clear();
    const origWrite = stream.write.bind(stream);
    (stream as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      if (s === '\x1b[2K') order.push('erase');
      return origWrite(s);
    };
    b.stop();
    expect(order[0]).toBe('erase');
    expect(order[order.length - 1]).toBe('reserve:0');
  });

  it('stop() is idempotent and start() twice does not double-reserve', () => {
    const stream = fakeStream();
    const { b, rowCounts } = band(stream);
    b.start();
    b.start();
    b.stop();
    b.stop();
    expect(rowCounts).toEqual([MASCOT_BAND_ROWS, 0]);
  });
});

describe('MascotBand right alignment', () => {
  it('paints the sprite flush right, leaving the final column untouched', () => {
    // Invariant (DECAWM): writing the last cell of a row arms the pending-wrap
    // flag and the next write scrolls the reserved band. The sprite therefore
    // ends at `columns - 1`.
    for (const columns of [100, 80, 62, 14]) {
      const stream = fakeStream(40, columns);
      const { b } = band(stream);
      b.start();
      const cols = stream.contentCups().map((c) => c.col);
      expect(cols.length, `columns=${columns}`).toBe(MASCOT_BAND_ROWS);
      for (const col of cols) {
        expect(col, `columns=${columns} start`).toBe(columns - MINI_MASCOT_WIDTH);
        expect(col + MINI_MASCOT_WIDTH - 1, `columns=${columns} end`).toBe(columns - 1);
      }
      b.stop();
    }
  });

  it('re-aligns to the new width on a resize', () => {
    const stream = fakeStream(40, 100);
    const { b } = band(stream);
    b.start();
    stream.clear();
    (stream as unknown as { columns: number }).columns = 70;
    b.redraw();
    for (const c of stream.contentCups()) expect(c.col).toBe(70 - MINI_MASCOT_WIDTH);
    b.stop();
  });

  it('drops the band whole rather than truncating on a narrow row', () => {
    const stream = fakeStream(40, MINI_MASCOT_WIDTH); // no room for the margin
    const { b, rowCounts } = band(stream);
    b.start();
    expect(rowCounts).toEqual([]);
    expect(b.getRowCount()).toBe(0);
    expect(stream.contentCups()).toEqual([]);
    b.stop();
  });
});

describe('MascotBand geometry', () => {
  it('paints immediately above the rows below it (bg bar + verdict rail)', () => {
    const stream = fakeStream(40);
    let adjacent = 0;
    const { b } = band(stream, { adjacent: () => adjacent });
    b.start();
    // rows 40-3-0 .. 40-1-0 => 37,38,39 (status line owns row 40)
    expect(stream.eraseRows()).toEqual([37, 38, 39]);

    // A bg bar with 2 rows + a 1-row verdict rail pushes the band up by 3.
    adjacent = 3;
    stream.clear();
    b.redraw();
    // Erase where it WAS (37-39), then paint where it now belongs (34-36).
    expect(stream.eraseRows()).toEqual([37, 38, 39, 34, 35, 36]);
    b.stop();
  });

  it('erases the rows it actually painted when the band moves', () => {
    const stream = fakeStream(40);
    let adjacent = 0;
    const { b } = band(stream, { adjacent: () => adjacent });
    b.start();
    stream.clear();
    adjacent = 5;
    b.redraw();
    // The first three erase targets must be the STALE rows (37-39), not the new
    // ones — erasing freshly-computed geometry is how ghost rows get orphaned.
    expect(stream.eraseRows().slice(0, 3)).toEqual([37, 38, 39]);
    b.stop();
  });

  it('collapses the band entirely on a short terminal', () => {
    const stream = fakeStream(11); // 11 - 1 status - 1 rail - 8 content floor = 1
    const { b, rowCounts } = band(stream);
    b.start();
    expect(rowCounts).toEqual([]); // never claimed anything
    expect(b.getRowCount()).toBe(0);
    expect(stream.eraseRows()).toEqual([]);
    b.stop();
  });

  it('releases the band when a resize makes the terminal too short', () => {
    const stream = fakeStream(40);
    const { b, rowCounts } = band(stream);
    b.start();
    expect(rowCounts).toEqual([MASCOT_BAND_ROWS]);
    (stream as unknown as { rows: number }).rows = 10;
    b.redraw();
    expect(rowCounts).toEqual([MASCOT_BAND_ROWS, 0]);
    // ...and claims it again when the terminal grows back.
    (stream as unknown as { rows: number }).rows = 40;
    b.redraw();
    expect(rowCounts).toEqual([MASCOT_BAND_ROWS, 0, MASCOT_BAND_ROWS]);
    b.stop();
  });

  it('repaints on a ResizeBus tick and unsubscribes on stop()', () => {
    // Isolate from the real process.stdout resize listener and drive the
    // subscriber directly, mirroring loop-stage.test.ts's harness.
    let resizeCb: (() => void) | null = null;
    const unsub = vi.fn();
    const spy = vi.spyOn(ResizeBus, 'subscribe').mockImplementation((fn: () => void) => {
      resizeCb = fn;
      return unsub;
    });
    try {
      const stream = fakeStream(40);
      const { b } = band(stream);
      b.start();
      stream.clear();
      expect(resizeCb).toBeTypeOf('function');
      resizeCb!();
      expect(stream.eraseRows().length).toBeGreaterThan(0);
      b.stop();
      expect(unsub).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('never targets a row outside the terminal', () => {
    const stream = fakeStream(40);
    const { b } = band(stream, { adjacent: () => 30 });
    b.start();
    for (const row of [...stream.eraseRows(), ...stream.contentCups().map((c) => c.row)]) {
      expect(row).toBeGreaterThanOrEqual(1);
      expect(row).toBeLessThanOrEqual(40);
    }
    b.stop();
  });

  it('pulls the frame fresh on every repaint (animation reaches the screen)', () => {
    const stream = fakeStream(40);
    let tick = 0;
    const { b } = band(stream, { lines: () => frameOf(String(tick)) });
    b.start();
    stream.clear();
    tick = 7;
    b.redraw();
    expect(stream.text()).toContain('7'.repeat(MINI_MASCOT_WIDTH));
    b.stop();
  });
});

describe('MascotBand co-tenancy with the other band painters', () => {
  /**
   * The band is shared, so the load-bearing property is that no two tenants ever
   * address the same physical row. This drives a REAL LoopStageBar with the same
   * row-count arithmetic footer-subsystems.ts uses, and derives the bg-bar rows
   * from BackgroundStatusBar's own `startRow` formula
   * (`totalRows - rowCount - adjacentRows`), then asserts the bands are disjoint
   * AND contiguous — a gap would be as wrong as an overlap.
   */
  function layout(totalRows: number, bgRows: number, ledgerRows: number) {
    const spy = vi.spyOn(ResizeBus, 'subscribe').mockImplementation(() => vi.fn());
    try {
      const mascotStream = fakeStream(totalRows);
      const railStream = fakeStream(totalRows);
      let mascotRows = 0;
      // Exactly footer-subsystems.ts's sum: loopStageRows + mascot + bg + ledger.
      const extraRows = () => 1 + mascotRows + bgRows + ledgerRows;

      const b = new MascotBand({
        getLines: () => frameOf('X'),
        getAdjacentRows: () => bgRows + ledgerRows,
        stream: mascotStream,
      });
      b.setRowCountChangeHandler((n) => {
        mascotRows = n;
      });
      const rail = new LoopStageBar({ getExtraRows: extraRows, stream: railStream });
      rail.start();
      b.start();
      railStream.clear();
      rail.repaint('acting'); // the rail reflows once the band claims its rows

      const mascot = [...new Set(mascotStream.eraseRows())];
      const railRows = railStream.eraseRows();
      const bgStart = totalRows - bgRows - ledgerRows;
      const bg = Array.from({ length: bgRows }, (_, i) => bgStart + i);
      const ledger = ledgerRows > 0 ? [totalRows - 1] : [];
      return { mascot, railRows, bg, ledger, statusRow: totalRows, extraRows: extraRows() };
    } finally {
      spy.mockRestore();
    }
  }

  it('is disjoint from the rail, the bg bar, the verdict rail and the status line', () => {
    for (const [bgRows, ledgerRows] of [
      [0, 0],
      [2, 1],
      [5, 1],
    ] as const) {
      const l = layout(40, bgRows, ledgerRows);
      const all = [...l.mascot, ...l.railRows, ...l.bg, ...l.ledger, l.statusRow];
      expect(new Set(all).size, `bg=${bgRows} ledger=${ledgerRows}`).toBe(all.length);
    }
  });

  it('sits directly below the rail and directly above the bg bar', () => {
    const l = layout(40, 2, 1);
    expect(l.mascot).toHaveLength(MASCOT_BAND_ROWS);
    expect(l.railRows).toEqual([40 - l.extraRows]); // topmost reserved row
    expect(Math.min(...l.mascot)).toBe(l.railRows[0]! + 1); // no gap below the rail
    expect(Math.max(...l.mascot)).toBe(Math.min(...l.bg) - 1); // no gap above the bg bar
  });

  it('keeps the whole reserved band inside the terminal', () => {
    const l = layout(40, 5, 1);
    for (const row of [...l.mascot, ...l.railRows]) {
      expect(row).toBeGreaterThanOrEqual(1);
      expect(row).toBeLessThan(40);
    }
  });
});
