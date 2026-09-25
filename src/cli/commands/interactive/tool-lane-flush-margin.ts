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
 * Visual indent prepended to every tool-lane line (overlay and scrollback)
 * when content centering is active. Aligns the tree glyphs (◉, ●, ├─) with
 * the progress-banner and stage-rail surfaces, which also use a 2-space
 * lead. Prose uses a 3-space markdown indent — the 1-space gap between 2
 * and 3 is barely perceptible and helps distinguish "the agent is talking"
 * from "the agent is working."
 */
const TOOL_LANE_INDENT = '  ';

/**
 * Join assembled overlay lines into a single string, applying the
 * `AFK_CENTER_CONTENT` left margin and a 2-space visual indent when
 * centering is active.
 *
 * On wide terminals with centering enabled, each line is prepended with
 * the margin + indent and clamped to the terminal width so the overlay
 * never wraps. On narrow terminals or when centering is off, lines are
 * joined with `\n` directly — a no-op pass.
 *
 * Called at the end of {@link ToolLane.getOverlay} after all lines have been
 * assembled, so the margin is applied uniformly to every pushed line
 * (including those from `renderOverlayChildren`).
 *
 * ### Width invariant (no double-clamp)
 *
 * Each incoming `line` was already clamped by `renderToolLaneOverlay` to
 * `cols = toolLaneWidth() = capToMeasure(tw)` before being passed here.
 * The `truncateDisplayWidth(prefix + line, tw)` guard below is therefore a
 * safety net, not a meaningful truncation:
 *
 * - When centering is active (`pad.length > 0`), `contentMargin()` returns
 *   `Math.floor((tw - measure) / 2)` spaces, where `measure =
 *   resolveTextMeasure()`. The prefix width is `margin + 2` (TOOL_LANE_INDENT).
 *   Each line is already clamped to `min(tw, measure)`. Therefore:
 *   `prefix.length + line.length = margin + 2 + min(tw, measure)
 *   = (tw - measure)/2 + 2 + measure = (tw + measure)/2 + 2`.
 *   For the default `measure = 100` on a 200-column terminal:
 *   `(200 + 100)/2 + 2 = 152 ≤ 200 = tw`. The clamp is a no-op.
 *
 * - When `AFK_TEXT_MEASURE=off` (`resolveTextMeasure()` returns `null`),
 *   `contentMargin()` uses `measure = tw`, giving `margin = 0` and an empty
 *   `pad` — so this branch is never entered. The double-clamp scenario is
 *   therefore unreachable: centering implies a finite measure, a finite
 *   measure keeps `prefix + line ≤ tw`, so the guard never fires.
 *
 * The `truncateDisplayWidth` call is kept as a hard terminal-wrap safety net
 * for any future change to the width pipeline that might violate the invariant.
 */
export function joinOverlayLines(lines: string[]): string {
  const pad = contentMargin();
  if (pad.length > 0) {
    const tw = getTerminalWidth();
    const prefix = pad + TOOL_LANE_INDENT;
    return lines
      .map((line) => line.length === 0 ? '' : truncateDisplayWidth(prefix + line, tw))
      .join('\n');
  }
  return lines.join('\n');
}

/**
 * Add the 2-space visual indent to tool-lane lines destined for scrollback
 * when content centering is active. The committed-band paint path adds
 * `contentMargin()` at paint time, so this only prepends the indent — not
 * the full margin.
 *
 * Returns the input array unchanged when centering is off.
 */
export function indentForScrollback(lines: readonly string[]): readonly string[] {
  if (contentMargin().length === 0) return lines;
  return lines.map(l => l === '' ? l : TOOL_LANE_INDENT + l);
}

