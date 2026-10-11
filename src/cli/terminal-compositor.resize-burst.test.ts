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

  it('ghost-erase CUP+EL fires after WIDTH-ONLY → modest SHRINK when snapshot row stays in viewport', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    const writes = collectWrites(stdout);
    // Use a tall terminal: frame bottom at row 59, shrink to 50 (row 59 goes
    // out of range but lower rows stay valid — we check for any CUP+EL erase).
    stdout.rows = 60;
    stdout.columns = 99;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    armedCompositors.push(c);
    await c.arm();
    // Allow the initial frame to render (establishes lastMeasuredFrameBottom).
    vi.advanceTimersByTime(20);
    writes.clear();

    const internals = c as unknown as {
      pendingResizeErase: { top: number; bottom: number } | null;
    };

    // Step 1: WIDTH-ONLY SIGWINCH — columns 99→49, rows stay at 60.
    stdout.columns = 49;
    process.stdout.emit('resize');

    // Snapshot was set.
    const snapshot = internals.pendingResizeErase;
    expect(snapshot, 'snapshot must be set after WIDTH-ONLY').not.toBeNull();

    // Step 2: modest SHRINK while CPR in-flight — rows 60→50. The snapshot
    // top row is within [1, 50] so flushResizeGhostErase will not skip it.
    stdout.rows = 50;
    process.stdout.emit('resize');

    // Snapshot survived.
    expect(internals.pendingResizeErase, 'snapshot must survive SHRINK while CPR in-flight').not.toBeNull();

    // Step 3: The dirty reply re-queries; a quiescent reply repaints with erase.
    // A timeout ends the burst directly, rather than issuing a re-query.
    completeCpr(c, stdin);

    const out = writes.all();
    // The ghost-erase mechanism must have fired: at least one CUP+EL sequence.
    // We do NOT assert the exact row (it depends on runtime frame geometry)
    // but we assert that erasing happened — the sequence CUP+EL must appear.
    expect(out, 'at least one ghost-erase CUP+EL must appear after WIDTH-ONLY → SHRINK burst')
      .toMatch(/\x1b\[\d+;1H\x1b\[2K/);

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
// B5: WIDTH-ONLY → SHRINK (CPR in-flight) but no prior snapshot: stays null
// ---------------------------------------------------------------------------

describe('B5: WIDTH-ONLY → SHRINK (CPR in-flight) with no snapshot: stays null', () => {

  it('pendingResizeErase stays null when WIDTH-ONLY produced no snapshot', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    stdout.rows = 40;
    stdout.columns = 99;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    armedCompositors.push(c);
    await c.arm();
    // Do NOT advance timers — no frame has rendered yet.

    const internals = c as unknown as {
      pendingResizeErase: { top: number; bottom: number } | null;
      lastMeasuredFrameBottom: number;
      logUpdate: { topRow?: number } | null;
      committedBand: string[];
      cprPending: boolean;
    };

    // Zero out all frame-position state to simulate no-frame scenario.
    internals.lastMeasuredFrameBottom = 0;
    internals.logUpdate = null;
    internals.committedBand.length = 0;

    // Step 1: WIDTH-ONLY — no snapshot set (top===0 guard), but CPR is also
    //         not emitted when frameBottom===0.
    stdout.columns = 49;
    process.stdout.emit('resize');

    // No CPR (frameBottom===0), no snapshot.
    expect(internals.cprPending).toBe(false);
    expect(internals.pendingResizeErase).toBeNull();

    // Step 2: SHRINK — no CPR in-flight, existing contract applies: stays null.
    stdout.rows = 35;
    process.stdout.emit('resize');

    expect(internals.pendingResizeErase, 'snapshot must remain null').toBeNull();

    completeCpr(c, stdin);
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
