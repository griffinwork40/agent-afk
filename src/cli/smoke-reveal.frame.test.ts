/**
 * Per-character smoke variation (smoke-reveal.frame.ts): determinism, bounds,
 * and the same-density-per-level property that keeps variation from reading
 * as noise.
 */
import { describe, it, expect } from 'vitest';
import stringWidth from 'string-width';
import {
  SMOKE_GLYPH_LEVELS,
  LIFETIME_JITTER,
  TONE_JITTER,
  seedUnit,
  charLifetime,
  smokeGlyph,
  smokeToneOffset,
  easeOutCubic,
} from './smoke-reveal.frame.js';

/** Raised-dot count of a braille pattern (U+2800 block): bits of the offset. */
function dots(glyph: string): number {
  let bits = (glyph.codePointAt(0) ?? 0) - 0x2800;
  let n = 0;
  while (bits > 0) {
    n += bits & 1;
    bits >>= 1;
  }
  return n;
}

const SEEDS = Array.from({ length: 256 }, (_, i) => i);

describe('SMOKE_GLYPH_LEVELS', () => {
  it('holds only single-column braille glyphs', () => {
    for (const level of SMOKE_GLYPH_LEVELS) {
      for (const g of level) {
        const cp = g.codePointAt(0) ?? 0;
        expect(cp >= 0x2801 && cp <= 0x28ff, g).toBe(true);
        expect(stringWidth(g), g).toBe(1);
      }
    }
  });

  it('keeps one dot count per level, never thinning as the level rises', () => {
    let prev = 0;
    for (const level of SMOKE_GLYPH_LEVELS) {
      const counts = new Set(level.map(dots));
      expect(counts.size, level.join('')).toBe(1);
      const [n = 0] = [...counts];
      expect(n).toBeGreaterThanOrEqual(prev);
      prev = n;
    }
  });

  it('offers at least two variants per level', () => {
    for (const level of SMOKE_GLYPH_LEVELS) expect(level.length).toBeGreaterThanOrEqual(2);
  });
});

describe('seedUnit', () => {
  it('is deterministic and stays in [0, 1)', () => {
    for (const s of SEEDS) {
      const u = seedUnit(s, 0);
      expect(u).toBe(seedUnit(s, 0));
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });

  it('spreads adjacent seeds across the range (neighbours do not move in lockstep)', () => {
    const us = SEEDS.map((s) => seedUnit(s, 0));
    const low = us.filter((u) => u < 0.5).length;
    expect(low).toBeGreaterThan(96);
    expect(low).toBeLessThan(160);
    let steps = 0;
    for (let i = 1; i < us.length; i++) steps += Math.abs((us[i] ?? 0) - (us[i - 1] ?? 0));
    // Uniform independent pairs average a 1/3 step; a monotone ramp would sum to < 1.
    expect(steps / (us.length - 1)).toBeGreaterThan(0.25);
  });

  it('gives different lanes independent values for the same seed', () => {
    const differing = SEEDS.filter((s) => seedUnit(s, 0) !== seedUnit(s, 1)).length;
    expect(differing).toBe(SEEDS.length);
  });

  it('accepts negative and very large seeds without leaving the range', () => {
    for (const s of [-1, -12345, 2 ** 31, 2 ** 40 + 7]) {
      const u = seedUnit(s, 2);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });
});

describe('charLifetime', () => {
  it('only ever shortens the base lifetime, by at most LIFETIME_JITTER', () => {
    for (const s of SEEDS) {
      const life = charLifetime(s, 320);
      expect(life).toBeLessThanOrEqual(320);
      expect(life).toBeGreaterThanOrEqual(320 * (1 - LIFETIME_JITTER));
    }
  });

  it('actually varies across characters', () => {
    const lives = SEEDS.map((s) => charLifetime(s, 320));
    expect(Math.max(...lives) - Math.min(...lives)).toBeGreaterThan(320 * LIFETIME_JITTER * 0.8);
  });
});

describe('smokeGlyph', () => {
  it('draws from the level matching the smoke progress', () => {
    const n = SMOKE_GLYPH_LEVELS.length;
    for (let level = 0; level < n; level++) {
      const p = (level + 0.5) / n;
      for (const s of SEEDS) expect(SMOKE_GLYPH_LEVELS[level]).toContain(smokeGlyph(p, s));
    }
  });

  it('clamps out-of-range progress to the first and last level', () => {
    expect(SMOKE_GLYPH_LEVELS[0]).toContain(smokeGlyph(-1, 3));
    expect(SMOKE_GLYPH_LEVELS.at(-1)).toContain(smokeGlyph(1, 3));
  });

  it('is stable for one character within a level, and varies across characters', () => {
    const n = SMOKE_GLYPH_LEVELS.length;
    for (const s of SEEDS.slice(0, 32)) expect(smokeGlyph(0.1 / n, s)).toBe(smokeGlyph(0.9 / n, s));
    for (let level = 0; level < n; level++) {
      const p = (level + 0.5) / n;
      const seen = new Set(SEEDS.map((s) => smokeGlyph(p, s)));
      expect(seen.size).toBeGreaterThan(Math.min(SMOKE_GLYPH_LEVELS[level]?.length ?? 0, SEEDS.length) / 4);
      for (const g of seen) expect(SMOKE_GLYPH_LEVELS[level]).toContain(g);
    }
  });

  it('only ever gains dots: each level is a superset of the one before (condenses, never re-scatters)', () => {
    const n = SMOKE_GLYPH_LEVELS.length;
    const bits = (g: string): number => g.charCodeAt(0) - 0x2800;
    for (const s of SEEDS) {
      let prev = 0;
      for (let level = 0; level < n; level++) {
        const cur = bits(smokeGlyph((level + 0.5) / n, s));
        expect(cur & prev, `seed ${s} level ${level}`).toBe(prev);
        expect(cur).not.toBe(prev);
        prev = cur;
      }
    }
  });
});

describe('smokeToneOffset', () => {
  it('stays within +/- TONE_JITTER and is not constant', () => {
    const offs = SEEDS.map(smokeToneOffset);
    for (const o of offs) {
      expect(Math.abs(o)).toBeLessThanOrEqual(TONE_JITTER);
    }
    expect(new Set(offs).size).toBeGreaterThan(SEEDS.length / 2);
  });
});

describe('easeOutCubic', () => {
  it('maps 0 to 0 and 1 to 1, clamping outside', () => {
    expect(easeOutCubic(0)).toBe(0);
    expect(easeOutCubic(1)).toBe(1);
    expect(easeOutCubic(-3)).toBe(0);
    expect(easeOutCubic(4)).toBe(1);
  });

  it('is monotonic and front-loaded (ahead of linear inside the range)', () => {
    let prev = 0;
    for (let i = 1; i < 100; i++) {
      const p = i / 100;
      const e = easeOutCubic(p);
      expect(e).toBeGreaterThan(prev);
      expect(e).toBeGreaterThan(p);
      prev = e;
    }
  });
});
