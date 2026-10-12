/**
 * Tests for the WIDTH-ONLY → SHRINK resize burst race (issue #3283).
 *
 * In a tmux split-drag burst, a WIDTH-ONLY SIGWINCH sets `pendingResizeErase`
 * and starts a CPR request.  If a SHRINK SIGWINCH arrives before the in-flight
 * CPR resolves, the old code unconditionally nulled `pendingResizeErase` in the
 * SHRINK branch — discarding the width-only erase snapshot the pending CPR still
 * needed.  When the CPR finally resolved and called repaint(), the ghost-row
 * erase did NOT fire because the snapshot was gone.
 *
 * Fix (terminal-compositor.lifecycle.resize.ts): when a CPR is already in-flight
 * with a WIDTH-ONLY snapshot, the SHRINK branch keeps
 * the existing snapshot rather than nulling it, so the CPR's repaint always has
 * an erase footprint to work with.
 *
 * Covers:
 *   B1 — WIDTH-ONLY → SHRINK (CPR in-flight): pendingResizeErase is NOT nulled.
 *   B2 — WIDTH-ONLY → SHRINK (CPR in-flight): erase snapshot preserved across both events.
 *   B3 — WIDTH-ONLY → SHRINK (CPR in-flight): ghost-erase CUP+EL is emitted after CPR resolves.
 *   B4 — SHRINK with NO prior CPR (cprPending=false): existing null contract preserved.
 *   B5 — WIDTH-ONLY → SHRINK with no frame: snapshot stays null.
 *   B6 — WIDTH-ONLY → SHRINK → SHRINK: snapshot survives repeated SHRINKs.
 *   B7 — WIDTH-ONLY → EXPAND → SHRINK: replacement EXPAND snapshot is dropped.
 *   B8 — EXPAND → WIDTH-ONLY → SHRINK: latest WIDTH-ONLY snapshot survives.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  __resetCprRttForTests,
} from './terminal-compositor.lifecycle.cpr.js';
import { TerminalCompositor } from './terminal-compositor.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';

const armedCompositors: TerminalCompositor[] = [];
// Invariant: disarm while fake timers are active, even if an assertion fails.
afterEach(() => {
  for (const c of armedCompositors.splice(0)) c.disarm();
  vi.useRealTimers();
});
beforeEach(() => {
  __resetStdinClaimForTests();
  __resetCprRttForTests();
  vi.useFakeTimers();
});

function completeCpr(c: TerminalCompositor, stdin: ReturnType<typeof makeMockStdin>): void {
  const state = c as unknown as {
    cprPending: boolean;
    cprBurst: { originalExpectedRow: number; currentRows: number } | null;
  };
  // A dirty reply starts one fresh query; the second reply completes the burst.
  for (let i = 0; i < 2 && state.cprPending; i++) {
    const burst = state.cprBurst!;
    const row = Math.min(burst.originalExpectedRow, burst.currentRows - 1);
    stdin.emit('data', Buffer.from(`\x1b[${row};1R`));
  }
  expect(state.cprPending, 'CPR replies must complete the burst').toBe(false);
}

// ---------------------------------------------------------------------------
// B1: WIDTH-ONLY → SHRINK while CPR in-flight: pendingResizeErase is NOT nulled
// ---------------------------------------------------------------------------

describe('B1: WIDTH-ONLY then SHRINK during in-flight CPR: snapshot NOT nulled', () => {

  it('pendingResizeErase survives a SHRINK that arrives while CPR is in-flight', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    stdout.rows = 40;
    stdout.columns = 99;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    armedCompositors.push(c);
    await c.arm();
    // Allow the initial frame to render (establishes lastMeasuredFrameBottom > 0).
    vi.advanceTimersByTime(20);

    const internals = c as unknown as {
      pendingResizeErase: { top: number; bottom: number } | null;
      cprPending: boolean;
    };
    expect(internals.cprPending).toBe(false);

    // Step 1: WIDTH-ONLY SIGWINCH — sets pendingResizeErase + starts CPR.
    stdout.columns = 49;
    process.stdout.emit('resize');

    // CPR should now be in-flight.
    expect(internals.cprPending, 'CPR must be in-flight after WIDTH-ONLY').toBe(true);
    expect(internals.pendingResizeErase, 'snapshot must be set after WIDTH-ONLY').not.toBeNull();

    // Step 2: SHRINK while CPR is in-flight.
    stdout.rows = 35;
    process.stdout.emit('resize');

    // KEY assertion: pendingResizeErase must NOT have been nulled while CPR is pending.
    expect(internals.pendingResizeErase, 'snapshot must survive SHRINK while CPR is in-flight').not.toBeNull();

    // Cleanup.
    completeCpr(c, stdin);
    c.disarm();
  });
});

// ---------------------------------------------------------------------------
// B2: WIDTH-ONLY footprint is preserved unchanged by SHRINK
// ---------------------------------------------------------------------------

describe('B2: WIDTH-ONLY erase footprint is preserved unchanged by SHRINK', () => {

  it('preserves the exact width-only snapshot through SHRINK', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    stdout.rows = 40;
    stdout.columns = 99;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    armedCompositors.push(c);
    await c.arm();
    vi.advanceTimersByTime(20);

    const internals = c as unknown as {
      pendingResizeErase: { top: number; bottom: number } | null;
      lastKnownRows: number;
    };

    // Step 1: WIDTH-ONLY.
    stdout.columns = 49;
    process.stdout.emit('resize');
    const afterWidth = internals.pendingResizeErase;
    expect(afterWidth).not.toBeNull();
    // Clone the snapshot before step 2 so the comparison is not same-reference.
    const afterWidthClone = afterWidth ? { ...afterWidth } : null;

    // Step 2: SHRINK (while CPR in-flight from step 1).
    stdout.rows = 35;
    process.stdout.emit('resize');

    expect(internals.pendingResizeErase).toEqual(afterWidthClone);

    completeCpr(c, stdin);
    c.disarm();
  });
});

// ---------------------------------------------------------------------------
// B3: Ghost-erase CUP+EL emitted after CPR resolves in a WIDTH-ONLY → SHRINK burst
//
// We use a tall terminal (60 rows) so the WIDTH-ONLY snapshot (row 5, near
// the top) stays within range after a modest SHRINK (60→50), and the erase
// can physically reach that row.  A SHRINK to fewer rows than the old frame
// bottom would push it out of viewport and the clamping in flushResizeGhostErase
// would correctly skip the now-nonexistent rows — not a ghost-erase failure.
// ---------------------------------------------------------------------------

describe('B3: ghost-erase CUP+EL emitted after CPR resolves in WIDTH-ONLY → SHRINK burst', () => {

  it('erases a known ghost row outside the newly painted frame after WIDTH-ONLY → modest SHRINK + CPR', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    const writes = collectWrites(stdout);
    // Use a tall terminal (60 rows) so the WIDTH-ONLY snapshot rows remain
    // within the post-SHRINK viewport (60→50): flushResizeGhostErase clamps to
    // stdout.rows, so the snapshot top must be ≤ 50 for the erase to fire.
    stdout.rows = 60;
    stdout.columns = 99;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    armedCompositors.push(c);
    await c.arm();
    // Allow the initial frame to render so logUpdate.topRow is populated and
    // lastMeasuredFrameBottom is established (drives CPR expectedRow).
    vi.advanceTimersByTime(20);

    const internals = c as unknown as {
      pendingResizeErase: { top: number; bottom: number } | null;
      lastMeasuredFrameBottom: number;
    };

    // Confirm a frame rendered (frameBottom > 0 is required for CPR to fire).
    expect(internals.lastMeasuredFrameBottom, 'frame must have rendered before WIDTH-ONLY').toBeGreaterThan(0);

    // Step 1: WIDTH-ONLY SIGWINCH — columns 99→49, rows stay at 60.
    // handleResizeImmediate snapshots the pre-resize footprint and starts a CPR.
    stdout.columns = 49;
    process.stdout.emit('resize');

    // The snapshot top is the known ghost row: it is the top of the pre-resize
    // frame/band footprint, guaranteed to be OUTSIDE the newly painted frame
    // (the repaint places the fresh frame at a fresh position after delta apply).
    const snapshot = internals.pendingResizeErase;
    expect(snapshot, 'snapshot must be set after WIDTH-ONLY').not.toBeNull();
    const ghostTop = snapshot!.top;
    expect(ghostTop, 'ghost top row must be ≥ 1').toBeGreaterThanOrEqual(1);

    // Shrink to ghostTop+4 rows: the snapshot top stays within the post-shrink
    // viewport so flushResizeGhostErase will not clamp it away, while the
    // post-resize row count is still smaller than the original 60.
    // The +4 slack keeps the frame's cursor-park row in range too.
    const shrinkTarget = ghostTop + 4;
    stdout.rows = shrinkTarget;
    process.stdout.emit('resize');
    expect(internals.pendingResizeErase, 'snapshot must survive SHRINK while CPR in-flight').not.toBeNull();

    // Clear writes accumulated during setup so only the CPR-triggered repaint
    // output is inspected.
    writes.clear();

    // Step 3: Drive dirty then quiescent CPR replies (not the timeout fallback).
    // completeCpr feeds a dirty reply first (re-queries) then a quiescent reply
    // (repaints with ghost erase).  After the quiescent reply, repaint() runs
    // flushResizeGhostErase which emits CUP+EL for every row in [top, bottom].
    completeCpr(c, stdin);

    const out = writes.all();

    // Assert that the known ghost row was erased: the exact CUP+EL sequence for
    // `ghostTop` must appear.  Ordinary frame rendering parks the cursor at the
    // frame bottom, not at the pre-resize snapshot row, so a match here proves
    // the ghost-erase path fired for that specific row — not just any CUP+EL.
    const ghostEraseSeq = `\x1b[${ghostTop};1H\x1b[2K`;
    expect(out, `CUP+EL for known ghost row ${ghostTop} must appear after CPR resolves`)
      .toContain(ghostEraseSeq);

    c.disarm();
  });
});

// ---------------------------------------------------------------------------
// B4: SHRINK with NO prior CPR (cprPending=false): existing null contract preserved
// ---------------------------------------------------------------------------

describe('B4: SHRINK with no prior CPR: existing null contract preserved', () => {

  it('SHRINK without prior CPR still nulls pendingResizeErase (existing contract)', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    stdout.rows = 50;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    armedCompositors.push(c);
    await c.arm();
    vi.advanceTimersByTime(20);

    // First EXPAND to set pendingResizeErase.
    stdout.rows = 70;
    process.stdout.emit('resize');
    // Complete EXPAND deterministically, independent of adaptive RTT history.
    completeCpr(c, stdin);

    const internals = c as unknown as {
      pendingResizeErase: { top: number; bottom: number } | null;
      cprPending: boolean;
    };
    // No CPR in-flight now.
    expect(internals.cprPending).toBe(false);
    // The completed repaint consumed its snapshot. Seed a stale footprint so
    // the nulling assertion proves SHRINK discards it rather than passing vacuously.
    internals.pendingResizeErase = { top: 30, bottom: 49 };

    // SHRINK without a pending CPR: must null the snapshot (existing contract).
    stdout.rows = 40;
    process.stdout.emit('resize');

    expect(internals.pendingResizeErase, 'SHRINK without pending CPR must null snapshot').toBeNull();

    completeCpr(c, stdin);
    c.disarm();
  });
});

// ---------------------------------------------------------------------------
// B5: WIDTH-ONLY burst (CPR in-flight) but no prior snapshot: SHRINK keeps null
//
// Constructs the state that a WIDTH-ONLY SIGWINCH produces when no frame has
// rendered yet (pendingResizeErase=null, cprPending=true, widthOnlyOrigin=true).
// The SHRINK branch's preservation rule only applies when pendingResizeErase is
// already a width-only snapshot; with null, it must remain null rather than
// incorrectly materialising a stale footprint.
// ---------------------------------------------------------------------------

describe('B5: WIDTH-ONLY → SHRINK (CPR in-flight) with no snapshot: stays null', () => {

  it('SHRINK keeps pendingResizeErase null when width-only CPR is in-flight with no snapshot', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    stdout.rows = 40;
    stdout.columns = 99;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    armedCompositors.push(c);
    await c.arm();
    vi.advanceTimersByTime(20);

    const internals = c as unknown as {
      pendingResizeErase: { top: number; bottom: number; origin?: string } | null;
      cprPending: boolean;
      cprBurst: {
        dirty: boolean;
        originalExpectedRow: number;
        currentRows: number;
        growTotal: number;
        shrinkTotal: number;
        requeryCt: number;
        widthOnlyOrigin: boolean;
      } | null;
      lastMeasuredFrameBottom: number;
    };

    // Construct the exact state a WIDTH-ONLY SIGWINCH produces when no frame
    // position data is available: CPR in-flight with widthOnlyOrigin=true but
    // pendingResizeErase=null (the top===0 guard in handleResizeImmediate skips
    // the snapshot when logUpdate.topRow and committedBandTopRow are both 0).
    // We set this directly rather than forcing frameBottom=0 (which also
    // prevents CPR) or nulling logUpdate (which collapses unrelated state).
    internals.cprPending = true;
    internals.cprBurst = {
      dirty: false,
      originalExpectedRow: internals.lastMeasuredFrameBottom,
      currentRows: stdout.rows,
      growTotal: 0,
      shrinkTotal: 0,
      requeryCt: 0,
      widthOnlyOrigin: true,   // ← width-only origin, as claimed by the test title
    };
    internals.pendingResizeErase = null;  // ← no snapshot: top===0 guard fired

    // SHRINK while the width-only CPR is in-flight.  The preservation rule in
    // handleResizeImmediate reads:
    //   preserveWidthSnapshot = cprPending && pendingResizeErase?.origin === 'width-only'
    // With pendingResizeErase===null the condition is false, so the branch must
    // null the snapshot — but it is already null.  Crucially, it must NOT set
    // pendingResizeErase to a non-null value (which would be a false positive).
    stdout.rows = 35;
    process.stdout.emit('resize');

    expect(internals.pendingResizeErase, 'SHRINK must keep pendingResizeErase null when width-only CPR has no snapshot').toBeNull();

    // cprPending was injected directly (no real stdin listener was installed by
    // _requestCpr), so we cannot drive completeCpr here.  Reset the flag before
    // disarm so the compositor does not attempt a stale cleanup path.
    internals.cprPending = false;
    internals.cprBurst = null;
    c.disarm();
  });
});

// ---------------------------------------------------------------------------
// B6: WIDTH-ONLY → SHRINK → second SHRINK inside one burst: snapshot survives
// ---------------------------------------------------------------------------

describe('B7/B8: snapshot provenance is independent of CPR burst origin', () => {
  it.each([
    { origin: 'width-only', firstRows: 40, secondRows: 50, preserve: false },
    { origin: 'expand', firstRows: 50, secondRows: 40, preserve: true },
  ])('SHRINK uses latest snapshot after a $origin-originated mixed burst', async ({ firstRows, secondRows, preserve }) => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    stdout.rows = 40;
    stdout.columns = 99;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    armedCompositors.push(c);
    await c.arm();
    vi.advanceTimersByTime(20);
    const state = c as unknown as {
      pendingResizeErase: { top: number; bottom: number; origin?: string } | null;
      cprPending: boolean;
      cprBurst: { widthOnlyOrigin: boolean } | null;
      committedBand: string[];
      committedBandTopRow: number;
    };
    // resetGeometry clears the live-frame top after the first event. Keep a
    // committed-band footprint so the second event genuinely replaces it.
    state.committedBand.push('committed row');
    state.committedBandTopRow = 30;
    stdout.columns = 49;
    stdout.rows = firstRows;
    process.stdout.emit('resize');
    expect(state.cprPending).toBe(true);
    const firstSnapshot = state.pendingResizeErase;
    expect(firstSnapshot).not.toBeNull();
    const burstOrigin = state.cprBurst?.widthOnlyOrigin;

    stdout.rows = secondRows;
    process.stdout.emit('resize');
    const replacement = state.pendingResizeErase;
    expect(replacement).not.toBe(firstSnapshot);
    expect(replacement?.origin).toBe(preserve ? 'width-only' : 'expand');
    expect(state.cprBurst?.widthOnlyOrigin).toBe(burstOrigin);

    stdout.rows = 35;
    process.stdout.emit('resize');
    expect(state.cprPending).toBe(true);
    if (preserve) expect(state.pendingResizeErase).toBe(replacement);
    else expect(state.pendingResizeErase).toBeNull();
    completeCpr(c, stdin);
  });
});

describe('B6: WIDTH-ONLY → SHRINK → second SHRINK in same burst: snapshot NOT nulled', () => {

  it('pendingResizeErase survives a second SHRINK that arrives while CPR is in-flight', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    stdout.rows = 40;
    stdout.columns = 99;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    armedCompositors.push(c);
    await c.arm();
    // Allow the initial frame to render (establishes lastMeasuredFrameBottom > 0).
    vi.advanceTimersByTime(20);

    const internals = c as unknown as {
      pendingResizeErase: { top: number; bottom: number } | null;
      cprPending: boolean;
      cprBurst: { shrinkTotal: number } | null;
    };
    expect(internals.cprPending).toBe(false);

    // Step 1: WIDTH-ONLY SIGWINCH — sets pendingResizeErase + starts CPR.
    stdout.columns = 49;
    process.stdout.emit('resize');

    expect(internals.cprPending, 'CPR must be in-flight after WIDTH-ONLY').toBe(true);
    expect(internals.pendingResizeErase, 'snapshot must be set after WIDTH-ONLY').not.toBeNull();

    // Step 2: First SHRINK while CPR is in-flight.
    stdout.rows = 35;
    process.stdout.emit('resize');

    expect(internals.pendingResizeErase, 'snapshot must survive first SHRINK').not.toBeNull();
    // After the first SHRINK, shrinkTotal > 0 in the burst context.
    expect(internals.cprBurst?.shrinkTotal).toBeGreaterThan(0);

    // Step 3: Second SHRINK — the bug: shrinkTotal > 0, so the old guard
    // (shrinkTotal === 0) fails, and pendingResizeErase is nulled.
    stdout.rows = 30;
    process.stdout.emit('resize');

    // KEY assertion: snapshot must STILL survive the second SHRINK.
    expect(internals.pendingResizeErase, 'snapshot must survive second SHRINK in width-only burst').not.toBeNull();

    // Cleanup.
    completeCpr(c, stdin);
    c.disarm();
  });
});
