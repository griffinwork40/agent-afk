/**
 * Frame renderers — input line, autocomplete dropdown rows, and hint row —
 * extracted from terminal-compositor.ts. Follows the free-functions-on-host
 * pattern used by src/cli/_lib/stream-renderer-* and the sibling paste/
 * autocomplete modules: TerminalCompositor owns the state; these functions
 * read the narrow {@link RenderHost} slice it passes as `self` and return
 * frame strings. They are pure string-producers — they never mutate compositor
 * state (the caller, `repaint`, owns frame assembly). No behavior change —
 * bodies are moves with `this.` rewritten to `self.`.
 */

import { displayWidth, nextGraphemeIndex, stripAnsi, truncateDisplayWidth } from './display.js';
import { formatDropdownRow, formatHintRow } from './input/dropdown.js';
import { stripGhostControlChars } from './input/suggest.js';
import { palette } from './palette.js';
import { MAX_DROPDOWN_ROWS } from './terminal-compositor.autocomplete.js';
import type { InputCoreState } from './input-core.js';
import type { AutocompleteState } from './input/autocomplete-state.js';
import type { SubmissionPayload } from './terminal-compositor.types.js';

/**
 * Narrowest TerminalCompositor state slice the frame renderers read. Every
 * field is `readonly`: these functions never mutate compositor state, so a
 * mutable host (the class) satisfies the interface while the contract
 * documents the no-write guarantee.
 */
export interface RenderHost {
  readonly queued: boolean;
  /** Pending submission FIFO — its length drives the `[N queued]` suffix. */
  readonly pendingSubmissions: readonly SubmissionPayload[];
  readonly input: InputCoreState;
  readonly activeGhost: string | null;
  readonly autocompleteState?: AutocompleteState;
  readonly formatInputBuffer?: (segment: string) => string;
  readonly promptTextFn: () => string;
  readonly stdout: NodeJS.WriteStream;
}

/**
 * Render the persistent input line: prompt + colorized buffer + inverse-video
 * caret + optional dim inline ghost suffix + optional `[queued]` marker.
 */
export function renderInputLine(self: RenderHost): string {
  // `[queued]` / `[N queued]` suffix while messages are queued mid-stream.
  // Without it, pressing Enter is visually a no-op — the input clears with no
  // signal that the message was committed to the send queue. The dim grey
  // keeps it low-salience so it doesn't compete with the streaming overlay
  // above. Singular `[queued]` for one (preserves the long-standing label);
  // `[N queued]` once additional messages stack up.
  const pendingCount = self.pendingSubmissions.length;
  const suffix =
    pendingCount > 0
      ? '  ' + palette.dim(pendingCount === 1 ? '[queued]' : `[${pendingCount} queued]`)
      : '';
  const rawBefore = self.input.buffer.slice(0, self.input.cursor);
  const cursorEnd = nextGraphemeIndex(self.input.buffer, self.input.cursor);
  const atEnd = self.input.cursor >= self.input.buffer.length;
  // At end-of-buffer show a thin ▏ bar (U+258F, LEFT ONE EIGHTH BLOCK) so
  // the idle cursor reads as a modern line caret rather than a filled block.
  // Mid-buffer the character under the cursor is kept and inverse-video is
  // applied so the active position stays legible during editing.
  const cursorText = atEnd
    ? '▏'
    : self.input.buffer.slice(self.input.cursor, cursorEnd);
  const rawAfter =
    self.input.cursor < self.input.buffer.length
      ? self.input.buffer.slice(cursorEnd)
      : '';
  // Apply the caller-supplied formatter (typically `colorizeInputBuffer`
  // closed over the slash registry) to each segment independently. The
  // caret character is rendered RAW so it stays a single visual
  // cell — passing it through a colorizer would compose ANSI codes on top
  // of the caret SGR and complicate grapheme-width math.
  const before = self.formatInputBuffer?.(rawBefore) ?? rawBefore;
  const after = self.formatInputBuffer?.(rawAfter) ?? rawAfter;
  // Caret is always painted. `repaint()` already gates on `armed`, so this
  // code only runs while we hold raw mode; there is no path where rendering
  // the caret "leaks" a phantom cursor after disarm — every async repaint
  // source (keypress, resize, spinner) is unsubscribed before
  // `logUpdate.done()` in `disarm()`.
  const caret = atEnd ? palette.caret(cursorText) : palette.caret.inverse(cursorText);
  // Ghost text: render a dim inline completion AFTER the caret, only when:
  //   1. cursor is at end-of-buffer (no rawAfter)
  //   2. there is an active ghost that strictly extends the current buffer
  //   3. the dropdown is NOT open (dropdown is its own suggestion UI; ghost defers to it)
  //   4. no [queued] suffix is active (ghost would visually conflict with the suffix)
  //
  // Invariant: the ghost is appended AFTER the caret cell — never interleaved.
  // Truncate to `cols - promptWidth - bufferWidth - 1` so the input line
  // never wraps (wrapping would corrupt DECSTBM scroll-region math).
  const ac = self.autocompleteState;
  let ghostSuffix = '';
  const ghost = self.activeGhost;
  if (
    ghost !== null &&
    !suffix &&
    self.input.buffer.length > 0 &&
    self.input.cursor === self.input.buffer.length &&
    ghost.startsWith(self.input.buffer) &&
    ghost.length > self.input.buffer.length &&
    !ac?.dropdownOpen
  ) {
    // Defense-in-depth: strip terminal control sequences / control chars from
    // the ghost suffix before rendering. Tier-2 (LLM) text is already
    // sanitized at the suggestion engine, but a Tier-1 candidate (e.g. a
    // multi-line history entry) could still carry an embedded newline that
    // would break the single-line input render and corrupt the DECSTBM
    // scroll-region accounting (see the truncation note below).
    const remainder = stripGhostControlChars(ghost.slice(self.input.buffer.length));
    // Compute available columns: total cols minus what the prompt + buffer
    // already consume. Measure with grapheme/column-aware displayWidth — NOT
    // String.length (UTF-16 code units) — so CJK (2 cells / 1 unit) and emoji
    // (2 cells / surrogate pair) are budgeted by the cells they occupy.
    const cols = self.stdout.columns ?? 80;
    const promptWidth = displayWidth(stripAnsi(self.promptTextFn()));
    const bufferWidth = displayWidth(stripAnsi(rawBefore)) + 1; // +1 for caret cell
    const budget = Math.max(0, cols - promptWidth - bufferWidth - 1);
    // truncateDisplayWidth truncates on grapheme boundaries (never splits a
    // surrogate pair) and counts display columns, so the input line never
    // wraps — wrapping would corrupt the DECSTBM scroll-region math. Empty
    // ellipsis: a ghost is a silent hint, not a labelled truncation.
    const truncated = truncateDisplayWidth(remainder, budget, '');
    if (truncated.length > 0) {
      ghostSuffix = palette.dim(truncated);
    }
  }
  return self.promptTextFn() + before + caret + after + ghostSuffix + suffix;
}

/**
 * Render dropdown rows for the shared autocomplete state inside the
 * compositor frame. Returns an array of formatted strings (one per visible
 * candidate row) — caller pushes them into the `frameLines` array before
 * handing off to `logUpdate`.
 *
 * Rendering inside the frame keeps `log-update` in sole control of the
 * bottom region of stdout — no sibling writes that would corrupt its
 * line-tracking.
 *
 * Invariant: the returned rows are ordered so the row at the LAST index
 * corresponds to the candidate at `viewportStart` (the lowest visible
 * candidate index, typically the selected one in a fresh open). When
 * pushed into a frame whose last line is the input row, this places the
 * highest-priority match closest to the input — the cursor is touching
 * the most likely completion. Higher candidate indices ascend visually
 * away from the input. See `repaint()` for the frame ordering rationale
 * (input pinned at `rows-1`, dropdown grows upward).
 */
export function renderDropdownRows(self: RenderHost): string[] {
  const ac = self.autocompleteState;
  if (!ac?.dropdownOpen) return [];
  const cols = self.stdout.columns || 80;
  if (cols <= 40) return [];
  const maxWidth = Math.min(cols - 4, 60);
  const visibleCount = Math.min(
    ac.candidates.length - ac.viewportStart,
    MAX_DROPDOWN_ROWS,
  );
  // Build the visible rows in candidate-index order first, then reverse
  // before returning so the lowest-index (selected-by-default) candidate
  // ends up at the BOTTOM of the rendered block (closest to the input
  // line). Reversing the array is simpler than iterating backwards
  // because the soft-wrap blank-line placeholders must accompany each
  // candidate row as a contiguous group — reversing after building
  // preserves that grouping naturally.
  const rows: string[] = [];
  for (let i = 0; i < visibleCount; i++) {
    const idx = ac.viewportStart + i;
    const candidate = ac.candidates[idx];
    if (!candidate) continue;
    const rowStr = formatDropdownRow(candidate, idx === ac.selectedIndex, maxWidth, ac.trigger?.kind);
    // Count soft-wraps so the frame height stays accurate.
    // Use displayWidth (not .length) so CJK/emoji candidate rows measure
    // display columns, matching the `cols` variable (also display columns).
    // UTF-16 .length under-counts wide chars and produces ghost/clip artifacts.
    const rowWidth = displayWidth(stripAnsi(rowStr));
    const softWraps = Math.max(0, Math.ceil(rowWidth / cols) - 1);
    rows.push(rowStr);
    // Push blank placeholders so log-update's line count stays correct
    // on narrow terminals where a single candidate row wraps.
    for (let w = 0; w < softWraps; w++) rows.push('');
  }
  return rows.reverse();
}

/**
 * Render the `↳ <when-to-use>` tooltip row for the currently-selected
 * dropdown candidate. Returns null when the dropdown is closed or the
 * terminal is too narrow; returns an empty string (a reserved blank
 * row) when the selected candidate has no `hint`.
 *
 * In the bottom-pinned frame layout the hint sits BETWEEN the dropdown
 * block and the input row (`dropdown rows → hint → input`), so the
 * tooltip for the selected (bottom-most) dropdown row appears directly
 * below it and directly above the input — the same visual relationship
 * the legacy `reader.ts` rendered when the dropdown lived below the
 * input.
 *
 * Invariant (frame-height stability): when the dropdown is open at all,
 * this function must return a non-null value so the frame's row count
 * stays constant as the user navigates ↑/↓. Many slash commands carry
 * no `hint` field (`/allow-dir`, `/bgsub`, `/changelog`, `/keys`,
 * `/stats`, `/worktree`, all `/bgsub:*` variants, etc.), and an
 * earlier version returned null in that case "to avoid wasting a row."
 * The cost of that frugality was a frame that oscillated between N and
 * N+1 rows as the selection crossed hinted ↔ un-hinted boundaries:
 * log-update kept the input row pinned at `rows-1`, so the dropdown
 * above it visibly shifted up by one row each navigation step. The
 * wasted row is the cheaper trade.
 */
export function renderHintRow(self: RenderHost): string | null {
  const ac = self.autocompleteState;
  if (!ac?.dropdownOpen) return null;
  const cols = self.stdout.columns || 80;
  if (cols <= 40) return null;
  const selected = ac.candidates[ac.selectedIndex];
  if (!selected) return null;
  const hintWidth = Math.min(cols - 4, 80);
  // Reserve the slot with an empty row when the candidate has no hint
  // — formatHintRow returns null there, and a null return from this
  // function would let the row collapse out of the frame.
  return formatHintRow(selected.hint, hintWidth) ?? '';
}
