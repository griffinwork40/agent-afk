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
  // Selection style mirrors the arrow-key picker (src/cli/render/picker.ts):
  // a brand-orange marker + bold label, NOT a reverse-video fill band. Cyan is
  // reserved for user identity only (see palette.ts) — the previous
  // `inverse(user(...))` borrowed it for menu chrome, which both broke that
  // rule and diverged from the picker's selection idiom. Unselected rows stay
  // uniform muted gray so the selected row is the only thing competing for
  // attention; the earlier per-trigger-kind yellow accent was dropped for the
  // same salience reason.
  void triggerKind;
  return isSelected
    ? `  ${palette.brand(marker)} ${palette.bold(truncated)}`
    : palette.meta(row);
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
