/**
 * Adaptive frame cadence of the SpinnerController. A pane animating only the
 * spinner at 12.5 Hz was measured at ~4.4% of a core in a GPU terminal, so a
 * spin keeps the warm 80ms cadence for its first 2s and then drops to 250ms.
 * The warm-up resets when the spinner restarts or its work-derived verb
 * changes, but NOT on the timed flavour rotation (which would pin 12.5 Hz).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SpinnerController,
  SPINNER_IDLE_FRAME_MS,
  SPINNER_WARM_FRAME_MS,
  SPINNER_WARMUP_MS,
} from './spinner.js';
import { TerminalCompositor } from '../terminal-compositor.js';
import { __resetStdinClaimForTests } from './stdin-claim.js';
import { collectWrites, makeMockStdin, makeMockStdout } from '../terminal-compositor.test-helpers.js';

/** Count onTick calls fired while advancing fake time by `ms`. */
function ticksDuring(counter: { n: number }, ms: number): number {
  const before = counter.n;
  vi.advanceTimersByTime(ms);
  return counter.n - before;
}

describe('SpinnerController — adaptive cadence', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('pins the documented intervals', () => {
    expect(SPINNER_WARM_FRAME_MS).toBe(80);
    expect(SPINNER_IDLE_FRAME_MS).toBe(250);
    expect(SPINNER_WARMUP_MS).toBe(2_000);
  });

  it('ticks at 80ms during the warm-up, then drops to 250ms', () => {
    const counter = { n: 0 };
    const c = new SpinnerController({ captureMode: false, onTick: () => { counter.n++; } });
    c.set({ enabled: true, rotateVerbEveryMs: 60_000 });
    try {
      // 2000 / 80 = 25 warm frames.
      expect(ticksDuring(counter, SPINNER_WARMUP_MS)).toBe(25);
      // Steady state: 4 Hz, i.e. 8 frames in the next 2s (allow the one
      // boundary frame that was armed at 80ms just before the warm-up ended).
      const idle = ticksDuring(counter, 2_000);
      expect(idle).toBeGreaterThanOrEqual(7);
      expect(idle).toBeLessThanOrEqual(9);
      expect(ticksDuring(counter, 10_000)).toBe(40);
    } finally {
      c.dispose();
    }
  });

  it('a work-derived verb change resets the warm-up', () => {
    const counter = { n: 0 };
    let verb: string | undefined;
    const c = new SpinnerController({ captureMode: false, onTick: () => { counter.n++; }, workVerb: () => verb });
    c.set({ enabled: true, rotateVerbEveryMs: 60_000 });
    try {
      vi.advanceTimersByTime(5_000);
      expect(ticksDuring(counter, 1_000)).toBe(4); // idle cadence
      verb = 'Reading'; // picked up on the next (idle) tick
      vi.advanceTimersByTime(SPINNER_IDLE_FRAME_MS);
      expect(ticksDuring(counter, 800)).toBe(10); // back to 80ms
      vi.advanceTimersByTime(SPINNER_WARMUP_MS);
      expect(ticksDuring(counter, 1_000)).toBe(4); // and back down again
    } finally {
      c.dispose();
    }
  });

  it('the timed flavour rotation does NOT reset the warm-up', () => {
    const counter = { n: 0 };
    const c = new SpinnerController({ captureMode: false, onTick: () => { counter.n++; } });
    c.set({ enabled: true, rotateVerbEveryMs: 500 });
    try {
      vi.advanceTimersByTime(3_000);
      expect(ticksDuring(counter, 4_000)).toBe(16);
    } finally {
      c.dispose();
    }
  });

  it('restarting the spinner restores the warm cadence', () => {
    const counter = { n: 0 };
    const c = new SpinnerController({ captureMode: false, onTick: () => { counter.n++; } });
    c.set({ enabled: true });
    vi.advanceTimersByTime(5_000);
    c.set({ enabled: false });
    c.set({ enabled: true });
    try {
      expect(ticksDuring(counter, 800)).toBe(10);
    } finally {
      c.dispose();
    }
  });

  it('dispose() and disable stop the ticker', () => {
    const counter = { n: 0 };
    const c = new SpinnerController({ captureMode: false, onTick: () => { counter.n++; } });
    c.set({ enabled: true });
    c.dispose();
    expect(ticksDuring(counter, 5_000)).toBe(0);
    c.set({ enabled: true });
    c.set({ enabled: false });
    expect(ticksDuring(counter, 5_000)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('TerminalCompositor — non-TTY stdout never animates the spinner', () => {
  beforeEach(() => {
    __resetStdinClaimForTests();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('setSpinner on a non-TTY stdout starts no timer and writes nothing', () => {
    const stdout = makeMockStdout(false);
    const writes = collectWrites(stdout);
    const c = new TerminalCompositor({ stdout, stdin: makeMockStdin(false), onCancel: vi.fn() });
    c.setSpinner({ enabled: true });
    vi.advanceTimersByTime(5_000);
    expect(c.spinnerController.renderSpinnerRow()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    expect(writes.all()).toBe('');
    c.setSpinner({ enabled: false });
  });
});
