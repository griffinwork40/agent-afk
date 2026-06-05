/**
 * Tests for src/cli/mascot.ts — the welcome-banner sprite + fallback ladder.
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

  it('renders using half-block characters (▀/▄)', () => {
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
    expect(flat).toMatch(/Y/); // eyes present
    expect(flat).toMatch(/M/); // body present
    expect(flat).toMatch(/L/); // highlight present
    expect(flat).toMatch(/K/); // nose/mouth present
    expect(flat).toMatch(/W/); // fangs present
  });

  it('no red tongue and no upward ear tips', () => {
    const flat = __GOBLIN_GRID_FOR_TESTS.join('');
    expect(flat).not.toMatch(/R/);

    const topRow = __GOBLIN_GRID_FOR_TESTS[0] ?? '';
    expect(topRow[0]).toBe('.');
    expect(topRow[MASCOT_WIDTH - 1]).toBe('.');
  });

  it('side ears form wider dark-outlined bracket shapes', () => {
    const upperEarRow = __GOBLIN_GRID_FOR_TESTS[3] ?? '';
    const earTipRow = __GOBLIN_GRID_FOR_TESTS[4] ?? '';
    const lowerEarRow = __GOBLIN_GRID_FOR_TESTS[5] ?? '';
    const browRow = __GOBLIN_GRID_FOR_TESTS[6] ?? '';

    expect(upperEarRow[0]).toBe('.');
    expect(upperEarRow[1]).toBe('.');
    expect(upperEarRow[2]).toBe('D');
    expect(upperEarRow[3]).toBe('D');
    expect(upperEarRow[4]).toBe('K');
    expect(upperEarRow[MASCOT_WIDTH - 1]).toBe('.');
    expect(upperEarRow[MASCOT_WIDTH - 2]).toBe('.');
    expect(upperEarRow[MASCOT_WIDTH - 3]).toBe('D');
    expect(upperEarRow[MASCOT_WIDTH - 4]).toBe('D');
    expect(upperEarRow[MASCOT_WIDTH - 5]).toBe('K');

    expect(earTipRow[0]).toBe('D');
    expect(earTipRow[1]).toBe('D');
    expect(earTipRow[2]).toBe('D');
    expect(earTipRow[3]).toBe('.');
    expect(earTipRow[4]).toBe('.');
    expect(earTipRow[5]).toBe('K');
    expect(earTipRow[MASCOT_WIDTH - 1]).toBe('D');
    expect(earTipRow[MASCOT_WIDTH - 2]).toBe('D');
    expect(earTipRow[MASCOT_WIDTH - 3]).toBe('D');
    expect(earTipRow[MASCOT_WIDTH - 4]).toBe('.');
    expect(earTipRow[MASCOT_WIDTH - 5]).toBe('.');
    expect(earTipRow[MASCOT_WIDTH - 6]).toBe('K');

    expect(lowerEarRow[0]).toBe('.');
    expect(lowerEarRow[1]).toBe('.');
    expect(lowerEarRow[2]).toBe('D');
    expect(lowerEarRow[3]).toBe('D');
    expect(lowerEarRow[4]).toBe('K');
    expect(lowerEarRow[MASCOT_WIDTH - 1]).toBe('.');
    expect(lowerEarRow[MASCOT_WIDTH - 2]).toBe('.');
    expect(lowerEarRow[MASCOT_WIDTH - 3]).toBe('D');
    expect(lowerEarRow[MASCOT_WIDTH - 4]).toBe('D');
    expect(lowerEarRow[MASCOT_WIDTH - 5]).toBe('K');

    expect(browRow[0]).toBe('.');
    expect(browRow[1]).toBe('.');
  });

  it('rendered sprite carries the yellow eye color (#F5D547)', async () => {
    chalk.level = 3;
    const { renderMascotLines: renderColored } = await import(
      './mascot.js?colored=v12'
    );
    const joined = renderColored('idle').join('');
    expect(joined).toMatch(/\x1B\[(?:38|48);2;245;213;71m/);
  });

  it('head is symmetric except for the intentional offset fang pixels', () => {
    for (const [i, row] of __GOBLIN_GRID_FOR_TESTS.entries()) {
      const comparable =
        i === 11 ? row.replaceAll('W', 'X') :
        i === 12 ? row.replaceAll('W', 'M') :
        row;
      const reversed = comparable.split('').reverse().join('');
      expect(comparable).toBe(reversed);
    }
  });

  it('renders one offset 2-pixel fang and no extra mouth teeth', () => {
    const shadowRow = __GOBLIN_GRID_FOR_TESTS[10] ?? '';
    const mouthRow = __GOBLIN_GRID_FOR_TESTS[11] ?? '';
    const fangTipRow = __GOBLIN_GRID_FOR_TESTS[12] ?? '';

    expect(shadowRow.slice(7, 12)).toBe('XXXXX');
    expect(mouthRow[8]).toBe('W');
    expect(fangTipRow[8]).toBe('W');
    expect(mouthRow[9]).toBe('X'); // center stays dark; fang is offset left

    const mouthAndJaw = __GOBLIN_GRID_FOR_TESTS.slice(10, 14).join('');
    expect((mouthAndJaw.match(/W/g) ?? [])).toHaveLength(2);

    for (const [i, row] of __GOBLIN_GRID_FOR_TESTS.entries()) {
      if (i === 11 || i === 12) continue;
      const reversed = row.split('').reverse().join('');
      expect(row).toBe(reversed);
    }
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
