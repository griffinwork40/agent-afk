/**
 * Reveal fades against terminal colors discovered via OSC 10/11/4, pinned on
 * the Classic Repaired theme (#8A8A8A on #000000), where the old theme-table
 * guess darkened mid-fade: 58 -> 84 -> 69 (the terminal's 50% faint) -> 138.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { applySgr, EMPTY_SGR, type SgrState } from './smoke-reveal.sgr.js';
import { INK_MS, SMOKE_GLYPH_PHASE, SMOKE_MS, inkCell, settledRgb, smokeCell } from './smoke-reveal.cells.js';
import { lightness } from './smoke-reveal.oklab.js';
import { resetSmokeToneCache, type Rgb } from './smoke-reveal.tones.js';
import { setTerminalColors } from './terminal-colors.js';

const HEX = [
  '#000000', '#C23621', '#25BC24', '#ADAD27', '#818AFC', '#D338D3', '#33BBC8', '#CBCCCD',
  '#818383', '#FC391F', '#31E722', '#EAEC23', '#A1A8FD', '#F935F8', '#14F0F0', '#FFFFFF',
];
const rgbOf = (h: string): Rgb => {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const CLASSIC = { fg: rgbOf('#8A8A8A'), bg: rgbOf('#000000'), palette: new Map(HEX.map((h, i) => [i, rgbOf(h)] as const)) };

/** The one truecolor fg a cell sets, or null (settled / palette-only). */
function cellRgb(cell: string | null): Rgb | null {
  if (cell === null) return null;
  const m = /38;2;(\d+);(\d+);(\d+)/.exec(cell);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const STATES: Record<string, SgrState> = {
  'default fg': EMPTY_SGR,
  'basic white 37': applySgr(EMPTY_SGR, '\u001b[37m'),
  'bright white 97': applySgr(EMPTY_SGR, '\u001b[97m'),
  'truecolor fg': applySgr(EMPTY_SGR, '\u001b[38;2;230;126;76m'),
  'bold default': applySgr(EMPTY_SGR, '\u001b[1m'),
  'basic cyan 36': applySgr(EMPTY_SGR, '\u001b[36m'),
};

let savedLevel: typeof chalk.level;
beforeEach(() => {
  savedLevel = chalk.level;
  chalk.level = 3;
  setTerminalColors(CLASSIC);
  resetSmokeToneCache();
});
afterEach(() => {
  chalk.level = savedLevel;
  setTerminalColors(null);
  resetSmokeToneCache();
});

describe('settledRgb with discovered colors', () => {
  it('resolves default fg, basic, and bright colors to what the terminal will draw', () => {
    expect(settledRgb(EMPTY_SGR)).toEqual(rgbOf('#8A8A8A'));
    expect(settledRgb(STATES['basic white 37'] ?? EMPTY_SGR)).toEqual(rgbOf('#CBCCCD'));
    expect(settledRgb(STATES['bright white 97'] ?? EMPTY_SGR)).toEqual(rgbOf('#FFFFFF'));
    expect(settledRgb(STATES['basic cyan 36'] ?? EMPTY_SGR)).toEqual(rgbOf('#33BBC8'));
    expect(settledRgb(applySgr(EMPTY_SGR, '\u001b[7m'))).toBeNull();
  });
});

describe.each(Object.entries(STATES))('%s on Classic Repaired', (_name, state) => {
  // Resolved per test: discovery is installed in beforeEach, after collection.
  const targetOf = (): Rgb | null => settledRgb(state);

  it('ink: continuous truecolor fade, perceived lightness never falls, never passes the target', () => {
    const target = targetOf();
    expect(target).not.toBeNull();
    const targetL = lightness(target ?? [0, 0, 0]);
    let prev = -1;
    for (let age = 0; age < INK_MS; age += 4) {
      const cell = inkCell('a', age, state);
      expect(cell, `age ${age}`).not.toContain('\u001b[0;2m');
      const rgb = cellRgb(cell);
      expect(rgb, `age ${age} has an exact color`).not.toBeNull();
      const l = lightness(rgb ?? [0, 0, 0]);
      expect(l, `age ${age} monotonic`).toBeGreaterThanOrEqual(prev - 1e-3);
      expect(l, `age ${age} no overshoot`).toBeLessThanOrEqual(targetL + 2e-3);
      prev = l;
    }
    expect(inkCell('a', INK_MS, state)).toBeNull();
  });

  it('ink: the first 60fps frame moves at most 20% of the lightness span', () => {
    const l0 = lightness(cellRgb(inkCell('a', 0, state)) ?? [0, 0, 0]);
    const l1 = lightness(cellRgb(inkCell('a', 1000 / 60, state)) ?? [0, 0, 0]);
    const span = lightness(targetOf() ?? [0, 0, 0]) - l0;
    expect((l1 - l0) / span).toBeLessThanOrEqual(0.2);
  });

  it('ink: gives every 60fps frame of a 200ms fade its own look (no stepped hand-off)', () => {
    const looks = new Set<string>();
    for (let age = 0; age < INK_MS; age += 1000 / 60) looks.add(inkCell('a', age, state) ?? 'settled');
    expect(looks.size).toBeGreaterThanOrEqual(10);
  });

  it('smoke: the letter phase rises monotonically into its own color', () => {
    const targetL = lightness(targetOf() ?? [0, 0, 0]);
    let prev = -1;
    // Seed 0 has the base lifetime's jitter applied; walk its whole letter phase.
    for (let age = SMOKE_MS * SMOKE_GLYPH_PHASE; age < SMOKE_MS; age += 5) {
      const rgb = cellRgb(smokeCell('a', age, 0, state));
      if (rgb === null) break;
      const l = lightness(rgb);
      expect(l).toBeGreaterThanOrEqual(prev - 1e-3);
      expect(l).toBeLessThanOrEqual(targetL + 2e-3);
      prev = l;
    }
  });
});

describe('without discovery (fallback)', () => {
  it('default fg never darkens: floor speck, then faint-real, then settled', () => {
    setTerminalColors(null);
    const early = inkCell('a', 5, EMPTY_SGR) ?? '';
    const late = inkCell('a', INK_MS * 0.8, EMPTY_SGR) ?? '';
    expect(cellRgb(early)).not.toBeNull();
    expect(late).toContain('\u001b[0;2m');
    // The speck never climbs: every speck frame shows the same floor tone.
    const specks = new Set<string>();
    for (let age = 0; age < INK_MS * 0.25; age += 5) specks.add(JSON.stringify(cellRgb(inkCell('a', age, EMPTY_SGR))));
    expect(specks.size).toBe(1);
  });
});
