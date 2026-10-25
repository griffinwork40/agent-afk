/**
 * SGR-subset ANSI→React element renderer.
 *
 * Supports:
 *   SGR 0,1,2,3,4,22,23,24          — reset, bold, dim, italic, underline
 *   SGR 30–37, 39                    — standard foreground colors
 *   SGR 40–47, 49                    — standard background colors
 *   SGR 90–97                        — bright foreground colors
 *   SGR 100–107                      — bright background colors
 *   SGR 38;5;n / 48;5;n             — 8-bit palette colors
 *   SGR 38;2;r;g;b / 48;2;r;g;b    — 24-bit true colors
 *   OSC 8 ;;url BEL text OSC 8 ;; BEL — hyperlinks
 *
 * Unknown/unsupported sequences are stripped silently.
 * No dangerouslySetInnerHTML — returns a React element array.
 */

import { createElement, type ReactElement } from 'react';

// ---------------------------------------------------------------------------
// Color name maps
// ---------------------------------------------------------------------------

const FG_NAMES: Record<number, string> = {
  30: 'black', 31: 'red', 32: 'green', 33: 'yellow',
  34: 'blue', 35: 'magenta', 36: 'cyan', 37: 'white',
  90: 'bright-black', 91: 'bright-red', 92: 'bright-green', 93: 'bright-yellow',
  94: 'bright-blue', 95: 'bright-magenta', 96: 'bright-cyan', 97: 'bright-white',
};

const BG_NAMES: Record<number, string> = {
  40: 'black', 41: 'red', 42: 'green', 43: 'yellow',
  44: 'blue', 45: 'magenta', 46: 'cyan', 47: 'white',
  100: 'bright-black', 101: 'bright-red', 102: 'bright-green', 103: 'bright-yellow',
  104: 'bright-blue', 105: 'bright-magenta', 106: 'bright-cyan', 107: 'bright-white',
};

// 8-bit palette: index 0–15 map to named ANSI colors
const PALETTE_FG: Record<number, string> = {
  0: 'black', 1: 'red', 2: 'green', 3: 'yellow',
  4: 'blue', 5: 'magenta', 6: 'cyan', 7: 'white',
  8: 'bright-black', 9: 'bright-red', 10: 'bright-green', 11: 'bright-yellow',
  12: 'bright-blue', 13: 'bright-magenta', 14: 'bright-cyan', 15: 'bright-white',
};

// ---------------------------------------------------------------------------
// Style state
// ---------------------------------------------------------------------------

interface Style {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: boolean;
  fg: string | null;   // CSS color string or named class token
  bg: string | null;
  fgClass: string | null; // 'ansi-fg-red' etc.
  bgClass: string | null;
}

function emptyStyle(): Style {
  return { bold: false, dim: false, italic: false, underline: false, fg: null, bg: null, fgClass: null, bgClass: null };
}

// ---------------------------------------------------------------------------
// 8-bit color helpers
// ---------------------------------------------------------------------------

function palette8Fg(n: number): { cls: string | null; color: string | null } {
  if (n < 16) return { cls: `ansi-fg-${PALETTE_FG[n] ?? 'white'}`, color: null };
  if (n < 232) {
    const idx = n - 16;
    const b = idx % 6, g = Math.floor(idx / 6) % 6, r = Math.floor(idx / 36);
    const v = (x: number) => x === 0 ? 0 : 55 + x * 40;
    return { cls: null, color: `rgb(${v(r)},${v(g)},${v(b)})` };
  }
  const gray = 8 + (n - 232) * 10;
  return { cls: null, color: `rgb(${gray},${gray},${gray})` };
}

function palette8Bg(n: number): { cls: string | null; color: string | null } {
  const { cls, color } = palette8Fg(n);
  return { cls: cls ? cls.replace('ansi-fg-', 'ansi-bg-') : null, color };
}

// ---------------------------------------------------------------------------
// SGR parser
// ---------------------------------------------------------------------------

function applySgr(params: number[], style: Style): void {
  let i = 0;
  while (i < params.length) {
    const p = params[i]!;
    if (p === 0) { Object.assign(style, emptyStyle()); }
    else if (p === 1) { style.bold = true; }
    else if (p === 2) { style.dim = true; }
    else if (p === 3) { style.italic = true; }
    else if (p === 4) { style.underline = true; }
    else if (p === 22) { style.bold = false; style.dim = false; }
    else if (p === 23) { style.italic = false; }
    else if (p === 24) { style.underline = false; }
    else if (p in FG_NAMES) { style.fgClass = `ansi-fg-${FG_NAMES[p]}`; style.fg = null; }
    else if (p === 39) { style.fg = null; style.fgClass = null; }
    else if (p in BG_NAMES) { style.bgClass = `ansi-bg-${BG_NAMES[p]}`; style.bg = null; }
    else if (p === 49) { style.bg = null; style.bgClass = null; }
    else if (p === 38) {
      if (params[i + 1] === 5 && i + 2 < params.length) {
        const { cls, color } = palette8Fg(params[i + 2]!);
        style.fgClass = cls; style.fg = color; i += 2;
      } else if (params[i + 1] === 2 && i + 4 < params.length) {
        style.fg = `rgb(${params[i+2]},${params[i+3]},${params[i+4]})`; style.fgClass = null; i += 4;
      }
    } else if (p === 48) {
      if (params[i + 1] === 5 && i + 2 < params.length) {
        const { cls, color } = palette8Bg(params[i + 2]!);
        style.bgClass = cls; style.bg = color; i += 2;
      } else if (params[i + 1] === 2 && i + 4 < params.length) {
        style.bg = `rgb(${params[i+2]},${params[i+3]},${params[i+4]})`; style.bgClass = null; i += 4;
      }
    }
    i++;
  }
}

// ---------------------------------------------------------------------------
// Span builder
// ---------------------------------------------------------------------------

function buildSpan(text: string, style: Style, key: number): ReactElement {
  const classes: string[] = [];
  const cssStyle: Record<string, string> = {};

  if (style.bold) classes.push('ansi-bold');
  if (style.dim) classes.push('ansi-dim');
  if (style.italic) classes.push('ansi-italic');
  if (style.underline) classes.push('ansi-underline');
  if (style.fgClass) classes.push(style.fgClass);
  if (style.bgClass) classes.push(style.bgClass);
  if (style.fg) cssStyle['color'] = style.fg;
  if (style.bg) cssStyle['backgroundColor'] = style.bg;

  const props: Record<string, unknown> = { key };
  if (classes.length) props['className'] = classes.join(' ');
  if (Object.keys(cssStyle).length) props['style'] = cssStyle;

  return createElement('span', props, text);
}

// ---------------------------------------------------------------------------
// Main renderer
// ---------------------------------------------------------------------------

/**
 * Render ANSI-escaped text as a React element containing styled spans.
 * Falls back to a plain `<span>{text}</span>` on any parse error.
 */
export function renderAnsi(ansi: string): ReactElement {
  try {
    return createElement('span', null, ..._parseAnsi(ansi));
  } catch {
    return createElement('span', null, ansi);
  }
}

function _parseAnsi(ansi: string): ReactElement[] {
  const elements: ReactElement[] = [];
  let key = 0;
  let style = emptyStyle();

  // Matches (in priority order):
  //   1. SGR:   ESC [ <params> m
  //   2. OSC 8: ESC ] 8 ; ; <url> BEL <text> ESC ] 8 ; ; BEL   (BEL or ST terminator)
  //   3. Any other CSI sequence: ESC [ ... <final byte 0x40-0x7E>
  //   4. Any other OSC sequence: ESC ] ... BEL-or-ST
  //   5. Other 2-byte ESC sequences
  const RE =
    /\x1b\[([0-9;]*)m|\x1b\]8;;([^\x07\x1b]*)(?:\x07|\x1b\\)([^\x1b]*)(?:\x1b\]8;;(?:\x07|\x1b\\))?|\x1b\[[0-9;]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b./g;

  let lastIndex = 0;

  for (const match of ansi.matchAll(RE)) {
    const matchStart = match.index!;

    // Flush plain text before this match
    if (matchStart > lastIndex) {
      const text = ansi.slice(lastIndex, matchStart);
      elements.push(buildSpan(text, style, key++));
    }

    const [full, sgrParams, oscUrl, oscText] = match;

    if (sgrParams !== undefined) {
      // SGR sequence
      const params = sgrParams === '' ? [0] : sgrParams.split(';').map(Number);
      applySgr(params, style);
    } else if (oscUrl !== undefined && oscText !== undefined) {
      // OSC 8 hyperlink
      if (/^https?:\/\//i.test(oscUrl) && oscText) {
        elements.push(
          createElement('a', { key: key++, href: oscUrl, rel: 'noopener noreferrer', target: '_blank' }, oscText),
        );
      } else if (oscText) {
        elements.push(buildSpan(oscText, style, key++));
      }
    }
    // Unknown escape sequences: skip (strip silently)

    lastIndex = matchStart + full.length;
  }

  // Flush remaining text
  if (lastIndex < ansi.length) {
    elements.push(buildSpan(ansi.slice(lastIndex), style, key++));
  }

  return elements;
}
