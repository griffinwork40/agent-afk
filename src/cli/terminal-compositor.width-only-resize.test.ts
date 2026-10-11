/**
 * Tests for the width-only SIGWINCH ghost-spinner fix (#3205).
 *
 * When a tmux pane is split side-by-side (width narrows, row count unchanged),
 * the old code dropped `pendingResizeErase` and issued no CPR.  This left a
 * ghost copy of the spinner row on screen that persisted through later resizes.
 *
 * Fix (terminal-compositor.lifecycle.resize.ts): the net-zero-rows branch now
 *   1. snapshots `pendingResizeErase` (same shape as EXPAND) so ghost rows are
 *      erased on the next repaint(), and
 *   2. emits a CPR request (rowDelta=0) so the repaint is deferred until after
 *      the erase snapshot is consumed, preventing a race between the debounced
 *      SIGWINCH repaint and the erase.
 *
 * Covers:
 *   W1 — CPR_REQUEST emitted on width-only SIGWINCH when a frame has been rendered.
 *   W2 — pendingResizeErase is populated for a width-only SIGWINCH.
 *   W3 — CPR_REQUEST NOT emitted when no frame has been rendered yet (frameBottom=0).
 *   W4 — pendingResizeErase is null after width-only SIGWINCH with no active frame.
 *   W5 — repaint fires (with erase) after CPR reply arrives for width-only resize.
 *   W6 — repaint fires after CPR timeout on width-only resize (fallback contract).
 *   W7 — regression: ghost-erase CUP written to terminal after width-only resize.
 *
 * Note: tmux repro was not verified (no tmux in CI); unit tests cover all
 * observable code paths.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  requestCprAndApplyDelta,
  CPR_REQUEST,
  CPR_TIMEOUT_MS,
  __resetCprRttForTests,
  type CprHost,
} from './terminal-compositor.lifecycle.cpr.js';
import { TerminalCompositor } from './terminal-compositor.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCprHost(opts: {
  frameTop?: number;
  frameBottom?: number;
  bandTop?: number;
  bandBottom?: number;
  eraseTop?: number;
  eraseBottom?: number;
  logUpdateTopRow?: number;
  anchorRow?: number;
} = {}): CprHost & { repaintCalls: number } {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { isTTY: boolean };
  stdin.isTTY = true;
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
  let repaintCalls = 0;
  return {
    stdout,
    stdin,
    armed: true,
    cprPending: false,
    cprBurst: null,
    lastMeasuredFrameTop: opts.frameTop ?? 0,
    lastMeasuredFrameBottom: opts.frameBottom ?? 0,
    committedBandTopRow: opts.bandTop ?? 0,
    committedBandBottomRow: opts.bandBottom ?? 0,
    pendingResizeErase: opts.eraseTop != null
      ? { top: opts.eraseTop, bottom: opts.eraseBottom ?? opts.eraseTop }
      : null,
    logUpdate: opts.logUpdateTopRow != null ? { topRow: opts.logUpdateTopRow } : null,
    anchorRow: opts.anchorRow,
    repaint() { repaintCalls++; },
    get repaintCalls() { return repaintCalls; },
  } as unknown as CprHost & { repaintCalls: number };
}

// ---------------------------------------------------------------------------
// W1: CPR_REQUEST emitted on width-only SIGWINCH
// ---------------------------------------------------------------------------

describe('W1: CPR_REQUEST emitted on width-only SIGWINCH (rows unchanged)', () => {
  beforeEach(() => { __resetStdinClaimForTests(); __resetCprRttForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('emits CPR_REQUEST when width shrinks but rows stay the same', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    const writes = collectWrites(stdout);
    stdout.rows = 40;
    stdout.columns = 99;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();
    // Allow the initial frame to render (establishes lastMeasuredFrameBottom > 0).
    vi.advanceTimersByTime(20);
    writes.clear();

    // Width-only shrink: rows stay at 40, columns narrow 99→49.
    stdout.columns = 49;
    process.stdout.emit('resize');

    const afterResize = writes.all();
    expect(afterResize, 'CPR_REQUEST must be emitted on width-only SIGWINCH').toContain(CPR_REQUEST);

    // Clean up CPR listener.
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 20);
    c.disarm();
  });
});

// ---------------------------------------------------------------------------
// W2: pendingResizeErase populated for width-only SIGWINCH
// ---------------------------------------------------------------------------

describe('W2: pendingResizeErase populated on width-only SIGWINCH', () => {
  beforeEach(() => { __resetStdinClaimForTests(); __resetCprRttForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('sets pendingResizeErase after a width-only SIGWINCH when a frame is active', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    stdout.rows = 40;
    stdout.columns = 99;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();
    vi.advanceTimersByTime(20);

    const internals = c as unknown as {
      pendingResizeErase: { top: number; bottom: number } | null;
      lastMeasuredFrameBottom: number;
    };
    // Confirm a frame has been measured before the resize.
    expect(internals.lastMeasuredFrameBottom).toBeGreaterThan(0);

    // Width-only shrink.
    stdout.columns = 49;
    process.stdout.emit('resize');

    expect(internals.pendingResizeErase, 'pendingResizeErase must be set for ghost-row erase').not.toBeNull();
    expect(internals.pendingResizeErase?.top).toBeGreaterThanOrEqual(1);
    expect(internals.pendingResizeErase?.bottom).toBeGreaterThanOrEqual(1);

    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 20);
    c.disarm();
  });
});

// ---------------------------------------------------------------------------
// W3: CPR_REQUEST NOT emitted when no frame rendered yet
// ---------------------------------------------------------------------------

describe('W3: CPR_REQUEST not emitted on width-only SIGWINCH with no measured frame', () => {
  beforeEach(() => { __resetStdinClaimForTests(); __resetCprRttForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('does NOT emit CPR_REQUEST when lastMeasuredFrameBottom is 0', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    const writes = collectWrites(stdout);
    stdout.rows = 40;
    stdout.columns = 99;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();

    // Force lastMeasuredFrameBottom to 0 to simulate no frame rendered.
    const internals = c as unknown as { lastMeasuredFrameBottom: number };
    internals.lastMeasuredFrameBottom = 0;
    writes.clear();

    // Width-only shrink.
    stdout.columns = 49;
    process.stdout.emit('resize');

    expect(writes.all()).not.toContain(CPR_REQUEST);

    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 20);
    c.disarm();
  });
});

// ---------------------------------------------------------------------------
// W4: pendingResizeErase null when no active frame footprint
// ---------------------------------------------------------------------------

describe('W4: pendingResizeErase null on width-only SIGWINCH with no active footprint', () => {
  beforeEach(() => { __resetStdinClaimForTests(); __resetCprRttForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('pendingResizeErase remains null when no frame has been measured', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    stdout.rows = 40;
    stdout.columns = 99;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();

    const internals = c as unknown as {
      lastMeasuredFrameBottom: number;
      pendingResizeErase: { top: number; bottom: number } | null;
      logUpdate: { topRow?: number } | null;
      committedBand: string[];
    };
    // Zero out all frame-position state so top===0 after the computation.
    internals.lastMeasuredFrameBottom = 0;
    // Null out logUpdate so frameTop=0 falls through in the tops filter.
    internals.logUpdate = null;
    // Clear committed band so bandTop=0.
    internals.committedBand.length = 0;

    // Width-only shrink.
    stdout.columns = 49;
    process.stdout.emit('resize');

    // With no frame top to anchor to, pendingResizeErase stays null.
    expect(internals.pendingResizeErase).toBeNull();

    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 20);
    c.disarm();
  });
});

// ---------------------------------------------------------------------------
// W5: repaint fires after CPR reply on width-only resize (via CprHost directly)
// ---------------------------------------------------------------------------

describe('W5: repaint fires after CPR reply on width-only resize', () => {
  beforeEach(() => { __resetCprRttForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('repaint fires and delta is 0 (no cursor shift for width-only) when CPR replies same row', async () => {
    const host = makeCprHost({ frameTop: 30, frameBottom: 39 });

    // rowDelta=0 — width-only change.
    requestCprAndApplyDelta(host, /* expectedRow= */ 39, /* newRows= */ 40, /* rowDelta= */ 0);
    expect(host.cprPending).toBe(true);

    // CPR reply: cursor still at row 39 (unchanged — width-only, no shift).
    host.stdin.emit('data', Buffer.from('\x1b[39;1R'));
    await Promise.resolve();

    expect(host.cprPending).toBe(false);
    expect(host.repaintCalls).toBe(1);
    // Rows unchanged (delta=0 → no applyScrollDelta).
    expect(host.lastMeasuredFrameTop).toBe(30);
    expect(host.lastMeasuredFrameBottom).toBe(39);
  });
});

// ---------------------------------------------------------------------------
// W6: repaint fires after CPR timeout on width-only resize
// ---------------------------------------------------------------------------

describe('W6: repaint fires after CPR timeout on width-only resize', () => {
  beforeEach(() => { __resetCprRttForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('repaint fires on timeout; rows unchanged (fallback contract)', async () => {
    const host = makeCprHost({ frameTop: 30, frameBottom: 39 });
    requestCprAndApplyDelta(host, /* expectedRow= */ 39, /* newRows= */ 40, /* rowDelta= */ 0);
    expect(host.cprPending).toBe(true);

    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 20);

    expect(host.cprPending).toBe(false);
    expect(host.repaintCalls).toBe(1);
    // No delta applied on timeout.
    expect(host.lastMeasuredFrameTop).toBe(30);
    expect(host.lastMeasuredFrameBottom).toBe(39);
  });
});

// ---------------------------------------------------------------------------
// W7: regression — ghost-erase CUP written after width-only resize
// ---------------------------------------------------------------------------

describe('W7: regression — ghost-erase CUP emitted after width-only resize', () => {
  beforeEach(() => { __resetStdinClaimForTests(); __resetCprRttForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('ghost-erase CUP+EL emitted for the pre-resize frame row after width-only shrink', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    const writes = collectWrites(stdout);
    stdout.rows = 40;
    stdout.columns = 99;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();
    // Allow the initial frame to render at row 39 (rows-1).
    vi.advanceTimersByTime(20);
    // Confirm the initial frame painted at row 39.
    expect(writes.all()).toContain('\x1b[39;1H');
    writes.clear();

    // Width-only shrink: columns 99→49, rows stay at 40.
    stdout.columns = 49;
    process.stdout.emit('resize');

    // Let the CPR timeout fire (120ms) → repaint with erase.
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 50);

    const out = writes.all();
    // The old spinner row (row 39) must be explicitly erased — the ghost-erase
    // mechanism (pendingResizeErase) must have fired.
    expect(out, 'ghost-erase CUP+EL must appear for the old frame row after width-only resize')
      .toContain('\x1b[39;1H\x1b[2K');

    c.disarm();
  });
});
