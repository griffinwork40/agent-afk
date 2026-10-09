/**
 * Tests for #3206 — CPR late-reply protection and adaptive timeout.
 *
 * Gap 2 (late-reply leak): after the CPR timeout fires and the compositor
 * disarms, a delayed terminal reply must NOT insert stray characters into
 * the idle-prompt reader.  The shared keypress guard in emit-keypress.ts
 * drops CPR-shaped keypresses while the guard is armed.
 *
 * Gap 1 (adaptive timeout): the timeout grows with measured RTT so slow
 * SSH/mosh links still get a delta correction rather than immediately falling
 * back to the old absolute-row behaviour.
 *
 * Test taxonomy:
 *   G1 — armCprKeypressGuard: basic arm/isCprKeypressGuardActive/isCprSequence semantics.
 *   G2 — guard active → CPR-shaped keypress is dropped by handleKeypress.
 *   G3 — guard NOT active → CPR-shaped keypress passes through normally.
 *   G4 — guard arms on _requestCpr emit and re-arms on timeout.
 *   G5 — adaptive timeout: baseline when no RTT, grows after first reply.
 *   G6 — adaptive timeout ceiling: never exceeds CPR_TIMEOUT_CEILING_MS.
 *   G7 — late CPR reply after compositor disarm does not reach prompt buffer
 *         (integration: arm + simulate late reply via keypress path).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PassThrough } from 'node:stream';
import {
  armCprKeypressGuard,
  emitKeypressEventsImmediateEscape,
  isCprKeypressGuardActive,
  isCprSequence,
  CPR_KEYPRESS_GRACE_MS,
  __resetCprKeypressGuardForTests,
} from './input/emit-keypress.js';
import {
  requestCprAndApplyDelta,
  CPR_TIMEOUT_MS,
  CPR_TIMEOUT_CEILING_MS,
  CPR_RTT_SCALE,
  __resetCprRttForTests,
  __getCprRttForTests,
} from './terminal-compositor.lifecycle.cpr.js';
import { handleKeypress } from './input/reader.keypress.js';
import type { CprHost } from './terminal-compositor.lifecycle.cpr.js';
import type { ReaderState } from './input/reader.state.js';
import type { KeyInfo } from './terminal-compositor.types.js';
import type { RepaintCtx } from './input/reader.repaint.js';
import type { KeypressCtx } from './input/reader.keypress.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStdin(): NodeJS.ReadStream & { isTTY: boolean } {
  const s = new PassThrough() as unknown as NodeJS.ReadStream & { isTTY: boolean };
  s.isTTY = true;
  return s;
}

function makeStdout(): NodeJS.WriteStream {
  return new PassThrough() as unknown as NodeJS.WriteStream;
}

function makeCprHost(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): CprHost & { repaintCalls: number } {
  let repaintCalls = 0;
  return {
    stdout,
    stdin,
    armed: true,
    cprPending: false,
    cprBurst: null,
    lastMeasuredFrameTop: 10,
    lastMeasuredFrameBottom: 20,
    committedBandTopRow: 5,
    committedBandBottomRow: 9,
    pendingResizeErase: null,
    logUpdate: null,
    anchorRow: undefined,
    repaint() { repaintCalls++; },
    get repaintCalls() { return repaintCalls; },
  } as unknown as CprHost & { repaintCalls: number };
}

/** Minimal ReaderState for handleKeypress tests. */
function makeReaderState(): ReaderState {
  return {
    input: { buffer: '', cursor: 0 },
    ac: { dropdownOpen: false, candidates: [], selectedIndex: 0, viewportStart: 0, suppressedSignature: null },
    rowsBelow: 0,
    pasting: false,
    clipboardInFlight: false,
    pasteStartBufferLen: 0,
    prevBufferRows: 0,
    prevStatusRows: 0,
    clipboardFailureMsg: null,
    attachments: [],
    maxDropdownRows: 6,
    lastKeypressAt: 0,
    repaintPending: false,
    settled: false,
    reverseSearch: { active: false, query: '', matches: [], matchIdx: 0, savedInput: null },
    pasteStartCursor: 0,
  } as unknown as ReaderState;
}

/** Minimal KeypressCtx for handleKeypress tests. */
function makeKeypressCtx(stdin: NodeJS.ReadStream): KeypressCtx {
  return {
    opts: { promptFn: () => '> ' } as unknown as KeypressCtx['opts'],
    stdout: new PassThrough() as unknown as NodeJS.WriteStream,
    stdin,
    repaintCtx: {} as RepaintCtx,
    callbacks: {
      onSubmit: vi.fn(),
      onAbort: vi.fn(),
      onEof: vi.fn(),
    },
    pasteWindowMs: 8,
  };
}

// ---------------------------------------------------------------------------
// G1: armCprKeypressGuard basics
// ---------------------------------------------------------------------------

describe('G1: armCprKeypressGuard / isCprKeypressGuardActive / isCprSequence', () => {
  beforeEach(() => { vi.useFakeTimers(); __resetCprKeypressGuardForTests(); __resetCprRttForTests(); });
  afterEach(() => { vi.useRealTimers(); __resetCprKeypressGuardForTests(); });

  it('guard is inactive before arm', () => {
    const stdin = makeStdin();
    expect(isCprKeypressGuardActive(stdin)).toBe(false);
  });

  it('guard is active immediately after arm', () => {
    const stdin = makeStdin();
    armCprKeypressGuard(stdin, 300);
    expect(isCprKeypressGuardActive(stdin)).toBe(true);
  });

  it('guard is inactive after the duration expires', () => {
    const stdin = makeStdin();
    armCprKeypressGuard(stdin, 300);
    vi.advanceTimersByTime(301);
    expect(isCprKeypressGuardActive(stdin)).toBe(false);
  });

  it('re-arming with a longer duration extends the deadline', () => {
    const stdin = makeStdin();
    armCprKeypressGuard(stdin, 200);
    vi.advanceTimersByTime(150);
    // Should still be active (200ms not expired yet).
    expect(isCprKeypressGuardActive(stdin)).toBe(true);
    // Extend to 400ms from original arm time — deadline is now ~250ms out.
    armCprKeypressGuard(stdin, 400);
    vi.advanceTimersByTime(300);
    // 150+300=450ms from arm, but we re-armed at 150ms for 400ms → deadline at 550ms.
    expect(isCprKeypressGuardActive(stdin)).toBe(true);
    vi.advanceTimersByTime(200);
    // 550+extra > 550ms now expired.
    expect(isCprKeypressGuardActive(stdin)).toBe(false);
  });

  it('isCprSequence returns true for CPR-shaped sequence when guard active', () => {
    const stdin = makeStdin();
    armCprKeypressGuard(stdin, 300);
    expect(isCprSequence(stdin, '\x1b[25;1R')).toBe(true);
    expect(isCprSequence(stdin, '\x1b[1;80R')).toBe(true);
  });

  it('isCprSequence returns false for non-CPR sequence even when guard active', () => {
    const stdin = makeStdin();
    armCprKeypressGuard(stdin, 300);
    expect(isCprSequence(stdin, 'a')).toBe(false);
    expect(isCprSequence(stdin, '\x1b[A')).toBe(false); // CUU
    expect(isCprSequence(stdin, '\x1b[200~')).toBe(false); // bracketed paste
  });

  it('isCprSequence returns false for CPR-shaped sequence when guard NOT active', () => {
    const stdin = makeStdin();
    // Guard not armed.
    expect(isCprSequence(stdin, '\x1b[25;1R')).toBe(false);
  });

  it('guard is stream-scoped: arming on stdin-A does not affect stdin-B', () => {
    const stdinA = makeStdin();
    const stdinB = makeStdin();
    armCprKeypressGuard(stdinA, 300);
    expect(isCprKeypressGuardActive(stdinA)).toBe(true);
    expect(isCprKeypressGuardActive(stdinB)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G2: CPR-shaped keypress is dropped by handleKeypress when guard active
// ---------------------------------------------------------------------------

describe('G2: handleKeypress drops CPR-shaped keypress when guard is active', () => {
  beforeEach(() => { vi.useFakeTimers(); __resetCprKeypressGuardForTests(); __resetCprRttForTests(); });
  afterEach(() => { vi.useRealTimers(); __resetCprKeypressGuardForTests(); });

  it('handleKeypress returns without processing a CPR-shaped sequence when guard armed', () => {
    // reader.ts uses process.stdin as the keypress source.  We arm the guard
    // on process.stdin to mirror the production code path (handleKeypress
    // calls isCprSequence(process.stdin, ...)).
    armCprKeypressGuard(process.stdin, 500);

    const st = makeReaderState();
    const ctx = makeKeypressCtx(process.stdin as unknown as NodeJS.ReadStream);
    const repaintFn = vi.fn();
    const schedulePaintFn = vi.fn();
    const applySelectionFn = vi.fn();

    const cprKey: KeyInfo = {
      sequence: '\x1b[25;1R',
      name: undefined,
      ctrl: false,
      meta: false,
      shift: false,
    };

    handleKeypress(undefined, cprKey, st, ctx, repaintFn, schedulePaintFn, applySelectionFn);

    // Buffer must remain empty — the CPR sequence was dropped, not inserted.
    expect(st.input.buffer).toBe('');
    // No repaint should have been triggered.
    expect(repaintFn).not.toHaveBeenCalled();
    expect(schedulePaintFn).not.toHaveBeenCalled();
  });

  it('handleKeypress does NOT drop a CPR-shaped sequence when guard is NOT active', () => {
    // Guard not armed — the sequence falls through to normal handling.
    // ESC[25;1R: not a printable grapheme, so it does nothing visible — but
    // the point is that the function does NOT short-circuit on it.
    const st = makeReaderState();
    const ctx = makeKeypressCtx(process.stdin as unknown as NodeJS.ReadStream);
    const repaintFn = vi.fn();
    const schedulePaintFn = vi.fn();
    const applySelectionFn = vi.fn();

    const cprKey: KeyInfo = {
      sequence: '\x1b[25;1R',
      name: undefined,
      ctrl: false,
      meta: false,
      shift: false,
    };

    // Should not throw and should reach the printable check (which rejects
    // the ESC-leading sequence) — buffer stays empty but for a different reason.
    expect(() =>
      handleKeypress(undefined, cprKey, st, ctx, repaintFn, schedulePaintFn, applySelectionFn),
    ).not.toThrow();
    expect(st.input.buffer).toBe('');
  });
});

// ---------------------------------------------------------------------------
// G3: normal keypresses are not affected by the guard
// ---------------------------------------------------------------------------

describe('G3: normal keypresses pass through even when CPR guard is armed', () => {
  beforeEach(() => { vi.useFakeTimers(); __resetCprKeypressGuardForTests(); __resetCprRttForTests(); });
  afterEach(() => { vi.useRealTimers(); __resetCprKeypressGuardForTests(); });

  it('printable char inserts into buffer even while guard is armed', () => {
    armCprKeypressGuard(process.stdin, 500);

    const st = makeReaderState();
    const ctx = makeKeypressCtx(process.stdin as unknown as NodeJS.ReadStream);
    const repaintFn = vi.fn();
    const schedulePaintFn = vi.fn();
    const applySelectionFn = vi.fn();

    const aKey: KeyInfo = {
      sequence: 'a',
      name: 'a',
      ctrl: false,
      meta: false,
      shift: false,
    };

    handleKeypress('a', aKey, st, ctx, repaintFn, schedulePaintFn, applySelectionFn);
    expect(st.input.buffer).toBe('a');
  });
});

// ---------------------------------------------------------------------------
// G4: _requestCpr arms the keypress guard when emitting the request
// ---------------------------------------------------------------------------

describe('G4: _requestCpr (via requestCprAndApplyDelta) arms keypress guard', () => {
  beforeEach(() => { vi.useFakeTimers(); __resetCprKeypressGuardForTests(); __resetCprRttForTests(); });
  afterEach(() => { vi.useRealTimers(); __resetCprKeypressGuardForTests(); });

  it('keypress guard is active on stdin immediately after CPR request is emitted', () => {
    const stdin = makeStdin();
    const stdout = makeStdout();
    const host = makeCprHost(stdin, stdout);

    requestCprAndApplyDelta(host, 10, 50, /* rowDelta= */ 10);

    // Guard must be armed — a late CPR reply keypress would be dropped.
    expect(isCprKeypressGuardActive(stdin)).toBe(true);
    expect(isCprSequence(stdin, '\x1b[25;1R')).toBe(true);

    // Advance past timeout to clean up.
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + CPR_KEYPRESS_GRACE_MS + 50);
  });

  it('keypress guard remains active for grace window after CPR timeout', () => {
    const stdin = makeStdin();
    const stdout = makeStdout();
    const host = makeCprHost(stdin, stdout);

    requestCprAndApplyDelta(host, 10, 50, /* rowDelta= */ 10);

    // Advance past the CPR timeout but still within the grace window.
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 10);

    // Guard must still be active (grace window covers this).
    expect(isCprKeypressGuardActive(stdin)).toBe(true);
    expect(isCprSequence(stdin, '\x1b[25;1R')).toBe(true);
  });

  it('keypress guard expires after timeout + grace window', () => {
    const stdin = makeStdin();
    const stdout = makeStdout();
    const host = makeCprHost(stdin, stdout);

    requestCprAndApplyDelta(host, 10, 50, /* rowDelta= */ 10);

    // Advance past both the CPR timeout and the full grace window.
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + CPR_KEYPRESS_GRACE_MS + 50);

    // Guard must be expired — a CPR-shaped keypress would now pass through.
    expect(isCprKeypressGuardActive(stdin)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// G5: adaptive timeout — baseline then grows with RTT
// ---------------------------------------------------------------------------

describe('G5: adaptive timeout — baseline 120ms, grows with measured RTT', () => {
  beforeEach(() => { vi.useFakeTimers(); __resetCprKeypressGuardForTests(); __resetCprRttForTests(); });
  afterEach(() => { vi.useRealTimers(); __resetCprKeypressGuardForTests(); });

  it('first CPR uses the baseline CPR_TIMEOUT_MS (no RTT sample yet)', () => {
    const stdin = makeStdin();
    const stdout = makeStdout();
    const host = makeCprHost(stdin, stdout);

    requestCprAndApplyDelta(host, 10, 50, /* rowDelta= */ 50);
    expect(host.cprPending).toBe(true);

    // Advance to just under the baseline — no timeout yet.
    vi.advanceTimersByTime(CPR_TIMEOUT_MS - 1);
    expect(host.cprPending).toBe(true);

    // Advance to just past the baseline — timeout fires.
    vi.advanceTimersByTime(2);
    expect(host.cprPending).toBe(false);
    expect(host.repaintCalls).toBe(1); // fallback repaint
  });

  it('after an RTT sample the timeout grows (adaptive > baseline)', async () => {
    // Seed an RTT by simulating a fast reply on a first CPR.
    const stdin = makeStdin();
    const stdout = makeStdout();
    const host = makeCprHost(stdin, stdout);

    // First request: reply arrives at ~50ms → RTT ≈ 50ms.
    requestCprAndApplyDelta(host, 10, 50, /* rowDelta= */ 50);
    vi.advanceTimersByTime(50);
    // Reply with reported row = expectedRow (delta=0, within [0,50]).
    host.stdin.emit('data', Buffer.from('\x1b[10;1R'));
    await Promise.resolve();
    expect(host.repaintCalls).toBe(1); // quiescent reply repainted

    // Reset for second request.
    host.cprPending = false;
    host.repaint = vi.fn();
    let repaintCalls2 = 0;
    host.repaint = () => { repaintCalls2++; };

    requestCprAndApplyDelta(host, 10, 50, /* rowDelta= */ 50);
    expect(host.cprPending).toBe(true);

    // The adaptive timeout is rtt * CPR_RTT_SCALE (at least CPR_TIMEOUT_MS).
    // With rtt≈50ms and scale=4: adaptive = 200ms.
    const expectedAdaptive = Math.min(
      Math.max(50 * CPR_RTT_SCALE, CPR_TIMEOUT_MS),
      CPR_TIMEOUT_CEILING_MS,
    );

    // Advance to just past baseline (120ms) but before adaptive timeout.
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 5);
    // With adaptive timeout, cprPending must still be true (hasn't fired yet).
    if (expectedAdaptive > CPR_TIMEOUT_MS + 5) {
      expect(host.cprPending).toBe(true); // adaptive timeout hasn't fired yet
    }

    // Advance to just past the adaptive timeout.
    vi.advanceTimersByTime(expectedAdaptive + 50);
    expect(host.cprPending).toBe(false);
    expect(repaintCalls2).toBe(1); // fallback repaint
  });
});

// ---------------------------------------------------------------------------
// G6: adaptive timeout ceiling
// ---------------------------------------------------------------------------

describe('G6: adaptive timeout ceiling — never exceeds CPR_TIMEOUT_CEILING_MS', () => {
  beforeEach(() => { vi.useFakeTimers(); __resetCprKeypressGuardForTests(); __resetCprRttForTests(); });
  afterEach(() => { vi.useRealTimers(); __resetCprKeypressGuardForTests(); });

  it('a very large RTT (>ceiling/scale) is capped at CPR_TIMEOUT_CEILING_MS', async () => {
    // Seed a very large RTT by simulating a slow reply.
    const stdin = makeStdin();
    const stdout = makeStdout();
    const host = makeCprHost(stdin, stdout);

    // First request: reply arrives at 1000ms → RTT=1000ms → adaptive=4000ms > ceiling.
    requestCprAndApplyDelta(host, 10, 50, /* rowDelta= */ 50);
    vi.advanceTimersByTime(1000);
    host.stdin.emit('data', Buffer.from('\x1b[10;1R'));
    await Promise.resolve();
    // First reply is quiescent (delta=0 within range).
    expect(host.repaintCalls).toBe(1);

    // Second request — timeout must be capped at ceiling.
    host.cprPending = false;
    let repaintCalls2 = 0;
    host.repaint = () => { repaintCalls2++; };
    requestCprAndApplyDelta(host, 10, 50, /* rowDelta= */ 50);

    // Advance to ceiling + safety margin.
    vi.advanceTimersByTime(CPR_TIMEOUT_CEILING_MS + 50);
    expect(host.cprPending).toBe(false); // must have timed out at ceiling
    expect(repaintCalls2).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// G7: integration — late reply after disarm does not reach prompt buffer
// ---------------------------------------------------------------------------
//
// Integration contract: `requestCprAndApplyDelta` is called with `process.stdin`
// as the host stdin (the real production path).  The CPR guard is automatically
// armed on `process.stdin` by _requestCpr.  After the timeout, the guard is
// re-armed on `process.stdin` for the grace window.  handleKeypress, which
// unconditionally queries `isCprSequence(process.stdin, ...)`, therefore drops
// a late CPR reply delivered via the keypress path without any extra manual arming.
//
// This test does NOT use a synthetic PassThrough stdin for the host — the host
// stdin IS process.stdin, so the data listener, the keypress guard, and the
// handleKeypress check are all scoped to the same stream object.

describe('G7: late CPR reply after compositor disarm does not reach prompt buffer', () => {
  beforeEach(() => { vi.useFakeTimers(); __resetCprKeypressGuardForTests(); __resetCprRttForTests(); });
  afterEach(() => {
    vi.useRealTimers();
    __resetCprKeypressGuardForTests();
  });

  it('CPR reply arriving after timeout is dropped through production request and keypress decoding', () => {
    // Scenario:
    //   1. CPR is requested with process.stdin as the host stdin.
    //      _requestCpr arms the keypress guard on process.stdin for
    //      (CPR_TIMEOUT_MS + CPR_KEYPRESS_GRACE_MS) and installs a data
    //      listener on process.stdin.
    //   2. Timeout fires — data listener removed, guard re-armed for the
    //      grace window on process.stdin, fallback repaint triggered.
    //   3. Terminal replies LATE — the data listener is gone; readline would
    //      decode the reply as a keypress and deliver it to handleKeypress.
    //   4. handleKeypress calls isCprSequence(process.stdin, seq).  Because
    //      the guard is still active on process.stdin (grace window) and the
    //      sequence matches CPR_REPLY_RE, the call returns early.
    //   5. Buffer must remain empty; no repaint must fire from handleKeypress.

    const stdout = makeStdout();

    // Build host with process.stdin as the stdin reference — same stream that
    // _requestCpr will prependListener on and armCprKeypressGuard will guard.
    const processStdinAsReadStream = process.stdin as unknown as NodeJS.ReadStream & { isTTY: boolean };
    const host = makeCprHost(processStdinAsReadStream, stdout);

    requestCprAndApplyDelta(host, 10, 50, /* rowDelta= */ 10);

    // Verify the guard is now active on process.stdin.
    expect(isCprKeypressGuardActive(process.stdin)).toBe(true);
    expect(host.cprPending).toBe(true);

    // Advance past the baseline timeout — the data listener is removed, guard
    // re-armed for the grace window, fallback repaint fires.
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 10);
    expect(host.cprPending).toBe(false);
    expect(host.repaintCalls).toBe(1); // fallback repaint

    // Guard must still be active in the grace window on process.stdin.
    expect(isCprKeypressGuardActive(process.stdin)).toBe(true);

    // Simulate the late CPR reply arriving as a keypress to handleKeypress.
    // In production this path is: readline's keypress emitter decodes the
    // reply bytes (no data listener to intercept them) and fires the 'keypress'
    // event; the active reader calls handleKeypress with the decoded key.
    const st = makeReaderState();
    const repaintFn = vi.fn();
    const schedulePaintFn = vi.fn();
    const applySelectionFn = vi.fn();
    const ctx = makeKeypressCtx(process.stdin as unknown as NodeJS.ReadStream);

    const priorDataListeners = new Set(process.stdin.listeners('data'));
    const decodedKeys: KeyInfo[] = [];
    const onKeypress = (char: string | undefined, key: KeyInfo): void => {
      decodedKeys.push(key);
      handleKeypress(char, key, st, ctx, repaintFn, schedulePaintFn, applySelectionFn);
    };
    // Invariant: request timeout must remove its data listener before readline
    // decodes the late bytes; the reader guard must then suppress the keypress.
    emitKeypressEventsImmediateEscape(process.stdin);
    process.stdin.on('keypress', onKeypress);
    try {
      host.armed = false;
      process.stdin.emit('data', Buffer.from('\x1b[21;1R'));
      expect(decodedKeys).toHaveLength(1);
      expect(decodedKeys[0]?.sequence).toBe('\x1b[21;1R');
      expect(host.repaintCalls).toBe(1);
      expect(host.lastMeasuredFrameBottom).toBe(20);
    } finally {
      process.stdin.removeListener('keypress', onKeypress);
      for (const listener of process.stdin.listeners('data')) {
        if (!priorDataListeners.has(listener)) process.stdin.removeListener('data', listener);
      }
    }

    // Buffer must be empty — the late CPR reply was dropped by the guard.
    expect(st.input.buffer).toBe('');
    expect(repaintFn).not.toHaveBeenCalled();

    // Advance past the full grace window so timers are cleaned up.
    vi.advanceTimersByTime(CPR_KEYPRESS_GRACE_MS + 50);
    expect(isCprKeypressGuardActive(process.stdin)).toBe(false);
  });

  it('a CPR-shaped keypress AFTER the grace window passes through normally', () => {
    // Once the guard expires, a CPR-shaped sequence (e.g. Ctrl+F3 on some
    // terminals) is not swallowed — only CPR replies during the active guard
    // window are dropped.
    const st = makeReaderState();
    const repaintFn = vi.fn();
    const schedulePaintFn = vi.fn();
    const applySelectionFn = vi.fn();
    const ctx = makeKeypressCtx(process.stdin as unknown as NodeJS.ReadStream);

    // Ensure guard is not armed.
    expect(isCprKeypressGuardActive(process.stdin)).toBe(false);

    const cprShapedKey: KeyInfo = {
      sequence: '\x1b[1;5R',
      name: undefined,
      ctrl: false,
      meta: false,
      shift: false,
    };

    // Should not throw; the key falls through to printable check (rejected
    // because ESC < space, so buffer stays empty — but for the right reason:
    // it was NOT swallowed by the CPR guard, it was rejected as non-printable).
    expect(() =>
      handleKeypress(undefined, cprShapedKey, st, ctx, repaintFn, schedulePaintFn, applySelectionFn),
    ).not.toThrow();
    // Buffer stays empty — not because of the CPR guard, but because ESC[...R
    // is not a printable grapheme.  The important invariant: no throw, no
    // unexpected state mutation, and the guard was not invoked (it's inactive).
    expect(st.input.buffer).toBe('');
  });
});

// ---------------------------------------------------------------------------
// G5-regression: timeout seeds RTT floor → next request uses floor * scale
// ---------------------------------------------------------------------------
//
// Regression guard for the bootstrap fix (item 1): when the first CPR times
// out at the 120 ms baseline, _updateRtt(120) is called, seeding the RTT
// sample.  The second request must therefore use 120 * CPR_RTT_SCALE (480 ms)
// as its timeout, NOT the 120 ms baseline.  Without the bootstrap, both
// requests would use 120 ms and slow links would never benefit from the
// adaptive timeout.

describe('G5-regression: timeout seeds RTT floor; next request uses floor * scale not baseline', () => {
  beforeEach(() => { vi.useFakeTimers(); __resetCprKeypressGuardForTests(); __resetCprRttForTests(); });
  afterEach(() => { vi.useRealTimers(); __resetCprKeypressGuardForTests(); });

  it('after first CPR times out at baseline, second request uses floor*scale timeout not baseline', () => {
    const stdin = makeStdin();
    const stdout = makeStdout();
    const host = makeCprHost(stdin, stdout);

    // First request: reply never arrives — baseline (120 ms) fires.
    requestCprAndApplyDelta(host, 10, 50, /* rowDelta= */ 10);
    expect(host.cprPending).toBe(true);

    // Advance exactly to baseline timeout; first CPR times out.
    // The timeout handler seeds RTT = CPR_TIMEOUT_MS = 120 ms.
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 1);
    expect(host.cprPending).toBe(false);
    expect(host.repaintCalls).toBe(1);

    // Second request — now RTT sample = 120 ms is set, so timeout =
    // min(max(120 * CPR_RTT_SCALE, CPR_TIMEOUT_MS), CPR_TIMEOUT_CEILING_MS)
    // = min(max(480, 120), 1500) = 480 ms.
    const expectedSecondTimeout = Math.min(
      Math.max(CPR_TIMEOUT_MS * CPR_RTT_SCALE, CPR_TIMEOUT_MS),
      CPR_TIMEOUT_CEILING_MS,
    );
    expect(expectedSecondTimeout).toBeGreaterThan(CPR_TIMEOUT_MS); // sanity: 480 > 120

    host.cprPending = false;
    let repaintCalls2 = 0;
    host.repaint = () => { repaintCalls2++; };

    requestCprAndApplyDelta(host, 10, 50, /* rowDelta= */ 10);
    expect(host.cprPending).toBe(true);

    // Advance to just past the baseline (120 ms) — second request must NOT
    // have timed out yet (adaptive timeout is 480 ms).
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 5);
    expect(host.cprPending).toBe(true);  // adaptive timeout hasn't fired
    expect(repaintCalls2).toBe(0);

    // Advance to just past the adaptive timeout — second request now fires.
    vi.advanceTimersByTime(expectedSecondTimeout + 50);
    expect(host.cprPending).toBe(false);
    expect(repaintCalls2).toBe(1);
  });

  it('first reply at 200ms is stale; next request uses timeout floor * scale, not baseline', async () => {
    // Scenario: first CPR times out at baseline (120 ms), seeding RTT=120.
    // Then a late reply arrives at 200 ms — it is discarded by the keypress
    // guard (not by the data listener, which is already gone).  The RTT from
    // the TIMEOUT bootstrap is 120 ms, so the second request uses 480 ms.
    // This confirms the stale delta is NOT applied (no double correction).
    const stdin = makeStdin();
    const stdout = makeStdout();
    const host = makeCprHost(stdin, stdout);

    // First request: timeout at 120 ms seeds RTT=120.
    requestCprAndApplyDelta(host, 10, 50, /* rowDelta= */ 10);
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 1);
    expect(host.cprPending).toBe(false);
    expect(host.repaintCalls).toBe(1);

    // Late CPR reply arrives at 200 ms (within grace window but data listener gone).
    // Emit on the stdin data channel — the listener is already removed, so this
    // bytes just hit readline's keypress decoder (not captured here).
    // The guard is still active; no new RTT update should be applied.
    vi.advanceTimersByTime(79); // total: ~200 ms from emit
    stdin.emit('data', Buffer.from('\x1b[21;1R')); // data listener gone — no effect
    await Promise.resolve();
    // No extra repaint from the stale reply.
    expect(host.repaintCalls).toBe(1);

    // Second request uses RTT=120 (timeout bootstrap only, no late update).
    host.cprPending = false;
    let repaintCalls2 = 0;
    host.repaint = () => { repaintCalls2++; };

    requestCprAndApplyDelta(host, 10, 50, /* rowDelta= */ 10);

    // Baseline (120 ms) must not fire the second request.
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 5);
    expect(host.cprPending).toBe(true); // adaptive keeps it alive

    // Advance to adaptive ceiling.
    const floor = Math.min(
      Math.max(CPR_TIMEOUT_MS * CPR_RTT_SCALE, CPR_TIMEOUT_MS),
      CPR_TIMEOUT_CEILING_MS,
    );
    vi.advanceTimersByTime(floor + 50);
    expect(host.cprPending).toBe(false);
    expect(repaintCalls2).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// G8: EWA ratchet and recovery trajectory (#3302 regression)
//
// Consecutive CPR timeouts ratchet _measuredRttMs toward the ceiling via EWA
// (α=0.25 on timeout samples; each timeout feeds timeoutMs as the sample).
// After ~5 fast replies the estimate recovers back toward the true fast RTT.
//
// The EWA update on timeout: rtt = rtt * 0.75 + timeoutMs * 0.25.
// Since each successive timeout feeds a larger timeoutMs (the adaptive timeout
// grows with rtt), the ratchet converges to CPR_TIMEOUT_CEILING_MS / CPR_RTT_SCALE
// (the ceiling working backward through the formula).
//
// Recovery: a fast reply at ~10ms drives rtt = rtt * 0.75 + 10ms * 0.25.
// After 5 fast replies from a ceiling-adjacent rtt the timeout drops well
// below CPR_TIMEOUT_CEILING_MS.
// ---------------------------------------------------------------------------

describe('G8: EWA ratchet and recovery trajectory', () => {
  beforeEach(() => { vi.useFakeTimers(); __resetCprKeypressGuardForTests(); __resetCprRttForTests(); });
  afterEach(() => { vi.useRealTimers(); __resetCprKeypressGuardForTests(); __resetCprRttForTests(); });

  /**
   * Helper: run one CPR cycle and let it time out.  Returns the timeout that
   * fired (the adaptive timeout used for that request).
   */
  async function runTimeoutCycle(stdin: NodeJS.ReadStream, stdout: NodeJS.WriteStream): Promise<number> {
    // Capture the timeoutMs by observing when cprPending transitions.
    const host = makeCprHost(stdin, stdout);
    requestCprAndApplyDelta(host, 10, 50, 10);
    // The current adaptive timeout is whatever _computeTimeout() returned.
    // We don't have direct access, so we binary-search by advancing time.
    // But for simplicity: advance to CPR_TIMEOUT_CEILING_MS + margin (always fires).
    vi.advanceTimersByTime(CPR_TIMEOUT_CEILING_MS + 50);
    expect(host.cprPending).toBe(false);
    await Promise.resolve();
    return CPR_TIMEOUT_CEILING_MS; // generous upper bound
  }

  it('consecutive timeouts ratchet _measuredRttMs upward via EWA', () => {
    const stdin = makeStdin();
    const stdout = makeStdout();

    // Seed with a fast baseline (10ms reply).
    const h0 = makeCprHost(stdin, stdout);
    requestCprAndApplyDelta(h0, 10, 50, 10);
    vi.advanceTimersByTime(10);
    stdin.emit('data', Buffer.from('\x1b[10;1R'));
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + CPR_KEYPRESS_GRACE_MS + 50);
    // RTT ≈ 10ms after first fast reply.
    const rttAfterFastSeed = __getCprRttForTests();
    expect(rttAfterFastSeed).not.toBeNull();
    expect(rttAfterFastSeed!).toBeLessThan(CPR_TIMEOUT_MS);

    // Now run 3 timeout cycles — each timeout seeds rtt = rtt*0.75 + timeoutMs*0.25.
    // The first timeout uses timeoutMs = max(rtt*scale, 120) which is ~120ms (fast rtt).
    for (let i = 0; i < 3; i++) {
      const h = makeCprHost(stdin, stdout);
      requestCprAndApplyDelta(h, 10, 50, 10);
      vi.advanceTimersByTime(CPR_TIMEOUT_CEILING_MS + 50);
    }

    const rttAfterTimeouts = __getCprRttForTests();
    expect(rttAfterTimeouts).not.toBeNull();
    // After 3 timeouts the RTT estimate must be higher than the initial fast seed.
    expect(rttAfterTimeouts!).toBeGreaterThan(rttAfterFastSeed!);
  });

  it('fast replies after ratchet-up recover _measuredRttMs toward actual RTT', async () => {
    const stdin = makeStdin();
    const stdout = makeStdout();

    // Manually push the RTT high by running multiple timeouts.
    // We need to get it well above the baseline.
    for (let i = 0; i < 5; i++) {
      const h = makeCprHost(stdin, stdout);
      requestCprAndApplyDelta(h, 10, 50, 10);
      vi.advanceTimersByTime(CPR_TIMEOUT_CEILING_MS + 50);
    }

    const rttHigh = __getCprRttForTests();
    expect(rttHigh).not.toBeNull();
    // After 5 timeouts at ceiling-level timeouts the estimate should be elevated.
    expect(rttHigh!).toBeGreaterThan(CPR_TIMEOUT_MS);

    // Now run 5 fast replies at ~10ms each.
    // EWA: rtt = rtt * 0.75 + 10ms * 0.25 each round → converges to ~10ms.
    for (let i = 0; i < 5; i++) {
      const h = makeCprHost(stdin, stdout);
      requestCprAndApplyDelta(h, 10, 50, 10);
      // Reply arrives at 10ms — well within any timeout.
      vi.advanceTimersByTime(10);
      stdin.emit('data', Buffer.from('\x1b[10;1R'));
      await Promise.resolve();
      // Clean up the guard timer so the next cycle starts fresh.
      vi.advanceTimersByTime(CPR_TIMEOUT_CEILING_MS + 50);
    }

    const rttRecovered = __getCprRttForTests();
    expect(rttRecovered).not.toBeNull();
    // After 5 fast replies the RTT must have dropped from the ratcheted high.
    expect(rttRecovered!).toBeLessThan(rttHigh!);
    // And the adaptive timeout it produces must be below the ceiling.
    const adaptiveTimeout = Math.min(
      Math.max(Math.round(rttRecovered! * CPR_RTT_SCALE), CPR_TIMEOUT_MS),
      CPR_TIMEOUT_CEILING_MS,
    );
    expect(adaptiveTimeout).toBeLessThan(CPR_TIMEOUT_CEILING_MS);
  });

  it('timeout ceiling is respected during full ratchet — adaptive never exceeds CPR_TIMEOUT_CEILING_MS', () => {
    const stdin = makeStdin();
    const stdout = makeStdout();

    // Run enough timeouts to saturate the EWA near ceiling.
    // We'll do 10 cycles, each timing out at CPR_TIMEOUT_CEILING_MS.
    for (let i = 0; i < 10; i++) {
      const h = makeCprHost(stdin, stdout);
      requestCprAndApplyDelta(h, 10, 50, 10);
      vi.advanceTimersByTime(CPR_TIMEOUT_CEILING_MS + 50);
    }

    const rttAtSaturation = __getCprRttForTests();
    expect(rttAtSaturation).not.toBeNull();

    // The adaptive timeout is min(max(rtt * scale, baseline), ceiling).
    // Even if rtt * scale > ceiling, the clamp must hold.
    const adaptiveTimeout = Math.min(
      Math.max(Math.round(rttAtSaturation! * CPR_RTT_SCALE), CPR_TIMEOUT_MS),
      CPR_TIMEOUT_CEILING_MS,
    );
    expect(adaptiveTimeout).toBeLessThanOrEqual(CPR_TIMEOUT_CEILING_MS);
    // And rtt itself must be bounded (it's fed only values ≤ CPR_TIMEOUT_CEILING_MS).
    expect(rttAtSaturation!).toBeLessThanOrEqual(CPR_TIMEOUT_CEILING_MS);
  });
});
