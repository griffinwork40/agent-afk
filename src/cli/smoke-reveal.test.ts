import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import chalk from 'chalk';
import stringWidth from 'string-width';
import {
  SmokeReveal,
  isSmokeTextEnabled,
  LIFETIME_MS,
  MAX_LAG_MS,
  FRAME_MS,
  SMOKE_GLYPHS,
} from './smoke-reveal.js';
import { segmentAnsi, countVisible } from './smoke-reveal.ansi.js';
import { smokeTone, resetSmokeToneCache } from './smoke-reveal.tones.js';
import { applyTheme } from './theme.js';

const stripAnsi = (s: string): string =>
  s.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\u001b\][^\u0007]*\u0007/g, '');
const hasSmokeGlyph = (s: string): boolean => SMOKE_GLYPHS.some((g) => stripAnsi(s).includes(g));
/** Time after which every recorded character is guaranteed settled. */
const SETTLED = MAX_LAG_MS + LIFETIME_MS + 1;

let savedLevel: typeof chalk.level;
beforeEach(() => {
  savedLevel = chalk.level;
  chalk.level = 3;
  resetSmokeToneCache();
});
afterEach(() => {
  chalk.level = savedLevel;
  resetSmokeToneCache();
  applyTheme('dark');
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

function clockAt(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

describe('segmentAnsi', () => {
  it('round-trips byte-for-byte across SGR, OSC 8, emoji, and combining marks', () => {
    const s = `a\u001b[1mb\u001b[22m \u001b]8;;https://x.y/z\u0007link\u001b]8;;\u0007 😀 e\u0301`;
    const segs = segmentAnsi(s);
    expect(segs.map((x) => x.text).join('')).toBe(s);
    const chars = segs.filter((x) => x.kind === 'char' && !x.ws).map((x) => x.text);
    expect(chars).toEqual(['a', 'b', 'l', 'i', 'n', 'k', '😀', 'e\u0301']);
  });

  it('keeps multi-code-point grapheme clusters (ZWJ, skin tone, flags) as one segment', () => {
    const s = 'a👩‍💻b👍🏽c👨‍👩‍👧🇺🇸';
    const chars = segmentAnsi(s).filter((x) => x.kind === 'char').map((x) => x.text);
    expect(chars).toEqual(['a', '👩‍💻', 'b', '👍🏽', 'c', '👨‍👩‍👧', '🇺🇸']);
    expect(countVisible(s)).toBe(7);
  });

  it('swallows an unterminated OSC so URL bytes never count as visible', () => {
    const segs = segmentAnsi('ok\u001b]8;;https://half');
    expect(segs.filter((x) => x.kind === 'char').map((x) => x.text).join('')).toBe('ok');
  });

  // DCS / APC / PM / SOS — terminated by ST (ESC \), not BEL.
  it('DCS sequence forms one raw segment and contributes zero visible chars', () => {
    // ESC P <payload> ESC \  surrounded by visible text.
    const s = 'a\u001bPq#1oo!\u001b\\b';
    const segs = segmentAnsi(s);
    expect(segs.map((x) => x.text).join('')).toBe(s); // byte-for-byte round-trip
    const rawTexts = segs.filter((x) => x.kind === 'raw').map((x) => x.text);
    // The entire DCS block is a single raw segment.
    expect(rawTexts).toContain('\u001bPq#1oo!\u001b\\');
    const visible = segs.filter((x) => x.kind === 'char' && !x.ws).map((x) => x.text);
    expect(visible).toEqual(['a', 'b']);
  });

  it('APC sequence forms one raw segment and contributes zero visible chars', () => {
    const s = 'x\u001b_some apc data\u001b\\y';
    const segs = segmentAnsi(s);
    expect(segs.map((x) => x.text).join('')).toBe(s); // byte-for-byte round-trip
    const rawTexts = segs.filter((x) => x.kind === 'raw').map((x) => x.text);
    expect(rawTexts).toContain('\u001b_some apc data\u001b\\');
    const visible = segs.filter((x) => x.kind === 'char' && !x.ws).map((x) => x.text);
    expect(visible).toEqual(['x', 'y']);
  });

  it('unterminated DCS swallows the rest and round-trips', () => {
    const s = 'hi\u001bPunterminated payload with no ST';
    const segs = segmentAnsi(s);
    expect(segs.map((x) => x.text).join('')).toBe(s); // byte-for-byte round-trip
    const visible = segs.filter((x) => x.kind === 'char' && !x.ws).map((x) => x.text);
    expect(visible).toEqual(['h', 'i']); // payload bytes must not be visible
  });

  it('DCS does NOT treat BEL as a terminator (only ST ends it)', () => {
    // BEL inside a DCS payload should be swallowed, not terminate the sequence.
    const s = '\u001bPdata\u0007more\u001b\\after';
    const segs = segmentAnsi(s);
    expect(segs.map((x) => x.text).join('')).toBe(s); // byte-for-byte round-trip
    const rawTexts = segs.filter((x) => x.kind === 'raw').map((x) => x.text);
    // The whole DCS including BEL and payload-after-BEL is one raw block.
    expect(rawTexts).toContain('\u001bPdata\u0007more\u001b\\');
    const visible = segs.filter((x) => x.kind === 'char' && !x.ws).map((x) => x.text);
    expect(visible).toEqual(['a', 'f', 't', 'e', 'r']); // only chars after ST
  });

  it('countVisible ignores whitespace and zero-width marks', () => {
    expect(countVisible('  ab c\n\td\u0301 ')).toBe(4);
  });
});

describe('SmokeReveal', () => {
  it('returns the same string reference when nothing has been recorded', () => {
    const r = new SmokeReveal(() => {}, clockAt().now);
    const s = 'hello world';
    expect(r.apply(s)).toBe(s);
  });

  it('shows the newest characters as smoke and leaves settled text untouched', () => {
    const c = clockAt();
    const r = new SmokeReveal(() => {}, c.now);
    r.record('Settled prefix. ');
    c.advance(SETTLED);
    r.record('fresh');
    c.advance(40);
    const out = r.apply('Settled prefix. fresh');
    expect(stripAnsi(out).startsWith('Settled prefix. ')).toBe(true);
    expect(stripAnsi(out)).not.toContain('fresh');
    expect(hasSmokeGlyph(out)).toBe(true);
    r.dispose();
  });

  it('settles back to the exact input once every character has aged out', () => {
    const c = clockAt();
    const r = new SmokeReveal(() => {}, c.now);
    r.record('abc def');
    c.advance(SETTLED);
    const s = '\u001b[1mabc\u001b[22m def';
    expect(r.apply(s)).toBe(s);
  });

  it('uses only glyphs that stay 1 column even on ambiguous-wide terminals', () => {
    // East-Asian-Width Ambiguous glyphs (e.g. U+00B7) render 2 columns when a
    // terminal treats ambiguous characters as double-width.
    for (const g of SMOKE_GLYPHS) {
      expect(stringWidth(g), g).toBe(1);
      expect(stringWidth(g, { ambiguousIsNarrow: false }), g).toBe(1);
    }
  });

  it('never changes the rendered column width at any point in the fade', () => {
    const c = clockAt();
    const r = new SmokeReveal(() => {}, c.now);
    const text = 'wide 漢字 and emoji 😀 👩‍💻 👍🏽 👨‍👩‍👧 plus \u001b[1mbold\u001b[22m tail';
    r.record(stripAnsi(text));
    for (let t = 0; t <= SETTLED; t += 11) {
      expect(stringWidth(r.apply(text)), `t=${t}`).toBe(stringWidth(text));
      c.advance(11);
    }
    r.dispose();
  });

  it('staggers a burst so its first character appears before its last', () => {
    const c = clockAt();
    const r = new SmokeReveal(() => {}, c.now);
    r.record('abcdefghijklmnopqrst');
    c.advance(5);
    const plain = stripAnsi(r.apply('abcdefghijklmnopqrst'));
    // Oldest is already a speck. The youngest are not born yet (held blank).
    expect(plain[0]).not.toBe(' ');
    expect(plain.endsWith(' ')).toBe(true);
    r.dispose();
  });

  it('caps reveal lag: a huge chunk is fully visible (as letters) within MAX_LAG_MS + LIFETIME_MS', () => {
    const c = clockAt();
    const r = new SmokeReveal(() => {}, c.now);
    const big = 'x'.repeat(2_000);
    r.record(big);
    c.advance(MAX_LAG_MS + LIFETIME_MS);
    expect(r.apply(big)).toBe(big);
  });

  it('keeps births monotonic when a second burst arrives mid-stagger', () => {
    const c = clockAt();
    const r = new SmokeReveal(() => {}, c.now);
    r.record('aaaaaaaaaa');
    c.advance(10);
    r.record('bbbbbbbbbb');
    c.advance(1);
    const plain = stripAnsi(r.apply('aaaaaaaaaabbbbbbbbbb'));
    // No 'b' may be revealed (non-blank) while an earlier 'a' is still unborn.
    const firstBlank = plain.indexOf(' ');
    expect(firstBlank).toBeGreaterThan(-1);
    expect(plain.slice(firstBlank).trim()).toBe('');
    r.dispose();
  });

  it('drives its own repaints while animating and stops once settled', () => {
    vi.useFakeTimers();
    const repaint = vi.fn();
    const c = clockAt();
    const r = new SmokeReveal(repaint, c.now);
    r.record('hello');
    r.apply('hello');
    vi.advanceTimersByTime(FRAME_MS);
    expect(repaint).toHaveBeenCalledTimes(1);
    // Simulate the owner repainting after full settle: no further ticks.
    c.advance(SETTLED);
    r.apply('hello');
    vi.advanceTimersByTime(FRAME_MS * 5);
    expect(repaint).toHaveBeenCalledTimes(1);
  });

  it('reset() cancels a pending tick and forgets history', () => {
    vi.useFakeTimers();
    const repaint = vi.fn();
    const r = new SmokeReveal(repaint, clockAt().now);
    r.record('hello');
    r.apply('hello');
    r.reset();
    vi.advanceTimersByTime(FRAME_MS * 3);
    expect(repaint).not.toHaveBeenCalled();
    expect(r.apply('hello')).toBe('hello');
  });

  it('ignores whitespace-only chunks', () => {
    const r = new SmokeReveal(() => {}, clockAt().now);
    r.record('   \n\n ');
    expect(r.apply('abc')).toBe('abc');
  });
});

describe('isSmokeTextEnabled', () => {
  it('is off by default', () => {
    vi.stubEnv('AFK_SMOKE_TEXT', '');
    expect(isSmokeTextEnabled()).toBe(false);
  });

  it('turns on with an explicit enable value on a 256-color or better terminal', () => {
    vi.stubEnv('AFK_SMOKE_TEXT', 'on');
    vi.stubEnv('AFK_PLAIN_OUTPUT', '');
    chalk.level = 2;
    expect(isSmokeTextEnabled()).toBe(true);
  });

  it('stays off for explicit-disable and garbage values', () => {
    for (const v of ['0', 'false', 'off', 'maybe']) {
      vi.stubEnv('AFK_SMOKE_TEXT', v);
      expect(isSmokeTextEnabled(), v).toBe(false);
    }
  });

  it('stays off on 16-color / no-color terminals and in plain-output mode', () => {
    vi.stubEnv('AFK_SMOKE_TEXT', '1');
    vi.stubEnv('AFK_PLAIN_OUTPUT', '');
    chalk.level = 1;
    expect(isSmokeTextEnabled()).toBe(false);
    chalk.level = 0;
    expect(isSmokeTextEnabled()).toBe(false);
    chalk.level = 3;
    vi.stubEnv('AFK_PLAIN_OUTPUT', '1');
    expect(isSmokeTextEnabled()).toBe(false);
  });
});

describe('smokeTone', () => {
  it('ramps from near-background to near-foreground and follows the active theme', () => {
    applyTheme('dark');
    const darkFaint = smokeTone(0)('x');
    const darkBright = smokeTone(1)('x');
    expect(darkFaint).not.toBe(darkBright);
    applyTheme('light');
    expect(smokeTone(0)('x')).not.toBe(darkFaint);
  });

  it('clamps out-of-range progress', () => {
    expect(smokeTone(-5)('x')).toBe(smokeTone(0)('x'));
    expect(smokeTone(9)('x')).toBe(smokeTone(1)('x'));
  });
});
