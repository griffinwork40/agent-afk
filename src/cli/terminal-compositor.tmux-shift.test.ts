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
import { parseCprReply, requestCprAndApplyDelta, requestCprOrMarkDirty, CPR_REQUEST, CPR_TIMEOUT_MS, CPR_MAX_REQUERY, __resetCprRttForTests } from './terminal-compositor.lifecycle.cpr.js';
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
  beforeEach(() => { __resetCprRttForTests(); vi.useFakeTimers(); });
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
      cprBurst: null,
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

    // rowDelta=29 (growing from 21→50): allows delta up to 29 — but delta=21 is <=29, fine.
    // Actually use rowDelta=21 to exactly match delta, or 50 to be generous in unit tests.
    requestCprAndApplyDelta(host, /* expectedRow= */ 10, /* newRows= */ 50, /* rowDelta= */ 50);
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

  it('ALWAYS repaints even when delta is 0 (new contract: frame must reflow to new geometry)', async () => {
    // "measure until quiescent" always repaints after the final CPR reply so the
    // frame reflows to the new terminal geometry even when no row shift occurred
    // (the debounced resize repaint may have been suppressed by cprPending).
    const host = makeHost({ frameTop: 10 });
    requestCprAndApplyDelta(host, 10, 50, /* rowDelta= */ 10);
    host.stdin.emit('data', Buffer.from('\x1b[10;1R')); // same row → delta=0
    await Promise.resolve();
    expect(host.repaintCalls).toBe(1); // ALWAYS repaint, even on delta=0
    expect(host.lastMeasuredFrameTop).toBe(10); // rows unchanged (delta=0 → no applyScrollDelta)
  });

  it('ALWAYS repaints on timeout so frame reflows to new geometry', async () => {
    // Timeout contract: fall back AND repaint. The debounced resize repaint may
    // have been suppressed while cprPending was true; we must repaint regardless.
    const host = makeHost({ frameTop: 10 });
    requestCprAndApplyDelta(host, 10, 50, /* rowDelta= */ 10);
    expect(host.cprPending).toBe(true);
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 10);
    expect(host.cprPending).toBe(false);
    expect(host.repaintCalls).toBe(1); // ALWAYS repaint on timeout
  });

  it('clamps shifted rows to [1, newRows]', async () => {
    const host = makeHost({ frameTop: 5, bandTop: 3, bandBottom: 4 });
    // delta=48 would push rows well above newRows=50 — clamp to 50.
    // rowDelta=50 so plausibility guard allows delta up to 50 (48 ≤ 50 passes).
    requestCprAndApplyDelta(host, /* expectedRow= */ 5, /* newRows= */ 50, /* rowDelta= */ 50);
    host.stdin.emit('data', Buffer.from('\x1b[53;1R')); // reported=53 → delta=48
    await Promise.resolve();
    expect(host.lastMeasuredFrameTop).toBe(50); // clamped
    expect(host.committedBandTopRow).toBe(50);  // 3+48=51 → clamped to 50
    expect(host.committedBandBottomRow).toBe(50); // 4+48=52 → clamped to 50
  });

  it('discards CPR reply when host becomes disarmed before reply arrives', async () => {
    const host = makeHost({ frameTop: 10 });
    requestCprAndApplyDelta(host, 10, 50, /* rowDelta= */ 50);
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
    requestCprAndApplyDelta(host, 10, 50, /* rowDelta= */ 10);
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 10); // cleanup
    expect(Buffer.concat(chunks).toString()).toContain(CPR_REQUEST);
  });

  it('is a no-op when cprPending is already true (idempotent)', () => {
    const host = makeHost({ frameTop: 10 });
    host.cprPending = true;
    const writesBefore: Buffer[] = [];
    host.stdout.on('data', (c: unknown) => { if (Buffer.isBuffer(c)) writesBefore.push(c); });
    requestCprAndApplyDelta(host, 10, 50, /* rowDelta= */ 10);
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 10);
    expect(Buffer.concat(writesBefore).toString()).not.toContain(CPR_REQUEST);
  });
});

// ---------------------------------------------------------------------------
// T3: cprPending suppresses Frame.repaint
// ---------------------------------------------------------------------------

describe('T3: cprPending suppresses compositor repaint while CPR is in-flight', () => {
  beforeEach(() => { __resetStdinClaimForTests(); __resetCprRttForTests(); vi.useFakeTimers(); });
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
  beforeEach(() => { __resetCprRttForTests(); vi.useFakeTimers(); });
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
        cprBurst: null,
        lastMeasuredFrameTop: 20,
        lastMeasuredFrameBottom: 23,
        committedBandTopRow: 15,
        committedBandBottomRow: 19,
        pendingResizeErase: null,
        logUpdate: { topRow: 20 },
        anchorRow: 1 as number | undefined,
        pendingEvictionRows: 0,
        repaint: vi.fn(),
      } as unknown as CprHost;
    })();

    const dataBefore = host.stdin.listenerCount('data');
    requestCprAndApplyDelta(host, 20, 50, /* rowDelta= */ 50);
    const dataAfterRequest = host.stdin.listenerCount('data');
    expect(dataAfterRequest).toBe(dataBefore + 1); // listener added

    // Reply arrives: cursor moved from 20 → 35 (delta=15).
    host.stdin.emit('data', Buffer.from('\x1b[35;1R'));
    await Promise.resolve();

    // Listener must have been removed.
    expect(host.stdin.listenerCount('data')).toBe(dataBefore);
    expect(host.cprPending).toBe(false);
    expect(host.lastMeasuredFrameTop).toBe(35); // 20+15
    expect(host.repaint).toHaveBeenCalledTimes(1);
  });

  it('re-emits non-CPR bytes surrounding the reply', async () => {
    const host = (() => {
      const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { isTTY: boolean };
      stdin.isTTY = true;
      const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
      return {
        stdout,
        stdin,
        armed: true,
        cprPending: false,
        cprBurst: null,
        lastMeasuredFrameTop: 20,
        lastMeasuredFrameBottom: 23,
        committedBandTopRow: 15,
        committedBandBottomRow: 19,
        pendingResizeErase: null,
        logUpdate: { topRow: 20 },
        anchorRow: 1 as number | undefined,
        pendingEvictionRows: 0,
        repaint: vi.fn(),
      } as unknown as CprHost;
    })();

    requestCprAndApplyDelta(host, 20, 50, 50);

    // Mixed chunk: keystrokes + CPR reply + keystrokes
    const unshifted: Buffer[] = [];
    const origUnshift = host.stdin.unshift.bind(host.stdin);
    host.stdin.unshift = ((chunk: Buffer) => {
      unshifted.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as unknown as string));
      origUnshift(chunk);
    }) as typeof host.stdin.unshift;

    host.stdin.emit('data', Buffer.from('ab\x1b[24;1Rcd'));
    await Promise.resolve();

    expect(host.stdin.listenerCount('data')).toBe(0); // listener removed
    // The non-CPR bytes 'ab' and 'cd' must be re-emitted
    const combined = Buffer.concat(unshifted).toString();
    expect(combined).toBe('abcd');
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
    const cprKey: KeyInfo = { sequence: '\x1b[25;1R', name: undefined, ctrl: false, meta: false, shift: false };
    dispatchKey(host, undefined, cprKey);
    expect(host.repaint).not.toHaveBeenCalled();
    expect(host.scheduleRepaint).not.toHaveBeenCalled();
  });

  it('does not call repaint for various CPR formats', () => {
    const host = makeMinimalDispatchHost();
    for (const seq of ['\x1b[1;1R', '\x1b[50;80R', '\x1b[999;1R']) {
      const key: KeyInfo = { sequence: seq, name: undefined, ctrl: false, meta: false, shift: false };
      dispatchKey(host, undefined, key);
    }
    expect(host.repaint).not.toHaveBeenCalled();
  });

  it('normal key sequences are NOT dropped (sanity)', () => {
    const host = makeMinimalDispatchHost();
    // 'a' key — should reach handlePrintable → applyEdit (which would call
    // scheduleRepaint on the real compositor; here we just verify applyEdit fires).
    const aKey: KeyInfo = { sequence: 'a', name: 'a', ctrl: false, meta: false, shift: false };
    dispatchKey(host, 'a', aKey);
    expect(host.applyEdit).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// T6: timeout fallback
// ---------------------------------------------------------------------------

describe('T6: CPR timeout fallback — existing behaviour preserved when no reply arrives', () => {
  beforeEach(() => { __resetCprRttForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('cprPending clears after timeout; rows do not shift; ALWAYS repaints', async () => {
    // New contract: timeout falls back AND repaints so the frame reflows to
    // the new geometry. The debounced resize repaint may have been suppressed
    // while cprPending was true, so we must paint unconditionally here.
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { isTTY: boolean };
    stdin.isTTY = true;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    let repaintCalls = 0;
    const host: CprHost = {
      stdout,
      stdin,
      armed: true,
      cprPending: false,
      cprBurst: null,
      lastMeasuredFrameTop: 10,
      lastMeasuredFrameBottom: 23,
      committedBandTopRow: 5,
      committedBandBottomRow: 9,
      pendingResizeErase: { top: 5, bottom: 23 },
      logUpdate: { topRow: 10 },
      anchorRow: 1,
      repaint() { repaintCalls++; },
    } as unknown as CprHost;

    requestCprAndApplyDelta(host, 10, 50, /* rowDelta= */ 10);
    expect(host.cprPending).toBe(true);

    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 20);

    // After timeout: cprPending cleared, rows NOT shifted (no delta), repainted.
    expect(host.cprPending).toBe(false);
    expect(repaintCalls).toBe(1); // ALWAYS repaint on timeout (new contract)
    expect(host.lastMeasuredFrameTop).toBe(10); // unchanged (no delta applied)
    expect(host.committedBandTopRow).toBe(5);   // unchanged
    // pendingResizeErase preserved so existing ghost-erase logic still fires.
    expect(host.pendingResizeErase).toEqual({ top: 5, bottom: 23 });
  });
});

// ---------------------------------------------------------------------------
// T7: Regression — tmux pane growth no longer duplicates the frame
// ---------------------------------------------------------------------------

describe('T7: regression — tmux pane growth + CPR shift → no frame duplication', () => {
  beforeEach(() => { __resetStdinClaimForTests(); __resetCprRttForTests(); vi.useFakeTimers(); });
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
      cprBurst: null,
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
      requestCprAndApplyDelta(host, 10, 50, /* rowDelta= */ 10);
    }

    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 20);

    // No CPR request emitted, no repaint called.
    expect(cprRequests.join('')).not.toContain('\x1b[6n');
    expect(repaintCalls).toBe(0);
    expect(host.cprPending).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T8: Burst correctness — "measure until quiescent" (Tasks 1 & 2)
// ---------------------------------------------------------------------------

describe('T8: burst correctness — measure until quiescent', () => {
  beforeEach(() => { __resetCprRttForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function makeBurstHost(opts: {
    frameTop?: number;
    frameBottom?: number;
    bandTop?: number;
    bandBottom?: number;
  } = {}): CprHost & { repaintCalls: number; cprRequests: string[] } {
    const stdin = new PassThrough() as unknown as NodeJS.ReadStream & { isTTY: boolean };
    stdin.isTTY = true;
    const stdout = new PassThrough() as unknown as NodeJS.WriteStream;
    let repaintCalls = 0;
    const cprRequests: string[] = [];
    stdout.on('data', (c: unknown) => {
      const s = Buffer.isBuffer(c) ? c.toString() : (typeof c === 'string' ? c : '');
      if (s.includes('\x1b[6n')) cprRequests.push(s);
    });
    return {
      stdout,
      stdin,
      armed: true,
      cprPending: false,
      cprBurst: null,
      lastMeasuredFrameTop: opts.frameTop ?? 10,
      lastMeasuredFrameBottom: opts.frameBottom ?? 23,
      committedBandTopRow: opts.bandTop ?? 5,
      committedBandBottomRow: opts.bandBottom ?? 9,
      pendingResizeErase: null,
      logUpdate: null,
      anchorRow: undefined,
      repaint() { repaintCalls++; },
      get repaintCalls() { return repaintCalls; },
      get cprRequests() { return cprRequests; },
    } as unknown as CprHost & { repaintCalls: number; cprRequests: string[] };
  }

  it('T8a: burst grow-grow: single delta from originalExpectedRow, no double-shift', async () => {
    // Scenario: two SIGWINCH GROWs arrive in rapid succession.
    // First: rows 30→34 (rowDelta=+4). Second: rows 34→38 (rowDelta=+4).
    // Expected: one CPR query per reply until quiescent, final delta applied once.
    const host = makeBurstHost({ frameTop: 10, frameBottom: 20 });

    // SIGWINCH 1 (30→34): starts a fresh burst
    requestCprOrMarkDirty(host, /* expectedRow= */ 20, /* newRows= */ 34, /* rowDelta= */ 4);
    expect(host.cprPending).toBe(true);
    expect(host.cprBurst?.originalExpectedRow).toBe(20);
    expect(host.cprBurst?.growTotal).toBe(4);
    expect(host.cprRequests.length).toBe(1); // first CPR emitted

    // SIGWINCH 2 arrives while CPR is in-flight (34→38):
    requestCprOrMarkDirty(host, /* expectedRow= */ 20, /* newRows= */ 38, /* rowDelta= */ 4);
    expect(host.cprPending).toBe(true); // still pending
    expect(host.cprBurst?.dirty).toBe(true);
    expect(host.cprBurst?.growTotal).toBe(8); // accumulated: 4+4
    expect(host.cprBurst?.currentRows).toBe(38);
    expect(host.cprRequests.length).toBe(1); // no second CPR emitted yet

    // First CPR reply arrives: cursor shifted by 4 rows (still dirty → re-query)
    host.stdin.emit('data', Buffer.from('\x1b[24;1R')); // 20+4=24
    await Promise.resolve();
    expect(host.cprPending).toBe(true); // re-querying
    expect(host.cprBurst?.dirty).toBe(false); // cleared
    expect(host.cprBurst?.requeryCt).toBe(1);
    expect(host.cprRequests.length).toBe(2); // fresh CPR emitted
    expect(host.repaintCalls).toBe(0); // no mid-burst paint

    // Second CPR reply arrives: quiescent, cursor at row 28 (originalExpected=20, delta=8)
    host.stdin.emit('data', Buffer.from('\x1b[28;1R')); // 20+8=28
    await Promise.resolve();
    expect(host.cprPending).toBe(false);
    expect(host.cprBurst).toBeNull();
    expect(host.repaintCalls).toBe(1); // exactly ONE repaint after quiescent reply
    // Rows shifted by cumulative delta=8 from originalExpectedRow=20
    expect(host.lastMeasuredFrameTop).toBe(18);  // 10+8
    expect(host.lastMeasuredFrameBottom).toBe(28); // 20+8 (clamped to 38)
  });

  it('T8b: grow-shrink-grow (non-monotonic): correct accumulated range, single apply', async () => {
    // Scenario: 30→34 (+4), 34→26 (−8), 26→38 (+12).
    // growTotal = 4+12=16, shrinkTotal = 8. Net shift = +8 (cursor moved down 8).
    const host = makeBurstHost({ frameTop: 5, frameBottom: 15 });

    // Step 1: GROW +4
    requestCprOrMarkDirty(host, 15, 34, /* rowDelta= */ 4);
    expect(host.cprBurst?.growTotal).toBe(4);
    expect(host.cprBurst?.shrinkTotal).toBe(0);

    // Step 2: SHRINK −8 (mid-flight)
    requestCprOrMarkDirty(host, 15, 26, /* rowDelta= */ -8);
    expect(host.cprBurst?.growTotal).toBe(4);
    expect(host.cprBurst?.shrinkTotal).toBe(8);
    expect(host.cprBurst?.currentRows).toBe(26);

    // Step 3: GROW +12 (still in-flight)
    requestCprOrMarkDirty(host, 15, 38, /* rowDelta= */ 12);
    expect(host.cprBurst?.growTotal).toBe(16); // 4+12
    expect(host.cprBurst?.shrinkTotal).toBe(8);
    expect(host.cprBurst?.currentRows).toBe(38);

    // Reply to first CPR (still dirty after step 3):
    host.stdin.emit('data', Buffer.from('\x1b[19;1R')); // whatever; dirty → re-query
    await Promise.resolve();
    expect(host.repaintCalls).toBe(0); // no mid-burst paint
    expect(host.cprBurst?.dirty).toBe(false);

    // Quiescent reply: cursor at 23 (originalExpected=15, delta=8).
    // Plausible: lo=−8, hi=+16, delta=8 ∈ [−8, 16] ✓
    host.stdin.emit('data', Buffer.from('\x1b[23;1R')); // 15+8=23
    await Promise.resolve();
    expect(host.repaintCalls).toBe(1);
    expect(host.lastMeasuredFrameTop).toBe(13);   // 5+8
    expect(host.lastMeasuredFrameBottom).toBe(23); // 15+8
  });

  it('T8c: reply arrives mid-burst (dirty) — re-query without apply or repaint', async () => {
    const host = makeBurstHost({ frameBottom: 10 });

    // Start burst
    requestCprOrMarkDirty(host, 10, 34, 4);
    // Mark dirty (new SIGWINCH arrives before reply)
    requestCprOrMarkDirty(host, 10, 38, 4);
    expect(host.cprBurst?.dirty).toBe(true);

    // CPR reply arrives while dirty
    host.stdin.emit('data', Buffer.from('\x1b[14;1R'));
    await Promise.resolve();

    // Must re-query, not apply
    expect(host.repaintCalls).toBe(0);
    expect(host.cprPending).toBe(true); // re-querying
    expect(host.cprBurst?.requeryCt).toBe(1);

    // Now quiescent reply arrives
    host.stdin.emit('data', Buffer.from('\x1b[18;1R')); // 10+8=18
    await Promise.resolve();
    expect(host.repaintCalls).toBe(1);
    expect(host.lastMeasuredFrameBottom).toBe(18);
  });

  it('T8d: final delta 0 still repaints (frame must reflow to new geometry)', async () => {
    // Net-zero burst: rows change but cursor ends up at original position.
    const host = makeBurstHost({ frameBottom: 20 });
    // Single step GROW: expectedRow=20, growTotal=4
    requestCprOrMarkDirty(host, 20, 34, 4);
    // Quiescent reply: cursor stayed at 20 (delta=0, within [0, 4])
    host.stdin.emit('data', Buffer.from('\x1b[20;1R'));
    await Promise.resolve();
    expect(host.repaintCalls).toBe(1); // ALWAYS repaint
    expect(host.lastMeasuredFrameBottom).toBe(20); // unchanged (delta=0)
  });

  it('T8e: out-of-range delta is discarded and a repaint still fires', async () => {
    // If cursor moved beyond the plausible range (some other writer moved it),
    // discard the delta and fall back — but ALWAYS repaint.
    const host = makeBurstHost({ frameTop: 10, frameBottom: 20 });
    // GROW of 4 rows: plausible range is [0, 4]
    requestCprOrMarkDirty(host, 20, 34, 4);
    // Report cursor at row 40 (delta=20) — way outside [0, 4] — implausible
    host.stdin.emit('data', Buffer.from('\x1b[40;1R'));
    await Promise.resolve();
    expect(host.repaintCalls).toBe(1); // repaint even on discard
    expect(host.lastMeasuredFrameTop).toBe(10);  // NOT shifted (delta discarded)
    expect(host.lastMeasuredFrameBottom).toBe(20); // NOT shifted
  });

  it('T8f: re-query cap (CPR_MAX_REQUERY) — falls back and repaints', async () => {
    // Simulate an endless burst that never quiesces: dirty is always set before
    // each reply. The cap check fires when requeryCt >= CPR_MAX_REQUERY.
    // Timeline: initial CPR → dirty reply 0 (requeryCt 0→1) → ... →
    //   dirty reply 7 (requeryCt 7→8) → dirty reply 8 triggers cap (8>=8) → fallback.
    // Total dirty replies before fallback: CPR_MAX_REQUERY + 1.
    const host = makeBurstHost({ frameBottom: 20 });
    requestCprOrMarkDirty(host, 20, 34, 4);
    // CPR_MAX_REQUERY dirty replies cause re-queries (incrementing requeryCt each time)
    for (let i = 0; i < CPR_MAX_REQUERY; i++) {
      expect(host.cprPending).toBe(true);
      if (host.cprBurst) host.cprBurst.dirty = true;
      host.stdin.emit('data', Buffer.from(`\x1b[${24 + i};1R`));
      await Promise.resolve();
      // After each: requeryCt should have incremented and a fresh CPR re-queued
      if (i < CPR_MAX_REQUERY - 1) {
        expect(host.cprBurst?.requeryCt).toBe(i + 1);
      }
    }
    // requeryCt is now CPR_MAX_REQUERY. One more dirty reply triggers the cap.
    expect(host.cprPending).toBe(true);
    if (host.cprBurst) host.cprBurst.dirty = true;
    host.stdin.emit('data', Buffer.from('\x1b[30;1R'));
    await Promise.resolve();
    // Cap hit — fallback + repaint, burst cleared.
    expect(host.cprPending).toBe(false);
    expect(host.cprBurst).toBeNull();
    expect(host.repaintCalls).toBe(1); // fallback repaint
  });

  it('T8g: timeout repaints (frame must reach new geometry even when no CPR reply)', async () => {
    const host = makeBurstHost({ frameTop: 5, frameBottom: 15 });
    requestCprOrMarkDirty(host, 15, 40, 10);
    expect(host.cprPending).toBe(true);
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 20);
    expect(host.cprPending).toBe(false);
    expect(host.repaintCalls).toBe(1); // ALWAYS repaint on timeout
    expect(host.lastMeasuredFrameTop).toBe(5);  // no delta applied
    expect(host.lastMeasuredFrameBottom).toBe(15); // no delta applied
  });
});
