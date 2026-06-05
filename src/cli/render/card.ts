import type { ChalkInstance } from 'chalk';
import { displayWidth } from '../display.js';
import { getTerminalWidth } from '../terminal-size.js';
import { wrapToWidth } from '../wrap.js';
import { palette } from '../palette.js';
import { renderCardLine } from '../formatter.js';
import { maxInnerBoxWidth } from './utils.js';
import { drawBox } from './box.js';
import { env } from '../../config/env.js';

// ─── Constants ───────────────────────────────────────────────────────────────

// Maximum number of visual rows renderUserCard emits before collapsing the
// remainder into a dim summary row. Overridable via AFK_USER_CARD_MAX_ROWS.
const MAX_USER_CARD_ROWS = (() => {
  const raw = env.AFK_USER_CARD_MAX_ROWS;
  const n = raw ? Number.parseInt(raw, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : 24;
})();

// ─── Card ────────────────────────────────────────────────────────────────────

/**
 * Card kinds carry semantic meaning and map to a palette color for the
 * border + title chip.
 *
 * - `plan`        — magenta. A plan being proposed.
 * - `status`      — blue.    A status or state report.
 * - `checkpoint`  — green.   A successful step / phase rollup.
 * - `diagnosis`   — yellow.  A diagnosis, problem, or warning.
 * - `user`        — cyan.    A user message echo (left-bar variant; no
 *                            top/bottom border or title chip).
 */
export type CardKind = 'plan' | 'status' | 'checkpoint' | 'diagnosis' | 'user';

/** Specification for a {@link card} call. */
export interface CardSpec {
  /** Visual kind; selects color and shape. */
  kind: CardKind;
  /**
   * Optional title shown as a chip in the top bar. Ignored for the `user`
   * kind. When omitted, the kind's default chip text is used (e.g. `PLAN`).
   */
  title?: string;
  /**
   * Body content. Strings are split on `\n`; arrays are joined line-by-line.
   * Each resulting line is wrap-aware and trimmed to fit the terminal.
   */
  body: string | string[];
  /**
   * Deprecated. Previously controlled the left-pad column for `kind: 'user'`
   * cards so they aligned with the inline prompt column. User echoes are now
   * right-aligned (chat-bubble style), so this value is ignored. Kept on the
   * type for source-compat with callers still passing it.
   */
  leftPad?: number;
}

const CARD_BORDERS: Record<Exclude<CardKind, 'user'>, ChalkInstance> = {
  plan: palette.plan,
  status: palette.info,
  checkpoint: palette.success,
  diagnosis: palette.warning,
};

const CARD_DEFAULT_TITLE: Record<Exclude<CardKind, 'user'>, string> = {
  plan: 'PLAN',
  status: 'STATUS',
  checkpoint: '✅ CHECKPOINT',
  diagnosis: 'DIAGNOSIS',
};

/**
 * Render a semantic card — a bordered or left-bar block carrying meaning
 * via color + title chip.
 *
 * Bordered kinds (`plan`, `status`, `checkpoint`, `diagnosis`) follow the
 * same shape vocabulary as {@link errorBox}: a colored border with a bold
 * title chip in the top bar and 2-space inner padding.
 *
 * The `user` kind is a thin, right-aligned variant — content is flushed to
 * the right edge of the terminal with a single cyan bar (`│`) on the far
 * right, no top/bottom border. Used for echoing user input in the REPL,
 * mirroring the chat-bubble convention where the speaker's own messages
 * sit on the right.
 *
 * @param spec - Card specification.
 * @returns Multi-line string ready to write to stdout.
 */
export function card(spec: CardSpec): string {
  const bodyLines = Array.isArray(spec.body) ? spec.body : spec.body.split('\n');

  if (spec.kind === 'user') {
    return renderUserCard(bodyLines);
  }

  const title = spec.title ?? CARD_DEFAULT_TITLE[spec.kind];
  return renderBorderedCard(spec.kind, title, bodyLines);
}

function renderUserCard(bodyLines: string[]): string {
  // Right-aligned chat-bubble layout: each body line is wrapped to fit within
  // the available width, then padded on the LEFT so the content + ' │' suffix
  // sits flush against the right edge of the terminal. `cols - 4` leaves 2
  // cols of breathing room on the left and reserves 2 cols on the right for
  // the ' │' suffix.
  const cols = getTerminalWidth();
  const innerW = Math.max(20, cols - 4);
  const wrapped: string[] = [];
  for (const line of bodyLines) {
    wrapped.push(...wrapToWidth(renderCardLine(line), innerW).split('\n'));
  }

  // Clamp output height so a long pasted prompt doesn't dominate the terminal.
  // When the wrapped row count exceeds MAX_USER_CARD_ROWS, keep the first
  // (MAX_USER_CARD_ROWS - 1) rows and append a dim summary row. The summary
  // row participates in the right-aligned │ treatment exactly like content rows.
  let displayRows = wrapped;
  if (wrapped.length > MAX_USER_CARD_ROWS) {
    const kept = MAX_USER_CARD_ROWS - 1;
    const collapsed = wrapped.length - kept;
    displayRows = [
      ...wrapped.slice(0, kept),
      palette.dim(`\u2026(${collapsed} lines collapsed)`),
    ];
  }

  const bar = palette.user('│');
  return displayRows
    .map((line) => {
      const lineW = displayWidth(line);
      // `cols - lineW - 2` reserves 2 cols for the trailing ' │'. Clamp to 0
      // so a line wider than the terminal (shouldn't happen post-wrap) still
      // renders without negative pad.
      const leadingSpace = Math.max(0, cols - lineW - 2);
      return ' '.repeat(leadingSpace) + line + ' ' + bar;
    })
    .join('\n');
}

function renderBorderedCard(
  kind: Exclude<CardKind, 'user'>,
  title: string,
  bodyLines: string[],
): string {
  const c = CARD_BORDERS[kind];
  const styledLines = bodyLines.map(renderCardLine);

  // Inner width: title chip + body content + 4-char padding, capped to the
  // terminal width (mirrors errorBox math). drawBox re-clamps to
  // maxInnerBoxWidth() and guarantees the title chip fits, so a long title in
  // a narrow terminal stays rectangular instead of throwing on a negative dash
  // count (the prior hand-rolled '─'.repeat math did before this unification).
  const contentMax = Math.max(
    displayWidth(title) + 4,
    ...styledLines.map((l) => displayWidth(l)),
  );
  const rawInner = Math.max(40, contentMax) + 4;
  let innerW = Math.min(rawInner, Math.min(getTerminalWidth() - 4, 100));
  innerW = Math.min(innerW, maxInnerBoxWidth());

  // Border color, bold title chip, and 2-space padding all flow through the
  // shared drawBox primitive. renderCardLine has already styled each body line,
  // so drawBox only handles wrapping + framing.
  return drawBox(styledLines, { border: c, title, width: innerW, padding: 2 });
}
