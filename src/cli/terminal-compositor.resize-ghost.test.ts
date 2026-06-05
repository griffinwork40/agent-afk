/**
 * Regression tests for the "TUI gets all whacky on terminal resize" bug.
 *
 * Root cause (verified via /diagnose + adversarial shadow-verify): the SIGWINCH
 * immediate handler used to zero the live-frame geometry (resetGeometry()) and
 * the committed band (clearCommittedBand()) WITHOUT emitting any erase escapes.
 * On an EXPAND the terminal freezes existing content at its old absolute rows
 * and opens blank rows at the new bottom, so the old live-frame AND committed
 * band were left orphaned on screen as ghosts while the next render painted a
 * fresh frame at the new (lower) bottom.
 *
 * Fix: the immediate handler now snapshots the pre-resize footprint
 * (`pendingResizeErase`) on EXPAND only, preserves the band for re-pinning, and
 * the next repaint() physically erases the snapshotted rows
 * (`flushResizeGhostErase`). SHRINK is left to terminal scroll + band re-pin
 * (no absolute-row erase, which would wipe reflowed content).
 *
 * These tests drive the REAL compositor against a mock stdout, fire the real
 * ResizeBus via `process.stdout.emit('resize')` (matching the existing resize
 * suite), and assert on the emitted escape sequences + the resulting
 * VirtualScreen grid.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { TerminalCompositor } from './terminal-compositor.js';
import { VirtualScreen } from './_lib/testing/virtual-screen.js';

type MockStdout = NodeJS.WriteStream & {
  isTTY: boolean;
  columns: number;
  rows: number;
  emit(event: string, ...args: unknown[]): boolean;
  on(event: string, listener: (...args: unknown[]) => void): MockStdout;
};

type MockStdin = NodeJS.ReadStream & {
  isTTY: boolean;
  isRaw: boolean;
  setRawMode: ReturnType<typeof vi.fn>;
  emit(event: string, ...args: unknown[]): boolean;
};

function makeMockStdout(isTTY = true): MockStdout {
  const s = new PassThrough() as unknown as MockStdout;
  s.isTTY = isTTY;
  s.columns = 80;
  s.rows = 24;
  return s;
}

function makeMockStdin(isTTY = true): MockStdin {
  const s = new PassThrough() as unknown as MockStdin;
  s.isTTY = isTTY;
  s.isRaw = false;
  s.setRawMode = vi.fn((raw: boolean) => {
    s.isRaw = raw;
    return s;
  });
  return s;
}

function collectWrites(stream: MockStdout): { all: () => string; clear: () => void } {
  const chunks: string[] = [];
  stream.on('data', (c: unknown) => chunks.push(String(c)));
  return {
    all: () => chunks.join(''),
    clear: () => {
      chunks.length = 0;
    },
  };
}

/** Internal view used to read the compositor's private geometry tracking. */
type Internals = {
  committedBandTopRow: number;
  committedBandBottomRow: number;
  committedBand: string[];
  logUpdate: { topRow: number } | null;
  lastKnownRows: number;
  pendingResizeErase: { top: number; bottom: number } | null;
};

const eraseAt = (row: number): string => `\x1b[${row};1H\x1b[2K`;

describe('TerminalCompositor — resize ghost erase', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;
  let writes: ReturnType<typeof collectWrites>;
  const armed: TerminalCompositor[] = [];

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
    writes = collectWrites(stdout);
  });

  afterEach(() => {
    // arm() registers a process-level SIGWINCH listener via ResizeBus; a failing
    // assertion would otherwise leak it and hang the run. Disarm defensively.
    while (armed.length > 0) {
      try {
        armed.pop()?.disarm();
      } catch {
        /* idempotent */
      }
    }
    vi.useRealTimers();
  });

  it('EXPAND: snapshots the old frame+band footprint and physically erases those rows on the next repaint', async () => {
    vi.useFakeTimers();
    stdout.rows = 24;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    armed.push(c);
    await c.arm();

    // Establish a committed band + a multi-line live frame so there is a real
    // footprint to ghost.
    c.commitAbove('UNIQUEBANDLINE');
    c.setOverlay('OVERLAY-1\nOVERLAY-2\nOVERLAY-3');

    const internals = c as unknown as Internals;
    const oldBandTop = internals.committedBandTopRow;
    const oldFrameTop = internals.logUpdate?.topRow ?? 0;
    expect(oldBandTop).toBeGreaterThan(0); // band is positioned
    expect(internals.lastKnownRows).toBe(24);

    writes.clear();

    // Drag the window taller. Node updates stdout.rows synchronously before the
    // 'resize' event; the immediate handler runs synchronously inside emit().
    stdout.rows = 40;
    process.stdout.emit('resize');

    // The immediate handler must have snapshotted the old footprint (expand).
    expect(internals.pendingResizeErase).not.toBeNull();
    expect(internals.pendingResizeErase!.top).toBe(Math.min(oldFrameTop, oldBandTop));
    expect(internals.pendingResizeErase!.bottom).toBe(23); // old targetBottomRow = oldRows-1

    // The band content is preserved for re-pinning (NOT cleared on resize).
    expect(internals.committedBand.length).toBeGreaterThan(0);

    // Fire the debounced repaint (150ms).
    vi.advanceTimersByTime(150);

    const out = writes.all();
    // Old band row + old frame bottom row are physically erased.
    expect(out).toContain(eraseAt(oldBandTop));
    expect(out).toContain(eraseAt(23));
    // New frame paints at the new bottom (rows-1 = 39).
    expect(out).toContain('\x1b[39;1H');
    // Erase consumed exactly once.
    expect(internals.pendingResizeErase).toBeNull();
    // lastKnownRows advanced to the new geometry.
    expect(internals.lastKnownRows).toBe(40);
  });

  it('EXPAND: no committed band still erases the old (idle) frame row, never row 0', async () => {
    vi.useFakeTimers();
    stdout.rows = 24;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    armed.push(c);
    await c.arm(); // idle 1-line frame at row 23, no commitAbove → empty band

    const internals = c as unknown as Internals;
    expect(internals.committedBand.length).toBe(0);

    writes.clear();
    stdout.rows = 40;
    process.stdout.emit('resize');

    // Old idle input row (23) is snapshotted; band is empty so top===frame row.
    expect(internals.pendingResizeErase).not.toBeNull();
    expect(internals.pendingResizeErase!.bottom).toBe(23);

    vi.advanceTimersByTime(150);

    const out = writes.all();
    expect(out).toContain(eraseAt(23));
    // Must never emit a row-0 CUP (the empty-band off-by-one regression guard).
    expect(out).not.toContain('\x1b[0;1H');
    expect(out).toContain('\x1b[39;1H');
  });

  it('SHRINK: does NOT snapshot a ghost erase (old absolute rows now hold reflowed content)', async () => {
    vi.useFakeTimers();
    stdout.rows = 40;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    armed.push(c);
    await c.arm();
    c.commitAbove('UNIQUEBANDLINE');
    c.setOverlay('OVERLAY-1\nOVERLAY-2\nOVERLAY-3');

    const internals = c as unknown as Internals;
    expect(internals.lastKnownRows).toBe(40);
    const bandLenBefore = internals.committedBand.length;
    expect(bandLenBefore).toBeGreaterThan(0);

    writes.clear();
    stdout.rows = 24; // shrink
    process.stdout.emit('resize');

    // Shrink must NOT arm a ghost erase — erasing stale absolute rows would
    // wipe content the terminal scrolled into those rows.
    expect(internals.pendingResizeErase).toBeNull();

    vi.advanceTimersByTime(150);

    // Band content is preserved across the shrink (re-pinned, not dropped) and
    // the frame repaints at the new bottom (rows-1 = 23).
    expect(internals.committedBand.length).toBeGreaterThan(0);
    expect(writes.all()).toContain('\x1b[23;1H');
  });

  it('VirtualScreen: after EXPAND the old band row is blank (no frozen ghost) and the band text survives', async () => {
    vi.useFakeTimers();
    // A 40-row VirtualScreen faithfully models the expand case: content the
    // compositor CUP-positioned for a 24-row screen lands at rows <=23 and stays
    // anchored there (the terminal opens blank rows below rather than scrolling).
    const vscreen = new VirtualScreen(80, 40);
    stdout.on('data', (chunk: unknown) => {
      if (Buffer.isBuffer(chunk)) vscreen.write(chunk as Buffer);
      else if (typeof chunk === 'string') vscreen.write(Buffer.from(chunk, 'utf-8'));
    });

    stdout.rows = 24;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    armed.push(c);
    await c.arm();
    c.commitAbove('UNIQUEBANDLINE');
    c.setOverlay('OVERLAY-1\nOVERLAY-2\nOVERLAY-3');

    const internals = c as unknown as Internals;
    const oldBandTop = internals.committedBandTopRow;
    expect(oldBandTop).toBeGreaterThan(0);
    // Pre-resize the band text occupies its old row.
    expect(vscreen.lineAt(oldBandTop)).toContain('UNIQUEBANDLINE');

    stdout.rows = 40;
    process.stdout.emit('resize');
    vi.advanceTimersByTime(150);

    // The old band row is now blank — the ghost is physically erased.
    expect(vscreen.lineAt(oldBandTop).trim()).toBe('');
    // The band content was re-pinned somewhere in the (new, taller) viewport —
    // it did not vanish.
    const grid = vscreen.visibleLines().join('\n');
    expect(grid).toContain('UNIQUEBANDLINE');
    // And it appears exactly once (no duplicate ghost + re-pin).
    const occurrences = grid.split('UNIQUEBANDLINE').length - 1;
    expect(occurrences).toBe(1);
  });

  it('EXPAND then SHRINK before any repaint drops the stale expand snapshot (no ghost-erase wipes reflowed rows)', async () => {
    // Regression for the mid-drag double-resize race: lastKnownRows only
    // advances on repaint(), so a drag that EXPANDS then settles SMALLER than
    // it started — with no repaint in between (the debounced repaint fires
    // 150ms after the drag settles) — leaves the EXPAND's pendingResizeErase
    // armed. On the next repaint flushResizeGhostErase clamps the stale (large)
    // `bottom` into the new viewport and erases absolute rows that, post-shrink,
    // now hold reflowed content — rows the frame repaint never restores.
    vi.useFakeTimers();
    stdout.rows = 24;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    armed.push(c);
    await c.arm();

    // Multi-line band so the snapshot `top` lands well above the eventual
    // post-shrink viewport bottom — the case where the clamp does NOT save us.
    c.commitAbove('BAND-1\nBAND-2\nBAND-3\nBAND-4\nBAND-5\nBAND-6');
    c.setOverlay('OVERLAY-1\nOVERLAY-2');

    const internals = c as unknown as Internals;
    expect(internals.committedBand.length).toBeGreaterThan(0);
    expect(internals.lastKnownRows).toBe(24);

    writes.clear();

    // 1) EXPAND 24 -> 40. The immediate handler arms a ghost-erase snapshot.
    //    No repaint runs (timers not advanced), so lastKnownRows stays 24 —
    //    exactly the mid-drag window.
    stdout.rows = 40;
    process.stdout.emit('resize');
    expect(internals.pendingResizeErase).not.toBeNull();
    expect(internals.pendingResizeErase!.top).toBeLessThanOrEqual(17);

    // 2) SHRINK 40 -> 18 before any repaint (overshoot-then-settle-smaller).
    //    lastKnownRows is still 24, so this is a net shrink from the last paint.
    stdout.rows = 18;
    process.stdout.emit('resize');

    // The stale expand snapshot MUST be dropped here.
    expect(internals.pendingResizeErase).toBeNull();

    // 3) Debounced repaint at the new (smaller) geometry.
    vi.advanceTimersByTime(150);

    // Frame repaints at the new bottom (rows-1 = 17) and lastKnownRows advances.
    expect(writes.all()).toContain('\x1b[17;1H');
    expect(internals.lastKnownRows).toBe(18);
  });

  it('EXPAND then SHRINK before a repaint never erases into the reserved status-line region (extraRows > 0)', async () => {
    // Same race, observed through its worst symptom: with a status bar reserving
    // rows, the stale snapshot's flush wipes the status rows the compositor
    // frame never repaints. The compositor must never CUP into the reserved
    // region, so any escape targeting it is the bug's signature.
    vi.useFakeTimers();
    const scrollRegion = {
      withFullScrollRegion<T>(fn: () => T): T { return fn(); },
      getExtraRows(): number { return 2; },
    };
    stdout.rows = 24;
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), scrollRegion });
    armed.push(c);
    await c.arm();

    c.commitAbove('BAND-1\nBAND-2\nBAND-3\nBAND-4\nBAND-5\nBAND-6');
    c.setOverlay('OVERLAY-1');

    const internals = c as unknown as Internals;
    expect(internals.committedBand.length).toBeGreaterThan(0);

    writes.clear();

    // EXPAND then SHRINK within one pre-repaint window (lastKnownRows stays 24).
    stdout.rows = 40;
    process.stdout.emit('resize');
    const snap = internals.pendingResizeErase;
    expect(snap).not.toBeNull();
    // Precondition: snapshot bottom = oldRows-1-extraRows = 21, and top is small
    // enough that the clamped erase would reach the post-shrink status region.
    expect(snap!.bottom).toBe(21);
    expect(snap!.top).toBeLessThanOrEqual(15);

    stdout.rows = 18;
    process.stdout.emit('resize');

    vi.advanceTimersByTime(150);

    // New geometry: rows=18, extraRows=2 -> targetBottomRow = 15; the status bar
    // owns rows 16-17 and row 18 is the physical bottom. The compositor frame is
    // bounded to row 15 and must never CUP the reserved region. Under the bug,
    // the stale snapshot (bottom=21) is clamped to 18 and the flush erases
    // [top, 18] — wiping status rows 16-17 the frame repaint never restores.
    const out = writes.all();
    expect(out).not.toContain('\x1b[16;1H'); // status row — bug signature
    expect(out).not.toContain('\x1b[17;1H'); // status row — bug signature
    // Sanity: the frame did repaint at its new bottom content row.
    expect(out).toContain('\x1b[15;1H');
  });
});
