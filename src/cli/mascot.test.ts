/**
 * Tests for src/cli/mascot.ts — the welcome-banner sprite + fallback ladder.
 *
 * Pins the load-bearing shape of the v14 "sadistic code goblin" without
 * over-pinning every pixel: dimensions, palette presence, the symmetric
 * face, the single pointed fang overlay, and the fallback ladder.
 */

import { describe, it, expect, afterEach, beforeAll } from 'vitest';
import stringWidth from 'string-width';
import chalk from 'chalk';
import {
  renderMascotLines,
  MASCOT_WIDTH,
  MASCOT_HEIGHT,
  mascotSuppressed,
  __GOBLIN_GRID_FOR_TESTS,
  __GLYPH_OVERLAY_FOR_TESTS,
} from './mascot.js';

// Force truecolor for color-channel assertions below. Vitest runs without a
// TTY by default, so chalk auto-detects level 0 and our sprite emits raw
// glyphs with no ANSI. The sprite still needs to *carry* the color escapes
// when invoked in a real terminal; pinning chalk.level here lets us assert
// that the per-glyph color partitioning is wired correctly without relying
// on the runner's environment.
beforeAll(() => {
  chalk.level = 3;
});

/** Strip ANSI for width / glyph assertions. */
function strip(s: string): string {
  return s.replace(/\x1B\[[0-9;]*m/g, '');
}

describe('mascot sprite', () => {
  const prevPlain = process.env['AFK_BANNER_PLAIN'];

  afterEach(() => {
    if (prevPlain === undefined) delete process.env['AFK_BANNER_PLAIN'];
    else process.env['AFK_BANNER_PLAIN'] = prevPlain;
  });

  it('renders exactly MASCOT_HEIGHT rows in the idle state', () => {
    const lines = renderMascotLines('idle');
    expect(lines).toHaveLength(MASCOT_HEIGHT);
  });

  it('every row has a display width of MASCOT_WIDTH columns', () => {
    for (const line of renderMascotLines('idle')) {
      expect(stringWidth(strip(line))).toBe(MASCOT_WIDTH);
    }
  });

  it('renders the body with half-block characters (▀/▄), no heavy blocks', () => {
    const joined = strip(renderMascotLines('idle').join(''));
    expect(joined).toMatch(/[▀▄]/);
    expect(joined).not.toMatch(/[█▟▙▜▛◥◤◢◣●]/);
  });

  it('pixel grid has the expected dimensions (MASCOT_WIDTH cols × MASCOT_HEIGHT*2 rows)', () => {
    expect(__GOBLIN_GRID_FOR_TESTS).toHaveLength(MASCOT_HEIGHT * 2);
    for (const row of __GOBLIN_GRID_FOR_TESTS) {
      expect(row.length).toBe(MASCOT_WIDTH);
    }
  });

  it('pixel grid contains the expected palette tokens', () => {
    const flat = __GOBLIN_GRID_FOR_TESTS.join('');
    expect(flat).toMatch(/Y/); // eyes + hatband
    expect(flat).toMatch(/M/); // body
    expect(flat).toMatch(/L/); // highlights
    expect(flat).toMatch(/K/); // brow / mouth / outline
    expect(flat).toMatch(/D/); // ears + under-eye bags
    expect(flat).toMatch(/B/); // brown cap
  });

  it('no red tongue and no upward ear tips at the very top row', () => {
    const flat = __GOBLIN_GRID_FOR_TESTS.join('');
    expect(flat).not.toMatch(/R/);

    const topRow = __GOBLIN_GRID_FOR_TESTS[0] ?? '';
    expect(topRow[0]).toBe('.');
    expect(topRow[MASCOT_WIDTH - 1]).toBe('.');
  });

  it('wears a brown cap (cone rows) above a gold hatband', () => {
    const grid = __GOBLIN_GRID_FOR_TESTS;
    // brown cone present in the upper cap rows
    expect(grid.slice(0, 7).join('')).toMatch(/B/);
    // gold hatband: a run of yellow framed by the dark outline
    expect(grid[7] ?? '').toMatch(/KY+K/);
    // cap colour does not bleed into the face below the band
    expect(grid.slice(8).join('')).not.toMatch(/B/);
  });

  it('has dark-outlined ears flanking the head at their widest row', () => {
    // ears reach their widest at the hooded-lid row (grid row 13)
    const widest = __GOBLIN_GRID_FOR_TESTS[13] ?? '';
    expect(widest[0]).toBe('D');
    expect(widest[MASCOT_WIDTH - 1]).toBe('D');
  });

  it('has yellow eyes with dark forward pupils', () => {
    const eyeRow = __GOBLIN_GRID_FOR_TESTS[14] ?? ''; // yellow eye band
    const pupilRow = __GOBLIN_GRID_FOR_TESTS[15] ?? ''; // pupils gaze forward
    expect(eyeRow).toMatch(/Y/);
    expect(pupilRow).toMatch(/YKY/); // dark pupil framed by yellow
  });

  it('hangs a single pointed ▼ fang as one white-on-dark overlay cell', () => {
    const overlay = __GLYPH_OVERLAY_FOR_TESTS;
    // The fang is the original pointed ▼ glyph, restored as a single overlay
    // cell. It is allowed here (unlike a general ban on shape glyphs) ONLY
    // because it renders white-on-dark against a dark mouth notch: the glyph
    // seats low and font-dependently, but with bg 'K' and a dark notch carved
    // into grid row 22 behind it, the empty top of the cell is dark and the old
    // "green space" gap cannot appear. See GLYPH_OVERLAY's invariant.
    expect(Object.keys(overlay)).toHaveLength(1);

    const fang = overlay['11,11'];
    expect(fang).toBeDefined();
    expect(fang!.char).toBe('▼'); // the original pointed glyph, back on purpose
    expect(fang!.fg).toBe('W'); // white tooth
    expect(fang!.bg).toBe('K'); // dark backing — the gap-killer

    // the fang sits at the viewer's-left canine (left of the centre column)
    const fangCol = Number(Object.keys(overlay)[0]!.split(',')[1]);
    expect(fangCol).toBeLessThan((MASCOT_WIDTH - 1) / 2);

    // the dark notch that backs the fang: grid row 22 is dark (K) at and around
    // the fang column, so nothing light shows above the tooth across fonts.
    const jaw = __GOBLIN_GRID_FOR_TESTS[22] ?? '';
    expect(jaw[fangCol]).toBe('K');
    expect(jaw[fangCol - 1]).toBe('K');
    expect(jaw[fangCol + 1]).toBe('K');

    // the tooth lives only in the overlay — no off-white W in the grid
    expect(__GOBLIN_GRID_FOR_TESTS.join('')).not.toMatch(/W/);
  });

  it('renders the fang as a white ▼ glyph in the sprite', () => {
    // W (238,238,222) appears nowhere in the grid, so a white FOREGROUND escape
    // in the rendered output proves the fang overlay is drawn (the ▼ glyph is
    // white-on-dark, so white is now the fg). chalk.level is pinned to 3 above.
    const joined = renderMascotLines('idle').join('');
    expect(joined).toMatch(/\x1B\[38;2;238;238;222m/);
    expect(strip(joined)).toMatch(/▼/);
  });

  it('the face below the cap is left-right symmetric', () => {
    // Rows 0–6 are the brown cap cone, which deliberately leans right.
    // Everything from the hatband (row 7) down must be a palindrome.
    for (const row of __GOBLIN_GRID_FOR_TESTS.slice(7)) {
      const reversed = row.split('').reverse().join('');
      expect(row).toBe(reversed);
    }
  });

  it('rendered sprite carries the yellow eye color (#F5D547)', async () => {
    chalk.level = 3;
    const { renderMascotLines: renderColored } = await import(
      './mascot.js?colored=v14'
    );
    const joined = renderColored('idle').join('');
    expect(joined).toMatch(/\x1B\[(?:38|48);2;245;213;71m/);
  });

  it('chin tapers to a rounded base in the bottom 2 pixel rows (no protrusions)', () => {
    const bottomTwo = __GOBLIN_GRID_FOR_TESTS.slice(-2);
    for (const row of bottomTwo) {
      expect(row[0]).toBe('.');
      expect(row[1]).toBe('.');
      expect(row[MASCOT_WIDTH - 2]).toBe('.');
      expect(row[MASCOT_WIDTH - 1]).toBe('.');
    }
  });

  it('AFK_BANNER_PLAIN=1 returns an empty sprite array', () => {
    process.env['AFK_BANNER_PLAIN'] = '1';
    expect(renderMascotLines('idle')).toEqual([]);
    expect(mascotSuppressed()).toBe(true);
  });

  it('working / alert states still render (fall through to idle in v1)', () => {
    expect(renderMascotLines('working')).toHaveLength(MASCOT_HEIGHT);
    expect(renderMascotLines('alert')).toHaveLength(MASCOT_HEIGHT);
  });

  it('mascotSuppressed() is false by default', () => {
    delete process.env['AFK_BANNER_PLAIN'];
    expect(mascotSuppressed()).toBe(false);
  });
});
