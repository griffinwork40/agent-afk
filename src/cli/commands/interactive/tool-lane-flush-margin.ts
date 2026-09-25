/**
 * Content-centering helpers for the ToolLane output paths.
 *
 * Extracted from `tool-lane.ts` to keep that file under the 350-code-line
 * ratchet. Both functions are pure with respect to the centering decision —
 * they delegate the margin computation to `contentMargin()` in
 * `src/cli/render/measure.ts`, which reads `AFK_CENTER_CONTENT` at call time.
 */

import { truncateDisplayWidth } from '../../display.js';
import { contentMargin } from '../../render/measure.js';
import { getTerminalWidth } from '../../terminal-size.js';

/**
 * Join assembled overlay lines into a single string, applying the
 * `AFK_CENTER_CONTENT` left margin when centering is active.
 *
 * On wide terminals with centering enabled, each line is prepended with
 * the margin and clamped to the terminal width so the overlay never wraps.
 * On narrow terminals or when centering is off, lines are joined with `\n`
 * directly — a no-op pass.
 *
 * Called at the end of {@link ToolLane.getOverlay} after all lines have been
 * assembled, so the margin is applied uniformly to every pushed line
 * (including those from `renderOverlayChildren`).
 */
export function joinOverlayLines(lines: string[]): string {
  const pad = contentMargin();
  if (pad.length > 0) {
    const tw = getTerminalWidth();
    return lines
      .map((line) => truncateDisplayWidth(pad + line, tw))
      .join('\n');
  }
  return lines.join('\n');
}

