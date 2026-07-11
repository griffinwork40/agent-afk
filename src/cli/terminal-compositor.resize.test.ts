/**
 * Tests for TerminalCompositor — resize handling.
 *
 * Split verbatim from the terminal-compositor.test.ts monolith (#369);
 * these were nested describes under the top-level TerminalCompositor suite.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TerminalCompositor } from './terminal-compositor.js';
import { CupFrameRenderer } from './cup-frame-renderer.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';
import type { MockStdout, MockStdin } from './terminal-compositor.test-helpers.js';

describe('TerminalCompositor — resize handling', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;
  let writes: ReturnType<typeof collectWrites>;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
    writes = collectWrites(stdout);
    // Reset the process-wide StdinClaim singleton so each test starts clean.
    __resetStdinClaimForTests();
  });

  describe('resize handling', () => {
    // CupFrameRenderer positions each frame via absolute CUP escapes derived
    // from `targetBottomRow = stdout.rows - 1`. On vertical resize `stdout.rows`
    // changes, so the very next repaint() computes a new targetBottomRow and
    // renders the frame at the new position — no separate anchor step is needed.
    //
    // Test uses fake timers + `process.stdout.emit('resize')` because
    // ResizeBus subscribes to the real `process.stdout` (singleton), then
    // reads `this.stdout.rows` from the injected mock for the row math.
    // Fake timers flush the 150ms debounce.

    it('re-issues CUP frame at new bottom row when stdout.rows changes via ResizeBus', async () => {
      vi.useFakeTimers();
      let c: TerminalCompositor | null = null;
      try {
        stdout.rows = 24;
        c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
        await c.arm();
        // The arm-time render wrote a CUP for the initial frame at bottom row 23
        // (rows-1=23). The single input line lands at row 23.
        expect(writes.all()).toContain('\x1b[23;1H');
        writes.clear();

        // Simulate the user dragging the terminal to a different height.
        stdout.rows = 40;
        process.stdout.emit('resize');
        vi.advanceTimersByTime(150);

        // The post-resize repaint must render the new frame at bottom row 39
        // (rows-1=39). CupFrameRenderer writes the new frame's bottom row via
        // CUP — verify it appears in the output.
        const out = writes.all();
        expect(out).toContain('\x1b[39;1H');
        // Erase pass may legitimately write `\x1b[23;1H` (to erase the
        // previous frame at the old bottom row) — that is correct behavior and
        // is NOT the stale-anchor regression. The regression was log-update
        // tracking the old anchor row forever; here the new frame's position
        // is defined by the last CUP written for new content, which is 39.
      } finally {
        c?.disarm();
        vi.useRealTimers();
      }
    });

    it('does not write CUP anchor on resize when stdout is not a TTY', async () => {
      vi.useFakeTimers();
      try {
        const nonTty = makeMockStdout(false);
        const nonTtyWrites = collectWrites(nonTty);
        const c = new TerminalCompositor({ stdout: nonTty, stdin, onCancel: vi.fn() });
        await c.arm(); // no-op on non-TTY per arm() early-return
        nonTtyWrites.clear();
        nonTty.rows = 50;
        process.stdout.emit('resize');
        vi.advanceTimersByTime(150);
        // Non-TTY compositor never armed → never subscribed → no anchor write.
        expect(nonTtyWrites.all()).toBe('');
      } finally {
        vi.useRealTimers();
      }
    });

    it('clamps anchor row to 1 when stdout.rows resizes to a tiny value', async () => {
      vi.useFakeTimers();
      let c: TerminalCompositor | null = null;
      try {
        stdout.rows = 24;
        c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
        await c.arm();
        writes.clear();
        stdout.rows = 1; // Pathological — guards the `Math.max(1, rows - 1)` clamp.
        process.stdout.emit('resize');
        vi.advanceTimersByTime(150);
        // rows=1 → rows-1=0 → clamped to 1. Must not write `\x1b[0;1H` (invalid CUP).
        const out = writes.all();
        expect(out).toContain('\x1b[1;1H');
        expect(out).not.toContain('\x1b[0;1H');
      } finally {
        c?.disarm();
        vi.useRealTimers();
      }
    });

    it('disarm() unsubscribes from ResizeBus so later resizes do not repaint', async () => {
      vi.useFakeTimers();
      try {
        stdout.rows = 24;
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
        await c.arm();
        c.disarm();
        writes.clear();
        stdout.rows = 50;
        process.stdout.emit('resize');
        vi.advanceTimersByTime(150);
        // After disarm the subscription is dropped; no new anchor write.
        expect(writes.all()).not.toContain('\x1b[49;1H');
      } finally {
        vi.useRealTimers();
      }
    });

    it('re-renders frame at correct bottom row after resize with a multi-row overlay active', async () => {
      // History: the original log-update anchor-row bug only manifested when
      // the frame occupied multiple rows. With CupFrameRenderer, each repaint()
      // derives `targetBottomRow = rows - 1` from the current stdout.rows, so
      // a resize simply causes the next repaint to render the frame at the new
      // bottom row — multi-row frames are handled correctly by construction.
      vi.useFakeTimers();
      let c: TerminalCompositor | null = null;
      try {
        stdout.rows = 24;
        c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
        await c.arm();

        // Establish a multi-row frame: 3-line overlay + input line = 4 rows.
        c.setOverlay('alpha\nbeta\ngamma');
        writes.clear();

        // Resize to 40 rows. New bottom row must be 39 (40-1).
        stdout.rows = 40;
        process.stdout.emit('resize');
        vi.advanceTimersByTime(150);

        const out = writes.all();
        // New bottom row must appear in the post-resize repaint output.
        // CupFrameRenderer positions the last content line at row 39.
        expect(out).toContain('\x1b[39;1H');
        // The frame content must appear in the repaint (column change forces
        // a full redraw since wrap-ansi sees a new width via stdout.columns,
        // but rows-only change also forces a redraw because the frame's
        // topRow shifts upward — the renderer always re-emits the full frame).
        expect(out).toContain('alpha');
        expect(out).toContain('gamma');
      } finally {
        c?.disarm();
        vi.useRealTimers();
      }
    });

    it('positions the frame at the correct new bottom row after resize', async () => {
      // Invariant: CupFrameRenderer computes targetBottomRow = rows-1 on
      // every render() call, so each post-resize repaint() automatically
      // positions the frame's bottom line at the new terminal bottom row.
      // This test verifies the bottom-row CUP appears in the output and
      // the frame content is present (proving repaint() ran with new rows).
      vi.useFakeTimers();
      let c: TerminalCompositor | null = null;
      try {
        stdout.rows = 24;
        stdout.columns = 80;
        c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
        await c.arm();
        c.setOverlay('alpha\nbeta\nORDERING_MARKER');
        writes.clear();

        // Concurrent rows + columns change. Both trigger a repaint.
        stdout.rows = 40;
        stdout.columns = 100;
        process.stdout.emit('resize');
        vi.advanceTimersByTime(150);

        const out = writes.all();
        // New bottom row (rows-1=39) must appear — proves renderer used the
        // updated stdout.rows value.
        expect(out).toContain('\x1b[39;1H');
        // Frame content must be present — proves repaint() ran.
        expect(out).toContain('ORDERING_MARKER');
        // The frame is positioned at its new top row, which precedes the
        // bottom row in the CUP stream. The bottom CUP \x1b[39;1H is the
        // last line of the frame (input row), so it appears AFTER content.
        const bottomRowIdx = out.lastIndexOf('\x1b[39;1H');
        const contentIdx = out.indexOf('ORDERING_MARKER');
        expect(bottomRowIdx).toBeGreaterThanOrEqual(0);
        expect(contentIdx).toBeGreaterThanOrEqual(0);
        // ORDERING_MARKER is the 3rd overlay line (above input), so its CUP
        // row is less than 39 and it appears before the input-row CUP.
        expect(contentIdx).toBeLessThan(bottomRowIdx);
      } finally {
        c?.disarm();
        vi.useRealTimers();
      }
    });

    it('does not double-subscribe to ResizeBus on a second arm() after disarm()', async () => {
      // Behavioral proxy for the ResizeBus subscriber-count invariant: if a
      // re-arm path leaked a second subscription (forgot to clear in disarm,
      // or subscribed twice on rearm), a single resize event would fire two
      // repaint() calls, doubling the visible frame output. Verify by counting
      // CURSOR_HIDE sequences (\x1b[?25l) — CupFrameRenderer emits exactly
      // one per render() call. A single resize → single repaint → count=1.
      vi.useFakeTimers();
      let c: TerminalCompositor | null = null;
      try {
        stdout.rows = 24;
        c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
        await c.arm();
        c.disarm();
        await c.arm();
        writes.clear();

        stdout.rows = 40;
        process.stdout.emit('resize');
        vi.advanceTimersByTime(150);

        const out = writes.all();
        // CupFrameRenderer.render() emits exactly one \x1b[?25l per call.
        // One resize → one subscriber callback → one render() → count=1.
        // eslint-disable-next-line no-control-regex
        const hideCursorMatches = out.match(/\x1b\[\?25l/g);
        expect(hideCursorMatches).not.toBeNull();
        expect(hideCursorMatches?.length).toBe(1);
      } finally {
        c?.disarm();
        vi.useRealTimers();
      }
    });

    // -----------------------------------------------------------------------
    // Stale-geometry regression: SIGWINCH must reset CupFrameRenderer's
    // tracked previous-frame coordinates SYNCHRONOUSLY, before any spinner
    // tick or subagent event in the 150ms debounce window can call repaint().
    //
    // Pre-fix bug shape (user report): "tui rendering got fucky after
    // resizing" — duplicate overlays stacked vertically (shrink case: erase
    // CUPs clamped off-screen, old frame survives in scrollback) and ~50
    // blank lines (expand case: new frame paints higher up, gap of un-erased
    // rows between old top and new top). See cup-frame-renderer.ts
    // resetGeometry() docs for the geometry invariant.
    // -----------------------------------------------------------------------

    it('SIGWINCH synchronously calls logUpdate.resetGeometry() before any repaint', async () => {
      vi.useFakeTimers();
      let c: TerminalCompositor | null = null;
      try {
        stdout.rows = 24;
        c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
        await c.arm();

        // Swap in a spied logUpdate so we can observe call order.
        const internals = c as unknown as {
          logUpdate: {
            render: (s: string, n: number) => void;
            clear: () => void;
            done: () => void;
            resetGeometry: () => void;
            topRow?: number;
          };
        };
        const callOrder: string[] = [];
        internals.logUpdate = {
          render: () => callOrder.push('render'),
          clear: () => callOrder.push('clear'),
          done: () => callOrder.push('done'),
          resetGeometry: () => callOrder.push('resetGeometry'),
          topRow: 0,
        };

        // Fire SIGWINCH. The immediate handler must run synchronously here,
        // BEFORE the 150ms debounce fires the repaint.
        stdout.rows = 40;
        process.stdout.emit('resize');
        // Sync check: resetGeometry has fired, repaint (render) has NOT.
        expect(callOrder).toEqual(['resetGeometry']);

        // After the debounce, the repaint fires — order: reset, then render.
        vi.advanceTimersByTime(150);
        expect(callOrder).toEqual(['resetGeometry', 'render']);
      } finally {
        c?.disarm();
        vi.useRealTimers();
      }
    });

    it('multiple SIGWINCH events fire resetGeometry per event (no debounce coalescing)', async () => {
      // The immediate channel is intentionally NOT coalesced — each SIGWINCH
      // could change dimensions again, so geometry must be re-invalidated
      // every time. The debounced repaint still coalesces — only one render
      // at the end of the burst.
      vi.useFakeTimers();
      let c: TerminalCompositor | null = null;
      try {
        stdout.rows = 24;
        c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
        await c.arm();

        const internals = c as unknown as {
          logUpdate: {
            render: (s: string, n: number) => void;
            clear: () => void;
            done: () => void;
            resetGeometry: () => void;
            topRow?: number;
          };
        };
        const counts = { reset: 0, render: 0 };
        internals.logUpdate = {
          render: () => counts.render++,
          clear: () => {},
          done: () => {},
          resetGeometry: () => counts.reset++,
          topRow: 0,
        };

        // Simulate a window-drag burst: 5 rapid SIGWINCH events.
        stdout.rows = 30;
        process.stdout.emit('resize');
        stdout.rows = 36;
        process.stdout.emit('resize');
        stdout.rows = 40;
        process.stdout.emit('resize');
        stdout.rows = 38;
        process.stdout.emit('resize');
        stdout.rows = 40;
        process.stdout.emit('resize');

        // Reset fires once per SIGWINCH. Render has not yet fired (debounce
        // still pending — every emit reset the timer).
        expect(counts.reset).toBe(5);
        expect(counts.render).toBe(0);

        vi.advanceTimersByTime(150);

        // Debounced render fires exactly once after the burst settles.
        expect(counts.reset).toBe(5);
        expect(counts.render).toBe(1);
      } finally {
        c?.disarm();
        vi.useRealTimers();
      }
    });

    it('disarm() unsubscribes the immediate resize handler', async () => {
      // After disarm(), a SIGWINCH must not invoke resetGeometry on the
      // (now-stale) logUpdate. This prevents leaking subscriber callbacks
      // across rearm cycles and pins the symmetric cleanup contract.
      vi.useFakeTimers();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      try {
        await c.arm();

        const internals = c as unknown as {
          logUpdate: {
            render: (s: string, n: number) => void;
            clear: () => void;
            done: () => void;
            resetGeometry: () => void;
            topRow?: number;
          } | null;
        };
        let resetCalls = 0;
        // Replace logUpdate so we can observe; disarm() will call clear()/done()
        // on this replacement before nulling the field.
        internals.logUpdate = {
          render: () => {},
          clear: () => {},
          done: () => {},
          resetGeometry: () => resetCalls++,
          topRow: 0,
        };

        c.disarm();

        process.stdout.emit('resize');
        vi.advanceTimersByTime(150);

        // Zero immediate-handler invocations after disarm.
        expect(resetCalls).toBe(0);
      } finally {
        vi.useRealTimers();
      }
    });

    it('CupFrameRenderer integration: EXPAND erases the old frame ghost and paints fresh (no stale render-pass erase)', async () => {
      // End-to-end check against the real CupFrameRenderer (not a spy). After a
      // 24→40 EXPAND, the terminal freezes the old 1-line frame at row 23 while
      // the new frame paints at row 39 — so row 23 is a GHOST unless explicitly
      // erased. The resize ghost-erase (flushResizeGhostErase, fed by the
      // SIGWINCH immediate handler's pending snapshot) must emit a deliberate
      // CUP+EL at row 23 to clean it.
      //
      // Distinct from the old (pre-fix) bug it supersedes: render()'s OWN erase
      // pass must still not run against the STALE previousTopRow — resetGeometry()
      // zeroes previousLineCount so that loop is a no-op. We assert that by
      // requiring row 23 to be touched EXACTLY ONCE (the single deliberate
      // ghost-erase), never twice (which would mean the stale render pass also
      // CUPped it).
      vi.useFakeTimers();
      let c: TerminalCompositor | null = null;
      try {
        stdout.rows = 24;
        c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
        await c.arm();
        // Initial render: 1-line input frame at row 23 (24-1). previousTopRow=23.
        expect(writes.all()).toContain('\x1b[23;1H');
        writes.clear();

        // Resize. Immediate handler snapshots the old footprint (row 23) and
        // zeroes previousTopRow inside the emit() call, BEFORE the debounce.
        stdout.rows = 40;
        process.stdout.emit('resize');
        vi.advanceTimersByTime(150);

        const out = writes.all();
        // Post-resize repaint paints at the new bottom row 39.
        expect(out).toContain('\x1b[39;1H');
        // The old frame ghost at row 23 is physically erased (CUP + erase-line).
        expect(out).toContain('\x1b[23;1H\x1b[2K');
        // Exactly once: the deliberate ghost-erase. A second row-23 CUP would
        // mean render()'s erase pass ran against the stale previousTopRow.
        const cup23Count = (out.match(/\x1b\[23;1H/g) ?? []).length;
        expect(cup23Count).toBe(1);
      } finally {
        c?.disarm();
        vi.useRealTimers();
      }
    });
  });

});
