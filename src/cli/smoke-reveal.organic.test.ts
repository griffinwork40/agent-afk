/**
 * SmokeReveal + per-character variation: the reveal front is organic (not a
 * repeating comb), yet every character's look is stable across repaints,
 * appended text, and block commits, and nothing outlives LIFETIME_MS.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import chalk from 'chalk';
import { SmokeReveal, LIFETIME_MS, MAX_LAG_MS, FRAME_MS, SMOKE_GLYPHS } from './smoke-reveal.js';
import { SMOKE_GLYPH_LEVELS } from './smoke-reveal.frame.js';
import { resetSmokeToneCache } from './smoke-reveal.tones.js';
import { stripAnsi } from './display.js';
const glyphsIn = (s: string): string[] => [...stripAnsi(s)].filter((ch) => SMOKE_GLYPHS.includes(ch));

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

function clockAt(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('SmokeReveal organic variation', () => {
  it('draws more distinct particles along the front than a single uniform ladder could', () => {
    const c = clockAt();
    const r = new SmokeReveal(() => {}, c.now);
    const text = 'x'.repeat(60);
    r.record(text);
    c.advance(FRAME_MS * 3);
    const seen = new Set(glyphsIn(r.apply(text)));
    // A uniform ladder has exactly one glyph per density level.
    expect(seen.size).toBeGreaterThan(SMOKE_GLYPH_LEVELS.length);
    r.dispose();
  });

  it('renders identically on two repaints at the same instant', () => {
    const c = clockAt();
    const r = new SmokeReveal(() => {}, c.now);
    const text = 'condensing out of smoke';
    r.record(text);
    c.advance(40);
    expect(r.apply(text)).toBe(r.apply(text));
    r.dispose();
  });

  it('keeps each character\'s look when more text is appended', () => {
    const c = clockAt();
    const r = new SmokeReveal(() => {}, c.now);
    const first = 'abcdefghijklmnop';
    r.record(first);
    c.advance(30);
    const before = stripAnsi(r.apply(first));
    r.record('qrstu');
    const after = stripAnsi(r.apply(first + 'qrstu'));
    expect(after.slice(0, before.length)).toBe(before);
    r.dispose();
  });

  it('keeps each character\'s look across a block commit (text leaves the front)', () => {
    const c = clockAt();
    const r = new SmokeReveal(() => {}, c.now);
    r.record('head ');
    r.record('tailtext');
    c.advance(30);
    const before = stripAnsi(r.apply('head tailtext'));
    r.noteCommit();
    const after = stripAnsi(r.apply('tailtext'));
    expect(after).toBe(before.slice(-after.length));
    r.dispose();
  });

  it('keeps each character\'s look when formatter-consumed syntax is reconciled', () => {
    const c = clockAt();
    const r = new SmokeReveal(() => {}, c.now);
    r.record('plainly');
    r.apply('plainly'); // establishes the growth baseline
    c.advance(20);
    const before = stripAnsi(r.apply('plainly'));
    // The formatter consumes the four asterisks: raw grows 8, formatted grows 4.
    // The reconcile must move the identity counter by 4, or every letter of
    // 'plainly' is re-seeded and changes shape mid-fade.
    r.record('**bold**');
    const after = stripAnsi(r.apply('plainlybold'));
    expect(after.slice(0, before.length)).toBe(before);
    r.dispose();
  });

  it('settles some characters before LIFETIME_MS (a ragged front) and all by it', () => {
    const c = clockAt();
    const r = new SmokeReveal(() => {}, c.now);
    const text = 'y'.repeat(40);
    r.record(text);
    // Past every birth, inside the jittered settle window of the oldest letters.
    c.advance(MAX_LAG_MS + LIFETIME_MS * 0.9);
    const mid = r.apply(text);
    const styled = (mid.match(/\u001b\[38;2;/g) ?? []).length;
    expect(styled).toBeGreaterThan(0);
    expect(styled).toBeLessThan(text.length);
    c.advance(LIFETIME_MS * 0.1 + 1);
    expect(r.apply(text)).toBe(text);
    r.dispose();
  });

  it('stops re-arming its settle driver once every letter has visually settled', () => {
    const c = clockAt();
    let repaints = 0;
    const r = new SmokeReveal(() => { repaints++; }, c.now);
    r.record('z');
    c.advance(LIFETIME_MS);
    // Settled on its own jittered lifetime: unchanged reference, no tick armed.
    expect(r.apply('z')).toBe('z');
    expect(repaints).toBe(0);
    r.dispose();
  });
});
