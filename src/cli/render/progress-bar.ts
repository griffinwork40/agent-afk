import { palette } from '../palette.js';

// ─── Progress Bar ────────────────────────────────────────────────────────────

/**
 * Render a Unicode block progress bar.
 *
 * @param ratio - Completion ratio between 0 and 1.
 * @param width - Character width of the bar (default 30).
 */
export function progressBar(ratio: number, width: number = 30): string {
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  return (
    palette.success('█'.repeat(filled)) +
    palette.dim('░'.repeat(empty)) +
    palette.dim(` ${Math.round(ratio * 100)}%`)
  );
}
