/**
 * Pure render helpers for the inline autocomplete dropdown.
 *
 * These functions produce ANSI-decorated strings; they do not write to
 * stdout. The raw-mode reader is responsible for placing them on screen
 * and tracking the row count for redraw.
 */

import stringWidth from 'string-width';
import { palette } from '../palette.js';
import type { Candidate, Trigger } from './types.js';

/**
 * Truncate text to fit within max width, preserving string-width semantics.
 */
export function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return '';
  let width = 0;
  for (let i = 0; i < text.length; i++) {
    width += stringWidth(text[i]!);
    if (width > maxWidth) {
      return text.slice(0, i) + palette.dim('…');
    }
  }
  return text;
}

/**
 * Format a single dropdown row with selection marker and optional summary.
 */
export function formatDropdownRow(
  candidate: Candidate,
  isSelected: boolean,
  maxWidth: number,
  triggerKind?: Trigger['kind'],
): string {
  const marker = isSelected ? '>' : ' ';
  const main = candidate.value;
  const summary = candidate.summary ? `  ${candidate.summary}` : '';
  const combined = `${main}${summary}`;
  const truncated = truncateToWidth(combined, maxWidth - 4);

  const row = `  ${marker} ${truncated}`;
  // Single muted base tone across trigger kinds. The earlier yellow accent for
  // flag rows clashed with the cyan inverse on the selected row and the orange
  // brand prompt above the dropdown — uniform gray reads as a quiet menu chrome
  // and lets the selection highlight be the only thing competing for attention.
  void triggerKind;
  return isSelected ? palette.inverse(palette.user(row)) : palette.meta(row);
}

/**
 * Format a single-line tooltip row shown beneath the dropdown for the
 * currently-selected candidate. Renders nothing if the hint is empty.
 *
 * The "↳" glyph visually ties the tooltip to the highlighted dropdown row
 * above. The whole row is dimmed so it never competes with the prompt or
 * with the highlighted candidate for visual weight.
 */
export function formatHintRow(hint: string | undefined, maxWidth: number): string | null {
  if (!hint) return null;
  const trimmed = hint.trim();
  if (trimmed.length === 0) return null;
  // Fixed chrome: 4 leading spaces + "↳ " prefix = 6 cols. `truncateToWidth`
  // can overshoot its budget by 1 col when it appends `…`, so subtract a 7th
  // column from the body budget to guarantee the full row fits in `maxWidth`.
  const body = truncateToWidth(trimmed, Math.max(0, maxWidth - 7));
  if (body.length === 0) return null;
  return palette.dim(`    ↳ ${body}`);
}
