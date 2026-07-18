import type { ChalkInstance } from 'chalk';
import { displayWidth, truncateDisplayWidth } from '../display.js';
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
 * - `user`        — cyan.    A user message echo (right-positioned chat
 *                            bubble: dim top rule + cyan right bar; no
 *                            full border or title chip).
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

/**
 * Resolve the border color for a bordered card kind.
 *
 * Invariant: this MUST be a function, not a module-level const lookup.
 * `palette` is a live view over the active theme (see palette.ts) —
 * capturing `palette.plan` etc. into a const at import time would freeze
 * the border color to whatever theme was active at module load, so a
 * `light` swap would leave stale dark-theme borders on screen. Resolving
 * per call (mirrors `buildSyntaxTheme()` in syntax-theme.ts) keeps the
 * border in lock-step with `applyTheme()`.
 */
function cardBorder(kind: Exclude<CardKind, 'user'>): ChalkInstance {
  switch (kind) {
    case 'plan': return palette.plan;
    case 'status': return palette.info;
    case 'checkpoint': return palette.success;
    case 'diagnosis': return palette.warning;
  }
}

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
 * The `user` kind is a thin chat-bubble variant — a width-capped block of
 * left-aligned text positioned against the right edge of the terminal,
 * closed by a single cyan bar (`│`) on the far right and a dim top rule.
 * Used for echoing user input in the REPL, mirroring the chat-bubble
 * convention where the speaker's own messages sit on the right.
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
  // Chat-bubble layout: the bubble BLOCK is positioned against the right
  // edge of the terminal, but the text INSIDE it stays left-aligned —
  // mirroring how iMessage/WhatsApp render the speaker's own messages.
  // Two width rules make it read as a bubble instead of misaligned text:
  //
  //   1. Bubble width is capped at 75% of the terminal (and at 100, the
  //      bordered-card ceiling) so a left gutter always remains. A bubble
  //      spanning the whole row is indistinguishable from plain output.
  //   2. Every row is padded to the width of the WIDEST row, giving the
  //      bubble a straight left edge. Per-row right-alignment (the prior
  //      layout) produced a ragged left edge that read as broken wrapping.
  const cols = getTerminalWidth();
  const innerW = Math.max(20, Math.min(cols - 4, Math.floor(cols * 0.75), 100));
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

  const bar = palette.user.bold('│');
  // Invariant (last-column safety): the bar lands at most at column `cols - 1`,
  // never the terminal's final column. A printable glyph in the last column
  // leaves many emulators (iTerm2/Ghostty/Kitty/WezTerm) in the DECAWM
  // deferred-wrap state; when the compositor later scrolls or CUP-repositions
  // for the committed-band repaint, those terminals flush the pending wrap
  // inconsistently and a full-width committed row ghosts/duplicates in
  // scrollback (the "user prompt echoed 3×" report). The live input line
  // already reserves this column for the same reason (terminal-compositor.render.ts:
  // `cols - … - 1`). xterm handles the boundary cleanly, so this never surfaces
  // in the @xterm/headless test harness — only on real terminals.
  //
  // Use `cols - 1` directly — NOT `Math.max(3, cols - 1)`: a floor would push
  // rightEdge UP to 3 on a 1–3 column terminal, landing the bar back in the
  // physical last column (the very bug above). For cols ≥ 3 the bar sits at
  // cols-1 with the final column empty; below 3 the ' │' suffix cannot fit at
  // all, so truncateDisplayWidth clamps content to '' (maxWidth ≤ 0) and the row
  // degrades to a bare bar without throwing instead of chasing an impossible
  // width.
  const rightEdge = cols - 1;

  // Bubble block width: the widest visible row, clamped so content + ' │'
  // still honors the last-column-safety ceiling. Rows wider than the clamp
  // (unbreakable tokens that survive wrapToWidth(hard:false)) are truncated
  // below, landing exactly at blockW.
  const blockW = Math.min(
    Math.max(0, ...displayRows.map((l) => displayWidth(l))),
    Math.max(0, rightEdge - 2),
  );

  // Separator row is built after capping — does not count against
  // MAX_USER_CARD_ROWS. It doubles as the bubble's top edge: spans the
  // bubble's footprint (content + ' │' = blockW + 2) starting at the
  // bubble's left edge. Floor of 12 keeps it legible for one-word bubbles;
  // the rightEdge clamp preserves the last-column-safety invariant.
  const sepW = Math.min(Math.max(1, rightEdge), Math.max(12, blockW + 2));
  const sepPad = Math.max(0, rightEdge - sepW);
  const separatorRow = ' '.repeat(sepPad) + palette.dim('─'.repeat(sepW));

  // Common left edge for every row; the bar lands at rightEdge on every row.
  const leadingSpace = Math.max(0, rightEdge - blockW - 2);
  const contentRows = displayRows
    .map((line) => {
      // Defensive clamp: an unbreakable token wider than innerW survives
      // wrapToWidth(hard:false) intact, so a row could otherwise exceed
      // blockW. Truncate (ANSI/hyperlink-aware) so content fits the block.
      const content =
        displayWidth(line) > blockW ? truncateDisplayWidth(line, blockW) : line;
      // Interior pad fills the gap between this row's text and the bar
      // column, keeping the text left-aligned within the bubble.
      const interiorPad = Math.max(0, blockW - displayWidth(content));
      return ' '.repeat(leadingSpace) + content + ' '.repeat(interiorPad) + ' ' + bar;
    })
    .join('\n');
  return separatorRow + '\n' + contentRows;
}

function renderBorderedCard(
  kind: Exclude<CardKind, 'user'>,
  title: string,
  bodyLines: string[],
): string {
  const c = cardBorder(kind);
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
