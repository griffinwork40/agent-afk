/**
 * ElementFade / fadeLine: the whole-element half of the AFK_SMOKE_TEXT
 * hierarchy. Pins: layout never shifts, settled lines are untouched (same
 * bytes), the frame driver runs only while something is fading, and an
 * element with zero rendered rows does not start its fade.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { ElementFade, fadeLine, FADE_MS, FADE_FRAME_MS } from './smoke-fade.js';
import { resetSmokeToneCache } from './smoke-reveal.tones.js';
import { stripAnsi, displayWidth } from './display.js';
import { SMOKE_GLYPHS } from './smoke-reveal.js';

let savedLevel: typeof chalk.level;
beforeEach(() => {
  vi.useFakeTimers();
  savedLevel = chalk.level;
  chalk.level = 3;
  resetSmokeToneCache();
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  chalk.level = savedLevel;
});

const STYLED = chalk.dim('   ') + chalk.bold.cyan('Read') + chalk.dim('(src/a.ts) — ') + chalk.green('✓');

describe('fadeLine', () => {
  it('keeps the visible text and width, replacing the styling with a ramp tone', () => {
    const out = fadeLine(STYLED, 0.5);
    expect(stripAnsi(out)).toBe(stripAnsi(STYLED));
    expect(displayWidth(stripAnsi(out))).toBe(displayWidth(stripAnsi(STYLED)));
    expect(out).not.toBe(STYLED);
    expect(out).toMatch(/\u001b\[38;2;\d+;\d+;\d+m/); // truecolor ramp stop
  });

  it('never uses the prose particle glyphs (no glyph phase for machine UI)', () => {
    for (const p of [0, 0.25, 0.5, 0.99]) {
      const plain = stripAnsi(fadeLine(STYLED, p));
      for (const g of SMOKE_GLYPHS) expect(plain).not.toContain(g);
    }
  });

  it('brightens monotonically across the fade', () => {
    const lum = (s: string): number => {
      const m = /38;2;(\d+);(\d+);(\d+)m/.exec(s);
      return m ? Number(m[1]) + Number(m[2]) + Number(m[3]) : -1;
    };
    const values = [0, 0.3, 0.6, 0.9].map((p) => lum(fadeLine('abc', p)));
    for (let i = 1; i < values.length; i++) expect(values[i]!).toBeGreaterThanOrEqual(values[i - 1]!);
    expect(values[3]!).toBeGreaterThan(values[0]!);
  });

  it('returns blank lines unchanged', () => {
    expect(fadeLine('', 0.3)).toBe('');
    expect(fadeLine('   ', 0.3)).toBe('   ');
  });
});

describe('ElementFade', () => {
  it('fades an element from its first rendered frame, then leaves it byte-identical', () => {
    const onFrame = vi.fn();
    const fade = new ElementFade(onFrame);
    const first = [STYLED];
    fade.fadeLines('tu_1', first, 0);
    expect(first[0]).not.toBe(STYLED);

    vi.advanceTimersByTime(FADE_MS);
    const settled = [STYLED];
    fade.fadeLines('tu_1', settled, 0);
    expect(settled[0]).toBe(STYLED);
  });

  it('only restyles lines from `from` onward', () => {
    const fade = new ElementFade(vi.fn());
    const lines = ['older row', STYLED, 'child row'];
    fade.fadeLines('tu_2', lines, 1);
    expect(lines[0]).toBe('older row');
    expect(stripAnsi(lines[1]!)).toBe(stripAnsi(STYLED));
    expect(lines[1]).not.toBe(STYLED);
    expect(stripAnsi(lines[2]!)).toBe('child row');
  });

  it('does not start the fade for an element that rendered zero rows', () => {
    const fade = new ElementFade(vi.fn());
    const lines: string[] = [];
    fade.fadeLines('tu_3', lines, 0); // not visible yet
    vi.advanceTimersByTime(FADE_MS * 3);
    const visible = [STYLED];
    fade.fadeLines('tu_3', visible, 0); // first visible frame: fade starts now
    expect(visible[0]).not.toBe(STYLED);
  });

  it('drives frames only while something is fading, then stops', () => {
    const onFrame = vi.fn();
    const fade = new ElementFade(onFrame);
    // Render-driven loop: each frame re-renders, like the overlay composer.
    const render = (): void => fade.fadeLines('tu_4', [STYLED], 0);
    onFrame.mockImplementation(render);
    render();
    vi.advanceTimersByTime(FADE_MS + FADE_FRAME_MS * 3);
    const framesDuringFade = onFrame.mock.calls.length;
    expect(framesDuringFade).toBeGreaterThan(0);
    expect(framesDuringFade).toBeLessThanOrEqual(Math.ceil(FADE_MS / FADE_FRAME_MS) + 1);
    vi.advanceTimersByTime(1000);
    expect(onFrame.mock.calls.length).toBe(framesDuringFade);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shares one frame timer across many fading elements', () => {
    const fade = new ElementFade(vi.fn());
    for (let i = 0; i < 20; i++) fade.fadeLines(`tu_${i}`, [STYLED], 0);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('dispose() stops the driver and styles nothing afterwards', () => {
    const onFrame = vi.fn();
    const fade = new ElementFade(onFrame);
    fade.fadeLines('tu_5', [STYLED], 0);
    fade.dispose();
    vi.advanceTimersByTime(FADE_FRAME_MS * 2);
    expect(onFrame).not.toHaveBeenCalled();
    const lines = [STYLED];
    fade.fadeLines('tu_6', lines, 0);
    expect(lines[0]).toBe(STYLED);
    expect(vi.getTimerCount()).toBe(0);
  });
});
