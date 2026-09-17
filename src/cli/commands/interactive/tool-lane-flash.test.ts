/**
 * Unit tests for ToolLaneFlash — the 150ms glyph-color pulse on tool completion.
 *
 * Fake timers throughout: the class's only observable side-effects are the
 * `isFlashing` Set membership and the `onRepaint` callback it fires on expiry.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ToolLaneFlash, FLASH_DURATION_MS } from './tool-lane-flash.js';

function make(): { flash: ToolLaneFlash; onRepaint: ReturnType<typeof vi.fn> } {
  const onRepaint = vi.fn();
  const flash = new ToolLaneFlash(onRepaint);
  return { flash, onRepaint };
}

describe('ToolLaneFlash', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('flashTool(id) makes isFlashing(id) return true immediately', () => {
    const { flash } = make();
    flash.flashTool('tool-1');
    expect(flash.isFlashing('tool-1')).toBe(true);
  });

  it('isFlashing returns false for an id that was never flashed', () => {
    const { flash } = make();
    expect(flash.isFlashing('never-seen')).toBe(false);
  });

  it(`after ${FLASH_DURATION_MS}ms, isFlashing returns false`, () => {
    const { flash } = make();
    flash.flashTool('tool-2');
    expect(flash.isFlashing('tool-2')).toBe(true);

    vi.advanceTimersByTime(FLASH_DURATION_MS);
    expect(flash.isFlashing('tool-2')).toBe(false);
  });

  it('isFlashing is still true just before the window expires', () => {
    const { flash } = make();
    flash.flashTool('tool-3');
    vi.advanceTimersByTime(FLASH_DURATION_MS - 1);
    expect(flash.isFlashing('tool-3')).toBe(true);
  });

  it('re-flashing the same id cancels the prior timer and restarts the window', () => {
    const { flash, onRepaint } = make();

    flash.flashTool('tool-4');
    vi.advanceTimersByTime(FLASH_DURATION_MS - 10); // almost expired

    // Re-flash before expiry — should restart the 150ms clock
    flash.flashTool('tool-4');

    vi.advanceTimersByTime(10); // old timer would have fired here — should not
    expect(flash.isFlashing('tool-4')).toBe(true);
    expect(onRepaint).not.toHaveBeenCalled(); // old timer was cancelled

    vi.advanceTimersByTime(FLASH_DURATION_MS - 10); // complete the new window
    expect(flash.isFlashing('tool-4')).toBe(false);
    expect(onRepaint).toHaveBeenCalledTimes(1);
  });

  it('onRepaint fires exactly once when a flash expires', () => {
    const { flash, onRepaint } = make();
    flash.flashTool('tool-5');
    expect(onRepaint).not.toHaveBeenCalled(); // no repaint on flash-start

    vi.advanceTimersByTime(FLASH_DURATION_MS);
    expect(onRepaint).toHaveBeenCalledTimes(1);
  });

  it('onRepaint fires independently for each distinct id', () => {
    const { flash, onRepaint } = make();
    flash.flashTool('a');
    flash.flashTool('b');

    vi.advanceTimersByTime(FLASH_DURATION_MS);
    // Both timers fire — two separate repaint calls
    expect(onRepaint).toHaveBeenCalledTimes(2);
    expect(flash.isFlashing('a')).toBe(false);
    expect(flash.isFlashing('b')).toBe(false);
  });

  it('dispose() clears all pending timers and onRepaint is never called', () => {
    const { flash, onRepaint } = make();
    flash.flashTool('x');
    flash.flashTool('y');

    flash.dispose();

    vi.advanceTimersByTime(FLASH_DURATION_MS * 2);
    expect(onRepaint).not.toHaveBeenCalled();
  });

  it('dispose() clears the flashing set', () => {
    const { flash } = make();
    flash.flashTool('z');
    expect(flash.isFlashing('z')).toBe(true);

    flash.dispose();
    expect(flash.isFlashing('z')).toBe(false);
  });

  it('flashTool is a no-op after dispose()', () => {
    const { flash, onRepaint } = make();
    flash.dispose();

    flash.flashTool('post-dispose');
    expect(flash.isFlashing('post-dispose')).toBe(false);

    vi.advanceTimersByTime(FLASH_DURATION_MS);
    expect(onRepaint).not.toHaveBeenCalled();
  });

  it('dispose() is idempotent — calling it twice does not throw', () => {
    const { flash } = make();
    flash.flashTool('idempotent');
    flash.dispose();
    expect(() => flash.dispose()).not.toThrow();
  });

  it('multiple distinct ids each have independent flash windows', () => {
    const { flash, onRepaint } = make();

    flash.flashTool('early');
    vi.advanceTimersByTime(50);
    flash.flashTool('late');

    vi.advanceTimersByTime(FLASH_DURATION_MS - 50); // 'early' expires here
    expect(flash.isFlashing('early')).toBe(false);
    expect(flash.isFlashing('late')).toBe(true);
    expect(onRepaint).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(50); // 'late' expires here
    expect(flash.isFlashing('late')).toBe(false);
    expect(onRepaint).toHaveBeenCalledTimes(2);
  });
});
