/**
 * Tests for MascotBar — the reacting goblin's reserved footer band (issue #336).
 *
 * The band is a co-tenant of the DECSTBM-reserved `extraRows` region shared by
 * the loop-stage rail, the background-task bar, and the verdict ledger, so the
 * load-bearing behaviour is not the art: it is (a) reserving rows before
 * painting and releasing them after clearing, (b) painting at the row the live
 * row-count arithmetic implies, (c) erasing exactly what it painted when the
 * geometry moves, and (d) staying completely inert unless opted in.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MascotBar, MASCOT_BAR_ROWS } from './mascot-bar.js';
import { ResizeBus } from '../../terminal-size.js';
import { LoopStageBar } from './loop-stage.js';

/** Minimal TTY-ish stream that records every write. */
function fakeStream(rows = 40, columns = 100) {
  const writes: string[] = [];
  return {
    isTTY: true,
    rows,
    columns,
    write(s: string) {
      writes.push(s);
      return true;
    },
    writes,
    /** Every absolute cursor row targeted by a CUP sequence. */
    cupRows(): number[] {
      return writes.flatMap((w) => {
        const m = /^\x1b\[(\d+);1H$/.exec(w);
        return m?.[1] ? [Number(m[1])] : [];
      });
    },
    text(): string {
      return writes.join('');
    },
    clear() {
      writes.length = 0;
    },
  } as unknown as NodeJS.WriteStream & {
    writes: string[];
    cupRows(): number[];
    text(): string;
    clear(): void;
  };
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

describe('MascotBar opt-in gates', () => {
  it('is inert without AFK_GOBLIN_MASCOT (no reservation, no paint)', () => {
    delete process.env['AFK_GOBLIN_MASCOT'];
    const stream = fakeStream();
    const rowCounts: number[] = [];
    const bar = new MascotBar({ getAdjacentRows: () => 0, stream });
    bar.setRowCountChangeHandler((n) => rowCounts.push(n));
    bar.start();
    bar.setState('working');
    bar.redraw();
    expect(stream.writes).toEqual([]);
    expect(rowCounts).toEqual([]);
    expect(bar.getRowCount()).toBe(0);
    bar.stop();
  });

  it('is inert under AFK_PLAIN_OUTPUT even when opted in', () => {
    process.env['AFK_PLAIN_OUTPUT'] = '1';
    const stream = fakeStream();
    const bar = new MascotBar({ getAdjacentRows: () => 0, stream });
    bar.start();
    bar.setState('working');
    expect(stream.writes).toEqual([]);
  });

  it('is inert under AFK_BANNER_PLAIN=1 (pixel art suppressed everywhere)', () => {
    process.env['AFK_BANNER_PLAIN'] = '1';
    const stream = fakeStream();
    const bar = new MascotBar({ getAdjacentRows: () => 0, stream });
    bar.start();
    bar.setState('working');
    expect(stream.writes).toEqual([]);
  });

  it('is inert on a non-TTY stream (no phantom row reservation on a pipe)', () => {
    const stream = fakeStream();
    (stream as unknown as { isTTY: boolean }).isTTY = false;
    const rowCounts: number[] = [];
    const bar = new MascotBar({ getAdjacentRows: () => 0, stream });
    bar.setRowCountChangeHandler((n) => rowCounts.push(n));
    bar.start();
    bar.setState('working');
    expect(stream.writes).toEqual([]);
    expect(rowCounts).toEqual([]);
  });
});

describe('MascotBar row reservation', () => {
  it('reserves nothing while idle and claims the band only when working', () => {
    const stream = fakeStream();
    const rowCounts: number[] = [];
    const bar = new MascotBar({ getAdjacentRows: () => 0, stream });
    bar.setRowCountChangeHandler((n) => rowCounts.push(n));
    bar.start();
    expect(rowCounts).toEqual([]); // arming alone costs no rows
    expect(stream.writes).toEqual([]);

    bar.setState('working');
    expect(rowCounts).toEqual([MASCOT_BAR_ROWS]);
    expect(bar.getRowCount()).toBe(MASCOT_BAR_ROWS);

    bar.setState('idle');
    expect(rowCounts).toEqual([MASCOT_BAR_ROWS, 0]);
    expect(bar.getRowCount()).toBe(0);
  });

  it('publishes the reservation BEFORE the first paint write', () => {
    // Invariant (DECSTBM): the rows must already be outside the scroll region
    // when the sprite lands in them, or the next scroll drags the art away.
    const stream = fakeStream();
    const order: string[] = [];
    const bar = new MascotBar({ getAdjacentRows: () => 0, stream });
    bar.setRowCountChangeHandler(() => order.push('reserve'));
    bar.start();
    const origWrite = stream.write.bind(stream);
    (stream as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      order.push('write');
      return origWrite(s);
    };
    bar.setState('working');
    expect(order[0]).toBe('reserve');
    expect(order).toContain('write');
  });

  it('clears the painted rows BEFORE releasing the reservation on stop()', () => {
    const stream = fakeStream();
    const order: string[] = [];
    const bar = new MascotBar({ getAdjacentRows: () => 0, stream });
    bar.setRowCountChangeHandler((n) => order.push(`reserve:${n}`));
    bar.start();
    bar.setState('working');
    order.length = 0;
    stream.clear();
    const origWrite = stream.write.bind(stream);
    (stream as unknown as { write: (s: string) => boolean }).write = (s: string) => {
      if (s === '\x1b[2K') order.push('erase');
      return origWrite(s);
    };
    bar.stop();
    expect(order[0]).toBe('erase');
    expect(order[order.length - 1]).toBe('reserve:0');
  });

  it('stop() is idempotent and start() twice does not double-reserve', () => {
    const stream = fakeStream();
    const rowCounts: number[] = [];
    const bar = new MascotBar({ getAdjacentRows: () => 0, stream });
    bar.setRowCountChangeHandler((n) => rowCounts.push(n));
    bar.start();
    bar.start();
    bar.setState('working');
    bar.stop();
    bar.stop();
    expect(rowCounts).toEqual([MASCOT_BAR_ROWS, 0]);
  });
});

describe('MascotBar geometry', () => {
  it('paints immediately above the rows below it (bg bar + verdict rail)', () => {
    const stream = fakeStream(40);
    let adjacent = 0;
    const bar = new MascotBar({ getAdjacentRows: () => adjacent, stream });
    bar.start();
    bar.setState('working');
    // rows 40-3-0 .. 40-1-0 => 37,38,39 (status line owns row 40)
    expect(stream.cupRows()).toEqual([37, 38, 39]);

    // A bg bar with 2 rows + a 1-row verdict rail pushes the band up by 3.
    adjacent = 3;
    stream.clear();
    bar.redraw();
    // Erase where it WAS (37-39), then paint where it now belongs (34-36).
    expect(stream.cupRows()).toEqual([37, 38, 39, 34, 35, 36]);
  });

  it('erases the rows it actually painted when the band moves', () => {
    const stream = fakeStream(40);
    let adjacent = 0;
    const bar = new MascotBar({ getAdjacentRows: () => adjacent, stream });
    bar.start();
    bar.setState('working');
    stream.clear();
    adjacent = 5;
    bar.redraw();
    // The first three CUP targets must be the STALE rows (37-39), not the new
    // ones — erasing freshly-computed geometry is how ghost rows get orphaned.
    expect(stream.cupRows().slice(0, 3)).toEqual([37, 38, 39]);
  });

  it('collapses the band entirely on a short terminal', () => {
    const stream = fakeStream(11); // 11 - 1 status - 1 rail - 8 content floor = 1
    const rowCounts: number[] = [];
    const bar = new MascotBar({ getAdjacentRows: () => 0, stream });
    bar.setRowCountChangeHandler((n) => rowCounts.push(n));
    bar.start();
    bar.setState('working');
    expect(rowCounts).toEqual([]); // never claimed anything
    expect(bar.getRowCount()).toBe(0);
    expect(stream.cupRows()).toEqual([]);
  });

  it('collapses the band on a narrow terminal', () => {
    const stream = fakeStream(40, 10); // narrower than the sprite + gutter
    const bar = new MascotBar({ getAdjacentRows: () => 0, stream });
    bar.start();
    bar.setState('working');
    expect(bar.getRowCount()).toBe(0);
  });

  it('releases the band when a resize makes the terminal too short', () => {
    const stream = fakeStream(40);
    const rowCounts: number[] = [];
    const bar = new MascotBar({ getAdjacentRows: () => 0, stream });
    bar.setRowCountChangeHandler((n) => rowCounts.push(n));
    bar.start();
    bar.setState('working');
    expect(rowCounts).toEqual([MASCOT_BAR_ROWS]);
    (stream as unknown as { rows: number }).rows = 10;
    bar.redraw();
    expect(rowCounts).toEqual([MASCOT_BAR_ROWS, 0]);
    bar.stop();
  });

  it('repaints on a ResizeBus tick and unsubscribes on stop()', () => {
    // Isolate from the real process.stdout resize listener and drive the
    // subscriber directly, mirroring loop-stage.test.ts's harness.
    let resizeCb: (() => void) | null = null;
    const unsub = vi.fn();
    const spy = vi
      .spyOn(ResizeBus, 'subscribe')
      .mockImplementation((fn: () => void) => {
        resizeCb = fn;
        return unsub;
      });
    try {
      const stream = fakeStream(40);
      const bar = new MascotBar({ getAdjacentRows: () => 0, stream });
      bar.start();
      bar.setState('working');
      stream.clear();
      expect(resizeCb).toBeTypeOf('function');
      resizeCb!();
      expect(stream.cupRows().length).toBeGreaterThan(0);
      bar.stop();
      expect(unsub).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it('never targets a row outside the terminal', () => {
    const stream = fakeStream(40);
    const bar = new MascotBar({ getAdjacentRows: () => 0, stream });
    bar.start();
    bar.setState('working');
    for (const row of stream.cupRows()) {
      expect(row).toBeGreaterThanOrEqual(1);
      expect(row).toBeLessThanOrEqual(40);
    }
  });
});

describe('MascotBar co-tenancy with the other band painters', () => {
  /**
   * The band is shared, so the load-bearing property is that no two tenants
   * ever address the same physical row. This drives a REAL LoopStageBar with
   * the same row-count arithmetic footer-subsystems.ts uses, and derives the
   * bg-bar rows from BackgroundStatusBar's own `startRow` formula
   * (`totalRows - rowCount - adjacentRows`), then asserts the three bands are
   * disjoint AND contiguous — a gap would be as wrong as an overlap.
   */
  function layout(totalRows: number, bgRows: number, ledgerRows: number) {
    let resizeCb: (() => void) | null = null;
    const spy = vi
      .spyOn(ResizeBus, 'subscribe')
      .mockImplementation((fn: () => void) => {
        resizeCb = fn;
        return vi.fn();
      });
    try {
      const mascotStream = fakeStream(totalRows);
      const railStream = fakeStream(totalRows);
      let mascotRows = 0;
      // Exactly footer-subsystems.ts's sum: loopStageRows + mascot + bg + ledger.
      const extraRows = () => 1 + mascotRows + bgRows + ledgerRows;

      const bar = new MascotBar({
        getAdjacentRows: () => bgRows + ledgerRows,
        stream: mascotStream,
      });
      bar.setRowCountChangeHandler((n) => {
        mascotRows = n;
      });
      const rail = new LoopStageBar({ getExtraRows: extraRows, stream: railStream });
      rail.start();
      bar.start();
      bar.setState('working');
      railStream.clear();
      rail.repaint('acting'); // the rail reflows once the band claims its rows

      const mascot = mascotStream.cupRows();
      const railRows = railStream.cupRows();
      const bgStart = totalRows - bgRows - ledgerRows;
      const bg = Array.from({ length: bgRows }, (_, i) => bgStart + i);
      const ledger = ledgerRows > 0 ? [totalRows - 1] : [];
      void resizeCb;
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

  it('sits exactly one row below the rail and one row above the bg bar', () => {
    const l = layout(40, 2, 1);
    expect(l.mascot).toHaveLength(MASCOT_BAR_ROWS);
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

describe('MascotBar animation', () => {
  it('advances frames on a timer while working and stops when idle', () => {
    vi.useFakeTimers();
    const stream = fakeStream(40);
    const bar = new MascotBar({ getAdjacentRows: () => 0, stream, frameMs: 100 });
    bar.start();
    bar.setState('working');
    stream.clear();
    vi.advanceTimersByTime(350);
    expect(stream.cupRows().length).toBeGreaterThan(0);

    bar.setState('idle');
    stream.clear();
    vi.advanceTimersByTime(1000);
    expect(stream.writes).toEqual([]); // ticker released with the band
    bar.stop();
  });

  it('does not thrash setExtraRows on every animation frame', () => {
    vi.useFakeTimers();
    const stream = fakeStream(40);
    const rowCounts: number[] = [];
    const bar = new MascotBar({ getAdjacentRows: () => 0, stream, frameMs: 50 });
    bar.setRowCountChangeHandler((n) => rowCounts.push(n));
    bar.start();
    bar.setState('working');
    vi.advanceTimersByTime(500); // ~10 frames
    expect(rowCounts).toEqual([MASCOT_BAR_ROWS]); // published exactly once
    bar.stop();
  });
});

describe('MascotBar.onStage', () => {
  it('maps acting → working and every other stage → idle', () => {
    const stream = fakeStream(40);
    const bar = new MascotBar({ getAdjacentRows: () => 0, stream });
    bar.start();
    bar.onStage('observing');
    expect(bar.getRowCount()).toBe(0);
    bar.onStage('acting');
    expect(bar.getRowCount()).toBe(MASCOT_BAR_ROWS);
    bar.onStage('updating');
    expect(bar.getRowCount()).toBe(0);
    bar.onStage('acting');
    expect(bar.getRowCount()).toBe(MASCOT_BAR_ROWS);
    bar.onStage('choosing');
    expect(bar.getRowCount()).toBe(0);
  });

  it('flashes alert on an errored tool result, then falls back to the live stage', () => {
    vi.useFakeTimers();
    const stream = fakeStream(40);
    const bar = new MascotBar({ getAdjacentRows: () => 0, stream, frameMs: 100 });
    bar.start();
    // A tool errored while other tools are still in flight: the stage is still
    // 'acting', so the fallback after the dwell must be 'working', not 'idle'.
    bar.onStage('acting', { toolErrored: true });
    expect(bar.getRowCount()).toBe(MASCOT_BAR_ROWS);
    // A plain stage tick during the dwell must not steal the band back.
    bar.onStage('updating');
    expect(bar.getRowCount()).toBe(MASCOT_BAR_ROWS);
    vi.advanceTimersByTime(2000);
    // Dwell expired; the last stage seen was 'updating' → idle.
    expect(bar.getRowCount()).toBe(0);
    bar.stop();
  });

  it('holds the band when the errored tool leaves the agent still acting', () => {
    vi.useFakeTimers();
    const stream = fakeStream(40);
    const bar = new MascotBar({ getAdjacentRows: () => 0, stream, frameMs: 100 });
    bar.start();
    bar.onStage('acting', { toolErrored: true });
    vi.advanceTimersByTime(2000);
    expect(bar.getRowCount()).toBe(MASCOT_BAR_ROWS); // still working
    bar.stop();
  });

  it('ignores stage traffic before start() and after stop()', () => {
    const stream = fakeStream(40);
    const bar = new MascotBar({ getAdjacentRows: () => 0, stream });
    bar.onStage('acting');
    expect(stream.writes).toEqual([]);
    bar.start();
    bar.stop();
    stream.clear();
    bar.onStage('acting');
    expect(stream.writes).toEqual([]);
  });
});
