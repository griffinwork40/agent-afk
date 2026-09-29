/**
 * WordReveal unit contracts (AFK_WORD_TEXT=1):
 *  1. Only whole words are shown; unreleased letters are blank cells of the
 *     same width, so the layout never changes.
 *  2. A still-growing final word waits, then shows after a quiet period.
 *  3. A burst releases in a few cohorts (ceil(waiting / WORD_DRAIN_TICKS) per
 *     tick), at most one release per WORD_TICK_MS.
 *  4. Only the newest cohort fades; the overlay settles to the exact input.
 *  5. Shown letters never go back to blank when syntax is consumed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import chalk from 'chalk';
import {
  WordReveal,
  isWordTextEnabled,
  PARTIAL_WORD_WAIT_MS,
  WORD_FADE_MS,
  WORD_HOLD_SHARE,
  WORD_TICK_MS,
} from './word-reveal.js';
import { resetSmokeToneCache } from './smoke-reveal.tones.js';

const stripAnsi = (s: string): string => s.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '');
/** Visible letters in a rendered overlay (blanks do not count). */
const shown = (s: string): string => stripAnsi(s).replace(/\s+/g, ' ').trim();

let t = 0;
let paints = 0;
function make(): WordReveal {
  return new WordReveal(() => { paints++; }, () => t);
}

let savedLevel: typeof chalk.level;
beforeEach(() => {
  vi.useFakeTimers();
  t = 0;
  paints = 0;
  savedLevel = chalk.level;
  chalk.level = 3;
  resetSmokeToneCache();
  vi.stubEnv('AFK_PLAIN_OUTPUT', '');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  chalk.level = savedLevel;
});

describe('isWordTextEnabled', () => {
  it('is off unless explicitly enabled on a color terminal', () => {
    vi.stubEnv('AFK_WORD_TEXT', '');
    expect(isWordTextEnabled()).toBe(false);
    vi.stubEnv('AFK_WORD_TEXT', '1');
    expect(isWordTextEnabled()).toBe(true);
    chalk.level = 1;
    expect(isWordTextEnabled()).toBe(false);
  });
});

describe('WordReveal', () => {
  it('shows whole words only and keeps the layout', () => {
    const w = make();
    w.record('Hello wor');
    const out = w.apply('Hello wor');
    expect(stripAnsi(out)).toBe('Hello    ');
    expect(shown(out)).toBe('Hello');
    w.dispose();
  });

  it('shows a trailing partial word after the stream goes quiet', () => {
    const w = make();
    w.record('Hello wor');
    w.apply('Hello wor');
    t = PARTIAL_WORD_WAIT_MS - 1;
    expect(shown(w.apply('Hello wor'))).toBe('Hello');
    t = PARTIAL_WORD_WAIT_MS;
    expect(shown(w.apply('Hello wor'))).toBe('Hello wor');
    w.dispose();
  });

  it('releases a trailing word as soon as whitespace follows it', () => {
    const w = make();
    w.record('Hello wor');
    w.apply('Hello wor');
    t = WORD_TICK_MS;
    w.record('ld ');
    expect(shown(w.apply('Hello world '))).toBe('Hello world');
    w.dispose();
  });

  it('drains a burst in calm cohorts, at most one release per tick', () => {
    const w = make();
    const text = 'one two three four five six seven eight nine ten eleven twelve ';
    w.record(text);
    const count = (s: string): number => shown(s).split(' ').filter(Boolean).length;
    expect(count(w.apply(text))).toBe(4); // ceil(12 / 3)
    t = WORD_TICK_MS - 1;
    expect(count(w.apply(text))).toBe(4); // same tick: no new release
    t = WORD_TICK_MS;
    expect(count(w.apply(text))).toBe(7); // + ceil(8 / 3)
    t = WORD_TICK_MS * 2;
    expect(count(w.apply(text))).toBe(9); // + ceil(5 / 3)
    // The last few words trickle out one per tick (20 words/s).
    for (const [tick, n] of [[3, 10], [4, 11], [5, 12]] as const) {
      t = WORD_TICK_MS * tick;
      expect(count(w.apply(text))).toBe(n);
    }
    w.dispose();
  });

  it('fades only the newest cohort and settles to the exact input', () => {
    const w = make();
    w.record('alpha ');
    w.apply('alpha ');
    t = WORD_FADE_MS; // alpha has finished fading
    w.record('beta ');
    const out = w.apply('alpha beta ');
    expect(out.startsWith('alpha ')).toBe(true); // older word verbatim
    expect(out).toMatch(/\u001b\[[\d;]*m/); // newest word is styled
    t = WORD_FADE_MS * 2;
    const settled = 'alpha beta ';
    expect(w.apply(settled)).toBe(settled); // same reference: nothing animating
    w.dispose();
  });

  it('reports commit-hold time: recheck while waiting, fade share once shown', () => {
    const w = make();
    w.record('Hello wor');
    w.apply('Hello wor');
    expect(w.revealHoldRemaining()).toBe(32); // "wor" not released
    expect(w.revealHoldRemaining(4)).toBe(WORD_FADE_MS * WORD_HOLD_SHARE); // "o" of Hello
    t = WORD_FADE_MS;
    expect(w.revealHoldRemaining(4)).toBe(0);
    expect(w.smokeHoldRemaining()).toBe(0);
    w.dispose();
  });

  it('never blanks shown letters when an earlier literal becomes syntax', () => {
    const w = make();
    w.record('see *this ');
    w.apply('see *this ');
    t = WORD_TICK_MS;
    w.apply('see *this ');
    t = WORD_FADE_MS * 2;
    expect(shown(w.apply('see *this '))).toBe('see *this');
    // The closing marker arrives and the formatter consumes both markers.
    w.record('* now ');
    const out = w.apply('see this now ');
    expect(shown(out).startsWith('see this')).toBe(true);
    // A word straddling the boundary is completed, never left half shown.
    expect(['see this', 'see this now']).toContain(shown(out));
    w.dispose();
  });

  it('forgets a stripped tail and resets cleanly', () => {
    const w = make();
    w.record('keep drop ');
    w.apply('keep drop ');
    w.forgetNewest(4);
    t = WORD_TICK_MS;
    expect(shown(w.apply('keep '))).toBe('keep');
    w.reset();
    expect(w.animating).toBe(false);
    expect(w.apply('keep ')).toBe('keep ');
  });

  it('drives repaints through its frame clock while words wait or fade', async () => {
    const w = make();
    w.record('Hello wor');
    w.apply('Hello wor');
    expect(w.animating).toBe(true);
    await vi.advanceTimersByTimeAsync(40);
    expect(paints).toBeGreaterThan(0);
    w.dispose();
    expect(w.animating).toBe(false);
  });
});
