/**
 * Formats a buffered thinking stream as a wrapped, soft-capped paragraph for
 * the live overlay in `'live'` mode.
 *
 * Lifecycle (in `setComposedOverlay`):
 *   ThinkingLane.peek() → formatThinkingParagraph → string suitable for
 *   `compositor.setOverlay` (joined by '\n' with the other overlay parts).
 *
 * Visual identity carries across the stream → collapsed transition:
 *   - the header `◆ thinking` uses the same `◆` glyph + mauve italic as the
 *     post-turn summary line `◆ thought for Xs · N tok` emitted by
 *     {@link ThinkingLane.collapse};
 *   - the `⋯ +N chars earlier` truncation footer uses `palette.dim` (no
 *     italic) so it reads as scaffolding, not reasoning.
 *
 * Replaces the previous trailing-80-codepoint single-line preview at
 * `setComposedOverlay` (commit 8664d4b era). The single-line tail was an
 * artifact of the pre-compositor era where each repaint clobbered exactly
 * one row; with `TerminalCompositor.setOverlay` repainting any multi-line
 * string through `log-update`, a multi-line paragraph costs the same and
 * reads dramatically better.
 *
 * The paragraph cap is intentional — without it, a 30-second chain of
 * thought would dominate the overlay region and push the tool lane and
 * progress banner off-screen.
 *
 * @module cli/commands/interactive/thinking-paragraph
 */

import wrapAnsi from 'wrap-ansi';
import { palette } from '../../palette.js';

const HEADER = '◆ thinking';
const INDENT = '  ';
const DEFAULT_MAX_BODY_LINES = 5;
/**
 * Floor on body width so a 20-col terminal still produces wrapped prose
 * rather than per-glyph breaks. wrap-ansi with `wordWrap: true, hard: false`
 * will still allow longer tokens to overrun this width — preferred over
 * mangling them into single-letter slivers.
 */
const MIN_BODY_WIDTH = 16;

/**
 * Multiplier on `maxLines × bodyWidth` used as the tail-slice threshold.
 * Holding TAIL_MULTIPLIER × the maximum renderable size ensures the sliced
 * tail has enough slack for whitespace collapse (which can reduce a run of
 * whitespace to a single space), multi-byte UTF-8 characters, and word-break
 * slack so that the visible `maxLines` lines are always populated even when
 * the buffer is dominated by whitespace.
 *
 * Chosen after testing with pathological cases: a 100 KB buffer with
 * alternating short words produces ~5 visible lines from the last 3120 raw
 * characters (5 × 78 × 4 = 1560 — doubled for safety here), and a buffer
 * that is 50 % newlines still produces the same visible tail as the full
 * pre-normalize run.
 */
const TAIL_MULTIPLIER = 8;

export interface ThinkingParagraphOptions {
  /** Terminal width in columns. */
  cols: number;
  /** Soft cap on visible body lines (header + footer do NOT count). Default 5. */
  maxLines?: number;
}

/**
 * Render the buffer as:
 *
 *   ◆ thinking
 *   first wrapped body line
 *   second wrapped body line
 *   ⋯ +N chars earlier   ← only when truncated
 *
 * All lines are indented by 2 columns. Header and body are italic mauve
 * (`palette.thinking`); the truncation footer is dim so it reads as
 * scaffolding rather than reasoning.
 *
 * Returns `''` when the buffer is empty or whitespace-only — the caller is
 * responsible for not pushing an empty overlay layer.
 *
 * Tail-scroll semantics: the most recent `maxLines` wrapped lines survive;
 * older lines drop off the top. The footer reports how many characters of
 * wrapped body content were dropped, NOT a line count, because users care
 * about how much reasoning they didn't see.
 *
 * Performance: on every thinking-chunk repaint (~50 Hz) the pre-optimisation
 * code ran `buffer.replace(/\s+/g, ' ')` + `wrapAnsi` on the ENTIRE
 * accumulated buffer (often 8-10 KB), then threw away everything except the
 * last ~5 lines.  The fix tail-slices the raw buffer before the O(N) regex
 * and wrap steps, bounding cost to O(maxLines · bodyWidth · TAIL_MULTIPLIER)
 * per call independent of the total CoT length.
 */
export function formatThinkingParagraph(
  buffer: string,
  opts: ThinkingParagraphOptions,
): string {
  // Invariant: maxLines and bodyWidth must be resolved BEFORE the tail-slice
  // step so the target character budget is known.
  const maxLines = opts.maxLines ?? DEFAULT_MAX_BODY_LINES;
  const bodyWidth = Math.max(MIN_BODY_WIDTH, opts.cols - INDENT.length);

  // Tail-slice the raw buffer before the O(N) normalize + wrap steps.
  // The most we can ever render is `maxLines × bodyWidth` codepoints of
  // body.  Slice a generous tail (×TAIL_MULTIPLIER) so that the regex and
  // wrap cost is bounded regardless of total buffer length.  Prefer
  // slice-at-character-boundary over truncating-at-word-boundary: the
  // ×TAIL_MULTIPLIER cushion means a partial-word at the cut boundary is
  // absorbed by the slack, and the collapsed whitespace in the remaining
  // tail still fills the visible window.
  const maxWorkChars = maxLines * bodyWidth * TAIL_MULTIPLIER;
  let preSliceChars = 0;
  if (buffer.length > maxWorkChars) {
    preSliceChars = buffer.length - maxWorkChars;
    buffer = buffer.slice(-maxWorkChars);
  }

  // Collapse all internal whitespace (including newlines) to single spaces.
  // CoT often has paragraph breaks the model used as natural pauses; in a
  // 5-line overlay those breaks don't add information and they shorten the
  // effective visible body. wrap-ansi will reflow at the body width below.
  const normalized = buffer.replace(/\s+/g, ' ').trim();
  if (!normalized) return '';

  // Wrap with `trim: true` (not the project-default `wrapToWidth`, which
  // uses `trim: false`). The default leaves whitespace at line breaks
  // visible — fine for code/quoted-line rendering, but it produces a
  // visible "extra column" of indent on continuation lines here that
  // looks like a layout bug. `trim: true` removes that artifact without
  // touching the per-line `INDENT` we prepend after wrapping.
  const wrapped = wrapAnsi(normalized, bodyWidth, {
    hard: false,
    trim: true,
    wordWrap: true,
  });
  const allLines = wrapped.split('\n');

  let visible = allLines;
  // Initialize droppedChars with the pre-slice drop count so the footer
  // accounts for ALL chars the user cannot see.  The pre-slice count is in
  // raw characters (not normalized chars) and the post-wrap count is in
  // display-line chars, so the sum is an approximate "+N earlier" hint —
  // acceptable per issue #23.
  let droppedChars = preSliceChars;
  if (allLines.length > maxLines) {
    const dropped = allLines.slice(0, allLines.length - maxLines);
    // Sum the wrapped-line lengths, plus 1 per join to account for the
    // spaces that would have separated them in the underlying prose.
    droppedChars += dropped.reduce((sum, l, i) => sum + l.length + (i > 0 ? 1 : 0), 0);
    visible = allLines.slice(-maxLines);
  }

  const out: string[] = [];
  out.push(INDENT + palette.thinking(HEADER));
  for (const line of visible) {
    out.push(INDENT + palette.thinking(line));
  }
  if (droppedChars > 0) {
    out.push(INDENT + palette.dim(`⋯ +${droppedChars} chars earlier`));
  }
  return out.join('\n');
}
