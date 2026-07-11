/**
 * Tests for TerminalCompositor
 *
 * Verifies:
 * 1. arm/disarm lifecycle + idempotency
 * 2. Repaint composition (overlay + input line via single log-update frame)
 * 3. commitAbove ordering (clear → write → repaint)
 * 4. Keypress dispatch (ESC/Ctrl+C → onCancel; Enter → queue; Backspace/printable → buffer edits)
 * 5. getBuffer semantics + queue transitions
 * 6. renderDropdownRows() — candidate text appears in stdout frame
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { PassThrough } from 'node:stream';
import { TerminalCompositor } from './terminal-compositor.js';
import { CupFrameRenderer } from './cup-frame-renderer.js';
import { createAutocompleteState } from './input/autocomplete-state.js';
import { register as registerSlashCommand, resetRegistry as resetSlashRegistry } from './slash/registry.js';
import { __resetStdinClaimForTests, currentStdinClaimHolder } from './input/stdin-claim.js';

// Module-level beforeEach: reset the stdin-claim singleton before every test
// regardless of which describe block it lives in. This prevents claim leaks
// when a test calls arm() without a corresponding disarm() in its teardown.
beforeEach(() => {
  __resetStdinClaimForTests();
});

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
  // PassThrough provides `write`, `on`, `emit`. Missing WriteStream methods
  // (cursorTo, clearLine, etc.) aren't used by the compositor; cast through
  // unknown to satisfy the NodeJS.WriteStream shape for test signatures.
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

describe('TerminalCompositor', () => {
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

  describe('arm/disarm lifecycle', () => {
    it('arm() enables raw mode and marks armed', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      expect(stdin.setRawMode).toHaveBeenCalledWith(true);
      expect(c.isArmed()).toBe(true);
    });

    it('arm() throws if called while already armed', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      await expect(c.arm()).rejects.toThrow('already armed');
      c.disarm();
    });

    it('disarm() restores prior raw mode', async () => {
      stdin.isRaw = false;
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.disarm();
      expect(stdin.setRawMode).toHaveBeenLastCalledWith(false);
      expect(c.isArmed()).toBe(false);
    });

    it('disarm() is idempotent when not armed', () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      expect(() => c.disarm()).not.toThrow();
      expect(c.isArmed()).toBe(false);
    });

    it('arm() on non-TTY stdout is a no-op (no raw mode)', async () => {
      const nonTtyStdout = makeMockStdout(false);
      const c = new TerminalCompositor({ stdout: nonTtyStdout, stdin, onCancel: vi.fn() });
      await c.arm();
      expect(stdin.setRawMode).not.toHaveBeenCalled();
      expect(c.isArmed()).toBe(false);
    });

    it('disarm() calls logUpdate.done() so the cursor is restored', async () => {
      // log-update hides the cursor on every render() and only calls
      // cliCursor.show() from done() — not clear(). Without this call the
      // cursor stays hidden for the rest of the session after the very
      // first turn finishes.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      // After arm(), the compositor's logUpdate instance exists. Swap in a
      // spy pair to observe disarm()'s teardown calls.
      const internals = c as unknown as {
        logUpdate: { clear: () => void; done: () => void } | null;
      };
      const clearSpy = vi.fn();
      const doneSpy = vi.fn();
      internals.logUpdate = { clear: clearSpy, done: doneSpy };
      c.disarm();
      expect(clearSpy).toHaveBeenCalledTimes(1);
      expect(doneSpy).toHaveBeenCalledTimes(1);
    });

    it('arm() acquires the stdin claim under TerminalCompositor.arm', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      expect(currentStdinClaimHolder()).toBeNull();
      await c.arm();
      expect(currentStdinClaimHolder()).toBe('TerminalCompositor.arm');
      c.disarm();
      expect(currentStdinClaimHolder()).toBeNull();
    });

    it('arm() throws a conflict error if another holder already holds the claim', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      // Manually acquire before arm() to simulate a concurrent consumer.
      const { acquireStdinClaim } = await import('./input/stdin-claim.js');
      const handle = acquireStdinClaim('test-interloper');
      try {
        await expect(c.arm()).rejects.toThrow('stdin claim conflict');
      } finally {
        handle.release();
      }
    });

    it('arm() rejecting on a stdin-claim conflict does not leak raw mode or bracketed-paste', async () => {
      // Regression: arm() enabled raw mode + bracketed-paste BEFORE acquiring the
      // stdin claim, then threw on conflict with armed=false — so disarm()'s
      // restore path never ran and the terminal leaked raw mode for the process
      // lifetime. After a failed arm(): raw mode must be off, and bracketed-paste
      // must not be left enabled (either never enabled, or re-disabled).
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      const { acquireStdinClaim } = await import('./input/stdin-claim.js');
      const handle = acquireStdinClaim('test-interloper');
      const chunks: string[] = [];
      stdout.on('data', (ch: unknown) => chunks.push(String(ch)));
      try {
        await expect(c.arm()).rejects.toThrow('stdin claim conflict');
        expect(stdin.isRaw).toBe(false);
        const out = chunks.join('');
        if (out.includes('\x1b[?2004h')) expect(out).toContain('\x1b[?2004l');
      } finally {
        handle.release();
      }
    });
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

  describe('repaint composition', () => {
    it('setOverlay writes overlay text to stdout', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.setOverlay('OVERLAY_TEXT');
      expect(writes.all()).toContain('OVERLAY_TEXT');
    });

    it('typing a printable char causes repaint to include the buffer', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      writes.clear();
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' });
      expect(writes.all()).toContain('hi');
    });

    it('empty overlay renders only input line (no leading blank)', async () => {
      // Idle state — no overlay, no spinner, no tip, no attachment — must
      // not pad above the prompt. With rows=24 the input lands at row 23
      // and no other row should be written. CupFrameRenderer emits one
      // `\x1b[<row>;1H\x1b[2K<content>` block per frame line; verify the
      // row just above input (row 22) is NOT written.
      stdout.rows = 24;
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), promptText: '> ' });
      await c.arm();
      const firstFrame = writes.all();
      expect(firstFrame).toContain('> ');
      // No write to row 22 — would indicate a gap row or other chrome.
      expect(firstFrame).not.toContain('\x1b[22;1H');
    });

    it('non-empty overlay inserts a blank row between overlay and the input cluster', async () => {
      // Visual breathing room: the input prompt is the user's surface and
      // should not sit flush against agent-activity chrome. When ANY content
      // (overlay/spinner/tip/attachment) renders above input, the frame
      // separates them with a single blank row (the gap sits between the
      // chrome region and the dropdown→hint→input bottom cluster).
      //
      // With rows=24 and a single-line overlay, frame = [overlay, gap, input]
      // → newTopRow = 21. Row 21 = overlay, row 22 = empty gap, row 23 =
      // input. Assert by locating the overlay text and the input prompt and
      // confirming the gap row's CUP+ERASE (with no content between it and
      // the next CUP for the input row) sits between them.
      stdout.rows = 24;
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), promptText: '> ' });
      await c.arm();
      writes.clear();
      c.setOverlay('OVERLAY_LAST_LINE');
      const out = writes.all();
      // CupFrameRenderer writes one CUP+ERASE+content per frame line, so byte
      // order in the captured stream reflects top-to-bottom row order.
      const overlayIdx = out.indexOf('OVERLAY_LAST_LINE');
      const inputIdx = out.lastIndexOf('> ');
      expect(overlayIdx).toBeGreaterThanOrEqual(0);
      expect(inputIdx).toBeGreaterThan(overlayIdx);
      // The gap row's CUP+ERASE pair must appear between the overlay and the
      // input row write — i.e., `\x1b[22;1H\x1b[2K` followed immediately by
      // a CUP for row 23. This is the empty content slot CupFrameRenderer
      // emits for the blank gap line.
      const gapPattern = '\x1b[22;1H\x1b[2K\x1b[23;1H';
      expect(out).toContain(gapPattern);
      const gapIdx = out.indexOf(gapPattern);
      expect(gapIdx).toBeGreaterThan(overlayIdx);
      expect(gapIdx).toBeLessThan(inputIdx);
    });
  });

  describe('commitAbove', () => {
    it('writes the committed text + scroll N times when armed', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      writes.clear();
      c.commitAbove('COMMITTED_BLOCK');
      const out = writes.all();
      // Text is present in the byte stream (Phase 3 CUP write above the frame).
      expect(out).toContain('COMMITTED_BLOCK');
      // Phase 3 positions the text immediately above the live frame.
      // With a 1-line idle frame and rows=24, newTopRow=23, so text lands at row 22.
      expect(out).toMatch(/\x1b\[22;1H\x1b\[2KCOMMITTED_BLOCK/);
      // Phase 1 emits bottom-margin scrolls only when existing band content
      // would overflow above-frame room (bandOverflow > 0). On the first
      // commit with an empty band the above-frame room (22 rows) is larger
      // than lineCount (1), so bandOverflow=0 and no LF fires — no blank
      // rows enter scrollback. The content enters scrollback naturally when
      // a later commit or overlay growth evicts it.
    });

    it('when not armed, writes directly without invoking log-update', () => {
      // Unarmed path: writeWithGuard short-circuits (no scrollRegion
      // configured), so the inner write is invoked verbatim. Text and \n
      // appear adjacent.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      c.commitAbove('ORPHAN_BLOCK');
      expect(writes.all()).toContain('ORPHAN_BLOCK\n');
    });

    it('with spinner active, commits text and renders exactly one spinner frame', async () => {
      // Regression: a re-entrant repaint() during the clear→write window
      // would strand a stale spinner frame in scrollback while repaint()
      // drew a second live frame below it, producing two visible spinners.
      // The `committing` guard suppresses repaint during that window.
      //
      // Single-copy contract (post-dedup fix): committed text appears EXACTLY
      // ONCE in the byte stream. The old dual-write (Phase 1 text + Phase 3
      // text) caused each committed block to appear twice in scrollback — the
      // "Done card rendered twice" regression. The fix: Phase 1 emits only
      // LF scrolls (no text); Phase 3 paints the single copy above the live
      // frame. Durability (surviving later overlay growth) is handled by
      // evict-on-growth in repaint(), which is gated on hasCommitted so it
      // only fires when transcript content actually exists above the frame.
      const BRAILLE_FRAME_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/g;
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.setSpinner({ enabled: true });
      writes.clear();
      c.commitAbove('COMMITTED_BLOCK');
      const out = writes.all();
      // Single-copy: committed text appears exactly once (Phase 3 only).
      expect(out.match(/COMMITTED_BLOCK/g)?.length).toBe(1);
      // Phase 1 emits LFs only when bandOverflow > 0 (existing band overflows
      // above-frame room). First commit with empty band: bandOverflow=0, no LF.
      // Exactly one spinner frame should be visible after the commit
      // (no re-entrant repaint stranded a second copy of it).
      const brailleMatches = out.match(BRAILLE_FRAME_RE);
      // The spinner appears at most once in the post-commit repaint.
      // (It may not appear at all if the spinner hadn't advanced its
      // frame index yet, but it should never appear twice.)
      expect(brailleMatches?.length ?? 0).toBeLessThanOrEqual(1);
    });

    it('fires bottom-margin scrolls only for band overflow (none while the band has above-frame room)', async () => {
      // Phase 1 of the scrollback-push contract: when committing new lines
      // causes the committed band to overflow above-frame room, Phase 1
      // emits `bandOverflow` LFs at the bottom margin — each LF at the
      // bottom margin triggers a full-screen scroll under
      // `withFullScrollRegion`'s temporary `(1, rows)` DECSTBM, evicting
      // the oldest band content (real rows, never blanks) into scrollback.
      //
      // When the new band fits in the above-frame room (bandOverflow=0),
      // Phase 1 emits NO LFs — Phase 3 extends the band in-place, no
      // blank rows ever enter scrollback.
      //
      // With a 1-line idle frame, rows=24, no scrollRegion, aboveFrameRoom=22.
      // 'A' adds 1 line to an empty band → 1 line total ≪ 22 → bandOverflow=0.
      // 'A\nB\nC' adds 3 more → 4 total ≪ 22 → still bandOverflow=0.
      // LFs only fire once the cumulative band exceeds 22 lines.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();

      writes.clear();
      c.commitAbove('A');
      const out1 = writes.all();
      // Band has 1 line, room is 22 → bandOverflow=0, no LF.
      expect(out1.match(/\x1b\[24;1H\n/g)?.length ?? 0).toBe(0);
      // Phase 3 places 'A' above the frame (row 22).
      expect(out1).toMatch(/\x1b\[22;1H\x1b\[2KA/);

      writes.clear();
      c.commitAbove('A\nB\nC');
      const out3 = writes.all();
      // Band has 4 lines after merge, room is 22 → still no overflow.
      expect(out3.match(/\x1b\[24;1H\n/g)?.length ?? 0).toBe(0);
      // Phase 3 places lines above the frame at rows 19-22.
      expect(out3).toMatch(/\x1b\[20;1H\x1b\[2KA/);
      expect(out3).toMatch(/\x1b\[22;1H\x1b\[2KC/);
    });

    it('writes committed text immediately above the new live frame (gap-free above-frame placement)', async () => {
      // Phase 3 of the scrollback-push contract: after the post-clear
      // repaint() lands the new live frame at `newTopRow..rows-1`, we
      // write the committed text at rows `newTopRow - lineCount..
      // newTopRow - 1` — directly above the live frame, with no blank
      // rows between text and frame.
      //
      // This places committed content visibly in the viewport's
      // above-frame area rather than only in scrollback (which requires
      // the user to scroll up). Older commits naturally climb upward as
      // each new commit's phase-1 scrolls shift the viewport up.
      //
      // Mock stdout.rows = 24. With a 1-line live frame (just the input
      // prompt), newTopRow = 23. Committed text lands at row 22.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      writes.clear();
      c.commitAbove('ABOVE_FRAME');
      const out = writes.all();

      // The text appears positioned via a CUP escape at row `newTopRow - 1`.
      // With a 1-line idle frame (just input prompt), newTopRow = 23, so
      // the text lands at row 22.
      expect(out).toMatch(/\x1b\[22;1H\x1b\[2KABOVE_FRAME/);

      // Phase 3 CUP write at row 22 appears in the output.
      // Phase 1 emits no LF (empty band, bandOverflow=0), so no
      // bottom-margin scroll precedes the Phase 3 write on the first commit.
      const phase3CupIdx = out.indexOf('\x1b[22;1H');
      expect(phase3CupIdx).toBeGreaterThanOrEqual(0);
    });

    it('multi-line text occupies consecutive rows immediately above the live frame', async () => {
      // 3-line text + 1-line idle frame → text at rows 20-22 (just above
      // newTopRow=23). Each line gets its own CUP positioning so they
      // start at column 1 regardless of whether the terminal driver
      // expands LF to CR+LF.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      writes.clear();
      c.commitAbove('LINE_ONE\nLINE_TWO\nLINE_THREE');
      const out = writes.all();

      // Each line CUP-positioned at its own row.
      expect(out).toMatch(/\x1b\[20;1H\x1b\[2KLINE_ONE/);
      expect(out).toMatch(/\x1b\[21;1H\x1b\[2KLINE_TWO/);
      expect(out).toMatch(/\x1b\[22;1H\x1b\[2KLINE_THREE/);
      // Phase 1 emits no LFs on first commit (empty band, bandOverflow=0).
      // The 3 lines are placed via Phase 3 CUP writes above the frame.
      expect(out).not.toMatch(/\x1b\[24;1H\n/);
    });

    it('text with trailing newline produces the same scroll count as text without (trailing \\n is not its own row)', async () => {
      // Regression: markdown commitBlock appends '\n' to the rendered text
      // before passing to commitAbove. That trailing newline represents
      // the end of the last paragraph row, not an additional row. If we
      // counted it as a row, we'd emit one extra scroll per commit and
      // push an extra banner-residue row to scrollback per turn.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();

      writes.clear();
      c.commitAbove('A\nB');
      const outWithout = writes.all();

      writes.clear();
      c.commitAbove('A\nB\n');
      const outWith = writes.all();

      // Both should emit the same Phase 3 CUP writes — trailing \n is
      // the line terminator, not an additional row. Phase 1 emits no LFs
      // (empty band on first commit, bandOverflow=0 either way).
      // After first commit ('A\nB'): band = ["A","B"] at rows 21..22.
      // After second commit ('A\nB\n'): same lineCount=2 → band = same positions.
      // Both Phase 3 writes land at rows 21..22.
      expect(outWithout).toMatch(/\x1b\[21;1H\x1b\[2KA/);
      expect(outWithout).toMatch(/\x1b\[22;1H\x1b\[2KB/);
      expect(outWith).toMatch(/\x1b\[21;1H\x1b\[2KA/);
      expect(outWith).toMatch(/\x1b\[22;1H\x1b\[2KB/);
    });

    it('double-newline-terminated commit preserves ALL rows with no content loss (top row archives to scrollback)', async () => {
      // Updated for the over-tall band-hold fix (commit-mode.ts): the separator-
      // inclusive bandLineCount (23) exceeds maxBandModel (22) for this exact-fit
      // scenario (rows=24, idle frame=1 row, maxBandModel=22), so useBandHold=true.
      // Phase 1 archives LINE_00 (the 1-row genuineOverflow) to scrollback via the
      // CUP-write-then-scroll mechanism. Phase 3 band-hold paints LINE_01..LINE_21 +
      // separator at viewport rows 1..22. No content is lost: LINE_00 is in
      // scrollback and LINE_01..LINE_21 are in the viewport (the end-to-end
      // no-loss invariant is pinned against a real @xterm/headless buffer by
      // terminal-compositor.band-hold-perline-gap.repro.test.ts and
      // terminal-compositor.endturn-overflow-gap.repro.test.ts).
      //
      // Pre-fix (d86f2a2 regression guard): the original test checked LINE_00 at row
      // 1 in the viewport — that assertion locked behavior the over-tall fix
      // legitimately changes. The invariant that MATTERS is "no row dropped", not
      // "every row in viewport when a 23-element band overflows maxBandModel=22".
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      writes.clear();
      // Build 22-line block. commitBlock calls commitAbove(trimmed + '\n\n');
      // we simulate that by appending '\n\n' ourselves.
      const lines = Array.from({ length: 22 }, (_, i) => `LINE_${String(i).padStart(2, '0')}`);
      c.commitAbove(lines.join('\n') + '\n\n');
      const out = writes.all();
      // The critical invariant: every content row must appear SOMEWHERE in the
      // output — either in the Phase 1 CUP-write (scrollback archive) or in
      // the Phase 3 band-hold viewport paint. No row is silently dropped.
      for (let i = 0; i < 22; i++) {
        const label = `LINE_${String(i).padStart(2, '0')}`;
        expect(out, `${label} must appear in output (not dropped)`).toContain(label);
      }
      // LINE_21 (last row) must be CUP-painted immediately above the frame (row 21
      // in the 22-row model — the model is [LINE_01..LINE_21, ''], so LINE_21 is at
      // model index 20, painted at row 21).
      expect(out).toMatch(/\x1b\[21;1H\x1b\[2KLINE_21/);
      // LINE_01 (first retained viewport row) must be at row 1 (top of viewport).
      expect(out).toMatch(/\x1b\[1;1H\x1b\[2KLINE_01/);
      // LINE_00 (archived to scrollback via Phase 1) must appear in the output
      // as a CUP-write at anchorFloor=1 before the scroll.
      expect(out).toMatch(/\x1b\[1;1H\x1b\[2KLINE_00/);
    });

    it('empty commit (compositor.commitAbove("")) places a blank row above the frame', async () => {
      // Used by the stream-renderer subagent-done path to insert a blank
      // separator line above the live frame. Phase 3 CUP-writes a blank
      // row immediately above newTopRow-1. Phase 1 emits no LF on the
      // first commit with an empty band (bandOverflow=0); the blank row
      // reaches scrollback when a subsequent commit evicts the band.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      writes.clear();
      c.commitAbove('');
      const out = writes.all();

      // Phase 3 CUP-writes a blank (empty) row at row 22 (newTopRow-1 for
      // a 1-line idle frame with rows=24).
      expect(out).toMatch(/\x1b\[22;1H\x1b\[2K/);
      // No bottom-margin LF on first commit (empty band, bandOverflow=0).
      expect(out).not.toMatch(/\x1b\[24;1H\n/);
    });

    it('consecutive "\\n\\n"-terminated commits paint a blank separator row between blocks (armed, with room)', async () => {
      // Regression (paragraphs-touching): commitBlock commits prose as
      // `trimmed + '\n\n'` so each block owns one trailing blank (the TUI rhythm
      // contract). d86f2a2 popped that trailing '' to fix a table exact-fit
      // cut-off, but as collateral it deleted the inter-block separator for
      // EVERY block in the armed path — consecutive paragraphs rendered with no
      // blank line between them. Fix: the separator is extracted, then re-painted
      // as a blank row whenever there is above-frame room beyond the content.
      //
      // rows=24, 1-line idle frame → newTopRow=23. After 'A\n\n': band=['A','']
      // (A@21, blank@22). After 'B\n\n': band=['A','','B',''] → A@19, blank@20,
      // B@21, blank@22. The blank at row 20 is the separator between paragraphs.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.commitAbove('A\n\n');
      writes.clear();
      c.commitAbove('B\n\n');
      const out = writes.all();
      // Block A sits two rows above block B — a blank separator occupies the row
      // between them (the buggy code butt-joined them at A@21, B@22).
      expect(out).toMatch(/\x1b\[19;1H\x1b\[2KA/);
      expect(out).toMatch(/\x1b\[21;1H\x1b\[2KB/);
      // The separator row (20) is CUP-painted blank: erase row 20 with empty
      // content, immediately followed by the CUP for row 21 (block B).
      expect(out).toContain('\x1b[20;1H\x1b[2K\x1b[21;1H');
      // Block B must NOT land immediately below A (row 20) — the butt-join.
      expect(out).not.toMatch(/\x1b\[20;1H\x1b\[2KB/);
    });

    it('single-block "\\n\\n"-terminated commit paints content + one trailing blank separator (armed, with room)', async () => {
      // The single-commit view of the same fix: `commitAbove('PARA\n\n')` paints
      // PARA immediately above a blank separator row, so the block owns its one
      // trailing blank even on the very first commit. rows=24, 1-line idle frame
      // → newTopRow=23; band=['PARA',''] → PARA@21, blank@22.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      writes.clear();
      c.commitAbove('PARA\n\n');
      const out = writes.all();
      // Content at row 21, separator blank painted at row 22 (against the frame).
      expect(out).toMatch(/\x1b\[21;1H\x1b\[2KPARA/);
      // Row 22 is CUP-erased with NO content (the blank separator), not PARA.
      expect(out).not.toMatch(/\x1b\[22;1H\x1b\[2KPARA/);
      expect(out).toMatch(/\x1b\[22;1H\x1b\[2K(\x1b|$)/);
    });

    it('text persists in scrollback even if a subsequent grow repaint overwrites the visible above-frame copy', async () => {
      // Single-copy contract (post-dedup fix): Phase 1 emits LF scrolls only
      // (no text write) to displace the topmost viewport row into scrollback
      // and open a slot just above the live frame. Phase 3 paints the text
      // into that slot — the SOLE copy. Durability (surviving a later overlay
      // growth that repaints over the above-frame slot) is provided by
      // evict-on-growth in repaint(): when the frame grows upward and would
      // CUP-overwrite the Phase-3 slot, repaint() evicts those rows to
      // scrollback first. The text therefore persists in scrollback even when
      // the visible above-frame copy is displaced by a taller frame.
      //
      // This test verifies: (a) Phase 1 emits LFs only for band overflow
      // (bandOverflow=0 on first commit with empty band), (b) Phase 3 writes
      // the single copy immediately above the live frame (row newTopRow-1),
      // and (c) the text appears exactly once in the byte stream.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      writes.clear();
      c.commitAbove('PERSISTED');
      const out = writes.all();

      // Phase 1: no LF on first commit (empty band, bandOverflow=0). No
      // blank row enters scrollback.
      expect(out).not.toMatch(/\x1b\[24;1H\n/);
      // Phase 3: text written above the live frame. With a 1-line idle frame,
      // newTopRow=23, so the text lands at row 22.
      expect(out).toMatch(/\x1b\[22;1H\x1b\[2KPERSISTED/);
      // Single-copy: the text appears exactly once (Phase 3 only, no Phase 1 text).
      expect(out.match(/PERSISTED/g)?.length).toBe(1);
    });

    it('resets the committing guard if logUpdate.clear() throws', async () => {
      // Without try/finally, a throw in clear() would leave committing=true
      // and silence every future repaint() — a permanent terminal freeze.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      // Force logUpdate.clear() to throw on the next call. Access the
      // private logUpdate via a typed cast — this is the minimal seam
      // available without exposing internals.
      const internals = c as unknown as { logUpdate: { clear: () => void } };
      const originalClear = internals.logUpdate.clear.bind(internals.logUpdate);
      internals.logUpdate.clear = () => {
        throw new Error('clear failed');
      };
      expect(() => c.commitAbove('WILL_THROW')).toThrow('clear failed');
      // Restore clear so the subsequent repaint can run.
      internals.logUpdate.clear = originalClear;
      // Guard must have been reset — a subsequent setOverlay → repaint
      // should produce a visible frame.
      writes.clear();
      c.setOverlay('POST_THROW_OVERLAY');
      expect(writes.all()).toContain('POST_THROW_OVERLAY');
    });

    it('emits \\x1b[2K before Phase 1 CUP-positioned text write (no tail survival)', async () => {
      // Regression: H2a — when a shorter string overwrites a longer one at the
      // same CUP-positioned row, the terminal retains the tail of the previous
      // write. Pattern: "embedders can inject a custom dispatcher via" (45 chars)
      // followed by "  $ bash cd agent-afk &&… — ✓ 50 lines" (38 chars) →
      // produces "  $ bash cd …liness can inject a custom dispatcher via" on
      // screen. Fix: prefix every Phase 1 CUP write with \x1b[2K (erase entire
      // line) so only the new content survives.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();

      // First commit: long text (45 chars).
      c.commitAbove('embedders can inject a custom dispatcher via');

      // Second commit: shorter text (38 chars). Without \x1b[2K the tail of the
      // first write survives on the same row, producing garbled output.
      writes.clear();
      c.commitAbove('  $ bash cd agent-afk && — ✓ 50 lines');
      const out = writes.all();

      // Phase 1 payload must include \x1b[2K immediately after the CUP sequence
      // and before the text content — no tail of a previous longer write can
      // survive when the line is erased before the new text is placed.
      expect(out).toMatch(/\x1b\[\d+;1H\x1b\[2K.*\$ bash cd agent-afk/);
    });
  });

  describe('anchorRow protection (banner-clobber regression)', () => {
    // Regression: CupFrameRenderer.render() grows the frame upward from
    // `rows-1` via absolute CUP positioning, floored only at row 1. When
    // the live overlay is tall enough that `newTopRow` reaches into rows
    // already occupied by a pre-arm welcome banner (printed via console.log
    // before the compositor armed), the renderer's per-row
    // `cup() + ERASE_LINE + content` writes overwrite the banner in place.
    //
    // These tests pin the fix: when `anchorRow` is supplied to the
    // compositor, a repaint that would otherwise overflow the anchor evicts
    // the deficit rows to scrollback FIRST (via `\n` writes at the bottom
    // of the active DECSTBM region — each `\n` scrolls the top row of
    // the region into the terminal's scrollback buffer), and the anchor
    // is shifted up by the eviction count so subsequent repaints see the
    // adjusted ceiling.

    it('frame that fits below anchorRow renders without eviction', async () => {
      // Frame fits: 1 overlay line + gap + input = 3 lines. Bottom at row
      // 23, top at row 21. Anchor at row 15. 21 > 15 → no overflow, no
      // eviction. Assert the CUP-to-bottom + \n eviction sequence is
      // absent from the post-render byte stream.
      stdout.rows = 24;
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), promptText: '> ',
        anchorRow: 15,
      });
      await c.arm();
      writes.clear();
      c.setOverlay('ONLY_ONE_LINE');
      const out = writes.all();
      // Eviction now targets the physical margin row 24 (this.stdout.rows),
      // which the frame render never writes to, so this cleanly asserts
      // no-eviction: a bare `\n` immediately after `\x1b[24;1H` (multi-newline
      // scroll trigger) must not appear.
      expect(out).not.toMatch(/\x1b\[24;1H\n/);
      // Overlay still rendered.
      expect(out).toContain('ONLY_ONE_LINE');
    });

    it('frame that overflows anchorRow evicts the deficit to scrollback before render', async () => {
      // Force overflow: 12-line overlay forces frame to 14 lines (overlay
      // + gap + input). With rows=24 → bottomRow=23 → desiredTopRow =
      // 23 - 14 + 1 = 10. anchorRow = 15 → deficit = 5 → 5 \n writes
      // expected at the bottom of the DECSTBM region BEFORE the render's
      // CUP sequences for the frame's content.
      stdout.rows = 24;
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), promptText: '> ',
        anchorRow: 15,
      });
      await c.arm();
      writes.clear();
      const bigOverlay = Array.from({ length: 12 }, (_, i) => `OVL_${i}`).join('\n');
      c.setOverlay(bigOverlay);
      const out = writes.all();
      // Eviction sequence: `\x1b[24;1H` followed by 5 consecutive `\n`s.
      // The implementation emits this in one stdout.write call.
      const evictionIdx = out.indexOf('\x1b[24;1H\n\n\n\n\n');
      expect(evictionIdx).toBeGreaterThanOrEqual(0);
      // First overlay line still rendered (proves the frame still ran).
      const overlayIdx = out.indexOf('OVL_0');
      expect(overlayIdx).toBeGreaterThanOrEqual(0);
      // Ordering matters: eviction MUST happen BEFORE the frame paints.
      // Without this ordering check, a buggy implementation that evicts
      // AFTER rendering (overwriting banner rows first, then scrolling
      // them into scrollback as blank-clears) would still satisfy the
      // two `toContain`-style checks above — defeating the regression's
      // purpose. The original bug was "frame overwrites banner"; the
      // fix is "evict first, then render."
      expect(evictionIdx).toBeLessThan(overlayIdx);
    });

    it('without anchorRow (undefined), no eviction even when frame is large (legacy behavior)', async () => {
      // Legacy guarantee: when anchorRow is not configured, the compositor
      // matches pre-fix behavior — frame can grow to row 1 without
      // evicting. Tests that the new path is strictly opt-in.
      stdout.rows = 24;
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), promptText: '> ',
      });
      await c.arm();
      writes.clear();
      const bigOverlay = Array.from({ length: 18 }, (_, i) => `OVL_${i}`).join('\n');
      c.setOverlay(bigOverlay);
      const out = writes.all();
      // No multi-newline scroll sequence — eviction must not have fired.
      expect(out).not.toMatch(/\x1b\[24;1H\n\n/);
    });

    it('setAnchorRow updates the anchor dynamically at runtime', async () => {
      // Two repaints: first with anchorRow=undefined (no eviction expected
      // even though overlay is large), second after setAnchorRow(15)
      // (overflow → eviction). Pins that the setter actually rewires the
      // protection without compositor reconstruction.
      stdout.rows = 24;
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), promptText: '> ',
      });
      await c.arm();
      const bigOverlay = Array.from({ length: 12 }, (_, i) => `OVL_${i}`).join('\n');

      writes.clear();
      c.setOverlay(bigOverlay);
      const phase1 = writes.all();
      expect(phase1).not.toMatch(/\x1b\[24;1H\n\n/);

      // Install the anchor — same overlay re-set to retrigger repaint.
      c.setAnchorRow(15);
      writes.clear();
      // Toggle the overlay so setOverlay does an update-and-repaint.
      c.setOverlay('');
      c.setOverlay(bigOverlay);
      const phase2 = writes.all();
      // Now eviction fires — same deficit calculation (5 rows).
      expect(phase2).toContain('\x1b[24;1H\n\n\n\n\n');
    });

    it('anchor shifts up after eviction so repeat repaints with the same frame do not double-evict', async () => {
      // After the first eviction shifts anchorRow from 15 to 10, a second
      // repaint with the same overlay sees desiredTopRow = 10 and the
      // anchor = 10 — no deficit, no second eviction. Without the shift,
      // every repaint would re-evict, scrolling the user's view away
      // until everything is in scrollback.
      stdout.rows = 24;
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), promptText: '> ',
        anchorRow: 15,
      });
      await c.arm();
      const bigOverlay = Array.from({ length: 12 }, (_, i) => `OVL_${i}`).join('\n');

      writes.clear();
      c.setOverlay(bigOverlay);
      const phase1 = writes.all();
      expect(phase1).toContain('\x1b[24;1H\n\n\n\n\n');

      writes.clear();
      // Force another repaint by typing a character (compositor repaints
      // on every keypress that mutates the input buffer).
      stdin.emit('keypress', 'x', { name: 'x', sequence: 'x' });
      const phase2 = writes.all();
      // No second eviction — anchor already shifted to match the frame top.
      expect(phase2).not.toMatch(/\x1b\[24;1H\n\n/);
    });

    it('disarm/rearm restores declared anchor — post-eviction shift does not leak across cycles', async () => {
      // Regression (H1, PR #539 review): repaint() mutates the working
      // anchorRow during eviction (15 → 10), but resetState() did not
      // clear it. On the next arm() the field still held 10, so the
      // declared ceiling was silently under-protected by 5 rows. The fix
      // separates the declared snapshot (constructor / setAnchorRow value)
      // from the working ceiling (mutated by eviction). On disarm the
      // working ceiling clears; on rearm it re-seeds from the declared
      // snapshot. This test:
      //   1. Arms with anchorRow=15, evicts (shifts working to 10).
      //   2. Disarms.
      //   3. Rearms — working anchor must be 15 again, NOT 10.
      //   4. Verifies behaviorally by repainting the same large overlay:
      //      a second eviction MUST fire (deficit = 15 - 10 = 5 rows).
      //      With the bug, working anchor stays at 10 → no overflow →
      //      no eviction — this would fail.
      stdout.rows = 24;
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), promptText: '> ',
        anchorRow: 15,
      });
      await c.arm();
      const bigOverlay = Array.from({ length: 12 }, (_, i) => `OVL_${i}`).join('\n');

      writes.clear();
      c.setOverlay(bigOverlay);
      expect(writes.all()).toContain('\x1b[24;1H\n\n\n\n\n');

      c.disarm();
      await c.arm();

      writes.clear();
      // Toggle to retrigger a repaint of the same large overlay. If the
      // working anchor leaked across cycles at value 10, this would not
      // overflow and would not evict. With the fix, the working anchor
      // is back at 15 → overflow → 5-row eviction fires again.
      c.setOverlay('');
      c.setOverlay(bigOverlay);
      expect(writes.all()).toContain('\x1b[24;1H\n\n\n\n\n');

      c.disarm();
    });

    it('setAnchorRow updates the declared snapshot — survives disarm/rearm', async () => {
      // Companion to the prior test: setAnchorRow() must also persist
      // across disarm/rearm. Construction starts with anchorRow=15;
      // setAnchorRow(undefined) clears it; after disarm/rearm the working
      // anchor must reflect the SETTER value (undefined → no protection),
      // not the CONSTRUCTOR value (15 → eviction).
      stdout.rows = 24;
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), promptText: '> ',
        anchorRow: 15,
      });
      await c.arm();
      c.setAnchorRow(undefined);
      c.disarm();
      await c.arm();

      writes.clear();
      const bigOverlay = Array.from({ length: 12 }, (_, i) => `OVL_${i}`).join('\n');
      c.setOverlay(bigOverlay);
      // Setter cleared protection → no eviction even with overflow-sized
      // overlay. If the ctor value had been incorrectly restored on rearm,
      // a 5-row eviction would fire here.
      expect(writes.all()).not.toMatch(/\x1b\[24;1H\n\n/);

      c.disarm();
    });

    it('commitAbove does NOT write text into banner rows even with anchorRow set (single-copy dedup fix)', async () => {
      // Post-dedup fix: Phase 1 is scroll-only (no text write at all),
      // which eliminates the "padded echo appearing above the banner"
      // artifact entirely — Phase 1 never writes to the banner zone.
      // Phase 3 writes the single copy above the live frame, respecting
      // anchorRow as a textStartRow floor so it never lands in pre-arm
      // banner rows either.
      //
      // With anchorRow=10, a 1-line commit, and rows=24 (idle 1-line frame):
      //   fitsAboveFrame = true, empty band, 13 rows of above-frame room →
      //     bandOverflow = max(0, 0 + 1 - 13) = 0 → Phase 1 emits NO scroll
      //   Phase 2 repaint → topRow=23
      //   Phase 3 textStartRow = max(10, 23-1) = 22 → text at row 22
      //
      // The committed line appears at row 22 (inside the frame zone, NOT the
      // banner zone rows 1..9) and is NOT written into the banner.
      stdout.rows = 24;
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), promptText: '> ',
        anchorRow: 10,
      });
      await c.arm();
      writes.clear();
      // Simulate the right-aligned echo InputSurface would produce.
      const paddedEcho = ' '.repeat(60) + '/review 539';
      c.commitAbove(paddedEcho);
      const out = writes.all();

      // Phase 1 does NOT write text at anchorRow (10) or row 1 — scroll-only.
      // Negative: neither the banner-clobber row nor the legacy row 1 carries text.
      expect(out).not.toContain(`\x1b[10;1H\x1b[2K${paddedEcho}`);
      expect(out).not.toContain(`\x1b[1;1H${paddedEcho}`);
      // Phase 3 writes the single copy above the live frame (row 22).
      expect(out).toContain(`\x1b[22;1H\x1b[2K${paddedEcho}`);
      // The FIRST commit into an empty band with ample above-frame room is
      // scroll-free (bandOverflow=0) — identical to the no-anchor single-copy
      // path. The banner no longer forces a spurious lineCount scroll on every
      // commit; that quirk left the floor stale and orphaned committed content
      // in the vacated banner rows — see terminal-compositor.banner-commit-gap.test.ts.
      // The single copy enters scrollback later via evict-on-growth / the next commit.
      expect(out).not.toMatch(/\x1b\[24;1H\n/);
    });

    it('commitAbove Phase 3 always lands at row newTopRow-1 regardless of anchorRow (single-copy path)', async () => {
      // Backward-compat pin: with no anchorRow set, Phase 1 is still
      // scroll-only (the dedup fix applies uniformly). Phase 3 writes the
      // single copy at row newTopRow-1 (22 with a 1-line idle frame and
      // rows=24). Text does NOT appear at row 1 in the byte stream.
      stdout.rows = 24;
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), promptText: '> ',
      });
      await c.arm();
      writes.clear();
      c.commitAbove('LEGACY_NO_ANCHOR');
      const out = writes.all();
      // Phase 3 writes at row 22 (newTopRow-1 for a 1-line idle frame).
      expect(out).toContain('\x1b[22;1H\x1b[2KLEGACY_NO_ANCHOR');
      // Phase 1 is scroll-only — text must NOT appear at row 1.
      expect(out).not.toContain('\x1b[1;1H\x1b[2KLEGACY_NO_ANCHOR');
      // No LF on first commit (no anchorRow → canUseMergePath=true, empty band
      // → bandOverflow=0). The content enters scrollback via evict-on-growth.
    });

    it('commitAbove Phase 3 textStartRow floors at anchorRow (no banner-row CUP write)', async () => {
      // Phase 3 writes the committed text into the visible above-frame
      // area at row `max(1, newTopRow - lineCount)` for visible
      // accumulation. With a 3-line commit, idle 1-line frame
      // (newTopRow=23), and anchorRow=22, the pre-fix textStartRow =
      // max(1, 20) = 20, which is INSIDE the pre-arm banner zone (rows
      // 1..21). The fix floors at anchorRow=22.
      //
      // Post-fix (over-tall band-hold): maxBandModel = overflowTargetBottom -
      // anchorFloor = 23 - 22 = 1. The 3-line block exceeds maxBandModel, so
      // useBandHold=true. Phase 1 archives the genuineOverflow (rows L1, L2) to
      // scrollback via CUP-write at anchorFloor=22 + scroll. Phase 3 band-hold
      // paints the capped model (last 1 row = [L3]) at row 22 (targetBottom).
      // The core invariant — no banner-row (rows 1..21) CUP write — is preserved.
      stdout.rows = 24;
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), promptText: '> ',
        anchorRow: 22,
      });
      await c.arm();
      writes.clear();
      c.commitAbove('L1\nL2\nL3');
      const out = writes.all();

      // Phase 3 must NOT write at rows 20-21 (banner zone).
      expect(out).not.toMatch(/\x1b\[20;1H\x1b\[2KL1/);
      expect(out).not.toMatch(/\x1b\[21;1H\x1b\[2KL2/);
      // All three lines must appear somewhere in the output (no content loss).
      // L1 and L2 are archived to scrollback via band-hold Phase 1 (CUP at row 22);
      // L3 is painted in the viewport via Phase 3 band-hold (model=[L3] at row 22).
      expect(out).toContain('L1');
      expect(out).toContain('L2');
      expect(out).toContain('L3');
      // Band-hold Phase 1 writes at anchorFloor (row 22) then scrolls:
      // the oldest genuineOverflow rows (L1, L2) are archived to scrollback.
      // The old legacy-overflow assertion '\x1b[24;1H\n\n\n' (3 newlines) no
      // longer applies — band-hold archives 2 rows (2 newlines), not 3.
      expect(out).toContain('\x1b[24;1H\n\n');
      expect(out).not.toContain('\x1b[24;1H\n\n\n');
    });
  });

  describe('keypress handling', () => {
    it('ESC triggers onSoftStop once (not onCancel)', async () => {
      const onCancel = vi.fn();
      const onSoftStop = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel, onSoftStop });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'escape' });
      // ESC routes to onSoftStop, NOT onCancel (Ctrl+C is the onCancel path).
      expect(onSoftStop).toHaveBeenCalledTimes(1);
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('second ESC is a no-op (softStopped once-only guard)', async () => {
      const onSoftStop = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onSoftStop });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'escape' });
      stdin.emit('keypress', undefined, { name: 'escape' });
      // softStopped guard: second ESC is silently ignored.
      expect(onSoftStop).toHaveBeenCalledTimes(1);
    });

    it('ESC leaves a typed-but-unsubmitted buffer as an editable draft (queued stays false)', async () => {
      // ESC does NOT queue a buffer the user only typed (never Entered).
      // The text is preserved — setInputMode no longer de-queues and never
      // clears the buffer — but queued stays false, so the next
      // idle-transition flush does NOT auto-submit it. The user keeps
      // editing and submits with an explicit Enter when ready. (Only an
      // Enter-confirmed buffer auto-submits on ESC — see the idempotent
      // test below and the 'soft-stop drain' block.)
      const onSoftStop = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop });
      await c.arm();
      // Type a message mid-stream WITHOUT pressing Enter (queued stays false).
      for (const ch of 'wait') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      expect(c.getBuffer()).toEqual({ text: 'wait', queued: false });
      stdin.emit('keypress', undefined, { name: 'escape' });
      expect(onSoftStop).toHaveBeenCalledTimes(1);
      // Text preserved, but NOT queued — stays a draft for explicit submission.
      expect(c.getBuffer()).toEqual({ text: 'wait', queued: false });
    });

    it('second ESC with a typed-but-unqueued draft is a no-op and does not disturb the draft', async () => {
      // The once-only `softStopped` guard must hold even when a typed draft is
      // present: a second ESC fires neither onSoftStop again nor any queue
      // mutation, and the preserved draft is left exactly as typed.
      const onSoftStop = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop });
      await c.arm();
      for (const ch of 'wait') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      stdin.emit('keypress', undefined, { name: 'escape' });
      stdin.emit('keypress', undefined, { name: 'escape' });
      expect(onSoftStop).toHaveBeenCalledTimes(1);
      // Draft untouched across both presses — still typed, still not queued.
      expect(c.getBuffer()).toEqual({ text: 'wait', queued: false });
    });

    it('ESC after Enter leaves the queued message in the FIFO (idempotent soft-stop)', async () => {
      // New contract: Enter commits the buffer to the FIFO and clears the live
      // input. ESC (soft-stop) does NOT drain or drop already-committed messages —
      // the queue survives the soft-stop and drains on the next → idle transition.
      const onSoftStop = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop });
      await c.arm();
      // Type + Enter → commits 'hi' to FIFO, live buffer cleared.
      for (const ch of 'hi') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
      stdin.emit('keypress', undefined, { name: 'escape' });
      expect(onSoftStop).toHaveBeenCalledTimes(1);
      // Queued message preserved, live buffer still empty.
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
    });

    it('ESC on an empty buffer does not set queued (nothing to submit)', async () => {
      const onSoftStop = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'escape' });
      expect(onSoftStop).toHaveBeenCalledTimes(1);
      expect(c.getBuffer()).toEqual({ text: '', queued: false });
    });

    // ── Usage-limit pause: Enter ends the wait AND queues (B) ──────────────
    //
    // While a turn is parked in a usage-limit pause, the compositor's `paused`
    // flag is set. A submitted line must still queue (so it flushes as the next
    // turn) AND fire onPauseInterrupt (so the turn handler ends the auto-resume
    // wait via session.interrupt). This is the one-gesture escape: type
    // `/model <name>` + Enter during the pause → on the new provider next turn.
    it('Enter during a usage-limit pause fires onPauseInterrupt and still queues the buffer', async () => {
      const onPauseInterrupt = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onPauseInterrupt });
      await c.arm();
      c.paused = true;
      for (const ch of 'hi') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(onPauseInterrupt).toHaveBeenCalledTimes(1);
      // Buffer stays queued so the next readLine's idle-flush dispatches it.
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      c.disarm();
    });

    // Regression guard: when NOT paused, Enter is plain type-ahead — it queues
    // but must NOT fire onPauseInterrupt (else normal mid-stream typing would
    // spuriously interrupt the turn).
    it('Enter when NOT paused does not fire onPauseInterrupt (normal type-ahead queue)', async () => {
      const onPauseInterrupt = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onPauseInterrupt });
      await c.arm();
      // paused defaults to false.
      for (const ch of 'hi') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(onPauseInterrupt).not.toHaveBeenCalled();
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      c.disarm();
    });

    // An empty-buffer Enter during a pause is suppressed (nothing to submit), so
    // it must not fire the pause-interrupt either — a stray Enter shouldn't kill
    // the wait when the user has typed nothing.
    it('Enter on an empty buffer during a pause does not fire onPauseInterrupt', async () => {
      const onPauseInterrupt = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onPauseInterrupt });
      await c.arm();
      c.paused = true;
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(onPauseInterrupt).not.toHaveBeenCalled();
      expect(c.getBuffer()).toEqual({ text: '', queued: false });
      c.disarm();
    });

    // ── h1 regression: ESC with an open autocomplete dropdown ──────────────
    //
    // Bug: while the agent streamed, ghost-text / slash autocomplete frequently
    // left `dropdownOpen === true`. handleEscape's dropdown-dismiss branch
    // returned EARLY, so the first ESC closed the dropdown but never reached
    // the soft-stop path — the user had to press ESC TWICE to stop the agent
    // ("double-press to cancel"). Fix (input-dispatch.ts): the dropdown-dismiss
    // branch no longer returns; it falls through so a single ESC both closes
    // the dropdown AND fires onSoftStop in streaming mode, while the idle-mode
    // guard on the next line keeps ESC a pure UI-dismissal between turns.
    it('single ESC fires onSoftStop AND dismisses an open dropdown mid-stream (h1)', async () => {
      resetSlashRegistry();
      registerSlashCommand({
        name: '/render-test',
        summary: 'Stub to open the slash dropdown',
        handler: async () => ({ kind: 'noop' as const }),
      });
      try {
        const ac = createAutocompleteState();
        const onSoftStop = vi.fn();
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop, autocompleteState: ac });
        await c.arm();
        c.setInputMode('streaming'); // a turn is live

        // Type '/' → updateAutocomplete opens the slash dropdown (earned via a
        // real keystroke, not mutation) — mirrors ghost-text open mid-stream.
        stdin.emit('keypress', '/', { name: '/', sequence: '/' });
        expect(ac.dropdownOpen).toBe(true);

        // A SINGLE ESC must both dismiss the dropdown AND fire soft-stop —
        // pre-fix this required two presses.
        stdin.emit('keypress', undefined, { name: 'escape' });
        expect(ac.dropdownOpen).toBe(false);
        expect(onSoftStop).toHaveBeenCalledTimes(1);
      } finally {
        resetSlashRegistry();
      }
    });

    it('ESC with an open dropdown stays a pure UI-dismissal in idle mode — no soft-stop (h1)', async () => {
      resetSlashRegistry();
      registerSlashCommand({
        name: '/render-test',
        summary: 'Stub to open the slash dropdown',
        handler: async () => ({ kind: 'noop' as const }),
      });
      try {
        const ac = createAutocompleteState();
        const onSoftStop = vi.fn();
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop, autocompleteState: ac });
        await c.arm();
        c.setInputMode('idle'); // between turns — NOT streaming

        stdin.emit('keypress', '/', { name: '/', sequence: '/' });
        expect(ac.dropdownOpen).toBe(true);

        // ESC dismisses the dropdown, but the idle-mode guard suppresses
        // soft-stop (no live turn to stop). The fall-through must not change this.
        stdin.emit('keypress', undefined, { name: 'escape' });
        expect(ac.dropdownOpen).toBe(false);
        expect(onSoftStop).not.toHaveBeenCalled();
      } finally {
        resetSlashRegistry();
      }
    });

    it('Ctrl+C triggers onCancel', async () => {
      const onCancel = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'c', ctrl: true });
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it('Ctrl+C does NOT auto-queue a typed-but-unconfirmed buffer (preserved as a draft, parity with ESC)', async () => {
      // Ctrl+C is now a graceful soft-stop (the REPL handleSigint fires the
      // same soft-stop ESC does). Like ESC, it must NOT auto-queue a buffer
      // the user only typed (never Entered): the text stays an editable draft
      // (queued=false) instead of being flung as a turn the user never
      // submitted. onCancel still fires (handleSigint owns stop/exit dispatch).
      const onCancel = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel });
      await c.arm();
      for (const ch of 'wait') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      expect(c.getBuffer()).toEqual({ text: 'wait', queued: false });
      stdin.emit('keypress', undefined, { name: 'c', ctrl: true });
      expect(onCancel).toHaveBeenCalledTimes(1);
      // Draft preserved, NOT auto-queued.
      expect(c.getBuffer()).toEqual({ text: 'wait', queued: false });
    });

    it('a second Ctrl+C within one streaming turn is swallowed by the once-only guard', async () => {
      // The compositor fires onCancel once per streaming turn; the SECOND
      // quit-press lands in idle (the turn ends on the soft-stop interrupt),
      // where handleSigint's exit-window check quits. This guard only stops a
      // burst of presses INSIDE one turn from firing onCancel repeatedly.
      const onCancel = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'c', ctrl: true });
      stdin.emit('keypress', undefined, { name: 'c', ctrl: true });
      expect(onCancel).toHaveBeenCalledTimes(1);
    });

    // ── New keybindings (PR 231): Ctrl+L, Ctrl+D, line-relative Home/End ────
    //
    // Dispatch-level coverage for the key ROUTING. The InputCore pure-function
    // contracts (moveLineStart / moveLineEnd / deleteForward) live in
    // input-core.test.ts; these tests drive real keypress events through an
    // armed compositor to prove the keys are wired to those functions.
    it('Ctrl+L clears the viewport (CSI 2J) + repaints, and does NOT wipe scrollback (no CSI 3J)', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      writes.clear(); // isolate the writes produced by Ctrl+L alone
      stdin.emit('keypress', undefined, { name: 'l', ctrl: true });
      const out = writes.all();
      // clearScreen() writes cursor-home + erase-entire-screen before repaint.
      expect(out).toContain('\x1b[H\x1b[2J');
      // Ctrl+L preserves scrollback — unlike /clear it must NOT send CSI 3J.
      expect(out).not.toContain('\x1b[3J');
    });

    it('Ctrl+D on an EMPTY buffer fires onCancel (EOF on an empty line)', async () => {
      const onCancel = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'd', ctrl: true });
      expect(onCancel).toHaveBeenCalledTimes(1);
      expect(c.getBuffer()).toEqual({ text: '', queued: false });
    });

    it('Ctrl+D on a NON-EMPTY buffer forward-deletes one char and does NOT fire onCancel', async () => {
      const onCancel = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel });
      await c.arm();
      for (const ch of 'hello') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      stdin.emit('keypress', undefined, { name: 'home' }); // cursor → line start (index 0)
      stdin.emit('keypress', undefined, { name: 'd', ctrl: true }); // forward-delete 'h'
      expect(c.getBuffer()).toEqual({ text: 'ello', queued: false });
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('Home routes to moveLineStart: on line 2 of a multi-line draft it lands at the line start, not buffer start', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      // Build 'first\nsecond' (shift+Enter inserts a soft newline); cursor ends on line 2.
      for (const ch of 'first') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      stdin.emit('keypress', undefined, { name: 'return', shift: true });
      for (const ch of 'second') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      stdin.emit('keypress', undefined, { name: 'home' }); // line-relative → start of "second"
      stdin.emit('keypress', 'z', { name: 'z', sequence: 'z' }); // marker at the cursor
      // Line-relative Home inserts at the start of line 2 → 'first\nzsecond'.
      // Buffer-absolute moveHome would instead have produced 'zfirst\nsecond'.
      expect(c.getBuffer()).toEqual({ text: 'first\nzsecond', queued: false });
    });

    it('End routes to moveLineEnd: on line 1 of a multi-line draft it lands at the line end, not buffer end', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      // Build 'first\nsecond'; cursor ends at index 12 (on line 2).
      for (const ch of 'first') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      stdin.emit('keypress', undefined, { name: 'return', shift: true });
      for (const ch of 'second') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      // Move into the MIDDLE of line 1: Home (→ start of line 2, idx 6) then Left×2 (→ idx 4).
      stdin.emit('keypress', undefined, { name: 'home' });
      stdin.emit('keypress', undefined, { name: 'left' });
      stdin.emit('keypress', undefined, { name: 'left' });
      stdin.emit('keypress', undefined, { name: 'end' }); // line-relative → end of line 1 (idx 5)
      stdin.emit('keypress', 'z', { name: 'z', sequence: 'z' }); // marker at the cursor
      // Line-relative End inserts at the end of line 1 → 'firstz\nsecond'.
      // Buffer-absolute moveEnd would instead have produced 'first\nsecondz'.
      expect(c.getBuffer()).toEqual({ text: 'firstz\nsecond', queued: false });
    });

    it('trailing backslash + Enter inserts a newline instead of submitting (regression: \\+Enter)', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      // Type 'foo\' then press PLAIN Enter. A trailing backslash is the
      // documented soft-newline escape for terminals that don't report
      // shift-state on Enter. Before the fix this branch lived only in
      // reader.ts (the non-TTY/legacy path), never in the compositor's
      // handleEnter — so in the live REPL plain Enter submitted the raw
      // 'foo\' instead of continuing onto a new line.
      for (const ch of 'foo') stdin.emit('keypress', ch, { name: ch, sequence: ch });
      stdin.emit('keypress', '\\', { name: '\\', sequence: '\\' });
      stdin.emit('keypress', undefined, { name: 'return' });
      // The trailing '\' is replaced by '\n'; nothing is submitted or queued.
      expect(c.getBuffer()).toEqual({ text: 'foo\n', queued: false });
    });

    // ── Soft-stop drain (regression: ESC → perpetual input-lag-of-one) ──────
    //
    // Reported bug: after ESC (soft-stop), the user's next typed+Enter'd
    // message appeared to do nothing — "it looks like it sends but no turn
    // starts; I have to send a follow-up for it to respond to the first one,"
    // then lag for the rest of the session.
    //
    // Root cause (two layers, both now fixed):
    //   1. session.interrupt() USED to be deferred to the next stream event,
    //      so the compositor lingered in streaming mode for a network-latency
    //      window after ESC. The soft-stop handler now calls interrupt()
    //      SYNCHRONOUSLY on ESC (turn-handler.ts / run-skill-dispatch-turn.ts),
    //      so the turn settles immediately and that window is closed at the
    //      source rather than merely survived.
    //   2. setInputMode's soft-stop guard USED to DE-QUEUE a buffer queued
    //      during/after ESC — clearing the queued flag and holding the text as
    //      an editable draft that needed a SECOND explicit Enter. That IS the
    //      "looks like it sends but no turn starts" symptom: the user pressed
    //      Enter, saw the echo, but no turn began.
    //
    // Fix (Bug B): the soft-stop guard NO LONGER de-queues. It clears the
    // once-only `softStopped` flag (bounding its lifetime) and falls through,
    // so an Enter-confirmed (queued) buffer AUTO-SUBMITS as the next turn via
    // the widened any→idle flush, exactly like normal mid-turn type-ahead. A
    // buffer the user only TYPED (never Entered) stays queued=false and is
    // preserved as an editable draft — ESC does not auto-queue it (see
    // handleEscape), matching "ESC with nothing queued keeps what I typed in
    // the input field." Safe because the synchronous interrupt (layer 1) closes
    // the window that would otherwise pile queued buffers into a perpetual
    // off-by-one.
    //
    // Each test mirrors the production turn boundary using only the public
    // compositor API:
    //   arm            → setInputMode('idle') then setInputMode('streaming')
    //   dispose        → setInputMode('idle')              [stream-renderer.ts:791]
    //   readLine       → setOnSubmit(h) then setInputMode('idle')  [input-surface.ts:438,448]
    //   next turn arm  → setInputMode('streaming')         [stream-renderer.ts:352]
    describe('soft-stop drain', () => {
      it('auto-flushes a buffer typed+Entered during the interrupt window as the next turn', async () => {
        const onSoftStop = vi.fn();
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop });
        await c.arm();
        c.setInputMode('idle');      // armCompositor initial idle
        c.setInputMode('streaming'); // turn arm

        // ESC with an empty buffer (user just wants to stop the agent).
        stdin.emit('keypress', undefined, { name: 'escape' });
        expect(onSoftStop).toHaveBeenCalledTimes(1);
        expect(c.getBuffer()).toEqual({ text: '', queued: false });

        // Interrupt window: user types a redirect + Enter BEFORE the stream
        // halts and readLine re-arms. onSubmit is null → Enter commits to FIFO
        // and clears the live buffer.
        for (const ch of 'redirect') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        stdin.emit('keypress', undefined, { name: 'return' });
        // New contract: live buffer is cleared; committed payload is in FIFO.
        expect(c.getBuffer()).toEqual({ text: '', queued: true });
        expect(c.getPendingCount()).toBe(1);

        // dispose() flips to idle. The soft-stop guard clears softStopped but
        // PRESERVES the queued FIFO (Bug B: no de-queue). onSubmit is null
        // here, so no flush yet — the FIFO stays for the next readLine.
        c.setInputMode('idle');
        expect(c.getBuffer()).toEqual({ text: '', queued: true });
        expect(c.getPendingCount()).toBe(1);

        // readLine: install handler + setInputMode('idle'). softStopped was
        // cleared at dispose, so the widened any→idle flush AUTO-SUBMITS the
        // queued message as the next turn — no second Enter, no phantom lag.
        const onSubmit = vi.fn();
        c.setOnSubmit(onSubmit);
        c.setInputMode('idle');
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith({ text: 'redirect', attachments: [] });
        expect(c.getBuffer()).toEqual({ text: '', queued: false });
      });

      it('breaks the perpetual lag + buffer contamination across consecutive soft-stops', async () => {
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');

        const submitTurn = (label: string): ReturnType<typeof vi.fn> => {
          // Turn arm.
          c.setInputMode('streaming');
          // ESC mid-stream, then type a message + Enter during the interrupt window.
          stdin.emit('keypress', undefined, { name: 'escape' });
          for (const ch of label) stdin.emit('keypress', ch, { name: ch, sequence: ch });
          stdin.emit('keypress', undefined, { name: 'return' });
          // dispose → idle: softStopped cleared, queued FIFO PRESERVED (no
          // de-queue). Live buffer was already cleared at Enter-time, so there is
          // no stale text from a prior turn (regression: 'alphabeta' contamination
          // cannot occur because the message was committed, not held in the buffer).
          c.setInputMode('idle');
          expect(c.getBuffer()).toEqual({ text: '', queued: true });
          expect(c.getPendingCount()).toBe(1);
          // readLine: installing the handler + setInputMode('idle') AUTO-SUBMITS
          // this turn's message exactly once — no second Enter, no off-by-one.
          const onSubmit = vi.fn();
          c.setOnSubmit(onSubmit);
          c.setInputMode('idle');
          expect(onSubmit).toHaveBeenCalledTimes(1);
          expect(onSubmit).toHaveBeenCalledWith({ text: label, attachments: [] });
          c.setOnSubmit(null);
          return onSubmit;
        };

        // Three sequential ESC-interrupted turns: each auto-submits its OWN
        // message exactly once — no off-by-one, no accumulated stale text.
        submitTurn('alpha');
        submitTurn('beta');
        submitTurn('gamma');
      });

      it('coalesces MULTIPLE messages Entered during ONE soft-stop window (merged, no backlog)', async () => {
        // The residual regression the Bug-B fix (see block comment above) did NOT
        // cover: it assumed the synchronous interrupt closes the streaming window
        // at the source. For a SUBAGENT turn that assumption fails —
        // cancelActiveForeground() (subagent-executor.ts) resolves the parent
        // await only after the child settles, so the compositor lingers in
        // 'streaming' for seconds. A user who sees no turn start types several
        // messages + Enter; pre-fix each pushed onto the FIFO, which drains ONE
        // per turn → the "it doesn't send, then I keep sending characters to catch
        // up" report. Post-fix, all window messages MERGE into one payload —
        // last-wins (the original #403 shape) silently dropped the earlier
        // messages, which users experienced as "it didn't send" all over again.
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');
        c.setInputMode('streaming'); // turn arm

        // ESC once (soft-stop), then THREE messages Entered during the teardown
        // window (softStopped stays true until the post-soft-stop → idle transition).
        stdin.emit('keypress', undefined, { name: 'escape' });
        for (const msg of ['first', 'second', 'third']) {
          for (const ch of msg) stdin.emit('keypress', ch, { name: ch, sequence: ch });
          stdin.emit('keypress', undefined, { name: 'return' });
        }
        // Merged: the FIFO holds ONE payload carrying all three messages,
        // not a backlog of 3 — and not just the last one.
        expect(c.getPendingCount()).toBe(1);
        expect(c.getBuffer()).toEqual({ text: '', queued: true });

        // dispose → idle: softStopped cleared, no drain (onSubmit null).
        c.setInputMode('idle');
        expect(c.getPendingCount()).toBe(1);

        // readLine drains the single merged payload as exactly ONE next turn.
        const onSubmit = vi.fn();
        c.setOnSubmit(onSubmit);
        c.setInputMode('idle');
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith({ text: 'first\nsecond\nthird', attachments: [] });
      });

      it('a "." poke after a real post-ESC message does NOT drop the message (merge, not last-wins)', async () => {
        // The exact field signature (v5.25.0 postmortem): during a slow
        // subagent-cancel settle the user types a real instruction + Enter,
        // sees nothing happen, and pokes with "." + Enter to test liveness.
        // Under last-wins the "." REPLACED the instruction — silently lost,
        // user had to retype: "it didn't send" round 2. Under merge, both
        // survive as one turn.
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');
        c.setInputMode('streaming'); // turn arm

        stdin.emit('keypress', undefined, { name: 'escape' });
        for (const ch of 'fix the bug') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        stdin.emit('keypress', undefined, { name: 'return' });
        stdin.emit('keypress', '.', { name: '.', sequence: '.' });
        stdin.emit('keypress', undefined, { name: 'return' });

        expect(c.getPendingCount()).toBe(1);
        c.setInputMode('idle'); // dispose → no drain (onSubmit null)

        const onSubmit = vi.fn();
        c.setOnSubmit(onSubmit);
        c.setInputMode('idle');
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith({ text: 'fix the bug\n.', attachments: [] });
      });

      it('normal multi-message type-ahead (NO ESC) still accumulates every message (blast-radius guard)', async () => {
        // The merge coalesce fires ONLY under softStopped. Ordinary mid-turn
        // type-ahead must still queue every message for sequential-turn delivery —
        // coalescing here would silently drop queued turns the user intended.
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');
        c.setInputMode('streaming'); // turn arm, no ESC → softStopped stays false

        for (const msg of ['one', 'two', 'three']) {
          for (const ch of msg) stdin.emit('keypress', ch, { name: ch, sequence: ch });
          stdin.emit('keypress', undefined, { name: 'return' });
        }
        // All three accumulate — the sequential-turn delivery contract is preserved.
        expect(c.getPendingCount()).toBe(3);
      });

      it('pre-ESC queued message survives a post-ESC Enter (coalesce preserves pre-ESC queue)', async () => {
        // Regression guard for the HIGH review finding: the array-wide
        // `pendingSubmissions = [payload]` reassignment silently dropped any
        // message committed via Enter BEFORE pressing ESC — violating the
        // handleEscape contract ("Already-queued messages: left untouched").
        // The fix snapshots the queue length at ESC time (softStopQueueBase)
        // and truncates back to that base before pushing, so pre-ESC payloads
        // drain as their own turns while post-ESC type-ahead still coalesces.
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');
        c.setInputMode('streaming'); // turn arm

        // 1. Enter "msg1" while streaming (no ESC yet) → push, queue=[msg1].
        for (const ch of 'msg1') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        stdin.emit('keypress', undefined, { name: 'return' });
        expect(c.getPendingCount()).toBe(1);

        // 2. ESC → softStopped=true, softStopQueueBase=1, queue untouched.
        stdin.emit('keypress', undefined, { name: 'escape' });

        // 3. Enter "msg2" during linger → truncate-to-base(1) + push → queue=[msg1, msg2].
        for (const ch of 'msg2') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        stdin.emit('keypress', undefined, { name: 'return' });
        expect(c.getPendingCount()).toBe(2); // pre-ESC msg1 is NOT dropped

        // 4. dispose → idle: softStopped cleared, no drain (onSubmit null).
        c.setInputMode('idle');
        expect(c.getPendingCount()).toBe(2);

        // 5. readLine drains the FIFO oldest-first: msg1 as the first turn, msg2 as the second.
        const onSubmit = vi.fn();
        c.setOnSubmit(onSubmit);
        c.setInputMode('idle'); // drain #1 → msg1
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith({ text: 'msg1', attachments: [] });
        c.setInputMode('idle'); // drain #2 → msg2
        expect(onSubmit).toHaveBeenCalledTimes(2);
        expect(onSubmit).toHaveBeenNthCalledWith(2, { text: 'msg2', attachments: [] });
      });

      it('pre-ESC queued message survives MULTIPLE post-ESC Enters (coalesce replaces only post-ESC entries)', async () => {
        // Same contract as above, but with several post-ESC Enters: the pre-ESC
        // payload must survive while the post-ESC ones coalesce into one merged payload.
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');
        c.setInputMode('streaming'); // turn arm

        for (const ch of 'pre') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        stdin.emit('keypress', undefined, { name: 'return' });
        expect(c.getPendingCount()).toBe(1);

        stdin.emit('keypress', undefined, { name: 'escape' });

        for (const msg of ['post1', 'post2', 'post3']) {
          for (const ch of msg) stdin.emit('keypress', ch, { name: ch, sequence: ch });
          stdin.emit('keypress', undefined, { name: 'return' });
        }
        // pre-ESC "pre" survives (base=1); three post-ESC Enters coalesce into
        // ONE merged payload → total queue = 2, NOT 1 (pre not dropped) and NOT 4.
        expect(c.getPendingCount()).toBe(2);

        c.setInputMode('idle'); // dispose → no drain (onSubmit null)

        const onSubmit = vi.fn();
        c.setOnSubmit(onSubmit);
        c.setInputMode('idle'); // drain #1 → "pre"
        expect(onSubmit).toHaveBeenCalledWith({ text: 'pre', attachments: [] });
        c.setInputMode('idle'); // drain #2 → merged post-ESC intent (nothing dropped)
        expect(onSubmit).toHaveBeenNthCalledWith(2, { text: 'post1\npost2\npost3', attachments: [] });
      });

      it('still auto-flushes normal mid-turn type-ahead (NO ESC) — no regression', async () => {
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');
        c.setInputMode('streaming'); // turn arm (softStopped stays false — no ESC)

        // User types ahead mid-stream + Enter → commits to FIFO, live buffer cleared.
        for (const ch of 'ahead') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        stdin.emit('keypress', undefined, { name: 'return' });
        // New contract: live buffer cleared; 'ahead' is in the FIFO.
        expect(c.getBuffer()).toEqual({ text: '', queued: true });
        expect(c.getPendingCount()).toBe(1);

        // dispose → idle: onSubmit null, softStopped false → FIFO stays.
        c.setInputMode('idle');
        expect(c.getBuffer()).toEqual({ text: '', queued: true });
        expect(c.getPendingCount()).toBe(1);

        // readLine: the widened flush auto-submits the type-ahead (the
        // intentional feature the drain guard must NOT suppress when there was
        // no ESC).
        const onSubmit = vi.fn();
        c.setOnSubmit(onSubmit);
        c.setInputMode('idle');
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith({ text: 'ahead', attachments: [] });
      });

      it('keeps a typed-but-unconfirmed (no Enter) interrupt-window buffer editable in idle', async () => {
        // A buffer typed during the interrupt window but NOT Entered stays
        // queued=false, so it is preserved as an editable idle draft; the user
        // can keep editing and the eventual submission is the EDITED text. Only
        // a typed+Entered buffer auto-submits — see above.
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');
        c.setInputMode('streaming');

        // ESC (empty buffer), then a partial message WITHOUT Enter.
        stdin.emit('keypress', undefined, { name: 'escape' });
        for (const ch of 'redirec') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        c.setInputMode('idle'); // dispose → softStopped cleared; queued stays false
        expect(c.getBuffer()).toEqual({ text: 'redirec', queued: false });

        // readLine: handler installed, no auto-fire.
        const onSubmit = vi.fn();
        c.setOnSubmit(onSubmit);
        c.setInputMode('idle');
        expect(onSubmit).not.toHaveBeenCalled();

        // User finishes editing the preserved draft in idle.
        for (const ch of 't more') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        expect(c.getBuffer()).toEqual({ text: 'redirect more', queued: false });

        // Explicit Enter submits the EDITED text, exactly once.
        stdin.emit('keypress', undefined, { name: 'return' });
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith({ text: 'redirect more', attachments: [] });
      });

      it('keeps a pre-ESC typed draft (no Enter) editable in idle — does NOT auto-submit', async () => {
        // Symmetric to the typed-AFTER-ESC case above: a buffer the user typed
        // BEFORE pressing ESC, without Enter, is also preserved as an editable
        // draft (queued=false). ESC no longer auto-queues it, so it waits for an
        // explicit Enter instead of being flung as an unconfirmed turn. This is
        // the "ESC with nothing queued leaves what I typed in the input" case.
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');
        c.setInputMode('streaming');

        // Type a draft WITHOUT Enter, then ESC. handleEscape does NOT queue it.
        for (const ch of 'wait') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        stdin.emit('keypress', undefined, { name: 'escape' });
        expect(c.getBuffer()).toEqual({ text: 'wait', queued: false });

        // dispose → idle: softStopped cleared, buffer preserved, still not queued.
        c.setInputMode('idle');
        expect(c.getBuffer()).toEqual({ text: 'wait', queued: false });

        // readLine: handler installed — NO auto-fire (queued is false).
        const onSubmit = vi.fn();
        c.setOnSubmit(onSubmit);
        c.setInputMode('idle');
        expect(onSubmit).not.toHaveBeenCalled();
        expect(c.getBuffer()).toEqual({ text: 'wait', queued: false });

        // Explicit Enter submits the preserved draft, exactly once.
        stdin.emit('keypress', undefined, { name: 'return' });
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith({ text: 'wait', attachments: [] });
      });

      it('flushes a message typed in the idle window AFTER an empty-buffer ESC (no dropped message)', async () => {
        // Regression (user report): "ESC to stop, then my next message looks
        // like it sends but no turn starts — I have to send a follow-up for it
        // to respond to the first one." Root cause: an EMPTY-buffer ESC sets
        // softStopped=true with queued=false, so the old `softStopped &&
        // queued` drain guard never fired at dispose and softStopped persisted
        // into the idle period; the next message — queued in the brief
        // inter-readLine window before onSubmit is installed — then hit the
        // guard at readLine→idle and was silently DE-QUEUED. The fix clears
        // softStopped at the first →idle transition, so idle-window
        // submissions flush normally. Pre-fix this asserts 0 onSubmit calls;
        // post-fix it asserts exactly 1.
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onSoftStop: vi.fn() });
        await c.arm();
        c.setInputMode('idle');      // armCompositor initial idle
        c.setInputMode('streaming'); // turn arm

        // ESC with an EMPTY buffer — the common "just stop the agent" case.
        stdin.emit('keypress', undefined, { name: 'escape' });
        expect(c.getBuffer()).toEqual({ text: '', queued: false });

        // dispose → idle: the drain guard fires on softStopped alone and
        // clears it (buffer empty — nothing to preserve).
        c.setInputMode('idle');
        expect(c.getBuffer()).toEqual({ text: '', queued: false });

        // Inter-readLine window: the user types their next message + Enter
        // BEFORE readLine installs onSubmit. Enter commits to FIFO and clears
        // the live buffer (queued=true, not yet fired).
        for (const ch of 'next') stdin.emit('keypress', ch, { name: ch, sequence: ch });
        stdin.emit('keypress', undefined, { name: 'return' });
        // New contract: live buffer cleared; 'next' is in the FIFO.
        expect(c.getBuffer()).toEqual({ text: '', queued: true });
        expect(c.getPendingCount()).toBe(1);

        // readLine: install handler + setInputMode('idle'). softStopped is
        // already cleared, so the widened any→idle flush fires onSubmit — the
        // message is NOT silently dropped (pre-fix: softStopped persisted and
        // de-queued it here, requiring a second send).
        const onSubmit = vi.fn();
        c.setOnSubmit(onSubmit);
        c.setInputMode('idle');
        expect(onSubmit).toHaveBeenCalledTimes(1);
        expect(onSubmit).toHaveBeenCalledWith({ text: 'next', attachments: [] });
        expect(c.getBuffer()).toEqual({ text: '', queued: false });
      });
    });

    it('printable chars grow buffer', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' });
      expect(c.getBuffer().text).toBe('hi');
    });

    it('printable emoji (multi-UTF-16-unit graphemes) are inserted, not dropped', async () => {
      // Regression: the printable filter used `char.length === 1`, a UTF-16
      // code-UNIT count — it silently dropped surrogate-pair emoji
      // ('😀'.length === 2) and variation-selector / skin-tone emoji
      // ('❤️', '👍🏽'). Each is a single printable grapheme and must insert.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', '😀', { sequence: '😀' });
      stdin.emit('keypress', '❤️', { sequence: '❤️' });
      expect(c.getBuffer().text).toBe('😀❤️');
      c.disarm();
    });

    it('backspace shrinks buffer', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' });
      stdin.emit('keypress', undefined, { name: 'backspace' });
      expect(c.getBuffer().text).toBe('h');
    });

    it('Enter sets queued=true when buffer is non-empty', async () => {
      // New contract: Enter COMMITS the buffer to the FIFO and CLEARS the live
      // input. The message is in getPendingCount(), not getBuffer().text.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
    });

    it('Enter on empty buffer does not set queued', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'return' });
      expect(c.getBuffer()).toEqual({ text: '', queued: false });
    });

    it('Backspace after Enter does NOT unqueue (queue is edited via ↑, not Backspace)', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', undefined, { name: 'return' }); // commits 'h', live buffer → ''
      expect(c.getBuffer().queued).toBe(true);
      expect(c.getPendingCount()).toBe(1);
      stdin.emit('keypress', undefined, { name: 'backspace' }); // empty buffer → no-op on the queue
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
    });

    it('typing after queue leaves the committed message queued and grows the live buffer', async () => {
      // New contract: the live buffer is independent of pendingSubmissions.
      // Editing the in-progress buffer does NOT pop or clear committed messages.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', undefined, { name: 'return' }); // commits 'h', clears live buffer
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
      stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' }); // next message draft
      // The committed 'h' is still in the queue; live buffer now has 'i'.
      expect(c.getBuffer()).toEqual({ text: 'i', queued: true });
      expect(c.getPendingCount()).toBe(1);
    });

    it('Enter on empty live buffer while already queued is a no-op (no double-queue)', async () => {
      // After first Enter: buffer cleared → ''. Second Enter on empty buffer
      // hits the early-return guard (empty text + no attachments) — does NOT
      // push an empty payload, so pendingCount stays 1.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', 'i', { name: 'i', sequence: 'i' });
      stdin.emit('keypress', undefined, { name: 'return' }); // commits 'hi', clears live buffer
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
      stdin.emit('keypress', undefined, { name: 'return' }); // empty buffer → no-op
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
    });

    it('cursor editing in the live buffer after a commit does not affect the queue', async () => {
      // After committing 'abc', the live buffer is empty. Type 'XY', move
      // left, insert 'Z' mid-buffer. Queue stays at 1 throughout — live-buffer
      // edits are completely decoupled from pendingSubmissions.
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
      stdin.emit('keypress', 'b', { name: 'b', sequence: 'b' });
      stdin.emit('keypress', 'c', { name: 'c', sequence: 'c' });
      stdin.emit('keypress', undefined, { name: 'return' }); // commits 'abc', live buffer → ''
      expect(c.getPendingCount()).toBe(1);
      // Type new content into the cleared live buffer.
      stdin.emit('keypress', 'X', { name: 'X', sequence: 'X' });
      stdin.emit('keypress', 'Y', { name: 'Y', sequence: 'Y' });
      stdin.emit('keypress', undefined, { name: 'left' }); // cursor before 'Y'
      stdin.emit('keypress', 'Z', { name: 'Z', sequence: 'Z' }); // insert mid-buffer
      // Live buffer edited; committed 'abc' is still queued untouched.
      expect(c.getBuffer()).toEqual({ text: 'XZY', queued: true });
      expect(c.getPendingCount()).toBe(1);
    });

    it('backspace inside the live buffer does not pop the queue', async () => {
      // After committing 'abc', type 'xy' in the live buffer then backspace
      // 'y'. The queued 'abc' is untouched — backspace only pops the queue
      // when the LIVE buffer is empty (cursor at 0, nothing to delete).
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
      stdin.emit('keypress', 'b', { name: 'b', sequence: 'b' });
      stdin.emit('keypress', 'c', { name: 'c', sequence: 'c' });
      stdin.emit('keypress', undefined, { name: 'return' }); // commits 'abc', live buffer → ''
      stdin.emit('keypress', 'x', { name: 'x', sequence: 'x' });
      stdin.emit('keypress', 'y', { name: 'y', sequence: 'y' });
      stdin.emit('keypress', undefined, { name: 'backspace' }); // deletes 'y' from live buffer
      // Live buffer = 'x'; committed 'abc' still pending.
      expect(c.getBuffer()).toEqual({ text: 'x', queued: true });
      expect(c.getPendingCount()).toBe(1);
    });

    it('Backspace on empty live buffer does NOT dequeue (queue is edited via ↑, not deleted)', async () => {
      // Contract: Backspace never touches pendingSubmissions. With the buffer
      // empty and 1 message queued, Backspace is a no-op on the queue — the
      // committed message is recalled for editing with ↑, never discarded by
      // Backspace (which previously popped it and silently lost the text).
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
      stdin.emit('keypress', 'b', { name: 'b', sequence: 'b' });
      stdin.emit('keypress', 'c', { name: 'c', sequence: 'c' });
      stdin.emit('keypress', undefined, { name: 'return' }); // commits 'abc', live buffer → ''
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
      stdin.emit('keypress', undefined, { name: 'backspace' }); // empty live buffer → no-op on queue
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
    });

    it('arrow keys do not trigger cancel', async () => {
      const onCancel = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'left' });
      stdin.emit('keypress', undefined, { name: 'right' });
      stdin.emit('keypress', undefined, { name: 'up' });
      stdin.emit('keypress', undefined, { name: 'down' });
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('left/right move cursor within buffer', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
      stdin.emit('keypress', 'b', { name: 'b', sequence: 'b' });
      stdin.emit('keypress', 'c', { name: 'c', sequence: 'c' });
      // cursor at 3. Move left once -> insert 'X' -> buffer is "abXc"
      stdin.emit('keypress', undefined, { name: 'left' });
      stdin.emit('keypress', 'X', { name: 'X', sequence: 'X' });
      expect(c.getBuffer().text).toBe('abXc');
    });

    it('Ctrl+B fires onBackground callback exactly once', async () => {
      const onBackground = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), onBackground });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'b', ctrl: true });
      expect(onBackground).toHaveBeenCalledTimes(1);
      stdin.emit('keypress', undefined, { name: 'b', ctrl: true });
      expect(onBackground).toHaveBeenCalledTimes(1);
    });

    it('Ctrl+B without onBackground does not throw', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'b', ctrl: true });
      expect(c.getBuffer().text).toBe('');
    });

    it('ignores ctrl/meta modifiers that are not cancel-combos', async () => {
      const onCancel = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel });
      await c.arm();
      // Use ctrl+y / meta+z — neither is bound by the compositor, so they
      // exercise the catch-all swallow. (Avoid ctrl+a here: ctrl+a now
      // moves the cursor to line-start as part of readline-parity word/line
      // nav. On an empty buffer that's still a no-op, but the test's intent
      // is "unbound modifier combos are silently dropped", which ctrl+a is
      // no longer an example of.)
      stdin.emit('keypress', undefined, { name: 'y', ctrl: true });
      stdin.emit('keypress', undefined, { name: 'z', meta: true });
      expect(c.getBuffer().text).toBe('');
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('falls back to key.sequence for printable input when char is absent', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', undefined, { name: 'x', sequence: 'x' });
      expect(c.getBuffer()).toEqual({ text: 'x', queued: false });
    });
  });

  describe('history navigation', () => {
    function makeHistory(entries: string[]): {
      back(draft: string): string | null;
      forward(): string | null;
      resetRecall(): void;
      readonly inRecall: boolean;
    } {
      let idx = entries.length;
      let recalling = false;
      return {
        back(_draft: string) {
          if (idx === 0) return null;
          idx--;
          recalling = true;
          return entries[idx] ?? null;
        },
        forward() {
          if (idx >= entries.length - 1) {
            idx = entries.length;
            recalling = false;
            return '';
          }
          idx++;
          return entries[idx] ?? null;
        },
        resetRecall() {
          idx = entries.length;
          recalling = false;
        },
        get inRecall() {
          return recalling;
        },
      };
    }

    it('↑ on an empty buffer pulls the newest queued message for editing (queue takes priority over history)', async () => {
      // Contract: when messages are queued and the live buffer is empty, ↑
      // recalls the most-recently-committed message (LIFO) for editing — NOT
      // history. The pulled message leaves the FIFO and becomes an editable
      // draft (re-Enter re-commits it). History recall only applies once the
      // queue is empty (see the next test).
      const history = makeHistory(['previous-message']);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), history });
      await c.arm();
      stdin.emit('keypress', 'h', { name: 'h', sequence: 'h' });
      stdin.emit('keypress', undefined, { name: 'return' }); // commits 'h', live buffer → ''
      expect(c.getBuffer()).toEqual({ text: '', queued: true });
      expect(c.getPendingCount()).toBe(1);
      stdin.emit('keypress', undefined, { name: 'up' }); // pulls queued 'h' back (NOT 'previous-message')
      // Live buffer now holds the recalled queued message; the FIFO is empty.
      expect(c.getBuffer()).toEqual({ text: 'h', queued: false });
      expect(c.getPendingCount()).toBe(0);
    });

    it('↑/↓ recall history when no messages are queued (queue-empty fall-through)', async () => {
      // With an empty FIFO, ↑/↓ behave as pure history navigation on the live
      // buffer — the queued-message pull is gated on a non-empty queue, so it
      // never intercepts here.
      const history = makeHistory(['older', 'newer']);
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn(), history });
      await c.arm();
      expect(c.getPendingCount()).toBe(0);
      stdin.emit('keypress', undefined, { name: 'up' });  // recalls 'newer'
      expect(c.getBuffer().text).toBe('newer');
      stdin.emit('keypress', undefined, { name: 'up' });  // recalls 'older'
      expect(c.getBuffer().text).toBe('older');
      stdin.emit('keypress', undefined, { name: 'down' }); // advances back to 'newer'
      expect(c.getBuffer().text).toBe('newer');
      expect(c.getPendingCount()).toBe(0);
    });
  });

  describe('getBuffer semantics', () => {
    it('initial state is empty and unqueued', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      expect(c.getBuffer()).toEqual({ text: '', queued: false });
    });

    it('disarm resets buffer state', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
      c.disarm();
      expect(c.getBuffer()).toEqual({ text: '', queued: false });
    });
  });

  describe('setSpinner', () => {
    // Match any frame from the dots Braille set (must stay in sync with
    // SPINNER_FRAMES in src/cli/terminal-compositor.ts).
    const BRAILLE_FRAME_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

    it('enabled: true renders a Braille frame in the next paint', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      writes.clear();
      c.setSpinner({ enabled: true });
      expect(writes.all()).toMatch(BRAILLE_FRAME_RE);
    });

    it('enabled: false clears the spinner from the next paint', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.setSpinner({ enabled: true });
      writes.clear();
      c.setSpinner({ enabled: false });
      expect(writes.all()).not.toMatch(BRAILLE_FRAME_RE);
    });

    it('enabled: true twice does not start a second interval', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      c.setSpinner({ enabled: true });
      c.setSpinner({ enabled: true });
      expect(setIntervalSpy).toHaveBeenCalledTimes(1);
      setIntervalSpy.mockRestore();
    });

    it('enabled: false is idempotent when no spinner is active', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      expect(() => c.setSpinner({ enabled: false })).not.toThrow();
    });

    it('disarm clears the spinner interval', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.setSpinner({ enabled: true });
      const clearIntervalSpy = vi.spyOn(global, 'clearInterval');
      c.disarm();
      expect(clearIntervalSpy).toHaveBeenCalled();
      clearIntervalSpy.mockRestore();
    });

    it('non-TTY stdout makes setSpinner a no-op', async () => {
      const nonTty = makeMockStdout(false);
      const nonTtyWrites = collectWrites(nonTty);
      const c = new TerminalCompositor({ stdout: nonTty, stdin, onCancel: vi.fn() });
      await c.arm();
      c.setSpinner({ enabled: true });
      expect(nonTtyWrites.all()).not.toMatch(BRAILLE_FRAME_RE);
    });

    // ─── capture-mode regression (audit RC-1: spinner-driven repaint storms) ───

    it('captureMode=true: setSpinner enable does NOT start the interval ticker', async () => {
      // Regression for audit RC-1: in a captured stream (`script(1)`,
      // `asciinema`, AFK_DEMO_CLEAN=1) the spinner's 80ms log-update tick
      // would record 12.5 redundant overlay frames per second. The
      // capture-mode guard in setSpinner short-circuits the enable path
      // before the setInterval call.
      const setIntervalSpy = vi.spyOn(global, 'setInterval');
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), captureMode: true,
      });
      await c.arm();
      const beforeCount = setIntervalSpy.mock.calls.length;
      c.setSpinner({ enabled: true });
      // Zero new setInterval registrations from the spinner-enable path.
      // (Other intervals — e.g. internal heartbeat — may exist, so we
      // compare deltas rather than total counts.)
      expect(setIntervalSpy.mock.calls.length).toBe(beforeCount);
      setIntervalSpy.mockRestore();
    });

    it('captureMode=true: spinner frame does NOT render on enable', async () => {
      // Direct user-visible assertion: the artifact contains no Braille
      // spinner glyphs at all when capture-mode is on. The text overlay
      // still renders on transitions (committed scrollback, tool-lane
      // updates) — only the spinner ticker is suppressed.
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), captureMode: true,
      });
      await c.arm();
      writes.clear();
      c.setSpinner({ enabled: true });
      expect(writes.all()).not.toMatch(BRAILLE_FRAME_RE);
    });

    it('captureMode=true: setSpinner({enabled: false}) is still safe (disable path runs unconditionally)', async () => {
      // The disable path runs even in capture-mode so a previously-started
      // spinner can be torn down. This is defensive — capture-mode is set
      // at construction time today, but the disable path stays robust to
      // future enable/disable wiring that could otherwise strand an
      // orphaned interval.
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), captureMode: true,
      });
      await c.arm();
      expect(() => c.setSpinner({ enabled: false })).not.toThrow();
    });

    it('captureMode=false (default): spinner ticker behavior is unchanged', async () => {
      // Live-TTY regression guard: omitting captureMode (or passing false)
      // preserves the existing spinner-renders-Braille behavior. This
      // exists to fail loudly if someone accidentally flips the default
      // or wires capture-mode to a broader condition that captures live
      // sessions.
      const c = new TerminalCompositor({
        stdout, stdin, onCancel: vi.fn(), captureMode: false,
      });
      await c.arm();
      writes.clear();
      c.setSpinner({ enabled: true });
      expect(writes.all()).toMatch(BRAILLE_FRAME_RE);
    });
  });

  // ─── suspend/resume invariant (regression: ask_question repaint clobbering) ───
  //
  // While suspended (external readline owning stdin), repaint() MUST short-
  // circuit so the spinner ticker doesn't overwrite the elicitation prompt
  // and the user's typed input. See terminal-compositor.ts repaint() guard.
  describe('suspendInput / resumeInput', () => {
    const BRAILLE_FRAME_RE = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/;

    it('repaint short-circuits while suspended: setOverlay produces no writes', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      // Establish a baseline frame so the next paint would otherwise produce
      // visible clear+redraw bytes.
      c.setOverlay('initial');
      c.suspendInput();
      writes.clear();
      c.setOverlay('would-clobber-the-elicitation-prompt');
      // No paint should occur — the suspended gate blocks repaint entirely.
      expect(writes.all()).toBe('');
    });

    it('spinner tick fires no paint while suspended (regression for ask_question clobbering)', async () => {
      vi.useFakeTimers();
      try {
        const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
        await c.arm();
        c.setSpinner({ enabled: true });
        // Drain the initial spinner paint so the assertion below isolates the
        // ticker-driven repaints.
        writes.clear();
        c.suspendInput();
        // Advance well past the 80ms tick interval — multiple ticks should
        // fire while suspended.
        writes.clear();
        vi.advanceTimersByTime(500);
        expect(writes.all()).not.toMatch(BRAILLE_FRAME_RE);
        // The spinner state itself still advances internally (frameIndex
        // bumps); only the paint is suppressed. resumeInput's terminal
        // repaint will surface the latest frame.
        c.resumeInput();
        expect(writes.all()).toMatch(BRAILLE_FRAME_RE);
      } finally {
        vi.useRealTimers();
      }
    });

    it('resumeInput is idempotent (calling twice does not double-paint)', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.suspendInput();
      writes.clear();
      c.resumeInput();
      const firstResumeBytes = writes.all();
      writes.clear();
      c.resumeInput();
      // Second resume is a no-op (already resumed); no further paint.
      expect(writes.all()).toBe('');
      expect(firstResumeBytes.length).toBeGreaterThan(0);
    });

    it('suspendInput is idempotent (calling twice does not throw or re-clear)', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.setOverlay('hello');
      writes.clear();
      c.suspendInput();
      const firstSuspendBytes = writes.all();
      writes.clear();
      c.suspendInput();
      // Second suspend short-circuits before the clear path runs.
      expect(writes.all()).toBe('');
      // First suspend did emit clear bytes (overlay was non-empty).
      expect(firstSuspendBytes.length).toBeGreaterThan(0);
    });

    it('suspendInput before arm is a safe no-op', () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      expect(() => c.suspendInput()).not.toThrow();
      expect(() => c.resumeInput()).not.toThrow();
    });
  });

  describe('keypresses ignored when disarmed', () => {
    it('does not call onCancel on ESC after disarm', async () => {
      const onCancel = vi.fn();
      const c = new TerminalCompositor({ stdout, stdin, onCancel });
      await c.arm();
      c.disarm();
      stdin.emit('keypress', undefined, { name: 'escape' });
      expect(onCancel).not.toHaveBeenCalled();
    });

    it('does not mutate buffer on keypress after disarm', async () => {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      c.disarm();
      stdin.emit('keypress', 'a', { name: 'a', sequence: 'a' });
      expect(c.getBuffer().text).toBe('');
    });
  });
});

// ---------------------------------------------------------------------------
// Word/line navigation (readline parity) — Option+arrow, Cmd+arrow,
// Ctrl+A/E/W/U/K, Alt+B/F, Option+Delete, etc.
//
// Strategy: seed a known buffer + cursor (via typed chars + `left` arrows),
// emit the binding under test, then insert a marker char and assert it
// landed at the expected position in the buffer. Black-box parity with the
// existing `left/right move cursor within buffer` test on line ~983.
// ---------------------------------------------------------------------------

