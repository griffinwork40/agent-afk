/**
 * The text-reveal seam `StreamingMarkdownRenderer` (markdown-stream.ts)
 * drives, and the factory that picks an implementation from the env:
 *  - `WordReveal` (word-reveal.ts) when `AFK_WORD_TEXT=1`: whole words at a
 *    steady cadence with a short fade, for reading along live.
 *  - `SmokeReveal` (smoke-reveal.ts) otherwise: per-character smoke, or ink
 *    with `AFK_SMOKE_TEXT=0`, plus the heading accent with `AFK_SMOKE_TEXT=1`.
 *
 * `AFK_INK_TEXT=0` turns every reveal off. Reduced motion is checked by the
 * caller, which owns that option.
 *
 * @module cli/text-reveal
 */

import {
  SmokeReveal,
  defaultRevealStyle,
  isInkTextEnabled,
  isSmokeTextEnabled,
  type ApplyOptions,
  type RecordOptions,
} from './smoke-reveal.js';
import { WordReveal, isWordTextEnabled } from './word-reveal.js';

/** The members markdown-stream.ts uses; see smoke-reveal.ts for each contract. */
export interface TextReveal {
  record(chunk: string, opts?: RecordOptions): void;
  apply(formatted: string, opts?: ApplyOptions): string;
  smokeHoldRemaining(): number;
  revealHoldRemaining(d?: number): number;
  noteCommit(): void;
  forgetNewest(count: number): void;
  markDirty(): void;
  readonly animating: boolean;
  reset(): void;
  dispose(): void;
}

/**
 * The reveal for a new renderer, or null when every reveal is off. `accent`
 * is true when the smoke heading accent (and its heading hold) is active.
 */
export function createTextReveal(paint: () => void): { reveal: TextReveal; accent: boolean } | null {
  const accent = isSmokeTextEnabled();
  if (!isInkTextEnabled() && !accent) return null;
  if (isWordTextEnabled()) return { reveal: new WordReveal(paint), accent: false };
  const style = defaultRevealStyle();
  return { reveal: new SmokeReveal(paint, Date.now, { prose: style, headings: accent ? 'smoke' : style }), accent };
}
