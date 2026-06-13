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
 * Multiplier for the pre-normalize tail-slice bound. ×4 accounts for
 * whitespace collapse + multi-byte chars + word-break slack — ensuring
 * that even a burst of whitespace before real content does not cause the
 * slice to discard visible prose.
 */
const TAIL_MULTIPLIER = 4;

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
 */
export function formatThinkingParagraph(
  buffer: string,
  opts: ThinkingParagraphOptions,
): string {
  const maxLines = opts.maxLines ?? DEFAULT_MAX_BODY_LINES;
  const bodyWidth = Math.max(MIN_BODY_WIDTH, opts.cols - INDENT.length);

  // Bound the work: the most we can ever render is maxLines × bodyWidth
  // codepoints of body. Slice a generous tail (×TAIL_MULTIPLIER accounts for
  // whitespace collapse + multi-byte chars + word-break slack) before running
  // the O(N) regex + wrap — keeping cost O(maxLines · bodyWidth) regardless
  // of accumulated CoT length.
  const tailBound = maxLines * bodyWidth * TAIL_MULTIPLIER;
  const tail = buffer.length > tailBound ? buffer.slice(-tailBound) : buffer;
  const preTailDropped = buffer.length - tail.length;

  // Collapse all internal whitespace (including newlines) to single spaces.
  // CoT often has paragraph breaks the model used as natural pauses; in a
  // 5-line overlay those breaks don't add information and they shorten the
  // effective visible body. wrap-ansi will reflow at the body width below.
  const normalized = tail.replace(/\s+/g, ' ').trim();
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
  // Invariant: droppedChars accounts for both pre-tail-slice raw chars
  // (preTailDropped) and any wrapped lines scrolled off the top of the
  // visible window — the footer is therefore a lower bound on total CoT
  // chars the user did not see, not an exact character count.
  let droppedChars = preTailDropped;
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
