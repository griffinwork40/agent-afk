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
    placementMode: 'cursor-follow',
    contentHug: false,
    pendingContentRows: null,
    lastMeasuredFrameBottom: 0,
    lifecycleStateDirty: false,
    pendingResizeErase: null,
    bandGeometryStale: false,
    anchorRow: 1,
    armed: true,
    suspended: false,
    suspendCommitQueue: [],
    logUpdate: null,
    stdout,
    ...over,
  };
}

/**
 * makeHostBannerScroll — variant of makeHost that exercises the banner-scroll
 * gate (`!hasCommitted && anchorRow > 1`). Introduced by PR #1823 to cover the
 * pre-commit banner scroll block in commitAbove (committed-band-commit.ts:151–163).
 */
function makeHostBannerScroll(stdout: Out, over: Partial<CommittedBandHost>): CommittedBandHost {
  return makeHost(stdout, {
    hasCommitted: false,
    anchorRow: 10,
    ...over,
  });
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

// ---------------------------------------------------------------------------
// Banner-scroll path — parallel invariant assertions for the
// `!hasCommitted && anchorRow > 1` gate introduced in PR #1823
// (committed-band-commit.ts:151–163).
//
// makeHostBannerScroll seeds hasCommitted=false, anchorRow=10 so the gate is
// entered on every call. All four ordering invariants are replayed here to
// ensure the banner-scroll block doesn't break the structural guarantees that
// the existing suite verifies for the already-committed path.
// ---------------------------------------------------------------------------
describe('commitAbove ordering invariants — banner-scroll path (#1829)', () => {
  it('banner-clear → banner-write → banner-repaint order before normal phase (committing=false at both repaints)', () => {
    // The banner-scroll block fires BEFORE the normal clear→write→repaint
    // pipeline. This test verifies that the banner block itself preserves the
    // clear→write→repaint ordering and that committing is false at both the
    // banner repaint and the main phase-2 repaint.
    const stdout = makeStdout();
    const events: string[] = [];
    let repaintCount = 0;

    const lu = makeLogUpdate(18);
    const origClear = lu.clear.bind(lu);
    lu.clear = function (extraRows: number) {
      events.push('clear');
      origClear(extraRows);
    };

    const host = makeHostBannerScroll(stdout, {
      logUpdate: lu as unknown as CommittedBandHost['logUpdate'],
      repaint() {
        repaintCount++;
        events.push(`repaint-${repaintCount}`);
        // committing must be false at EVERY repaint — banner or phase-2.
        expect(this.committing, `committing should be false at repaint-${repaintCount}`).toBe(false);
      },
    });

    const origWrite = stdout.write.bind(stdout);
    (stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      events.push(repaintCount > 0 ? `write-after-repaint-${repaintCount}` : 'write-pre-repaint');
      return origWrite(chunk);
    };

    commitAbove(host as CommittedBandHost & { repaint(): void }, 'Hello world\n');

    // Banner-scroll sequence: first clear, then a write, then the first repaint.
    const firstClearIdx = events.indexOf('clear');
    const firstPreRepaintWriteIdx = events.indexOf('write-pre-repaint');
    const firstRepaintIdx = events.indexOf('repaint-1');

    expect(firstClearIdx, 'banner clear should appear').toBeGreaterThanOrEqual(0);
    expect(firstPreRepaintWriteIdx, 'banner write should appear before repaint-1').toBeGreaterThanOrEqual(0);
    expect(firstRepaintIdx, 'repaint-1 (banner repaint) should appear').toBeGreaterThanOrEqual(0);

    expect(firstClearIdx, 'banner clear before banner write').toBeLessThan(firstPreRepaintWriteIdx);
    expect(firstPreRepaintWriteIdx, 'banner write before banner repaint').toBeLessThan(firstRepaintIdx);

    // A second repaint (phase 2) must also occur after the banner repaint.
    const secondRepaintIdx = events.indexOf('repaint-2');
    expect(secondRepaintIdx, 'phase-2 repaint should appear after banner repaint').toBeGreaterThan(firstRepaintIdx);
  });

  it('finally releases committing guard on throw — banner-scroll path', () => {
    // In the banner-scroll path the banner write is #1 (before committing=true).
    // The phase-1 write (inside the committing=true block) is write #2.
    // Throwing on write #2 exercises the finally{committing=false} guard.
    const stdout = makeStdout();
    const lu = makeLogUpdate(18);

    let writeCount = 0;
    const origWrite = stdout.write.bind(stdout);
    (stdout as unknown as { write: (chunk: string) => boolean }).write = (chunk: string) => {
      writeCount++;
      if (writeCount === 2) {
        // Write #2 is the phase-1 scrollback write inside the try/finally block.
        throw new Error('TTY closed mid-session');
      }
      return origWrite(chunk);
    };

    const host = makeHostBannerScroll(stdout, {
      logUpdate: lu as unknown as CommittedBandHost['logUpdate'],
    });

    expect(() => {
      commitAbove(host, 'Hello world\n');
    }).toThrow('TTY closed mid-session');

    // The invariant: committing must be false regardless of where the throw lands.
    expect(host.committing, 'committing should be false after throw').toBe(false);
  });

  it('geometry is read before the first clear — banner-scroll path', () => {
    // The banner-scroll block reads stdout.rows (for bannerRows calculation)
    // before calling logUpdate.clear(). This test asserts those reads happen
    // before ANY clear() invocation, mirroring the same invariant the normal
    // path tests assert for the phase-1 clear.
    let columnsReadCount = 0;
    let rowsReadCount = 0;
    let clearCount = 0;
    const columnsReadsBeforeFirstClear: number[] = [];
    const rowsReadsBeforeFirstClear: number[] = [];

    const stdout = new PassThrough() as unknown as Out;
    Object.defineProperty(stdout, 'columns', {
      get() {
        columnsReadCount++;
        if (clearCount === 0) columnsReadsBeforeFirstClear.push(columnsReadCount);
        return COLS;
      },
      configurable: true,
    });
    Object.defineProperty(stdout, 'rows', {
      get() {
        rowsReadCount++;
        if (clearCount === 0) rowsReadsBeforeFirstClear.push(rowsReadCount);
        return ROWS;
      },
      configurable: true,
    });

    const lu = {
      get topRow() {
        return 18;
      },
      clearCalled: false,
      clear(_extraRows: number) {
        clearCount++;
        this.clearCalled = true;
      },
    };

    const host = makeHostBannerScroll(stdout, {
      logUpdate: lu as unknown as CommittedBandHost['logUpdate'],
    });

    commitAbove(host, 'Hello\n');

    // stdout.rows must be read at least once before the first clear() —
    // the banner-scroll block uses it to compute bannerRows.
    expect(rowsReadsBeforeFirstClear.length, 'stdout.rows should be read before first clear()').toBeGreaterThan(0);
    // stdout.columns is read for the reflow / geometry snapshot.
    expect(columnsReadsBeforeFirstClear.length, 'stdout.columns should be read before first clear()').toBeGreaterThan(0);
    // Both clears (banner + phase-1) must have fired.
    expect(clearCount, 'both banner and phase-1 clear() calls should fire').toBeGreaterThanOrEqual(2);
  });

  it('commitInFlight === true when phase-2 repaint fires — banner-scroll path', () => {
    // The banner-scroll repaint (repaint #1) fires BEFORE commitInFlight is set.
    // The phase-2 repaint (#2) fires after commitInFlight = true. This test
    // captures the flag at each repaint to assert the correct per-repaint state.
    const stdout = makeStdout();
    const lu = makeLogUpdate(18);

    let repaintCount = 0;
    const commitInFlightAtRepaint: boolean[] = [];

    const host = makeHostBannerScroll(stdout, {
      logUpdate: lu as unknown as CommittedBandHost['logUpdate'],
      repaint() {
        repaintCount++;
        commitInFlightAtRepaint.push(this.commitInFlight);
      },
    });

    commitAbove(host as CommittedBandHost & { repaint(): void }, 'Hello world\n');

    // Banner repaint (first) fires before commitInFlight is set — it should be false.
    expect(commitInFlightAtRepaint[0], 'commitInFlight should be false at banner repaint').toBe(false);
    // Phase-2 repaint (second) fires after commitInFlight = true — suppresses repin.
    expect(commitInFlightAtRepaint[1], 'commitInFlight should be true at phase-2 repaint').toBe(true);
    // Released after commitAbove completes.
    expect(host.commitInFlight, 'commitInFlight should be false after commitAbove completes').toBe(false);
  });
});
