/**
 * Tests for the inline footer: the right-gutter mascot compositor
 * (`overlayMascotGutter`) and `LoopStageBar`'s inline mode.
 *
 * These cover the path that moves the loop-stage rail and the goblin sprite
 * OUT of reserved DECSTBM rows and into the compositor frame, so the prompt
 * renders below its own stage rail with the sprite flanking it. The
 * reserved-row path is unchanged and is covered by loop-stage.test.ts /
 * mascot-band.test.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import { stripAnsi } from './display.js';
import {
  overlayMascotGutter,
  GUTTER_RIGHT_MARGIN,
  GUTTER_MIN_CONTENT_COLS,
} from './terminal-compositor.footer-inline.js';
import { MINI_MASCOT_WIDTH } from './mascot-mini.js';
import { LoopStageBar } from './commands/interactive/loop-stage.js';

/** A sprite row is always exactly MINI_MASCOT_WIDTH display columns. */
const SPRITE = ['A'.repeat(MINI_MASCOT_WIDTH), 'B'.repeat(MINI_MASCOT_WIDTH), 'C'.repeat(MINI_MASCOT_WIDTH)];
const COLS = 80;

describe('overlayMascotGutter', () => {
  it('returns the frame unchanged when the sprite is empty', () => {
    const frame = ['rail', 'prompt'];
    expect(overlayMascotGutter(frame, [], COLS, 20)).toEqual(frame);
  });

  it('never mutates the input array', () => {
    const frame = ['rail', 'prompt', 'x'];
    const snapshot = [...frame];
    overlayMascotGutter(frame, SPRITE, COLS, 20);
    expect(frame).toEqual(snapshot);
  });

  it('right-aligns the sprite so the row ends one column short of the width', () => {
    // DECAWM guard: writing the final cell arms pending-wrap and the next
    // write scrolls the frame. Every composited row must stop at columns-1.
    const out = overlayMascotGutter(['a', 'b', 'c'], SPRITE, COLS, 20);
    for (const line of out) {
      expect(stripAnsi(line)).toHaveLength(COLS - GUTTER_RIGHT_MARGIN);
    }
  });

  it('composites onto the LAST n lines, leaving earlier lines untouched', () => {
    const out = overlayMascotGutter(['top', 'a', 'b', 'c'], SPRITE, COLS, 20);
    expect(out[0]).toBe('top');
    expect(stripAnsi(out[1]!)).toMatch(/^a\s+A+$/);
    expect(stripAnsi(out[3]!)).toMatch(/^c\s+C+$/);
  });

  it('pads UPWARD when the frame is shorter than the sprite', () => {
    // An idle frame is just [rail, input] against a 3-row goblin. Padding must
    // go above so the input stays the last line.
    const out = overlayMascotGutter(['rail', 'input'], SPRITE, COLS, 20);
    expect(out).toHaveLength(3);
    expect(stripAnsi(out[0]!).trimEnd()).toBe('A'.repeat(MINI_MASCOT_WIDTH).padStart(COLS - GUTTER_RIGHT_MARGIN).trimEnd());
    expect(stripAnsi(out[2]!)).toMatch(/^input\s+C+$/);
  });

  it('suppresses entirely when padding would breach the viewport budget', () => {
    const frame = ['rail', 'input'];
    // maxLines 2 cannot host the 3-row sprite.
    expect(overlayMascotGutter(frame, SPRITE, COLS, 2)).toEqual(frame);
  });

  it('suppresses entirely when the terminal is too narrow for content + sprite', () => {
    const frame = ['a', 'b', 'c'];
    const tooNarrow = GUTTER_MIN_CONTENT_COLS + MINI_MASCOT_WIDTH + GUTTER_RIGHT_MARGIN - 1;
    expect(overlayMascotGutter(frame, SPRITE, tooNarrow, 20)).toEqual(frame);
  });

  it('is all-or-nothing: ONE over-wide target row suppresses the whole sprite', () => {
    // Partial sprites are worse than no sprite — a half-drawn goblin reads as
    // corruption. A long paste on the input line must hide it, not clip it.
    const long = 'x'.repeat(COLS - MINI_MASCOT_WIDTH);
    const frame = ['a', 'b', long];
    expect(overlayMascotGutter(frame, SPRITE, COLS, 20)).toEqual(frame);
  });

  it('recovers on the next frame once the over-wide line shrinks', () => {
    const long = 'x'.repeat(COLS - MINI_MASCOT_WIDTH);
    expect(overlayMascotGutter(['a', 'b', long], SPRITE, COLS, 20)).toEqual(['a', 'b', long]);
    const out = overlayMascotGutter(['a', 'b', 'short'], SPRITE, COLS, 20);
    expect(stripAnsi(out[2]!)).toMatch(/^short\s+C+$/);
  });

  it('emits a reset before the gutter so an open SGR run cannot tint the sprite', () => {
    // The caret renders as an inverse-video block; without the reset it would
    // bleed across the padding and colour the goblin.
    const out = overlayMascotGutter(['a', 'b', '\x1b[7mcaret'], SPRITE, COLS, 20);
    expect(out[2]).toContain('\x1b[0m');
    expect(out[2]!.indexOf('\x1b[0m')).toBeGreaterThan(out[2]!.indexOf('caret'));
  });
});

// ─── LoopStageBar inline mode ───────────────────────────────────────────────

function mockStdout(): NodeJS.WriteStream & { written: string[] } {
  const written: string[] = [];
  return {
    isTTY: true,
    rows: 40,
    columns: 80,
    write: (s: string) => { written.push(s); return true; },
    written,
  } as unknown as NodeJS.WriteStream & { written: string[] };
}

describe('LoopStageBar — inline mode', () => {
  const make = (requestRepaint = vi.fn()) => {
    const stream = mockStdout();
    const bar = new LoopStageBar({
      getExtraRows: () => 0,
      stream,
      inline: true,
      requestRepaint,
    });
    return { bar, stream, requestRepaint };
  };

  it('publishes a row count of 0 on start — it reserves nothing', () => {
    const { bar } = make();
    const rows: number[] = [];
    bar.setRowCountChangeHandler((n) => rows.push(n));
    bar.start();
    expect(rows).toEqual([0]);
  });

  it('never writes to the stream (no CUP paint) across start/repaint/stop', () => {
    const { bar, stream } = make();
    bar.start();
    bar.repaint('acting');
    bar.redraw();
    bar.stop();
    expect(stream.written).toEqual([]);
  });

  it('railLine() is null before start and after stop, non-null while running', () => {
    const { bar } = make();
    expect(bar.railLine()).toBeNull();
    bar.start();
    expect(bar.railLine()).not.toBeNull();
    bar.stop();
    expect(bar.railLine()).toBeNull();
  });

  it('railLine() reflects the current stage', () => {
    const { bar } = make();
    bar.start();
    bar.repaint('acting');
    const line = stripAnsi(bar.railLine()!);
    expect(line).toContain('act');
    expect(line).toContain('observe');
    // Active stage carries the solid diamond.
    expect(line).toContain('◆ act');
  });

  it('collapses to the idle cell between turns', () => {
    const { bar } = make();
    bar.start();
    bar.repaint('observing');
    expect(stripAnsi(bar.railLine()!)).toContain('idle');
  });

  it('a stage change asks the compositor to repaint', () => {
    const requestRepaint = vi.fn();
    const { bar } = make(requestRepaint);
    bar.start();
    requestRepaint.mockClear();
    bar.repaint('acting');
    expect(requestRepaint).toHaveBeenCalledTimes(1);
  });

  it('redraw() is a no-op — the compositor self-heals its own frame', () => {
    const requestRepaint = vi.fn();
    const { bar } = make(requestRepaint);
    bar.start();
    requestRepaint.mockClear();
    bar.redraw();
    expect(requestRepaint).not.toHaveBeenCalled();
  });

  it('reserved-row mode is unaffected: still publishes 1 row and paints', () => {
    const stream = mockStdout();
    const bar = new LoopStageBar({ getExtraRows: () => 1, stream });
    const rows: number[] = [];
    bar.setRowCountChangeHandler((n) => rows.push(n));
    bar.start();
    expect(rows).toEqual([1]);
    expect(stream.written.join('')).toContain('\x1b[39;1H');
    expect(bar.railLine()).toBeNull();
    bar.stop();
  });
});
