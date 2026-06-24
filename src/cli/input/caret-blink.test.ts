/**
 * Unit tests for CaretBlinkController — the input caret's blink phase + timer.
 *
 * Fake timers throughout: the controller's only observable effects are the
 * `visible` phase flips and the `onTick` repaint requests it emits on each
 * interval boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CaretBlinkController, DEFAULT_CARET_BLINK_INTERVAL_MS } from './caret-blink.js';

interface MakeOpts {
  enabled?: boolean;
  captureMode?: boolean;
  intervalMs?: number;
}

function make(opts: MakeOpts = {}): { c: CaretBlinkController; onTick: ReturnType<typeof vi.fn> } {
  const onTick = vi.fn();
  const c = new CaretBlinkController({
    enabled: opts.enabled ?? true,
    captureMode: opts.captureMode ?? false,
    intervalMs: opts.intervalMs ?? 100,
    onTick,
  });
  return { c, onTick };
}

describe('CaretBlinkController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('exports a positive default interval', () => {
    expect(DEFAULT_CARET_BLINK_INTERVAL_MS).toBeGreaterThan(0);
  });

  it('is visible before start (solid caret until armed)', () => {
    const { c } = make();
    expect(c.visible).toBe(true);
  });

  it('toggles the visible phase and ticks once per interval after start', () => {
    const { c, onTick } = make({ intervalMs: 100 });
    c.start();
    expect(c.visible).toBe(true);

    vi.advanceTimersByTime(100);
    expect(c.visible).toBe(false);
    expect(onTick).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(100);
    expect(c.visible).toBe(true);
    expect(onTick).toHaveBeenCalledTimes(2);
  });

  it('disabled: stays visible, starts no timer, never ticks', () => {
    const { c, onTick } = make({ enabled: false });
    c.start();
    vi.advanceTimersByTime(1000);
    expect(c.visible).toBe(true);
    expect(onTick).not.toHaveBeenCalled();
  });

  it('capture mode: stays visible, starts no timer, never ticks', () => {
    const { c, onTick } = make({ captureMode: true });
    c.start();
    vi.advanceTimersByTime(1000);
    expect(c.visible).toBe(true);
    expect(onTick).not.toHaveBeenCalled();
  });

  it('start is idempotent — a second call does not spawn a second timer', () => {
    const { c, onTick } = make({ intervalMs: 100 });
    c.start();
    c.start();
    vi.advanceTimersByTime(100);
    // A doubled timer would tick twice per interval.
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it('stop clears the timer and resets to the solid phase', () => {
    const { c, onTick } = make({ intervalMs: 100 });
    c.start();
    vi.advanceTimersByTime(100);
    expect(c.visible).toBe(false);

    c.stop();
    expect(c.visible).toBe(true);

    onTick.mockClear();
    vi.advanceTimersByTime(500);
    expect(onTick).not.toHaveBeenCalled();
  });

  it('stop is idempotent', () => {
    const { c } = make();
    c.start();
    c.stop();
    expect(() => c.stop()).not.toThrow();
    expect(c.visible).toBe(true);
  });

  it('resetVisible snaps an off-phase caret back to solid and returns true (no self-repaint)', () => {
    const { c, onTick } = make({ intervalMs: 100 });
    c.start();
    vi.advanceTimersByTime(100); // → off phase
    expect(c.visible).toBe(false);

    onTick.mockClear();
    // Pure state mutation: reports the un-hide via its return value and does NOT
    // repaint — the caller coalesces the repaint with the keystroke's own frame.
    expect(c.resetVisible()).toBe(true);
    expect(c.visible).toBe(true);
    expect(onTick).not.toHaveBeenCalled();
  });

  it('resetVisible while already visible returns false and does not repaint', () => {
    const { c, onTick } = make({ intervalMs: 100 });
    c.start();
    onTick.mockClear();
    expect(c.resetVisible()).toBe(false);
    expect(c.visible).toBe(true);
    expect(onTick).not.toHaveBeenCalled();
  });

  it('resetVisible restarts the dwell window so the caret stays solid while typing', () => {
    const { c, onTick } = make({ intervalMs: 100 });
    c.start();
    vi.advanceTimersByTime(80); // still in the first visible window
    expect(c.visible).toBe(true);

    c.resetVisible(); // restart the 100ms window from here
    onTick.mockClear();

    vi.advanceTimersByTime(80); // 80ms since reset < 100 → still solid
    expect(c.visible).toBe(true);
    expect(onTick).not.toHaveBeenCalled();

    vi.advanceTimersByTime(20); // 100ms since reset → first flip
    expect(c.visible).toBe(false);
    expect(onTick).toHaveBeenCalledTimes(1);
  });

  it('resetVisible before start is a no-op and returns false', () => {
    const { c, onTick } = make({ intervalMs: 100 });
    expect(c.resetVisible()).toBe(false);
    expect(c.visible).toBe(true);
    expect(onTick).not.toHaveBeenCalled();
  });

  it('resetVisible is a no-op and returns false when disabled', () => {
    const { c, onTick } = make({ enabled: false });
    c.start();
    expect(c.resetVisible()).toBe(false);
    expect(c.visible).toBe(true);
    expect(onTick).not.toHaveBeenCalled();
  });

  it('can be restarted after stop', () => {
    const { c, onTick } = make({ intervalMs: 100 });
    c.start();
    c.stop();
    onTick.mockClear();
    c.start();
    vi.advanceTimersByTime(100);
    expect(c.visible).toBe(false);
    expect(onTick).toHaveBeenCalledTimes(1);
  });
});
