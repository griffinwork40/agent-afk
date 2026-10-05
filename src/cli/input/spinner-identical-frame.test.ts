/**
 * The SpinnerController never requests a repaint for a frame byte-identical
 * to the last one it requested. With the stock 10-glyph braille set the glyph
 * advances every tick, so this guard is a backstop; a single-glyph frame set
 * isolates it: once the elapsed label settles, nothing changes and no repaint
 * may be requested until something does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../terminal-compositor.types.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../terminal-compositor.types.js')>()),
  SPINNER_FRAMES: ['*'] as const,
}));

const { SpinnerController, SPINNER_IDLE_FRAME_MS } = await import('./spinner.js');

describe('SpinnerController — identical frames are not rewritten', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('skips ticks whose composed rows are unchanged, repaints when they change', () => {
    let ticks = 0;
    // A context hint pins the tip row (it wins over rotating tips), so the
    // rotating-tip warm-up cannot introduce a change of its own.
    let hint = 'waiting';
    const c = new SpinnerController({
      captureMode: false,
      onTick: () => { ticks++; },
      workVerb: () => 'Reading', // stable verb: no flavour re-picks
      contextTip: () => hint,
    });
    c.set({ enabled: true, rotateVerbEveryMs: 60_000 });
    try {
      expect(ticks).toBe(1); // the enable paint
      // Under 2s the elapsed label is hidden and glyph + verb never change:
      // 24 warm ticks fire, none may request a repaint.
      vi.advanceTimersByTime(1_950);
      expect(ticks).toBe(1);
      // Crossing 2s reveals " 2s": exactly one repaint, then quiet again.
      vi.advanceTimersByTime(500);
      expect(ticks).toBe(2);
      vi.advanceTimersByTime(400);
      expect(ticks).toBe(2);
      // A tip-row change is a real change and does repaint.
      hint = 'stop me';
      vi.advanceTimersByTime(SPINNER_IDLE_FRAME_MS);
      expect(ticks).toBe(3);
    } finally {
      c.dispose();
    }
  });
});
