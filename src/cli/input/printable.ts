import { nextGraphemeIndex } from '../display.js';

/**
 * True when `s` is a single printable grapheme cluster (one visual character):
 * not a control char (< ' '), and exactly one grapheme — so multi-UTF-16-unit
 * emoji (surrogate pairs, variation selectors, skin-tone modifiers) count as
 * one printable character, while escape sequences and multi-char fragments are
 * rejected. Replaces the old `s.length === 1` UTF-16 code-unit test that
 * silently dropped all astral / composed emoji.
 *
 * Single source of truth shared by both input surfaces — the live
 * TerminalCompositor (`handlePrintable`) and the legacy/non-TTY
 * `readWithAutocompleteTty` reader — so the printable-char admission rule
 * cannot drift between them (the reader previously carried the stale
 * `length === 1` test and dropped emoji on the fallback path).
 */
export function isPrintableGrapheme(s: string): boolean {
  return s >= ' ' && nextGraphemeIndex(s, 0) === s.length;
}
