/**
 * Tests for TerminalCompositor — caret rendering + blink.
 *
 * Split verbatim from the terminal-compositor.test.ts monolith (#369).
 * Shared mock factories live in ./terminal-compositor.test-helpers.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TerminalCompositor } from './terminal-compositor.js';
import { __resetStdinClaimForTests } from './input/stdin-claim.js';
import { makeMockStdout, makeMockStdin, collectWrites } from './terminal-compositor.test-helpers.js';
import type { MockStdout, MockStdin } from './terminal-compositor.test-helpers.js';

beforeEach(() => {
  __resetStdinClaimForTests();
});

describe('TerminalCompositor — caret always rendered while armed', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;
  let writes: ReturnType<typeof collectWrites>;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
    writes = collectWrites(stdout);
  });

  it('emits the thin-bar caret character even when buffer is empty', async () => {
    // At end-of-buffer the compositor paints a ▏ (U+258F, LEFT ONE EIGHTH BLOCK)
    // in the caret accent color instead of an inverse-video space block.
    // chalk.level is forced to 1 so color SGRs are emitted; the ▏ character
    // itself is present regardless of chalk level. Saved/restored to avoid
    // leaking state to other suites.
    const chalkModule = await import('chalk');
    const priorLevel = chalkModule.default.level;
    chalkModule.default.level = 1;
    try {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      const frame = writes.all();
      expect(frame).toContain('▏');
    } finally {
      chalkModule.default.level = priorLevel;
    }
  });

  it('emits the thin-bar caret after the buffer goes empty again', async () => {
    // Regression target: previously the caret was suppressed when buffer.length === 0
    // && !queued. Verify that after typing then deleting back to empty, the caret
    // is still painted. This exercises the post-Backspace empty-buffer render.
    const chalkModule = await import('chalk');
    const priorLevel = chalkModule.default.level;
    chalkModule.default.level = 1;
    try {
      const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
      await c.arm();
      stdin.emit('keypress', 'x', { name: 'x', sequence: 'x' });
      stdin.emit('keypress', undefined, { name: 'backspace' });
      // Buffer is now empty (and !queued). The most recent rendered frame must
      // still contain the ▏ thin-bar caret.
      expect(c.getBuffer().text).toBe('');
      expect(c.getBuffer().queued).toBe(false);
      writes.clear();
      // Force a repaint via setOverlay change so we observe one fresh frame
      // generated from the empty+!queued state.
      c.setOverlay('overlay-content');
      const frame = writes.all();
      expect(frame).toContain('▏');
    } finally {
      chalkModule.default.level = priorLevel;
    }
  });
});

// ---------------------------------------------------------------------------
// Caret blink wiring: arm() starts the ticker, each interval toggles the
// painted caret, a keystroke snaps it back to solid, and disarm() stops it.
// ---------------------------------------------------------------------------

describe('TerminalCompositor — caret blink', () => {
  let stdout: MockStdout;
  let stdin: MockStdin;
  let writes: ReturnType<typeof collectWrites>;

  beforeEach(() => {
    stdout = makeMockStdout();
    stdin = makeMockStdin();
    writes = collectWrites(stdout);
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('pulses the ▏ caret on/off on the interval and resets to solid on a keystroke', async () => {
    vi.useFakeTimers();
    const c = new TerminalCompositor({
      stdout,
      stdin,
      onCancel: vi.fn(),
      caretBlink: true,
      caretBlinkIntervalMs: 50,
    });
    await c.arm();
    // First frame (armed) shows the solid caret.
    expect(writes.all()).toContain('▏');

    // One interval later the caret blinks OFF — the repaint paints a blank cell.
    writes.clear();
    vi.advanceTimersByTime(50);
    expect(writes.all()).not.toContain('▏');

    // A keystroke snaps the caret back to solid (and types the char).
    writes.clear();
    stdin.emit('keypress', 'x', { name: 'x', sequence: 'x' });
    expect(writes.all()).toContain('▏');
    expect(c.getBuffer().text).toBe('x');

    // After disarm the ticker is stopped: no further repaints fire.
    c.disarm();
    writes.clear();
    vi.advanceTimersByTime(500);
    expect(writes.all()).toBe('');
  });

  it('does not start a blink timer when caretBlink is unset (default)', async () => {
    vi.useFakeTimers();
    const c = new TerminalCompositor({ stdout, stdin, onCancel: vi.fn() });
    await c.arm();
    expect(writes.all()).toContain('▏'); // solid caret painted at arm
    writes.clear();
    // No ticker → no timer-driven repaints regardless of how far time advances.
    vi.advanceTimersByTime(5000);
    expect(writes.all()).toBe('');
    c.disarm();
  });

  it('coalesces the caret un-hide with the edit repaint — one frame on an off-phase keystroke', async () => {
    vi.useFakeTimers();
    const c = new TerminalCompositor({
      stdout,
      stdin,
      onCancel: vi.fn(),
      caretBlink: true,
      caretBlinkIntervalMs: 50,
    });
    await c.arm();
    // Blink into the OFF phase (caret painted away).
    writes.clear();
    vi.advanceTimersByTime(50);
    expect(writes.all()).not.toContain('▏');

    // A printable key in the off phase: dispatchKey → applyEdit repaints once,
    // and that single frame already shows the now-solid caret. resetVisible()
    // must NOT add a second frame. Before the fix this painted twice.
    const before = c.repaintCount;
    writes.clear();
    stdin.emit('keypress', 'x', { name: 'x', sequence: 'x' });
    expect(c.repaintCount - before).toBe(1); // exactly one frame, not two
    expect(c.getBuffer().text).toBe('x');
    expect(writes.all()).toContain('▏'); // solid caret in that one frame
    c.disarm();
  });

  it('un-hides an off-phase caret with exactly one repaint on a non-painting keystroke', async () => {
    vi.useFakeTimers();
    const c = new TerminalCompositor({
      stdout,
      stdin,
      onCancel: vi.fn(),
      caretBlink: true,
      caretBlinkIntervalMs: 50,
    });
    await c.arm();
    vi.advanceTimersByTime(50); // → off phase
    // F5 is consumed by no edit handler, so dispatchKey paints nothing; the
    // caret-blink un-hide must still issue exactly one repaint to show it solid.
    const before = c.repaintCount;
    writes.clear();
    stdin.emit('keypress', undefined, { name: 'f5' });
    expect(c.repaintCount - before).toBe(1);
    expect(writes.all()).toContain('▏');
    c.disarm();
  });
});

// ---------------------------------------------------------------------------
// Tab applies dropdown selection (Fix C): mirrors reader.ts:769-772 behavior
// so completion works during agent turns, not just user turns.
// ---------------------------------------------------------------------------

