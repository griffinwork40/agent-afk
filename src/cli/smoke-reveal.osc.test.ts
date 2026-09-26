/**
 * Extra tests for OSC sequences >254 bytes (issue #2246).
 * Kept in a separate file to stay under the 350-LOC limit for
 * smoke-reveal.test.ts while covering the new uncapped OSC scan behaviour.
 */

import { describe, it, expect } from 'vitest';
import { segmentAnsi } from './smoke-reveal.ansi.js';
import {
  SmokeReveal,
  LIFETIME_MS,
  MAX_LAG_MS,
} from './smoke-reveal.js';

const ESC = '\u001b';
const BEL = '\u0007';
const ST = `${ESC}\\`;
const SETTLED = MAX_LAG_MS + LIFETIME_MS + 1;

function clockAt(start = 1_000): { now: () => number; advance: (ms: number) => void } {
  let t = start;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/** Build a 300-byte OSC 8 URL payload terminated by BEL. */
function longOscBEL(): string {
  // ESC ] 8 ; ; <url of 280+ chars> BEL
  // Total: 2 (ESC ]) + 3 (8;;) + 280 ('a'.repeat) + 1 (BEL) = 286 bytes.
  const url = 'https://example.com/' + 'a'.repeat(260);
  return `${ESC}]8;;${url}${BEL}`;
}

/** Build the equivalent sequence terminated by ST (ESC \). */
function longOscST(): string {
  const url = 'https://example.com/' + 'a'.repeat(260);
  return `${ESC}]8;;${url}${ST}`;
}

describe('segmentAnsi — long OSC sequences (issue #2246)', () => {
  it('300-byte OSC 8 URL with BEL is a single raw segment (round-trip + no visible chars)', () => {
    const osc = longOscBEL();
    const trailing = 'click here';
    const input = osc + trailing;

    // Sanity: the OSC payload is definitely >254 bytes.
    expect(osc.length).toBeGreaterThan(256);

    const segs = segmentAnsi(input);

    // Round-trip must be byte-identical.
    expect(segs.map((x) => x.text).join('')).toBe(input);

    // The OSC block must appear as exactly ONE raw segment.
    const rawSegs = segs.filter((x) => x.kind === 'raw');
    expect(rawSegs.some((r) => r.text === osc),
      'OSC should be one raw segment byte-identical to the input OSC').toBe(true);

    // Visible chars come only from the trailing text, not from inside the OSC.
    const visible = segs.filter((x) => x.kind === 'char' && !x.ws).map((x) => x.text);
    expect(visible).toEqual([...'clickhere'].map((c) => c)); // 'click here' without space
    expect(visible.join('')).toBe('clickhere');
  });

  it('300-byte OSC 8 URL with ST terminator is a single raw segment (round-trip + no visible chars)', () => {
    const osc = longOscST();
    const trailing = 'link text';
    const input = osc + trailing;

    expect(osc.length).toBeGreaterThan(256);

    const segs = segmentAnsi(input);

    // Round-trip.
    expect(segs.map((x) => x.text).join('')).toBe(input);

    // OSC is one raw segment.
    const rawSegs = segs.filter((x) => x.kind === 'raw');
    expect(rawSegs.some((r) => r.text === osc),
      'OSC with ST terminator should be one raw segment').toBe(true);

    // Only trailing text is visible.
    const visible = segs.filter((x) => x.kind === 'char' && !x.ws).map((x) => x.text);
    expect(visible.join('')).toBe('linktext');
  });

  it('smoke mask: output contains the long OSC byte-identical and only trailing text is masked', () => {
    const c = clockAt();
    const r = new SmokeReveal(() => {}, c.now);

    const osc = longOscBEL();
    const trailing = 'hello';
    const full = osc + trailing;

    // Record only the trailing visible text — the OSC has no visible chars
    // so record() sees it as zero visible graphemes and ignores it.
    r.record(trailing);

    // While the trailing text is still fresh (smoke phase), apply the mask.
    c.advance(10);
    const out = r.apply(full);

    // The OSC block must be present in the output byte-identical.
    expect(out.includes(osc),
      'OSC must appear byte-identical in masked output — no ESC[0m injected inside it').toBe(true);

    // The trailing text should be masked (hidden behind smoke), so it should
    // NOT appear as its plain letters in the output.
    const oscEnd = out.indexOf(osc) + osc.length;
    const tail = out.slice(oscEnd);
    expect(tail).not.toBe(trailing);
    expect(tail.length).toBeGreaterThan(0); // some replacement output exists

    r.dispose();
  });

  it('unterminated long OSC (>254 bytes, no BEL/ST) still becomes a 2-byte literal', () => {
    // A streaming chunk boundary mid-OSC: no terminator present.
    const payload = '8;;https://example.com/' + 'a'.repeat(260);
    const s = `${ESC}]${payload}`;

    const segs = segmentAnsi(s);

    // Round-trip.
    expect(segs.map((x) => x.text).join('')).toBe(s);

    // ESC ] appears as a 2-byte raw literal.
    const rawSegs = segs.filter((x) => x.kind === 'raw');
    expect(rawSegs.some((r) => r.text === `${ESC}]`),
      'unterminated OSC must produce a 2-byte ESC ] raw literal').toBe(true);

    // Payload bytes after ESC ] must be emitted as char segments (not swallowed).
    const chars = segs.filter((x) => x.kind === 'char' && !x.ws);
    expect(chars.length, 'payload chars must not be swallowed for unterminated OSC').toBeGreaterThan(0);
  });
});
