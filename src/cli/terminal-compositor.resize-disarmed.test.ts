/**
 * Tests for TerminalCompositor — resize while disarmed (between turns).
 *
 * Verifies the disarmRows snapshot protocol: disarm() records stdout.rows;
 * arm() compares against the live value and resets CupFrameRenderer geometry
 * when they differ. No ResizeBus subscription survives disarm, so there is
 * no listener leak on final disposal.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TerminalCompositor } from './terminal-compositor.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';
import type { MockStdout, MockStdin } from './terminal-compositor.test-helpers.js';

describe('TerminalCompositor — resize while disarmed', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;
  let writes: ReturnType<typeof collectWrites>;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
    writes = collectWrites(stdout);
    __resetStdinClaimForTests();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('resize while disarmed triggers resetGeometry on next arm', async () => {
    stdout.rows = 24;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    try {
      await c.arm();
      // Establish geometry by painting a frame.
      c.repaint();
      c.disarm();
      writes.clear();

      // Simulate a resize while disarmed (e.g. tmux pane close).
      // No ResizeBus event fires (no listener is attached); only stdout.rows
      // changes, which arm() detects via the disarmRows snapshot.
      stdout.rows = 40;

      // Re-arm — the first repaint should use the new geometry.
      await c.arm();

      // The arm-time repaint should render at the new bottom row (rows-1=39).
      const out = writes.all();
      expect(out).toContain('\x1b[39;1H');
    } finally {
      c.disarm();
    }
  });

  it('no spurious resetGeometry when no resize between turns', async () => {
    stdout.rows = 24;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    try {
      await c.arm();
      c.repaint();
      c.disarm();
      writes.clear();

      // No resize — just re-arm.
      await c.arm();

      // The frame should render at the same bottom row as before (rows-1=23).
      const out = writes.all();
      expect(out).toContain('\x1b[23;1H');
      // No ghost-erase should fire for rows above 23.
      expect(out).not.toContain('\x1b[39;1H');
    } finally {
      c.disarm();
    }
  });

  it('EXPAND while disarmed resets geometry so first armed repaint uses new dimensions', async () => {
    stdout.rows = 24;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    type Internals = { disarmRows: number; disarmCols: number };
    try {
      await c.arm();
      c.repaint();
      c.disarm();

      const internals = c as unknown as Internals;
      // disarm() should have snapshot the rows.
      expect(internals.disarmRows).toBe(24);

      // Expand: 24 → 40 rows while disarmed.
      stdout.rows = 40;

      writes.clear();
      await c.arm();

      // arm() should have consumed the snapshot (reset to 0).
      expect(internals.disarmRows).toBe(0);
      // disarmCols must also be reset (#4203: handleDisarmWindowResize zeroed
      // disarmRows but not disarmCols; both must be cleared together).
      expect(internals.disarmCols).toBe(0);
      // The frame should render at the new expanded bottom row (39 = 40-1),
      // NOT at the old position (23 = 24-1). This is the core assertion:
      // without the fix, the renderer's stale previousTopRow/previousLineCount
      // would cause the frame to render at the wrong position.
      const out = writes.all();
      expect(out).toContain('\x1b[39;1H');
    } finally {
      c.disarm();
    }
  });

  it('SHRINK while disarmed does NOT set pendingResizeErase', async () => {
    stdout.rows = 40;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    try {
      await c.arm();
      c.repaint();
      c.disarm();
      writes.clear();

      // Shrink: 40 → 24 rows while disarmed.
      stdout.rows = 24;

      await c.arm();

      // The frame should render at the new (smaller) bottom row.
      const out = writes.all();
      expect(out).toContain('\x1b[23;1H');
      // No ghost-erase should target rows > 24 (that would wipe reflowed
      // content after a SHRINK — the exact bug the SHRINK-drop invariant
      // prevents).
      expect(out).not.toMatch(/\x1b\[(2[5-9]|3[0-9]|4[0-9]);1H\x1b\[2K/);
    } finally {
      c.disarm();
    }
  });

  it('multiple rapid resizes while disarmed — only one geometry reset', async () => {
    stdout.rows = 24;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    try {
      await c.arm();
      c.repaint();
      c.disarm();
      writes.clear();

      // Only the final size matters — arm() compares the snapshot against
      // live stdout.rows, so intermediate values are irrelevant.
      stdout.rows = 36;

      await c.arm();

      // The frame should render at the FINAL size (rows=36 → bottom=35).
      const out = writes.all();
      expect(out).toContain('\x1b[35;1H');
    } finally {
      c.disarm();
    }
  });

  it('EXPAND while disarmed with simultaneous column narrowing inflates pendingResizeErase', async () => {
    // Regression for #4054 item 1: handleDisarmWindowResize was computing
    // `bottom` as `disarmRows - 1 - extraRows` (logical rows only), without
    // applying reflowedPhysicalRows inflation. When the EXPAND also narrowed
    // columns, DECAWM autowrap reflows old rows wider than newCols into
    // ceil(oldCols/newCols) physical rows, so the un-inflated erase range
    // under-erases ghost rows above the logical top.
    //
    // Scenario: 24 rows × 200 cols → 40 rows × 80 cols while disarmed.
    // Old rows painted at 200 cols reflow to ceil(200/80)=3 physical rows each
    // on the 80-col terminal. logicalRows = disarmRows-1 = 23 (top=1..23),
    // so physicalRows = 23×3 = 69 — bottom should be 69, clamped by
    // flushResizeGhostErase to the new viewport (40).
    stdout.rows = 24;
    stdout.columns = 200;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    type Internals = {
      pendingResizeErase: { top: number; bottom: number; origin?: string } | null;
      lastKnownCols: number;
    };
    try {
      await c.arm();
      c.repaint();
      // After repaint, lastKnownCols should be 200.
      expect((c as unknown as Internals).lastKnownCols).toBe(200);

      c.disarm();

      // Expand rows AND narrow columns while disarmed.
      stdout.rows = 40;
      stdout.columns = 80;

      writes.clear();
      await c.arm();

      // pendingResizeErase.bottom must be inflated: logicalRows=23,
      // rowsPerOldRow=ceil(200/80)=3, physicalRows=69, bottom=1+69-1=69.
      const internals = c as unknown as Internals;
      // The snapshot was consumed by arm()'s repaint, so read it from the
      // emitted ghost-erase escapes instead.
      const out = writes.all();
      // With inflation the erase must reach above row 23 (the un-inflated
      // logical bottom). Row 24 must be erased (first row beyond logical top).
      expect(out, 'inflated ghost-erase must erase rows beyond logical bottom').toContain(
        `\x1b[24;1H\x1b[2K`,
      );
      // Upper-bound clamp: flushResizeGhostErase clamps bottom to liveRows (40),
      // so row 40 IS erased but row 41 is NOT (would be off-screen).
      expect(out, 'ghost-erase must reach the new viewport bottom (row 40)').toContain(
        `\x1b[40;1H\x1b[2K`,
      );
      expect(out, 'ghost-erase must not exceed the new viewport (row 41 must not appear)').not.toContain(
        `\x1b[41;1H\x1b[2K`,
      );
    } finally {
      c.disarm();
    }
  });

  it('double disarm does not leak listeners or throw', async () => {
    stdout.rows = 24;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();
    c.disarm();
    // Second disarm on an already-disarmed compositor — should not throw.
    expect(() => c.disarm()).not.toThrow();

    // No ResizeBus listener should survive — verify by checking that
    // a resize event produces no compositor output.
    writes.clear();
    stdout.rows = 50;
    process.stdout.emit('resize');
    vi.advanceTimersByTime(150);
    expect(writes.all()).toBe('');
  });

  it('no ResizeBus listener survives final disarm (leak-free disposal)', async () => {
    stdout.rows = 24;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();
    c.repaint();
    c.disarm();

    // After disarm, the only state is disarmRows (an integer). No closure
    // captures the compositor in a ResizeBus subscriber Set, so the
    // compositor can be GC'd. Verify no listener fires.
    writes.clear();
    stdout.rows = 50;
    process.stdout.emit('resize');
    vi.advanceTimersByTime(150);
    expect(writes.all()).toBe('');
  });
});
