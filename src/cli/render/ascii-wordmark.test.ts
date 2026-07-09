/**
 * Tests for src/cli/render/ascii-wordmark.ts — the block-art wordmark font.
 */

import { describe, it, expect } from 'vitest';
import {
  renderAsciiWordmark,
  asciiWordmarkWidth,
  ASCII_WORDMARK_HEIGHT,
  WORDMARK_TEXT,
} from './ascii-wordmark.js';

describe('renderAsciiWordmark', () => {
  it('renders exactly ASCII_WORDMARK_HEIGHT rows', () => {
    expect(renderAsciiWordmark(WORDMARK_TEXT)).toHaveLength(ASCII_WORDMARK_HEIGHT);
  });

  it('pads every row to the same display width', () => {
    const rows = renderAsciiWordmark(WORDMARK_TEXT);
    const widths = new Set(rows.map((r) => r.length));
    expect(widths.size).toBe(1);
    expect([...widths][0]).toBe(asciiWordmarkWidth(WORDMARK_TEXT));
  });

  it('draws with block glyphs and spaces only (no half-block sprite chars)', () => {
    // The wordmark must not emit ▀/▄ — the banner uses their absence to detect
    // "mascot dropped" in the compact fallback, so a stray half-block here
    // would spoof a sprite. Every non-space cell is a full block.
    const joined = renderAsciiWordmark(WORDMARK_TEXT).join('\n');
    expect(joined).toMatch(/█/);
    expect(joined).not.toMatch(/[▀▄]/);
    expect(joined.replace(/[█ \n]/g, '')).toBe('');
  });

  it('is case-insensitive', () => {
    expect(renderAsciiWordmark('afk')).toEqual(renderAsciiWordmark('AFK'));
  });

  it('renders a word space narrower than a letter (words read apart)', () => {
    // "AGENT AFK" must be wider than "AGENTAFK" by the space glyph + its gaps.
    expect(asciiWordmarkWidth('AGENT AFK')).toBeGreaterThan(asciiWordmarkWidth('AGENTAFK'));
  });

  it('throws on a character with no defined glyph (fail-loud on typos)', () => {
    expect(() => renderAsciiWordmark('AFK!')).toThrow(/no glyph/);
  });
});
