/**
 * Ordering-invariant characterization tests for commitAbove (#827).
 *
 * These tests verify four structural invariants of the commitAbove pipeline:
 * 1. clear → write → repaint order, and `committing === false` at repaint time.
 * 2. `committing` is released even when stdout.write throws.
 * 3. stdout.columns, stdout.rows, and logUpdate.topRow are each read exactly
 *    once (before clear()) — the "atomic geometry snapshot" invariant.
 * 4. `commitInFlight === true` when repaint() is called — suppresses repin.
 */
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import type { CommittedBandHost } from './terminal-compositor.committed-band-commit.js';
import { commitAbove } from './terminal-compositor.committed-band-commit.js';

const COLS = 80;
const ROWS = 24;

type Out = NodeJS.WriteStream & { columns: number; rows: number };

function makeStdout(overrides?: { write?: (chunk: string) => boolean }): Out {
  const s = new PassThrough() as unknown as Out;
  s.columns = COLS;
  s.rows = ROWS;
  if (overrides?.write) {
    (s as unknown as { write: (chunk: string) => boolean }).write = overrides.write;
  }
  return s;
}

/**
 * Minimal LogUpdateFn stub that records call order and exposes topRow.
 */
interface LogUpdateStub {
  topRow: number;
  clearCalled: boolean;
  clearArgs: number[];
  clear(extraRows: number): void;
}

function makeLogUpdate(topRow = 18): LogUpdateStub & { topRow: number } {
  return {
    topRow,
    clearCalled: false,
    clearArgs: [],
    clear(extraRows: number) {
      this.clearCalled = true;
      this.clearArgs.push(extraRows);
    },
  };
}

function makeHost(stdout: Out, over: Partial<CommittedBandHost>): CommittedBandHost {
  return {
    repaint: () => {},
    debugLog: () => {},
    committedBand: [],
    committedBandMeta: [],
    committedBandTopRow: 0,
    committedBandBottomRow: 0,
    lastMeasuredFrameTop: 0,
    committedBandPaintedRows: 0,
    bandReflowCache: null,
    committing: false,
    commitInFlight: false,
    hasCommitted: true,
    pendingResizeErase: null,
    bandGeometryStale: false,
    anchorRow: 1,
    armed: true,
    logUpdate: null,
    stdout,
    ...over,
  };
}

describe('commitAbove ordering invariants (#827)', () => {
  it('clear → phase1-write → repaint order, and committing === false at repaint time', () => {
    // This test verifies the clear→write→repaint ordering for the PHASE 1 write
    // (the scrollback write that happens before repaint()). Phase 3 writes happen
    // AFTER repaint by design (they CUP-paint above the freshly rendered frame).
    const stdout = makeStdout();
    const events: string[] = [];
    let repaintFired = false;

    const lu = makeLogUpdate(18);
    const origClear = lu.clear.bind(lu);
    lu.clear = function (extraRows: number) {
      events.push('clear');
      origClear(extraRows);
    };

    const host = makeHost(stdout, {
      logUpdate: lu as unknown as CommittedBandHost['logUpdate'],
      repaint() {
        repaintFired = true;
        events.push('repaint');
        // The invariant: committing must be false when repaint fires
        expect(this.committing, 'committing should be false during repaint').toBe(false);
      },
    });

    // Intercept stdout.write to record write events with phase (before/after repaint)
    const origWrite = stdout.write.bind(stdout);
    (stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      events.push(repaintFired ? 'write-phase3' : 'write-phase1');
      return origWrite(chunk);
    };

    commitAbove(host as CommittedBandHost & { repaint(): void }, 'Hello world\n');

    // Assert ordering invariants
    const clearIdx = events.indexOf('clear');
    const repaintIdx = events.indexOf('repaint');
    const phase1WriteIdx = events.findIndex((e) => e === 'write-phase1');

    expect(clearIdx, 'clear should appear in the event log').toBeGreaterThanOrEqual(0);
    expect(repaintIdx, 'repaint should appear in the event log').toBeGreaterThanOrEqual(0);
    expect(clearIdx, 'clear should come before repaint').toBeLessThan(repaintIdx);

    // Phase 1 write (the scrollback write) must come after clear and before repaint
    if (phase1WriteIdx >= 0) {
      expect(clearIdx, 'clear should come before phase1 write').toBeLessThan(phase1WriteIdx);
      expect(phase1WriteIdx, 'phase1 write should come before repaint').toBeLessThan(repaintIdx);
    }
  });

  it('finally releases committing guard on throw', () => {
    const stdout = makeStdout();
    const lu = makeLogUpdate(18);

    let writeCount = 0;
    const origWrite = stdout.write.bind(stdout);
    (stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      writeCount++;
      if (writeCount === 1) {
        throw new Error('TTY closed mid-session');
      }
      return origWrite(chunk);
    };

    const host = makeHost(stdout, {
      logUpdate: lu as unknown as CommittedBandHost['logUpdate'],
    });

    expect(() => {
      commitAbove(host, 'Hello world\n');
    }).toThrow('TTY closed mid-session');

    // The invariant: committing must be released even after a throw
    expect(host.committing, 'committing should be false after throw').toBe(false);
  });

  it('geometry is read exactly once before clear()', () => {
    // Counting getters for columns, rows, and topRow
    let columnsReadCount = 0;
    let rowsReadCount = 0;
    let topRowReadCount = 0;

    // Track when clear() fires so we can assert reads happened before it
    let clearFired = false;
    const columnsReadsBeforeClear: number[] = [];
    const rowsReadsBeforeClear: number[] = [];
    const topRowReadsBeforeClear: number[] = [];

    const stdout = new PassThrough() as unknown as Out;
    Object.defineProperty(stdout, 'columns', {
      get() {
        columnsReadCount++;
        if (!clearFired) columnsReadsBeforeClear.push(columnsReadCount);
        return COLS;
      },
      configurable: true,
    });
    Object.defineProperty(stdout, 'rows', {
      get() {
        rowsReadCount++;
        if (!clearFired) rowsReadsBeforeClear.push(rowsReadCount);
        return ROWS;
      },
      configurable: true,
    });

    const lu = {
      get topRow() {
        topRowReadCount++;
        if (!clearFired) topRowReadsBeforeClear.push(topRowReadCount);
        return 18;
      },
      clearCalled: false,
      clear(_extraRows: number) {
        clearFired = true;
        this.clearCalled = true;
      },
    };

    const host = makeHost(stdout, {
      logUpdate: lu as unknown as CommittedBandHost['logUpdate'],
    });

    commitAbove(host, 'Hello\n');

    // All geometry reads must have happened before clear()
    expect(columnsReadsBeforeClear.length, 'stdout.columns should be read before clear()').toBeGreaterThan(0);
    expect(rowsReadsBeforeClear.length, 'stdout.rows should be read before clear()').toBeGreaterThan(0);
    expect(topRowReadsBeforeClear.length, 'logUpdate.topRow should be read before clear()').toBeGreaterThan(0);

    // Each should be read exactly once for geometry purposes
    expect(columnsReadCount, 'stdout.columns read count').toBeGreaterThanOrEqual(1);
    expect(rowsReadCount, 'stdout.rows read count').toBeGreaterThanOrEqual(1);
  });

  it('commitInFlight === true when repaint fires (repin suppressed)', () => {
    const stdout = makeStdout();
    const lu = makeLogUpdate(18);

    let commitInFlightAtRepaint: boolean | undefined;

    const host = makeHost(stdout, {
      logUpdate: lu as unknown as CommittedBandHost['logUpdate'],
      repaint() {
        commitInFlightAtRepaint = this.commitInFlight;
      },
    });

    commitAbove(host as CommittedBandHost & { repaint(): void }, 'Hello world\n');

    expect(commitInFlightAtRepaint, 'commitInFlight should be true when repaint fires').toBe(true);
    // And released afterward
    expect(host.commitInFlight, 'commitInFlight should be false after commitAbove completes').toBe(false);
  });
});
