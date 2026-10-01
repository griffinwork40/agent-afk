import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import stringWidth from 'string-width';
import {
  applySgr,
  EMPTY_SGR,
  isSgr,
  knownFgRgb,
  rgbToAnsi256,
  serializeSgr,
} from './smoke-reveal.sgr.js';
import {
  INK_MS,
  SMOKE_MS,
  WISP_CELLS,
  WISP_MS,
  WISP_STEP_MS,
  inkCell,
  smokeCell,
  wispCells,
} from './smoke-reveal.cells.js';
import { SmokeReveal } from './smoke-reveal.js';
import { resetSmokeToneCache, toneRgb } from './smoke-reveal.tones.js';

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
const luma = (rgb: readonly number[]): number => 0.2126 * (rgb[0] ?? 0) + 0.7152 * (rgb[1] ?? 0) + 0.0722 * (rgb[2] ?? 0);
/** Every truecolor foreground a string sets, in order. */
function fgColors(s: string): number[][] {
  return [...s.matchAll(/38;2;(\d+);(\d+);(\d+)/g)].map((m) => [Number(m[1]), Number(m[2]), Number(m[3])]);
}

let savedLevel: typeof chalk.level;
beforeEach(() => {
  savedLevel = chalk.level;
  chalk.level = 3;
  resetSmokeToneCache();
});
afterEach(() => {
  chalk.level = savedLevel;
  resetSmokeToneCache();
});

describe('SGR state', () => {
  it('follows chalk styling on and off', () => {
    const styled = chalk.bold.hex('#FF8800')('hi');
    const opens = styled.slice(0, styled.indexOf('h'));
    let s = EMPTY_SGR;
    for (const m of opens.matchAll(/\u001b\[[0-9;]*m/g)) s = applySgr(s, m[0]);
    expect(s.bold).toBe(true);
    expect(knownFgRgb(s)).toEqual([255, 136, 0]);
    s = applySgr(s, '\u001b[39m');
    expect(s.fg).toBeNull();
    s = applySgr(s, '\u001b[22m');
    expect(s.bold).toBe(false);
    expect(applySgr(s, '\u001b[m')).toEqual(EMPTY_SGR);
  });

  it('reports RGB only when exact: truecolor and 256-cube yes, default and basic 16 no', () => {
    expect(knownFgRgb(applySgr(EMPTY_SGR, '\u001b[38;5;196m'))).toEqual([255, 0, 0]);
    expect(knownFgRgb(applySgr(EMPTY_SGR, '\u001b[38;5;244m'))).toEqual([128, 128, 128]);
    expect(knownFgRgb(applySgr(EMPTY_SGR, '\u001b[37m'))).toBeNull();
    expect(knownFgRgb(applySgr(EMPTY_SGR, '\u001b[38;5;7m'))).toBeNull();
    expect(knownFgRgb(EMPTY_SGR)).toBeNull();
    expect(knownFgRgb(applySgr(EMPTY_SGR, '\u001b[7;38;2;1;2;3m')), 'inverse swaps fg/bg').toBeNull();
  });

  it('accepts colon sub-parameters', () => {
    expect(knownFgRgb(applySgr(EMPTY_SGR, '\u001b[38:2::10:20:30m'))).toEqual([10, 20, 30]);
  });

  it('serializes to one absolute escape that re-creates the state', () => {
    const s = applySgr(applySgr(EMPTY_SGR, '\u001b[1;3m'), '\u001b[38;2;9;8;7m');
    const seq = serializeSgr(s);
    expect(isSgr(seq)).toBe(true);
    expect(applySgr({ ...EMPTY_SGR, underline: true }, seq)).toEqual(s);
  });

  it('maps RGB to the xterm-256 cube like chalk does', () => {
    expect(rgbToAnsi256(255, 0, 0)).toBe(196);
    expect(rgbToAnsi256(0, 0, 0)).toBe(16);
    expect(rgbToAnsi256(128, 128, 128)).toBe(244);
  });
});

describe('ink cell (no overshoot)', () => {
  const orange = applySgr(EMPTY_SGR, '\u001b[38;2;230;120;40m');

  it('blends toward an exact color and never passes it', () => {
    let prev = -1;
    for (let age = 0; age < INK_MS; age += 10) {
      const cell = inkCell('a', age, orange);
      expect(cell).not.toBeNull();
      const [rgb] = fgColors(cell ?? '');
      const l = luma(rgb ?? []);
      expect(l, `age ${age} got brighter than its target`).toBeLessThanOrEqual(luma([230, 120, 40]) + 0.5);
      expect(l, `age ${age} dimmed`).toBeGreaterThanOrEqual(prev - 0.5);
      prev = l;
    }
    expect(inkCell('a', INK_MS, orange)).toBeNull();
  });

  it('never guesses a palette color: default fg climbs a low tone, then goes faint-real', () => {
    const early = inkCell('a', 5, EMPTY_SGR) ?? '';
    const [rgb] = fgColors(early);
    expect(luma(rgb ?? [255, 255, 255])).toBeLessThan(luma(toneRgb(0.3)));
    const late = inkCell('a', INK_MS * 0.8, EMPTY_SGR) ?? '';
    expect(fgColors(late)).toHaveLength(0);
    expect(late).toContain('\u001b[0;2m');
  });

  it('keeps bold/italic, draws one column, and restores the exact state after the cell', () => {
    const s = applySgr(EMPTY_SGR, '\u001b[1;3;38;2;200;200;200m');
    for (const age of [0, 50, 150]) {
      const cell = inkCell('x', age, s) ?? '';
      expect(stringWidth(stripAnsi(cell))).toBe(1);
      expect(cell.startsWith('\u001b[0;1;3')).toBe(true);
      expect(cell.endsWith(serializeSgr(s))).toBe(true);
    }
  });
});

describe('smoke cell', () => {
  const white = applySgr(EMPTY_SGR, '\u001b[1;38;2;240;240;240m');

  it('starts as a particle, becomes the letter, and never overshoots the letter color', () => {
    expect(stripAnsi(smokeCell('H', 1, 7, white) ?? '')).not.toBe('H');
    const letterAges = [0.6, 0.7, 0.8, 0.9].map((f) => f * SMOKE_MS * 0.8);
    for (const age of letterAges) {
      const cell = smokeCell('H', age, 7, white) ?? '';
      expect(stripAnsi(cell)).toBe('H');
      for (const rgb of fgColors(cell)) expect(luma(rgb)).toBeLessThanOrEqual(luma([240, 240, 240]) + 0.5);
    }
    expect(smokeCell('H', SMOKE_MS, 7, white)).toBeNull();
  });

  it('keeps wide characters as themselves (column count never changes)', () => {
    const cell = smokeCell('界', 1, 3, EMPTY_SGR) ?? '';
    expect(stripAnsi(cell)).toBe('界');
  });
});

describe('wisp', () => {
  it('is exactly WISP_CELLS columns and vanishes after WISP_MS', () => {
    const w = wispCells(0, 1_000, 11);
    expect(stringWidth(stripAnsi(w))).toBe(WISP_CELLS);
    expect(wispCells(WISP_MS, 1_000, 11)).toBe('');
  });

  it('drifts rightward: cell k at the next step shows what cell k-1 showed', () => {
    const cellsAt = (now: number): string[] => [...stripAnsi(wispCells(0, now, 42))];
    let shifted = 0;
    for (let step = 0; step < 40; step++) {
      const a = cellsAt(step * WISP_STEP_MS);
      const b = cellsAt((step + 1) * WISP_STEP_MS);
      // Same glyph set (level) at cells 2..3, so the pattern carries over there.
      if (a[1] === b[2] || (a[1] === ' ' && b[2] === ' ')) shifted++;
    }
    expect(shifted).toBeGreaterThan(30);
  });

  it('is drawn after a smoke front only when the line has room, and never after ink', () => {
    let t = 10_000;
    const now = (): number => t;
    const smoke = new SmokeReveal(() => {}, now);
    smoke.record('Heading', { style: 'smoke', staggerMs: 0 });
    t += 1;
    const roomy = smoke.apply('Heading', { maxWidth: 40 });
    expect(stringWidth(stripAnsi(roomy))).toBe('Heading'.length + WISP_CELLS);
    const tight = smoke.apply('Heading', { maxWidth: 'Heading'.length + 1 });
    expect(stringWidth(stripAnsi(tight))).toBe('Heading'.length);
    expect(stringWidth(stripAnsi(smoke.apply('Heading')))).toBe('Heading'.length);
    smoke.dispose();

    const ink = new SmokeReveal(() => {}, now);
    ink.record('Body', { style: 'ink', staggerMs: 0 });
    t += 1;
    expect(stringWidth(stripAnsi(ink.apply('Body', { maxWidth: 40 })))).toBe(4);
    ink.dispose();
  });

  it('drifts into the reserved (not yet born) cells ahead of a smoke front, never changing width', () => {
    let t = 10_000;
    const now = (): number => t;
    const r = new SmokeReveal(() => {}, now);
    const text = 'Heading text';
    r.record(text, { style: 'smoke', staggerMs: 40 });
    let wispSeen = 0;
    for (let i = 0; i < 12; i++) {
      t += 20;
      const out = stripAnsi(r.apply(text));
      expect(stringWidth(out)).toBe(text.length);
      if (/[\u2800-\u28ff]/.test(out.slice(Math.floor(i / 2) + 1))) wispSeen++;
    }
    expect(wispSeen).toBeGreaterThan(0);
    r.dispose();
  });
});
