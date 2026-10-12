/**
 * Layout for agent `ask_question` overlays: a header and option labels that fit
 * the terminal, so the operator can always read the whole question.
 *
 * Invariant: the picker sizes its option window from `header.length`
 * (`render/picker.ts` `pickerViewportSize`) and paints each option as ONE row,
 * while the frame renderer hard-wraps at `stdout.columns`. So every header
 * entry must already be one physical row, and every option label must fit on
 * one row. This module does that wrapping before the overlay sees anything,
 * which keeps `picker.ts`, `text-input.ts`, and `PickerHost` unchanged for the
 * other overlay consumers.
 *
 * Contract: when the full text cannot fit (the wrapped header would leave fewer
 * than {@link MIN_OPTION_ROWS} option rows, or a choice label had to be
 * shortened), `scrollback` holds the complete question, context, and numbered
 * choices. The caller writes it BEFORE opening the overlay (never while picker
 * mode is active), and the overlay shows a compact header pointing at it.
 * Nothing the agent wrote is ever only visible in truncated form.
 */

import type { ElicitationRequest } from '../../agent/types/sdk-types.js';
import { sanitizeTerminalText } from '../_lib/sanitize.js';
import { displayWidth, truncateDisplayWidth } from '../display.js';
import { palette } from '../palette.js';
import { wrapToWidth } from '../wrap.js';

/** Fewest option rows the overlay must keep visible before spilling to scrollback. */
export const MIN_OPTION_ROWS = 3;
/** Rows the overlay needs besides header + options: bottom margin, help row, scroll indicator. */
const RESERVED_ROWS = 3;
/** Widest picker row prefix (`  ▶ [x] ` in multi mode) plus a safety column. */
const OPTION_PREFIX_COLS = 10;

export interface TerminalSize {
  columns: number;
  rows: number;
}

export interface AgentQuestionLayout {
  /** Overlay header rows, each guaranteed to fit on one physical row. */
  header: readonly string[];
  /** Picker labels (one row each), parallel to `request.choices`. */
  options: readonly string[];
  /** Lines to write to scrollback BEFORE the overlay opens; empty when everything fits. */
  scrollback: readonly string[];
  /** Map a picker label back to the agent's ORIGINAL choice string. */
  choiceFor(label: string): string | undefined;
}

/** Word-wrap `text` to `width`, prefixing the first row with `first` and the rest with `rest`. */
function wrapWithPrefix(text: string, width: number, first: string, rest: string): string[] {
  const body = Math.max(10, width - Math.max(displayWidth(first), displayWidth(rest)));
  const rows = wrapToWidth(text, body, { breakLongWords: true }).split('\n');
  return rows.map((row, i) => (i === 0 ? first : rest) + row);
}

/** The agent's question (and context) as rows that fit `columns`. */
function questionRows(request: ElicitationRequest, columns: number): string[] {
  const rows = wrapWithPrefix(sanitizeTerminalText(request.message), columns, '  ? ', '    ')
    .map((r) => palette.bold(r));
  if (request.context) {
    rows.push(
      ...wrapWithPrefix(sanitizeTerminalText(request.context), columns, '    ', '    ').map((r) => palette.dim(r)),
    );
  }
  return rows;
}

/** One-row picker labels; numbered when any had to be shortened (or collide) so they stay unique. */
function optionLabels(choices: readonly string[], columns: number): { labels: string[]; shortened: boolean } {
  const flat = choices.map((c) => sanitizeTerminalText(c).replace(/\s*[\r\n]+\s*/g, ' '));
  const max = Math.max(10, columns - OPTION_PREFIX_COLS);
  const shortened = flat.some((l) => displayWidth(l) > max);
  const collide = new Set(flat).size !== flat.length;
  if (!shortened && !collide) return { labels: flat, shortened: false };
  const labels = flat.map((l, i) => {
    const num = `${i + 1}. `;
    return num + truncateDisplayWidth(l, max - displayWidth(num));
  });
  return { labels, shortened };
}

/**
 * Build the overlay header, picker labels, and (when needed) the full-text
 * scrollback block for an agent question.
 *
 * Known gap: if the terminal is resized while a question is open, the layout
 * is not recalculated — the overlay keeps the wrap computed at open time.
 * Fixing this would require a SIGWINCH / onResize hook wired into the picker
 * and text-overlay paths (terminal-compositor.lifecycle.resize.ts has such
 * infrastructure, but it is not plumbed through ReplElicitationDeps). The
 * impact is limited to the narrow window between open and answer, and only
 * affects wrapping aesthetics, not correctness — the answer value always maps
 * back to the original choice string via `choiceFor`.
 */
export function layoutAgentQuestion(request: ElicitationRequest, size: TerminalSize): AgentQuestionLayout {
  // Wrap to the REAL terminal width so the header row-count matches what
  // CupFrameRenderer will physically paint.  Below 20 columns the overlay
  // cannot usefully host the question, so we always spill to scrollback (the
  // `spill` flag is forced true at the end of this block in that case).
  const columns = size.columns;
  const banner = palette.warning('  💬 Agent question');
  const qRows = questionRows(request, columns);
  const { labels, shortened } = optionLabels(request.choices ?? [], columns);

  // header = banner + question rows + (choices pointer when shortened) + trailing blank.
  const fullHeaderRows = qRows.length + 2 + (shortened ? 1 : 0);
  const overflow = fullHeaderRows + RESERVED_ROWS + MIN_OPTION_ROWS > size.rows;
  // Below 20 columns the overlay is too narrow to be usable — force a spill
  // so the full question lands in scrollback regardless of row count.
  const spill = overflow || shortened || size.columns < 20;

  const byLabel = new Map<string, string>();
  labels.forEach((l, i) => {
    const original = request.choices?.[i];
    if (original !== undefined && !byLabel.has(l)) byLabel.set(l, original);
  });
  const choiceFor = (label: string): string | undefined => byLabel.get(label);

  if (!spill) {
    return { header: [banner, ...qRows, ''], options: labels, scrollback: [], choiceFor };
  }

  const scrollback: string[] = [banner, ...qRows];
  (request.choices ?? []).forEach((c, i) => {
    const num = `  ${i + 1}. `;
    scrollback.push(...wrapWithPrefix(sanitizeTerminalText(c), columns, num, ' '.repeat(num.length)));
  });
  // Question fits but a choice was shortened: keep the full question in the
  // overlay and point at the full choices. Otherwise point at the whole block.
  const header = overflow
    ? [banner, palette.bold('  ? (full question above \u2191)'), '']
    : [banner, ...qRows, palette.dim('    (full choices above \u2191)'), ''];
  return { header, options: labels, scrollback, choiceFor };
}
