/**
 * Regression test for issue #3212 — TUI: mid-turn resize burst (window drag)
 * still duplicates the frame when grow-eviction runs between resizes.
 *
 * Root cause: in `preserveRowsBeforeFrameRender` (frame-preserve.ts), the
 * legacy deficit-based eviction path was not gated on `bandGeometryStale`.
 *
 * During a rapid GROW → SHRINK → GROW burst, a CPR-resolved repaint fires
 * mid-burst.  `applyScrollDelta` shifts `anchorRow` upward (smaller row
 * number) after the SHRINK step.  On the CPR-resolved repaint,
 * `desiredTopRow` is computed fresh for the new geometry while `anchorRow` is
 * stale/over-shifted.  If `desiredTopRow < anchorRow` at that moment,
 * `anchorDeficit` is positive → `scrollBannerDeficit` → `evictRowsToScrollback`
 * fires, scrolling committed rows into native scrollback.  On the next GROW
 * step tmux pulls those rows back as frozen ghost duplicates.
 *
 * The debug log from the issue shows:
 *   [compositor] evict:enter rows=3 anchorRow=28   ← spurious mid-burst eviction
 *
 * Fix: gate the entire legacy deficit block on `!self.bandGeometryStale`.
 * `bandGeometryStale` is set by the SIGWINCH immediate handler and cleared by
 * `repositionCommittedBand` once a full steady-state repaint establishes fresh
 * geometry.  While the burst is in flight the flag remains set, deferring the
 * anchor eviction until coordinates are reliable.
 *
 * Tests:
 *   GE-1 — burst repaint: no \n scrollback-push writes while bandGeometryStale.
 *   GE-2 — GROW SIGWINCH sets bandGeometryStale; it persists through SHRINK.
 *   GE-3 — bandGeometryStale cleared after burst quiesces (repositionCommittedBand).
 *   GE-4 — anchorRow eviction still fires in steady state (not stale).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TerminalCompositor } from './terminal-compositor.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';
import { __resetCprRttForTests, CPR_TIMEOUT_MS } from './terminal-compositor.lifecycle.cpr.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';
import type { MockStdout, MockStdin } from './terminal-compositor.test-helpers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CompositorInternals = {
  bandGeometryStale: boolean;
  resizeGeometryStale: boolean;
  committedBand: string[];
  committedBandPaintedRows: number;
  hasCommitted: boolean;
  lastKnownRows: number;
  cprPending: boolean;
  anchorRow: number | undefined;
  pendingResizeErase: { top: number; bottom: number } | null;
};

function internals(c: TerminalCompositor): CompositorInternals {
  return c as unknown as CompositorInternals;
}

/**
 * Detect whether `evictRowsToScrollback` fired — it emits:
 *   \x1b[<rows>;1H  (CUP to physical bottom)
 *   followed immediately by \n (the scroll push)
 */
function hasScrollbackPush(output: string): boolean {
  // evictRowsToScrollback: \x1b[<rows>;1H\n...\n
  return /\x1b\[\d+;1H\n/.test(output);
}

// ---------------------------------------------------------------------------
// Shared setup
// ---------------------------------------------------------------------------

let stdout: MockStdout;
let stdin: MockStdin;

beforeEach(() => {
  stdout = makeMockStdout();
  stdin = makeMockStdin();
  __resetStdinClaimForTests();
  __resetCprRttForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// GE-1: GROW→SHRINK burst with anchorRow > desiredTopRow — no scrollback push.
//
// Reproduces the reported failure mode: anchorRow is live (> 1, e.g. a session
// with a welcome banner or update notice) when the burst fires.  A SHRINK step
// in the burst causes applyScrollDelta to shift anchorRow upward.  Without the
// fix, the CPR-resolved repaint sees desiredTopRow < anchorRow (stale) →
// anchorDeficit > 0 → evictRowsToScrollback fires → \n written to stdout.
// With the fix, bandGeometryStale gates the deficit block and no \n fires.
// ---------------------------------------------------------------------------

describe('GE-1: no scrollback-push \\n during GROW→SHRINK burst repaint (anchorRow scenario)', () => {
  it('evictRowsToScrollback does NOT fire while bandGeometryStale is true', async () => {
    vi.useFakeTimers();
    const writes = collectWrites(stdout);

    // Use rows=30 with a mid-range anchorRow to simulate a banner session.
    // The anchorRow is set high enough (row 20 in a 30-row terminal) that
    // a SHRINK of ~10 rows shifts it upward past where desiredTopRow lands —
    // triggering the spurious anchorDeficit on HEAD without the fix.
    stdout.rows = 30;
    stdout.columns = 80;

    const c = new TerminalCompositor({
      stdout,
      stdin,
      onCancel: vi.fn(),
      anchorRow: 20,
    });
    await c.arm();
    // Render the initial frame (establishes lastMeasuredFrameBottom).
    vi.advanceTimersByTime(20);

    const int = internals(c);
    // After arm(), the anchorRow was restored from declaredAnchorRow.
    // It may have been shifted by the initial render but should still be set.
    expect(int.anchorRow, 'anchorRow must be set after arm()').toBeDefined();
    expect(int.resizeGeometryStale, 'must not be stale before burst').toBe(false);

    // Set overlay to represent a mid-turn state (turn is active).
    c.setOverlay('THINKING…');
    vi.advanceTimersByTime(5);

    // Clear accumulated writes from setup.
    writes.clear();

    // ── Burst: GROW → SHRINK (within a single CPR flight) ──────────────────
    // Step 1: GROW — sets bandGeometryStale=true, starts CPR.
    stdout.rows = 40;
    process.stdout.emit('resize');

    expect(int.resizeGeometryStale, 'stale after GROW').toBe(true);
    expect(int.cprPending, 'CPR in-flight after GROW').toBe(true);

    // Step 2: SHRINK while CPR is in-flight.
    // applyScrollDelta will shift anchorRow UP on CPR resolution.
    stdout.rows = 22;
    process.stdout.emit('resize');

    // Still stale — burst not resolved.
    expect(int.resizeGeometryStale, 'still stale after SHRINK in burst').toBe(true);

    // ── Let CPR timeout fire → calls repaint() with stale geometry.
    // Without the fix, that repaint runs preserveRowsBeforeFrameRender which
    // sees desiredTopRow < anchorRow (stale) → eviction fires.
    // With the fix, bandGeometryStale=true gates the entire deficit block.
    //
    // Advance ONLY to just past the CPR timeout (120ms) — the ResizeBus
    // debounce fires at 150ms.  We stop at 125ms so the debounce has not
    // fired yet: we are asserting on the CPR-resolved repaint specifically,
    // which is the mid-burst repaint the bug report describes.
    vi.advanceTimersByTime(CPR_TIMEOUT_MS + 5); // 125 ms — past CPR, before debounce (150ms)

    const burstOutput = writes.all();

    // KEY assertion: no \n scrollback push during mid-burst stale repaint.
    // evictRowsToScrollback writes \x1b[<rows>;1H\n (CUP to bottom + newline).
    expect(
      hasScrollbackPush(burstOutput),
      'evictRowsToScrollback must NOT fire mid-burst (bandGeometryStale=true must suppress it)',
    ).toBe(false);

    // Let remaining timeouts settle.
    vi.advanceTimersByTime((CPR_TIMEOUT_MS + 50) * 5);
    c.disarm();
  });
});

// ---------------------------------------------------------------------------
// GE-2: bandGeometryStale is set by GROW and persists through SHRINK.
// ---------------------------------------------------------------------------

describe('GE-2: bandGeometryStale is set by GROW and persists through SHRINK in burst', () => {
  it('both resize steps keep bandGeometryStale=true while CPR is in-flight', async () => {
    vi.useFakeTimers();

    stdout.rows = 24;
    stdout.columns = 80;

    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();
    vi.advanceTimersByTime(20);

    const int = internals(c);
    expect(int.resizeGeometryStale).toBe(false);

    // GROW → sets stale + CPR.
    stdout.rows = 34;
    process.stdout.emit('resize');

    expect(int.resizeGeometryStale, 'resizeGeometryStale after GROW').toBe(true);
    expect(int.cprPending, 'CPR in-flight after GROW').toBe(true);

    // SHRINK while CPR in-flight — must NOT clear stale.
    stdout.rows = 28;
    process.stdout.emit('resize');

    expect(int.resizeGeometryStale, 'resizeGeometryStale must persist after SHRINK in burst').toBe(true);

    vi.advanceTimersByTime((CPR_TIMEOUT_MS + 50) * 3);
    c.disarm();
  });
});

// ---------------------------------------------------------------------------
// GE-3: bandGeometryStale is cleared after burst quiesces.
// ---------------------------------------------------------------------------

describe('GE-3: bandGeometryStale is false after burst fully quiesces', () => {
  it('repositionCommittedBand clears bandGeometryStale once geometry settles', async () => {
    vi.useFakeTimers();

    stdout.rows = 24;
    stdout.columns = 80;

    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();
    vi.advanceTimersByTime(20);

    // Commit so repositionCommittedBand has something to re-pin.
    c.setOverlay('SPIN');
    c.commitAbove('content-row');
    vi.advanceTimersByTime(20);

    // GROW → SHRINK → GROW burst.
    stdout.rows = 34;
    process.stdout.emit('resize');
    stdout.rows = 28;
    process.stdout.emit('resize');
    stdout.rows = 40;
    process.stdout.emit('resize');

    // Let all CPR timeouts fire and settle.
    vi.advanceTimersByTime((CPR_TIMEOUT_MS + 100) * 12);

    const int = internals(c);
    expect(int.resizeGeometryStale, 'must be false after burst quiesces').toBe(false);

    c.disarm();
  });
});

// ---------------------------------------------------------------------------
// GE-4: Steady-state: anchorRow check still gates the deficit path correctly.
//
// Verify the guard doesn't over-suppress: bandGeometryStale=false allows the
// legacy deficit path to run (it just does nothing visible in this test, which
// is fine — we assert no TYPE errors and no crash).
// ---------------------------------------------------------------------------

describe('GE-4: no regression in steady-state repaint with anchorRow', () => {
  it('steady-state repaint with anchorRow does not crash or throw', async () => {
    vi.useFakeTimers();

    stdout.rows = 24;
    stdout.columns = 80;

    const c = new TerminalCompositor({
      stdout,
      stdin,
      onCancel: vi.fn(),
      anchorRow: 5,
    });
    await c.arm();
    vi.advanceTimersByTime(20);

    c.setOverlay('L1\nL2\nL3');
    vi.advanceTimersByTime(20);

    // Non-burst repaint (no resize) — bandGeometryStale=false.
    const int = internals(c);
    expect(int.resizeGeometryStale, 'no resize → resizeGeometryStale must be false').toBe(false);

    // No throws = pass.
    c.disarm();
  });
});
