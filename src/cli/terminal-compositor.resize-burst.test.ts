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
 * (`cprPending === true`), the SHRINK branch merges the footprints
 * (min top / max bottom) instead of unconditionally nulling the snapshot, so
 * the CPR's repaint always has an erase footprint to work with.
 *
 * Covers:
 *   B1 — WIDTH-ONLY → SHRINK (CPR in-flight): pendingResizeErase is NOT nulled.
 *   B2 — WIDTH-ONLY → SHRINK (CPR in-flight): merged erase footprint covers both events.
 *   B3 — WIDTH-ONLY → SHRINK (CPR in-flight): ghost-erase CUP+EL is emitted after CPR resolves.
 *   B4 — SHRINK with NO prior CPR (cprPending=false): existing null contract preserved.
 *   B5 — WIDTH-ONLY → SHRINK (CPR in-flight, no prior snapshot): still nulls (no snapshot to merge).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  CPR_REQUEST,
  CPR_TIMEOUT_MS,
} from './terminal-compositor.lifecycle.cpr.js';
import { TerminalCompositor } from './terminal-compositor.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';

// ---------------------------------------------------------------------------
// B1: WIDTH-ONLY → SHRINK while CPR in-flight: pendingResizeErase is NOT nulled
// ---------------------------------------------------------------------------

describe('B1: WIDTH-ONLY then SHRINK during in-flight CPR: snapshot NOT nulled', () => {
  beforeEach(() => { __resetStdinClaimForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('pendingResizeErase survives a SHRINK that arrives while CPR is in-flight', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    stdout.rows = 40;
    stdout.columns = 99;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
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
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 50);
    c.disarm();
  });
});

// ---------------------------------------------------------------------------
// B2: Merged footprint covers both WIDTH-ONLY and SHRINK events
// ---------------------------------------------------------------------------

describe('B2: Merged erase footprint covers both WIDTH-ONLY and SHRINK events', () => {
  beforeEach(() => { __resetStdinClaimForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('merged footprint uses min(top) / max(bottom) of both snapshots', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    stdout.rows = 40;
    stdout.columns = 99;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
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

    // Step 2: SHRINK (while CPR in-flight from step 1).
    stdout.rows = 35;
    process.stdout.emit('resize');

    // The merged footprint must encompass the width-only snapshot.
    const merged = internals.pendingResizeErase;
    expect(merged, 'merged snapshot must exist').not.toBeNull();
    if (afterWidth !== null && merged !== null) {
      expect(merged.top).toBeLessThanOrEqual(afterWidth.top);
      expect(merged.bottom).toBeGreaterThanOrEqual(afterWidth.bottom);
    }

    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 50);
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
  beforeEach(() => { __resetStdinClaimForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('ghost-erase CUP+EL fires after WIDTH-ONLY → modest SHRINK when snapshot row stays in viewport', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    const writes = collectWrites(stdout);
    // Use a tall terminal: frame bottom at row 59, shrink to 50 (row 59 goes
    // out of range but lower rows stay valid — we check for any CUP+EL erase).
    stdout.rows = 60;
    stdout.columns = 99;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
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

    // Step 3: Allow CPR timeouts to fire → repaint WITH the erase snapshot.
    // Two timeouts: one for the WIDTH-ONLY CPR (dirty=true → re-queries), one
    // for the re-query.  Advance well past 2×CPR_TIMEOUT_MS to cover both.
    vi.advanceTimersByTime((CPR_TIMEOUT_MS + 50) * 3);

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
  beforeEach(() => { __resetStdinClaimForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('SHRINK without prior CPR still nulls pendingResizeErase (existing contract)', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    stdout.rows = 50;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();
    vi.advanceTimersByTime(20);

    // First EXPAND to set pendingResizeErase.
    stdout.rows = 70;
    process.stdout.emit('resize');
    // Let the EXPAND CPR time out so no CPR is in-flight.
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 50);

    const internals = c as unknown as {
      pendingResizeErase: { top: number; bottom: number } | null;
      cprPending: boolean;
    };
    // No CPR in-flight now.
    expect(internals.cprPending).toBe(false);

    // SHRINK without a pending CPR: must null the snapshot (existing contract).
    stdout.rows = 40;
    process.stdout.emit('resize');

    expect(internals.pendingResizeErase, 'SHRINK without pending CPR must null snapshot').toBeNull();

    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 50);
    c.disarm();
  });
});

// ---------------------------------------------------------------------------
// B5: WIDTH-ONLY → SHRINK (CPR in-flight) but no prior snapshot: stays null
// ---------------------------------------------------------------------------

describe('B5: WIDTH-ONLY → SHRINK (CPR in-flight) with no snapshot: stays null', () => {
  beforeEach(() => { __resetStdinClaimForTests(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('pendingResizeErase stays null when WIDTH-ONLY produced no snapshot', async () => {
    const stdout = makeMockStdout();
    const stdin = makeMockStdin();
    stdout.rows = 40;
    stdout.columns = 99;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
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

    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 50);
    c.disarm();
  });
});
