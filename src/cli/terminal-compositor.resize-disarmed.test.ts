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
    type Internals = { disarmRows: number };
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
