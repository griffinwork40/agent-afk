/**
 * Tests for tmux pane-SHRINK CPR re-anchoring (defect 1).
 *
 * When a tmux pane shrinks, tmux trims blank rows below the cursor, then
 * pushes top rows into history, shifting all content and the cursor UP by
 * `delta` rows (0 ≤ delta ≤ shrink_amount). The compositor's absolute row
 * tracking becomes stale — the frame is still painted at the OLD rows while
 * the terminal content now sits `delta` rows higher, causing the visible
 * duplicate ghost below the live frame.
 *
 * Fix: apply the same CPR re-anchoring on SHRINK (delta is 0 or negative).
 * The existing SHRINK rule that drops a stale EXPAND erase snapshot is kept.
 *
 * Covers:
 *   S1 — handleResizeImmediate emits CPR request on SHRINK (when lastMeasuredFrameBottom > 0).
 *   S2 — negative delta (shift UP) is applied correctly to all tracked rows.
 *   S3 — delta=0 shrink (blank rows trimmed, no push): no rows shift, no extra repaint.
 *   S4 — pendingResizeErase is nulled on SHRINK (existing contract preserved).
 *   S5 — CPR timeout on shrink: falls back, no rows shifted.
 *   S6 — regression: after tmux SHRINK with delta=-21, frame is at shifted row, no stale ghost.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  requestCprAndApplyDelta,
  CPR_REQUEST,
  CPR_TIMEOUT_MS,
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
    pendingEvictionRows: 0,
    repaint() { repaintCalls++; },
    get repaintCalls() { return repaintCalls; },
  } as unknown as CprHost & { repaintCalls: number };
}

// ---------------------------------------------------------------------------
// S1: handleResizeImmediate emits CPR request on SHRINK
// ---------------------------------------------------------------------------

describe('S1: handleResizeImmediate emits CPR request on SHRINK', () => {
  beforeEach(() => { __resetStdinClaimForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('emits CPR_REQUEST when a SHRINK SIGWINCH fires and a frame has been rendered', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    const writes = collectWrites(stdout);
    stdout.rows = 50;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();
    // Allow initial frame to render.
    vi.advanceTimersByTime(20);
    writes.clear();

    // Simulate SHRINK: 50→29 rows.
    stdout.rows = 29;
    process.stdout.emit('resize');

    // CPR request must be emitted on shrink (new fix).
    const afterShrink = writes.all();
    expect(afterShrink, 'CPR_REQUEST must be emitted on SHRINK').toContain(CPR_REQUEST);

    // Existing contract: pendingResizeErase is null after shrink.
    const internals = c as unknown as { pendingResizeErase: { top: number; bottom: number } | null };
    expect(internals.pendingResizeErase, 'pendingResizeErase must be null after SHRINK').toBeNull();

    // Cleanup CPR listener.
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 20);
    c.disarm();
  });

  it('does NOT emit CPR_REQUEST when no frame has been rendered yet (frameBottom===0)', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    const writes = collectWrites(stdout);
    stdout.rows = 50;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();

    // Reset lastMeasuredFrameBottom to 0 to simulate no frame rendered.
    const internals = c as unknown as { lastMeasuredFrameBottom: number };
    internals.lastMeasuredFrameBottom = 0;
    writes.clear();

    // Simulate SHRINK.
    stdout.rows = 29;
    process.stdout.emit('resize');

    // No CPR when no frame has been measured yet.
    expect(writes.all()).not.toContain(CPR_REQUEST);

    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 20);
    c.disarm();
  });
});

// ---------------------------------------------------------------------------
// S2: negative delta (shift UP) applied correctly
// ---------------------------------------------------------------------------

describe('S2: negative delta applied correctly to all tracked rows', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('shifts all tracked rows up by |delta| when CPR reply indicates cursor moved up', async () => {
    // Scenario: frame was at rows 30-45 in a 50-row pane; pane shrinks to 29,
    // tmux pushes 21 rows into history (delta=-21), cursor moves from 45 to 24.
    const host = makeCprHost({
      frameTop: 30,
      frameBottom: 45,
      bandTop: 15,
      bandBottom: 29,
      logUpdateTopRow: 30,
      anchorRow: 10,
    });

    // Use expectedRow=45 (frameBottom), newRows=29, rowDelta=−21 (shrink).
    requestCprAndApplyDelta(host, /* expectedRow= */ 45, /* newRows= */ 29, /* rowDelta= */ -21);
    expect(host.cprPending).toBe(true);

    // CPR reply: cursor moved to row 24 (delta = 24 - 45 = -21).
    host.stdin.emit('data', Buffer.from('\x1b[24;1R'));
    await Promise.resolve();

    expect(host.cprPending).toBe(false);
    expect(host.repaintCalls).toBe(1);
    // All rows shifted by -21, clamped to [1, 29].
    expect(host.lastMeasuredFrameTop).toBe(9);    // 30 - 21
    expect(host.lastMeasuredFrameBottom).toBe(24); // 45 - 21
    expect(host.committedBandTopRow).toBe(1);       // 15 - 21 = -6 → clamped to 1
    expect(host.committedBandBottomRow).toBe(8);    // 29 - 21 = 8
    expect((host.logUpdate as { topRow: number }).topRow).toBe(9); // 30 - 21
    expect(host.anchorRow).toBe(1); // 10 - 21 = -11 → clamped to 1
  });

  it('handles delta=0 (no history pushed on shrink): no rows shift; ALWAYS repaints', async () => {
    // New contract: even when delta=0, we repaint so the frame reflows to the
    // new geometry (the debounced resize repaint may have been suppressed).
    const host = makeCprHost({ frameTop: 10, frameBottom: 20, bandTop: 5, bandBottom: 9 });
    requestCprAndApplyDelta(host, /* expectedRow= */ 20, /* newRows= */ 25, /* rowDelta= */ -5);
    // CPR reply: cursor still at row 20 (delta=0 — blank rows trimmed, no push).
    host.stdin.emit('data', Buffer.from('\x1b[20;1R'));
    await Promise.resolve();
    expect(host.repaintCalls).toBe(1); // ALWAYS repaint
    expect(host.lastMeasuredFrameTop).toBe(10); // unchanged (delta=0 → no applyScrollDelta)
    expect(host.committedBandTopRow).toBe(5);   // unchanged
  });
});

// ---------------------------------------------------------------------------
// S3: pendingResizeErase nulled on SHRINK (existing contract)
// ---------------------------------------------------------------------------

describe('S3: SHRINK contract — pendingResizeErase nulled', () => {
  beforeEach(() => { __resetStdinClaimForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('pendingResizeErase is null after SHRINK even if a prior EXPAND had set it', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    stdout.rows = 50;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();
    vi.advanceTimersByTime(20);

    // First EXPAND to set pendingResizeErase.
    stdout.rows = 70;
    process.stdout.emit('resize');
    // Clear the CPR listener from the EXPAND.
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 20);

    const internals = c as unknown as { pendingResizeErase: { top: number; bottom: number } | null };
    // Now SHRINK: must null pendingResizeErase.
    stdout.rows = 40;
    process.stdout.emit('resize');
    // Let the CPR listener time out (shrink).
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 20);

    expect(internals.pendingResizeErase, 'pendingResizeErase must be null after SHRINK').toBeNull();

    c.disarm();
  });
});

// ---------------------------------------------------------------------------
// S4: CPR timeout on SHRINK — fallback, no rows shifted
// ---------------------------------------------------------------------------

describe('S4: CPR timeout on SHRINK — fallback preserves existing behaviour', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('rows unchanged after CPR timeout on shrink; ALWAYS repaints', async () => {
    // New contract: timeout falls back AND repaints (lost repaint fix).
    const host = makeCprHost({ frameTop: 30, frameBottom: 45 });
    requestCprAndApplyDelta(host, /* expectedRow= */ 45, /* newRows= */ 29, /* rowDelta= */ -21);
    expect(host.cprPending).toBe(true);

    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 20);

    expect(host.cprPending).toBe(false);
    expect(host.repaintCalls).toBe(1); // ALWAYS repaint on timeout (new contract)
    expect(host.lastMeasuredFrameTop).toBe(30);    // unchanged (no delta applied)
    expect(host.lastMeasuredFrameBottom).toBe(45); // unchanged
  });
});

// ---------------------------------------------------------------------------
// S5: Regression — GROW→SHRINK→GROW yields exactly one frame
// ---------------------------------------------------------------------------

describe('S5: regression — GROW→SHRINK→GROW sequence yields one frame', () => {
  beforeEach(() => { __resetStdinClaimForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('after GROW then SHRINK with CPR, frame paints at correct row (no stale ghost)', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    const writes = collectWrites(stdout);
    stdout.rows = 29;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();
    vi.advanceTimersByTime(20);
    writes.clear();

    // Step 1: GROW 29→50, delta=+21 (history pulled back).
    stdout.rows = 50;
    process.stdout.emit('resize');
    // CPR reply: cursor moved from ~28 to ~49 (delta=21).
    const internals = c as unknown as { lastMeasuredFrameBottom: number; cprPending: boolean };
    const frameBotAfterArm = internals.lastMeasuredFrameBottom || 28;
    const grownRow = frameBotAfterArm + 21;
    stdin.emit('data', Buffer.from(`\x1b[${grownRow};1R`));
    await Promise.resolve();
    vi.advanceTimersByTime(150); // debounce
    writes.clear();

    // Step 2: SHRINK 50→29, delta=-21 (pushed 21 rows into history).
    stdout.rows = 29;
    process.stdout.emit('resize');

    // CPR request emitted for SHRINK.
    const afterShrink = writes.all();
    expect(afterShrink, 'CPR_REQUEST must be emitted on SHRINK').toContain(CPR_REQUEST);
    writes.clear();

    // CPR reply for SHRINK: cursor moved up by 21 rows.
    const currentFrameBot = internals.lastMeasuredFrameBottom;
    const shrunkRow = Math.max(1, currentFrameBot - 21);
    stdin.emit('data', Buffer.from(`\x1b[${shrunkRow};1R`));
    await Promise.resolve();
    vi.advanceTimersByTime(150); // debounce

    const out = writes.all();
    // Frame must be at the shrunk position — it must write a CUP sequence.
    expect(out, 'repaint after shrink CPR must write CUP sequences').toContain('\x1b[');

    // The stale GROW-era frame position (row ~49) must NOT appear as a bare
    // frame paint after the shrink correction.
    const staleRow = grownRow;
    const staleRowBareRepaint = out
      .split(`\x1b[${staleRow};1H\x1b[2K`).join('')
      .includes(`\x1b[${staleRow};1H`);
    expect(staleRowBareRepaint, `stale row ${staleRow} must not receive bare frame paint after shrink`).toBe(false);

    c.disarm();
  });
});
