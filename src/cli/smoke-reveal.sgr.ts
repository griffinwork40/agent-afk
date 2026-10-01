/**
 * SGR state tracking for the text reveal mask.
 *
 * The reveal restyles one character at a time in the middle of an already
 * formatted string. To fade a letter INTO its own color (instead of into a
 * generic near-white, which overshoots dim prose and reads as a flash), the
 * mask must know what style is active at that character, and it must restore
 * that exact style afterwards so the next character is untouched.
 *
 * This module is a small, pure SGR interpreter: `applySgr` folds one escape
 * into a state, `serializeSgr` turns a state back into one absolute escape
 * (always starting from a reset, so it is correct regardless of what came
 * before), and `knownFgRgb` reports the foreground as RGB when, and only
 * when, it is exact. Basic 16-color and default foregrounds depend on the
 * terminal's palette, so they report `null` and the caller uses the
 * discovered palette (terminal-colors.ts) or a palette-independent fade
 * instead of guessing a color.
 *
 * @module cli/smoke-reveal.sgr
 */

import chalk from 'chalk';
import type { Rgb } from './smoke-reveal.tones.js';

export interface SgrState {
  /** Foreground params, e.g. ['38','2','r','g','b'] or ['31']; null = terminal default. */
  fg: readonly string[] | null;
  /** Background params, same shape; null = terminal default. */
  bg: readonly string[] | null;
  bold: boolean;
  faint: boolean;
  italic: boolean;
  underline: boolean;
  inverse: boolean;
  strike: boolean;
}

export const EMPTY_SGR: SgrState = Object.freeze({
  fg: null, bg: null, bold: false, faint: false, italic: false, underline: false, inverse: false, strike: false,
});

const SGR_RE = /^\u001b\[([0-9;:]*)m$/;

/** True when `seq` is one complete SGR escape (`ESC [ ... m`). */
export function isSgr(seq: string): boolean {
  return SGR_RE.test(seq);
}

/** Split params, expanding colon sub-params (`38:2::r:g:b`) into the `;` form. */
function params(body: string): string[] {
  if (body === '') return ['0'];
  const out: string[] = [];
  for (const p of body.split(';')) {
    if (!p.includes(':')) {
      out.push(p === '' ? '0' : p);
      continue;
    }
    const parts = p.split(':');
    const head = parts[0] ?? '';
    const mode = parts[1] ?? '';
    // 38:2:<colorspace>:r:g:b has an optional colorspace id; keep the last three.
    if (mode === '2') out.push(head, '2', ...parts.slice(-3));
    else out.push(...parts.filter((x) => x !== ''));
  }
  return out;
}

/** Consume an extended color starting at index `i` (which holds 38 or 48). Returns [tokens, next index]. */
function extendedColor(ps: string[], i: number): [string[] | null, number] {
  const mode = ps[i + 1];
  if (mode === '5' && ps[i + 2] !== undefined) return [[ps[i] ?? '38', '5', ps[i + 2] ?? '0'], i + 3];
  if (mode === '2' && ps[i + 4] !== undefined) {
    return [[ps[i] ?? '38', '2', ps[i + 2] ?? '0', ps[i + 3] ?? '0', ps[i + 4] ?? '0'], i + 5];
  }
  return [null, ps.length];
}

type Flag = 'bold' | 'faint' | 'italic' | 'underline' | 'inverse' | 'strike';
type MutableSgr = { -readonly [K in keyof SgrState]: SgrState[K] };

const FLAG_ON: Readonly<Record<string, Flag>> = {
  '1': 'bold', '2': 'faint', '3': 'italic', '4': 'underline', '7': 'inverse', '9': 'strike',
};
const FLAG_OFF: Readonly<Record<string, readonly Flag[]>> = {
  '22': ['bold', 'faint'], '23': ['italic'], '24': ['underline'], '27': ['inverse'], '29': ['strike'],
};

/** Fold one SGR escape into `state`. Non-SGR input returns `state` unchanged. */
export function applySgr(state: SgrState, seq: string): SgrState {
  const m = SGR_RE.exec(seq);
  if (!m) return state;
  const ps = params(m[1] ?? '');
  let s: MutableSgr = { ...state };
  for (let i = 0; i < ps.length; ) {
    const p = ps[i] ?? '0';
    const n = Number(p);
    const on = FLAG_ON[p];
    const off = FLAG_OFF[p];
    if (n === 0) s = { ...EMPTY_SGR };
    else if (on) s[on] = true;
    else if (off) for (const k of off) s[k] = false;
    else if ((n >= 30 && n <= 37) || (n >= 90 && n <= 97)) s.fg = [p];
    else if (n === 39) s.fg = null;
    else if ((n >= 40 && n <= 47) || (n >= 100 && n <= 107)) s.bg = [p];
    else if (n === 49) s.bg = null;
    else if (n === 38 || n === 48) {
      const [tokens, next] = extendedColor(ps, i);
      if (tokens) {
        if (n === 38) s.fg = tokens;
        else s.bg = tokens;
      }
      i = next;
      continue;
    }
    i++;
  }
  return s;
}

/** Absolute escape for `state` (starts from a reset, so it never depends on prior state). */
export function serializeSgr(state: SgrState, fgOverride?: string): string {
  let out = '\u001b[0';
  if (state.bold) out += ';1';
  if (state.faint) out += ';2';
  if (state.italic) out += ';3';
  if (state.underline) out += ';4';
  if (state.inverse) out += ';7';
  if (state.strike) out += ';9';
  const fg = fgOverride ?? (state.fg ? state.fg.join(';') : '');
  if (fg) out += ';' + fg;
  if (state.bg) out += ';' + state.bg.join(';');
  return out + 'm';
}

/** xterm 256-color cube / greyscale entry as RGB (indices >= 16 only). */
function xterm256(n: number): Rgb | null {
  if (n < 16 || n > 255) return null;
  if (n >= 232) {
    const v = 8 + (n - 232) * 10;
    return [v, v, v];
  }
  const i = n - 16;
  const step = (x: number): number => (x === 0 ? 0 : 55 + x * 40);
  return [step(Math.floor(i / 36)), step(Math.floor(i / 6) % 6), step(i % 6)];
}

/**
 * The foreground as exact RGB, or null when it depends on the terminal's own
 * palette (default fg, basic 16 colors) or is visually swapped (inverse).
 */
export function knownFgRgb(state: SgrState): Rgb | null {
  if (state.inverse || !state.fg) return null;
  const [head, mode, a, b, c] = state.fg;
  if (head !== '38') return null;
  if (mode === '2') return [Number(a), Number(b), Number(c)];
  if (mode === '5') return xterm256(Number(a));
  return null;
}

/**
 * True when the foreground is the terminal's basic white (37 or 97). Its
 * exact RGB belongs to the terminal palette, but every palette keeps it near
 * the brightest text tone, so callers may blend toward the theme's
 * near-foreground (which sits at or just below it) without risking a visible
 * overshoot.
 */
export function isBasicWhite(state: SgrState): boolean {
  if (state.inverse || !state.fg || state.fg.length !== 1) return false;
  return state.fg[0] === '37' || state.fg[0] === '97';
}

/**
 * Palette index (0-15) of a basic foreground (30-37, 90-97, or 38;5;n with
 * n < 16), or null. Its RGB belongs to the terminal, so callers look it up in
 * the discovered palette (terminal-colors.ts) rather than guessing.
 */
export function paletteIndex(state: SgrState): number | null {
  if (state.inverse || !state.fg) return null;
  const [head, mode, n] = state.fg;
  if (state.fg.length === 1) {
    const code = Number(head);
    if (code >= 30 && code <= 37) return code - 30;
    if (code >= 90 && code <= 97) return code - 90 + 8;
    return null;
  }
  if (head === '38' && mode === '5' && Number(n) < 16) return Number(n);
  return null;
}

/** Nearest xterm-256 index for an RGB color (same mapping chalk uses). */
export function rgbToAnsi256(r: number, g: number, b: number): number {
  if (r === g && g === b) {
    if (r < 8) return 16;
    if (r > 248) return 231;
    return Math.round(((r - 8) / 247) * 24) + 232;
  }
  const q = (x: number): number => Math.round((x / 255) * 5);
  return 16 + 36 * q(r) + 6 * q(g) + q(b);
}

/** SGR foreground params for `rgb` at the active chalk color level. */
export function fgParams(rgb: Rgb): string {
  const [r, g, b] = rgb.map((x) => Math.min(255, Math.max(0, Math.round(x)))) as [number, number, number];
  return chalk.level >= 3 ? `38;2;${r};${g};${b}` : `38;5;${rgbToAnsi256(r, g, b)}`;
}

/** Linear blend of two colors at `t` in [0, 1]. */
export function mixRgb(a: Rgb, b: Rgb, t: number): Rgb {
  const c = Math.min(1, Math.max(0, t));
  return [a[0] + (b[0] - a[0]) * c, a[1] + (b[1] - a[1]) * c, a[2] + (b[2] - a[2]) * c];
}
