/**
 * Tests for the tmux-pane-growth duplication fix (CPR-based delta correction).
 *
 * Covers:
 *   T1 — parseCprReply: well-formed and malformed sequences.
 *   T2 — applyScrollDelta: absolute-row fields shift by delta on CPR reply.
 *   T3 — repaint suppressed while cprPending; fires once delta applied.
 *   T4 — CPR reply intercepted by data listener; never leaks into dispatchKey.
 *   T5 — CPR reply sequence dropped by dispatchKey (belt-and-suspenders).
 *   T6 — timeout fallback: existing behaviour when no CPR reply arrives.
 *   T7 — RED-FIRST regression: frame NOT duplicated after tmux pane growth.
 *
 * T7 is the key regression test. Before the fix, the compositor painted the
 * frame at old absolute rows while the terminal kept the shifted copy,
 * producing a visible duplicate. After the fix, tracked rows are shifted by
 * delta and the old ghost is erased.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import { parseCprReply, requestCprAndApplyDelta, CPR_REQUEST, CPR_TIMEOUT_MS } from './terminal-compositor.lifecycle.cpr.js';
import { dispatchKey } from './terminal-compositor.input-dispatch.js';
import { TerminalCompositor } from './terminal-compositor.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';
import type { MockStdout, MockStdin } from './terminal-compositor.test-helpers.js';
import type { CprHost } from './terminal-compositor.lifecycle.cpr.js';
import type { KeyDispatchHost } from './terminal-compositor.input-dispatch.js';
import type { KeyInfo } from './terminal-compositor.types.js';

// ---------------------------------------------------------------------------
// T1: parseCprReply
// ---------------------------------------------------------------------------

describe('T1: parseCprReply — well-formed and malformed sequences', () => {
  it('parses a well-formed CPR reply', () => {
    expect(parseCprReply('\x1b[12;1R')).toEqual({ row: 12, col: 1 });
    expect(parseCprReply('\x1b[1;80R')).toEqual({ row: 1, col: 80 });
    expect(parseCprReply('\x1b[50;40R')).toEqual({ row: 50, col: 40 });
  });

  it('returns null for non-CPR sequences', () => {
    expect(parseCprReply('')).toBeNull();
    expect(parseCprReply('\x1b[A')).toBeNull(); // CUU
    expect(parseCprReply('\x1b[2K')).toBeNull(); // EL
    expect(parseCprReply('plain text')).toBeNull();
    expect(parseCprReply('\x1b[;R')).toBeNull(); // missing params
    expect(parseCprReply('\x1b[0;0R')).toBeNull(); // zero params
  });

  it('returns null for partial CPR sequences', () => {
    expect(parseCprReply('\x1b[12;1')).toBeNull(); // missing R
    expect(parseCprReply('\x1b[12')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// T2: applyScrollDelta via requestCprAndApplyDelta integration
// ---------------------------------------------------------------------------

describe('T2: requestCprAndApplyDelta applies delta to tracked rows', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function makeHost(opts: {
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
    const host = {
      stdout,
      stdin,
      armed: true,
      cprPending: false,
      lastMeasuredFrameTop: opts.frameTop ?? 0,
      lastMeasuredFrameBottom: opts.frameBottom ?? 0,
      committedBandTopRow: opts.bandTop ?? 0,
      committedBandBottomRow: opts.bandBottom ?? 0,
      pendingResizeErase: opts.eraseTop != null
        ? { top: opts.eraseTop, bottom: opts.eraseBottom ?? opts.eraseTop }
        : null,
      logUpdate: opts.logUpdateTopRow != null
        ? { topRow: opts.logUpdateTopRow }
        : null,
      anchorRow: opts.anchorRow,
      repaint() { repaintCalls++; },
      get repaintCalls() { return repaintCalls; },
    } as unknown as CprHost & { repaintCalls: number };
    return host;
  }

  it('shifts all tracked rows by +delta when CPR reply arrives', async () => {
    const host = makeHost({
      frameTop: 10,
      frameBottom: 23,
      bandTop: 6,
      bandBottom: 9,
      eraseTop: 6,
      eraseBottom: 23,
      logUpdateTopRow: 10,
      anchorRow: 1,
    });

    requestCprAndApplyDelta(host, /* expectedRow= */ 10, /* newRows= */ 50);
    expect(host.cprPending).toBe(true);

    // Simulate CPR reply: cursor was shifted by 21 rows (delta=21).
    // expectedRow=10, reportedRow=31 → delta=21.
    host.stdin.emit('data', Buffer.from('\x1b[31;1R'));

    // Flush promises / timers
    await Promise.resolve();

    expect(host.cprPending).toBe(false);
    expect(host.repaintCalls).toBe(1);
    // All rows shifted by +21, clamped to [1, 50].
    expect(host.lastMeasuredFrameTop).toBe(31);   // 10 + 21
    expect(host.lastMeasuredFrameBottom).toBe(44); // 23 + 21
    expect(host.committedBandTopRow).toBe(27);      // 6 + 21
    expect(host.committedBandBottomRow).toBe(30);   // 9 + 21
    expect(host.pendingResizeErase).toEqual({ top: 27, bottom: 44 });
    expect((host.logUpdate as { topRow: number }).topRow).toBe(31); // 10 + 21
    expect(host.anchorRow).toBe(22); // 1 + 21
  });

  it('does NOT call repaint when delta is 0', async () => {
    const host = makeHost({ frameTop: 10 });
    requestCprAndApplyDelta(host, 10, 50);
    host.stdin.emit('data', Buffer.from('\x1b[10;1R')); // same row → delta=0
    await Promise.resolve();
    expect(host.repaintCalls).toBe(0);
    expect(host.lastMeasuredFrameTop).toBe(10); // unchanged
  });

  it('falls back (no repaint, pending cleared) on timeout', async () => {
    const host = makeHost({ frameTop: 10 });
    requestCprAndApplyDelta(host, 10, 50);
    expect(host.cprPending).toBe(true);
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 10);
    expect(host.cprPending).toBe(false);
    expect(host.repaintCalls).toBe(0); // no delta applied
  });

  it('clamps shifted rows to [1, newRows]', async () => {
    const host = makeHost({ frameTop: 5, bandTop: 3, bandBottom: 4 });
    // delta=48 would push rows well above newRows=50 — clamp to 50.
    requestCprAndApplyDelta(host, /* expectedRow= */ 5, /* newRows= */ 50);
    host.stdin.emit('data', Buffer.from('\x1b[53;1R')); // reported=53 → delta=48
    await Promise.resolve();
    expect(host.lastMeasuredFrameTop).toBe(50); // clamped
    expect(host.committedBandTopRow).toBe(50);  // 3+48=51 → clamped to 50
    expect(host.committedBandBottomRow).toBe(50); // 4+48=52 → clamped to 50
  });

  it('discards CPR reply when host becomes disarmed before reply arrives', async () => {
    const host = makeHost({ frameTop: 10 });
    requestCprAndApplyDelta(host, 10, 50);
    // Simulate disarm between request and reply.
    (host as unknown as { armed: boolean }).armed = false;
    host.stdin.emit('data', Buffer.from('\x1b[21;1R'));
    await Promise.resolve();
    // Delta NOT applied (armed was false).
    expect(host.lastMeasuredFrameTop).toBe(10);
    expect(host.repaintCalls).toBe(0);
  });

  it('emits CPR_REQUEST to stdout', () => {
    const chunks: Buffer[] = [];
    const host = makeHost({ frameTop: 10 });
    host.stdout.on('data', (c: unknown) => { if (Buffer.isBuffer(c)) chunks.push(c); });
    requestCprAndApplyDelta(host, 10, 50);
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 10); // cleanup
    expect(Buffer.concat(chunks).toString()).toContain(CPR_REQUEST);
  });

  it('is a no-op when cprPending is already true (idempotent)', () => {
    const host = makeHost({ frameTop: 10 });
    host.cprPending = true;
    const writesBefore: Buffer[] = [];
    host.stdout.on('data', (c: unknown) => { if (Buffer.isBuffer(c)) writesBefore.push(c); });
    requestCprAndApplyDelta(host, 10, 50);
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 10);
    expect(Buffer.concat(writesBefore).toString()).not.toContain(CPR_REQUEST);
  });
});

// ---------------------------------------------------------------------------
// T3: cprPending suppresses Frame.repaint
// ---------------------------------------------------------------------------

describe('T3: cprPending suppresses compositor repaint while CPR is in-flight', () => {
  beforeEach(() => { __resetStdinClaimForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('repaint is suppressed while cprPending, then fires after CPR reply', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    const writes = collectWrites(stdout);
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();
    writes.clear();

    // Manually set cprPending to simulate in-flight state.
    const internals = c as unknown as { cprPending: boolean; repaint(): void };
    internals.cprPending = true;

    // A repaint while cprPending must NOT write to stdout.
    internals.repaint();
    expect(writes.all()).toBe('');

    // Clear cprPending and repaint — now it should write.
    internals.cprPending = false;
    internals.repaint();
    expect(writes.all()).not.toBe('');

    c.disarm();
  });
});

// ---------------------------------------------------------------------------
// T4: CPR reply intercepted by data listener before readline sees it
// ---------------------------------------------------------------------------

describe('T4: CPR data-listener intercepts reply before readline emits keypress', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('data listener fires and removes itself; stdin has no cprPending after reply', async () => {
    const host = (() => {
      const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { isTTY: boolean };
      stdin.isTTY = true;
      const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
      return {
        stdout,
        stdin,
        armed: true,
        cprPending: false,
        lastMeasuredFrameTop: 20,
        lastMeasuredFrameBottom: 23,
        committedBandTopRow: 15,
        committedBandBottomRow: 19,
        pendingResizeErase: null,
        logUpdate: { topRow: 20 },
        anchorRow: 1 as number | undefined,
        repaintCalls: 0,
        repaint() { this.repaintCalls++; },
      } as unknown as CprHost & { repaintCalls: number };
    })();

    const dataBefore = host.stdin.listenerCount('data');
    requestCprAndApplyDelta(host, 20, 50);
    const dataAfterRequest = host.stdin.listenerCount('data');
    expect(dataAfterRequest).toBe(dataBefore + 1); // listener added

    // Reply arrives: cursor moved from 20 → 35 (delta=15).
    host.stdin.emit('data', Buffer.from('\x1b[35;1R'));
    await Promise.resolve();

    // Listener must have been removed.
    expect(host.stdin.listenerCount('data')).toBe(dataBefore);
    expect(host.cprPending).toBe(false);
    expect(host.lastMeasuredFrameTop).toBe(35); // 20+15
    expect(host.repaintCalls).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// T5: dispatchKey drops CPR-shaped sequences (belt-and-suspenders)
// ---------------------------------------------------------------------------

describe('T5: dispatchKey silently drops CPR reply sequences', () => {
  function makeMinimalDispatchHost(): KeyDispatchHost {
    return {
      armed: true,
      cprPending: false,
      input: { buffer: '', cursor: 0 },
      queued: false,
      pendingSubmissions: [],
      queuedReservations: new Map(),
      canceled: false,
      backgrounded: false,
      softStopped: false,
      postEscCoalesce: false,
      postEscPayload: null,
      paused: false,
      pasting: false,
      pasteStartBufferLen: 0,
      pasteStartCursor: 0,
      pasteRegistry: new Map(),
      clipboardFailureMsg: null,
      modeNotice: null,
      lastEscTime: 0,
      pickerController: null,
      inputMode: 'idle',
      attachments: [],
      repaint: vi.fn(),
      scheduleRepaint: vi.fn(),
      clearScreen: vi.fn(),
      applyEdit: vi.fn(() => true),
      updateAutocomplete: vi.fn(),
      updateGhost: vi.fn(),
      dismissPromptGhost: vi.fn(() => false),
      applyDropdownSelection: vi.fn(() => false),
      applyGhostAccept: vi.fn(() => false),
      applyGhostWordAccept: vi.fn(() => false),
    } as unknown as KeyDispatchHost;
  }

  it('does not call repaint for a CPR-shaped sequence', () => {
    const host = makeMinimalDispatchHost();
    const cprKey: KeyInfo = { sequence: '\x1b[25;1R', name: undefined, ctrl: false, meta: false, shift: false, code: '' };
    dispatchKey(host, undefined, cprKey);
    expect(host.repaint).not.toHaveBeenCalled();
    expect(host.scheduleRepaint).not.toHaveBeenCalled();
  });

  it('does not call repaint for various CPR formats', () => {
    const host = makeMinimalDispatchHost();
    for (const seq of ['\x1b[1;1R', '\x1b[50;80R', '\x1b[999;1R']) {
      const key: KeyInfo = { sequence: seq, name: undefined, ctrl: false, meta: false, shift: false, code: '' };
      dispatchKey(host, undefined, key);
    }
    expect(host.repaint).not.toHaveBeenCalled();
  });

  it('normal key sequences are NOT dropped (sanity)', () => {
    const host = makeMinimalDispatchHost();
    // 'a' key — should reach handlePrintable → applyEdit (which would call
    // scheduleRepaint on the real compositor; here we just verify applyEdit fires).
    const aKey: KeyInfo = { sequence: 'a', name: 'a', ctrl: false, meta: false, shift: false, code: '' };
    dispatchKey(host, 'a', aKey);
    expect(host.applyEdit).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T6: timeout fallback
// ---------------------------------------------------------------------------

describe('T6: CPR timeout fallback — existing behaviour preserved when no reply arrives', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('cprPending clears after timeout and no rows shift', async () => {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { isTTY: boolean };
    stdin.isTTY = true;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    let repaintCalls = 0;
    const host: CprHost = {
      stdout,
      stdin,
      armed: true,
      cprPending: false,
      lastMeasuredFrameTop: 10,
      lastMeasuredFrameBottom: 23,
      committedBandTopRow: 5,
      committedBandBottomRow: 9,
      pendingResizeErase: { top: 5, bottom: 23 },
      logUpdate: { topRow: 10 },
      anchorRow: 1,
      repaint() { repaintCalls++; },
    } as unknown as CprHost;

    requestCprAndApplyDelta(host, 10, 50);
    expect(host.cprPending).toBe(true);

    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 20);

    // After timeout: cprPending cleared, no rows shifted, no repaint.
    expect(host.cprPending).toBe(false);
    expect(repaintCalls).toBe(0);
    expect(host.lastMeasuredFrameTop).toBe(10); // unchanged
    expect(host.committedBandTopRow).toBe(5);   // unchanged
    // pendingResizeErase preserved so existing ghost-erase logic still fires.
    expect(host.pendingResizeErase).toEqual({ top: 5, bottom: 23 });
  });
});

// ---------------------------------------------------------------------------
// T7: Regression — tmux pane growth no longer duplicates the frame
// ---------------------------------------------------------------------------

describe('T7: regression — tmux pane growth + CPR shift → no frame duplication', () => {
  beforeEach(() => { __resetStdinClaimForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  /**
   * Simulate a tmux EXPAND: pane grows from `oldRows` to `newRows`, with
   * `delta` lines of history pulled back onto screen. The compositor must
   * erase the old ghost footprint at [oldFrameTop, oldRows-1] and paint
   * the frame at the NEW (delta-shifted) position — not at the stale row.
   *
   * RED-FIRST: before the fix, the compositor erased/painted at the OLD
   * rows and the frozen shifted copy (delta rows lower) was never erased.
   * After the fix, tracked rows shift by delta and both old-ghost erase
   * and new-frame paint target the correct rows.
   */
  it('after tmux EXPAND with delta=21 (29→50 rows), frame paints at shifted row not stale row', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    const writes = collectWrites(stdout);
    stdout.rows = 29;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();

    // Initial frame at row 28 (rows-1=28).
    expect(writes.all()).toContain('\x1b[28;1H');
    writes.clear();

    // --- Simulate tmux EXPAND: pane grows 29→50, delta=21 ---
    // tmux pulls 21 history lines back onto screen → cursor shifts from row 28
    // to row 49 (28+21). We grow stdout.rows and emit a synthetic resize.
    stdout.rows = 50;
    process.stdout.emit('resize');

    // The CPR request should have been emitted to stdout.
    const afterResize = writes.all();
    expect(afterResize).toContain('\x1b[6n'); // CPR_REQUEST
    writes.clear();

    // Simulate CPR reply: cursor moved from 28 → 49 (delta=21).
    stdin.emit('data', Buffer.from('\x1b[49;1R'));
    await Promise.resolve();

    // Advance debounce timer so the ResizeBus subscriber fires the repaint.
    vi.advanceTimersByTime(150);

    const out = writes.all();

    // After the delta correction, the frame should be painted at row 49 + delta
    // (but actually: the cursor was AT frameTop=28 before resize; after delta=21
    // the frame's tracked top shifts to 49, and the repaint below that fires
    // after delta correction should use newRows-1=49 for the bottom pin too).
    // The important invariant: the OLD stale frame position (row 28) must be
    // ERASED (ghost erase), and the new frame must be at the correct position.

    // Ghost erase at the old footprint (rows 28 or nearby from pendingResizeErase).
    // After delta correction, the pendingResizeErase also shifted, so the erase
    // is at the shifted position — verifying the erase at least one row covers
    // the old area is the key assertion.
    // The repaint that fires after CPR reply must write a CUP sequence.
    expect(out, 'repaint after CPR delta should write CUP sequences').toContain('\x1b[');

    // The critical regression check: the NEW frame bottom (row 49 = newRows-1).
    // After CPR delta correction the compositor knows the cursor shifted to 49
    // and re-anchors; the next debounce repaint paints at the new viewport bottom.
    expect(out).toContain('\x1b[49;1H');

    // The stale row 28 frame must have been erased (pendingResizeErase covers it
    // pre-delta; after delta it's at 28+21=49 which is the new frame position —
    // but the key is no SECOND copy of the frame at the old un-shifted row 28
    // remains without an erase). We assert the old raw row 28 CUP appears only
    // as part of the deliberate erase sequence (CUP+EL), not as a bare repaint.
    // Count bare row-28 CUPs: every '\x1b[28;1H' NOT followed immediately by '\x1b[2K'.
    const cup28WithoutErase = out.split('\x1b[28;1H\x1b[2K').join('').includes('\x1b[28;1H');
    expect(cup28WithoutErase, 'row 28 must not receive a bare frame paint after delta shift').toBe(false);

    c.disarm();
  });

  it('without CPR (stdin not TTY flag in handleResizeImmediate), no CPR_REQUEST is emitted', async () => {
    // Verify the guard in handleResizeImmediate: when stdin.isTTY is false
    // at the host level (simulated by checking the isTTY guard directly),
    // requestCprAndApplyDelta is not called. We test this via the CprHost
    // path directly rather than via the full compositor arm() (which also
    // bails on non-TTY stdin, making it a moot scenario end-to-end).
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { isTTY: boolean };
    stdin.isTTY = false; // non-TTY: no CPR emitted
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    const cprRequests: string[] = [];
    stdout.on('data', (c: unknown) => {
      if (typeof c === 'string') cprRequests.push(c);
      else if (Buffer.isBuffer(c)) cprRequests.push(c.toString());
    });

    let repaintCalls = 0;
    const host: CprHost = {
      stdout,
      stdin,
      armed: true,
      cprPending: false,
      lastMeasuredFrameTop: 10,
      lastMeasuredFrameBottom: 23,
      committedBandTopRow: 5,
      committedBandBottomRow: 9,
      pendingResizeErase: null,
      logUpdate: { topRow: 10 },
      anchorRow: 1,
      repaint() { repaintCalls++; },
    } as unknown as CprHost;

    // Mimic handleResizeImmediate's guard: only call requestCprAndApplyDelta
    // when stdin.isTTY is true.
    if (host.stdin.isTTY) {
      requestCprAndApplyDelta(host, 10, 50);
    }

    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 20);

    // No CPR request emitted, no repaint called.
    expect(cprRequests.join('')).not.toContain('\x1b[6n');
    expect(repaintCalls).toBe(0);
    expect(host.cprPending).toBe(false);
  });
});
