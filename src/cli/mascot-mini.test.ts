/**
 * Tests for src/cli/mascot-mini.ts — the 3-row reacting goblin (issue #336).
 *
 * The band painter (`MascotBar`) reserves a FIXED number of rows and clears
 * exactly what it painted, so the sprite's shape is load-bearing geometry, not
 * decoration: a frame with the wrong row count or an over-wide row would leave
 * the reserved band and corrupt the DECSTBM accounting. These tests pin the
 * shape mechanically for every frame of every state, plus the fallback ladder
 * (truecolor → uncoloured silhouette → suppressed).
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import stringWidth from 'string-width';
import chalk from 'chalk';
import {
  MINI_MASCOT_WIDTH,
  MINI_MASCOT_HEIGHT,
  miniMascotFrameCount,
  renderMiniMascotLines,
  __MINI_MASCOT_FRAMES_FOR_TESTS as FRAMES,
} from './mascot-mini.js';
import type { MascotState } from './mascot.js';

// Force truecolor so the colour-channel assertions below are meaningful:
// vitest runs without a TTY, where chalk auto-detects level 0 and the sprite
// emits bare glyphs. (One test flips this back to 0 on purpose.)
beforeAll(() => {
  chalk.level = 3;
});

/** Strip ANSI for width / glyph assertions. */
function strip(s: string): string {
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

const STATES: MascotState[] = ['idle', 'working', 'alert'];

describe('mini mascot grids', () => {
  it('every frame of every state is MINI_MASCOT_HEIGHT*2 pixel rows', () => {
    for (const state of STATES) {
      for (const [i, grid] of FRAMES[state].entries()) {
        expect(grid, `${state} frame ${i}`).toHaveLength(MINI_MASCOT_HEIGHT * 2);
      }
    }
  });

  it('every pixel row is exactly MINI_MASCOT_WIDTH columns', () => {
    for (const state of STATES) {
      for (const [i, grid] of FRAMES[state].entries()) {
        for (const row of grid) {
          expect(row.length, `${state} frame ${i}: ${row}`).toBe(MINI_MASCOT_WIDTH);
        }
      }
    }
  });

  it('every pixel row is left-right symmetric', () => {
    // At 13 columns a single off-centre pixel is a visible defect, so unlike
    // the banner sprite (whose cap leans right) the whole mini grid must be a
    // palindrome — including the cap.
    for (const state of STATES) {
      for (const [i, grid] of FRAMES[state].entries()) {
        for (const row of grid) {
          expect(row.split('').reverse().join(''), `${state} frame ${i}`).toBe(row);
        }
      }
    }
  });

  it('uses only known palette tokens', () => {
    // Mirrors PIXEL_PALETTE's key set (mascot.ts). An unknown token renders as
    // transparent, i.e. silently punches a hole in the sprite.
    const known = /^[.DMLYKWXBR]+$/;
    for (const state of STATES) {
      for (const grid of FRAMES[state]) {
        for (const row of grid) expect(row).toMatch(known);
      }
    }
  });

  it('animated states have >1 frame; idle has exactly 1', () => {
    expect(miniMascotFrameCount('idle')).toBe(1);
    expect(miniMascotFrameCount('working')).toBeGreaterThan(1);
    expect(miniMascotFrameCount('alert')).toBeGreaterThan(1);
  });

  it('working frames are all distinct (the animation actually animates)', () => {
    const rendered = FRAMES['working'].map((g) => g.join('|'));
    expect(new Set(rendered).size).toBe(rendered.length);
  });

  it('only alert uses the alarm-red token', () => {
    expect(FRAMES['alert'].map((g) => g.join('')).join('')).toMatch(/R/);
    expect(FRAMES['idle'].map((g) => g.join('')).join('')).not.toMatch(/R/);
    expect(FRAMES['working'].map((g) => g.join('')).join('')).not.toMatch(/R/);
  });
});

describe('renderMiniMascotLines', () => {
  const prevPlain = process.env['AFK_BANNER_PLAIN'];

  afterEach(() => {
    if (prevPlain === undefined) delete process.env['AFK_BANNER_PLAIN'];
    else process.env['AFK_BANNER_PLAIN'] = prevPlain;
    chalk.level = 3;
  });

  it('renders exactly MINI_MASCOT_HEIGHT rows for every state', () => {
    for (const state of STATES) {
      expect(renderMiniMascotLines(state), state).toHaveLength(MINI_MASCOT_HEIGHT);
    }
  });

  it('every rendered row is MINI_MASCOT_WIDTH display columns wide', () => {
    for (const state of STATES) {
      for (let f = 0; f < miniMascotFrameCount(state); f++) {
        for (const line of renderMiniMascotLines(state, f)) {
          expect(stringWidth(strip(line))).toBe(MINI_MASCOT_WIDTH);
        }
      }
    }
  });

  it('draws with half-blocks only — no emoji, no heavy blocks, no geometric shapes', () => {
    // Cross-terminal cell metrics: half-blocks are single-width everywhere,
    // emoji and geometric shapes are not.
    for (const state of STATES) {
      const joined = strip(renderMiniMascotLines(state).join(''));
      expect(joined).toMatch(/[▀▄]/);
      expect(joined).not.toMatch(/[█▟▙▜▛◥◤◢◣●▼◆]/);
      // eslint-disable-next-line no-control-regex
      expect(joined).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u);
    }
  });

  it('cycles frames modulo the frame count (callers may pass a raw tick)', () => {
    const count = miniMascotFrameCount('working');
    const first = renderMiniMascotLines('working', 0);
    expect(renderMiniMascotLines('working', count)).toEqual(first);
    expect(renderMiniMascotLines('working', count * 7)).toEqual(first);
    // Defensive: a negative tick must not throw or return an empty frame.
    expect(renderMiniMascotLines('working', -1)).toHaveLength(MINI_MASCOT_HEIGHT);
  });

  it('working frames differ from each other once rendered', () => {
    const frames = Array.from({ length: miniMascotFrameCount('working') }, (_, f) =>
      renderMiniMascotLines('working', f).join('|'),
    );
    expect(new Set(frames).size).toBe(frames.length);
  });

  it('alert carries the alarm-red channel; idle does not', () => {
    expect(renderMiniMascotLines('alert').join('')).toMatch(/\x1B\[(?:38|48);2;200;60;40m/);
    expect(renderMiniMascotLines('idle').join('')).not.toMatch(/200;60;40/);
  });

  it('degrades to an uncoloured silhouette at chalk.level 0 (NO_COLOR / non-TTY)', () => {
    chalk.level = 0;
    const lines = renderMiniMascotLines('working');
    expect(lines).toHaveLength(MINI_MASCOT_HEIGHT);
    for (const line of lines) {
      expect(line).not.toMatch(/\x1B\[/); // no escapes at all
      expect(stringWidth(line)).toBe(MINI_MASCOT_WIDTH); // still exact geometry
    }
  });

  it('animation stays VISIBLE at chalk.level 0 (glyph change, not just hue)', () => {
    // The load-bearing rule from the module's invariant block: a frame set that
    // differs only in colour freezes into a still silhouette under NO_COLOR.
    chalk.level = 0;
    for (const state of ['working', 'alert'] as const) {
      const frames = Array.from({ length: miniMascotFrameCount(state) }, (_, f) =>
        renderMiniMascotLines(state, f).join('|'),
      );
      expect(new Set(frames).size, `${state} is glyph-static at level 0`).toBeGreaterThan(1);
    }
  });

  it('alert widens the silhouette relative to idle (flared ears, mono-visible)', () => {
    chalk.level = 0;
    const idleFace = renderMiniMascotLines('idle')[2] ?? '';
    const alertFace = renderMiniMascotLines('alert', 0)[2] ?? '';
    expect(idleFace.trim().length).toBeLessThan(alertFace.trim().length);
  });

  it('AFK_BANNER_PLAIN=1 suppresses the sprite entirely (reserve no rows)', () => {
    process.env['AFK_BANNER_PLAIN'] = '1';
    for (const state of STATES) {
      expect(renderMiniMascotLines(state), state).toEqual([]);
    }
  });
});
