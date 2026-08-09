/**
 * Bounded-line wrapping — the last stop before a composed row reaches a TTY.
 *
 * ## Why this exists
 *
 * Every REPL row is composed by a caller (a slash command's table, a status
 * notice, a resume banner) and handed to a write seam. Callers budget their
 * own width — or don't. When one emits a row wider than the terminal, the
 * terminal auto-wraps it, and the continuation lands at COLUMN 0: the row's
 * leading indent is lost, tree glyphs and table columns detach, and the
 * output reads as broken rather than wrapped. Truncating instead would
 * bound the row but destroy content.
 *
 * Invariant: no row handed to a TTY may exceed the terminal width. This
 * module is the enforcement point, applied at the RAW write seams rather
 * than at the ~40 call sites, so a new caller cannot reintroduce the bug by
 * forgetting to budget. Rows that already fit pass through byte-identical.
 *
 * The four raw seams, all of which write straight to the terminal with no
 * compositor to wrap them:
 *   - `slash/writer.ts` — sinkless `console.log` (all slash-command output)
 *   - `commands/interactive/repl-renderer.ts` — the disarmed TTY branch
 *   - `commands/interactive/bootstrap-surface.ts` — `CompletionWriter`'s
 *     pre-arm `console.log` default for `fn` / `idleFn`
 *   - `terminal-compositor.committed-band-commit.ts` — `commitAbove`'s
 *     disarmed early return
 *
 * Deliberately NOT applied to the armed compositor path: `commitAbove`
 * already hard-wraps to the live width for its row accounting AND re-wraps
 * the retained band on resize, so pre-wrapping there would freeze rows at
 * today's width and a later WIDEN could no longer rejoin them (guarded by
 * `tests/pty/compositor-scrollback.pty.test.ts`'s width-resize-fragment
 * cases).
 *
 * ## Wrap, don't truncate; hang the indent
 *
 * A row that overflows is wrapped at the width and every continuation row is
 * re-prefixed with the SOURCE row's own leading indent, so wrapped output
 * stays visually attached to the row that produced it:
 *
 *     `  ↳ some long message that does not fit in the terminal width`
 *
 *     `  ↳ some long message that does not`
 *     `  fit in the terminal width`
 *
 * ## Not applied to non-TTY output
 *
 * Piped/redirected output stays byte-identical: `afk worktree list | grep`
 * must see whole logical rows, and a consumer's parser must not have to
 * reassemble rows this module split for a human. The TTY check lives in
 * {@link boundLineToTerminal}; {@link hangingWrap} is pure and testable.
 */

import { displayWidth } from '../display.js';
import { getTerminalWidth } from '../terminal-size.js';
import { hardWrapToWidth, wrapToWidth } from '../wrap.js';

/**
 * Minimum content columns preserved beside a hanging indent.
 *
 * Contract: when a row's own indent is so deep that honoring it would leave
 * fewer than this many columns for text, the hanging indent is abandoned and
 * the row is plain hard-wrapped at the full width instead. Without this
 * floor, a deeply-indented row on a narrow terminal degrades into a column
 * of one or two characters — bounded, but unreadable.
 */
const MIN_CONTENT_COLUMNS = 8;

/** Leading ANSI SGR runs, then literal spaces: `\x1b[2m` + `  ` + text. */
const LEADING_INDENT = /^((?:\x1B\[[0-9;]*m)*)( *)/;

/**
 * Wrap one logical line to `width` display columns, preserving its indent on
 * every continuation row.
 *
 * Returns the line unchanged when it already fits — the common case, and the
 * reason this is safe to call on every write.
 */
function wrapOneLine(line: string, width: number): string {
  if (displayWidth(line) <= width) return line;

  const match = LEADING_INDENT.exec(line);
  const leadingAnsi = match?.[1] ?? '';
  const indent = match?.[2] ?? '';
  const contentWidth = width - indent.length;

  // Pathological indent (deeper than the terminal can usefully hold): drop
  // the hanging indent rather than squeezing text into a sliver.
  if (contentWidth < MIN_CONTENT_COLUMNS) {
    return hardWrapToWidth(line, width);
  }

  // Re-attach the leading SGR run to the body so the wrapped text keeps its
  // styling; the indent itself is re-emitted as plain spaces (a space has no
  // glyph, so its styling is unobservable).
  const body = leadingAnsi + line.slice(match?.[0]?.length ?? 0);
  const rows = wrapToWidth(body, contentWidth, { breakLongWords: true }).split('\n');

  return rows
    .map((row) => {
      const prefixed = indent + row;
      // Defensive: wrap-ansi is width-correct for every input we know of, but
      // this module's whole contract is "never exceeds width", so a row that
      // somehow overshoots is hard-wrapped rather than emitted over-wide.
      return displayWidth(prefixed) > width ? hardWrapToWidth(prefixed, width) : prefixed;
    })
    .join('\n');
}

/**
 * Wrap `text` so that no resulting row exceeds `width` display columns,
 * preserving each source row's indent on its continuation rows.
 *
 * Pure: no terminal or environment reads. Embedded newlines are honored —
 * each logical line is wrapped independently. Non-finite or non-positive
 * `width` returns `text` unchanged.
 */
export function hangingWrap(text: string, width: number): string {
  if (!Number.isFinite(width) || width <= 0) return text;
  const w = Math.floor(width);
  return text
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => wrapOneLine(line, w))
    .join('\n');
}

/**
 * Bound a composed row to the live terminal width, or pass it through
 * untouched when the sink is not a TTY.
 *
 * Contract: TTY output is wrapped (never truncated) to `getTerminalWidth()`;
 * non-TTY output is returned byte-identical so piped consumers still see
 * whole logical rows.
 */
export function boundLineToTerminal(
  text: string,
  stream: { isTTY?: boolean } = process.stdout,
): string {
  if (stream.isTTY !== true) return text;
  return hangingWrap(text, getTerminalWidth());
}
