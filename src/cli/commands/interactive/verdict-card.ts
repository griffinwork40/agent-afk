/**
 * Verdict card — first-class structural rendering of a terminal state.
 *
 * Where the markdown stream renders the assistant's prose, the verdict card
 * renders the *commitment*: the named end-state (Done / Blocked / Asking /
 * Interrupted), the structured fields the prompt requires, and a one-line
 * affordance telling the user what the state implies for them.
 *
 * The card is emitted *after* the assistant text has already streamed. It is
 * additive: if the parser failed (e.g. the model didn't produce a clean
 * declaration), this module is never invoked. Worst case is the previous
 * status quo — the user reads the prose. Best case is a glance-readable
 * verdict surface that makes the structural shape of the turn legible.
 *
 * Visual contract:
 *   - Each terminal kind gets a distinct color and chip glyph so a user
 *     scanning a long transcript can spot end-states at a glance.
 *   - Rows are key-value pairs lined up under the chip; missing rows are
 *     skipped (no "n/a" filler) so the card compresses to its real content.
 *   - One affordance line at the bottom answers the only question the user
 *     ever has at end-of-turn: "what does this mean for me right now?"
 */

import type { TerminalState, TerminalKind } from './terminal-state.js';
import { palette } from '../../palette.js';
import { displayWidth, padDisplayRight, truncateDisplayWidth } from '../../display.js';
import { getTerminalWidth } from '../../terminal-size.js';
import { renderMarkdownToTerminal } from '../../formatter.js';
import { wrapToWidth } from '../../wrap.js';
import { formatCost } from '../../format-utils.js';

interface KindStyle {
  color: (s: string) => string;
  chip: string;
  affordance: string;
}

// Invariant: affordance strings must be ASCII-only (no em-dash `—`, en-dash,
// `…`, `·`, or other East-Asian-Width "Ambiguous" glyphs). The affordance row
// is padded to the full card width; `string-width` counts an ambiguous glyph
// as 1 column, but terminals/fonts that render it as 2 push the row 1 column
// past the right border, wrapping the trailing `│` and breaking the box. Use
// ASCII `-` for dashes. (Chip glyphs ✓/⊘/?/⏸ are NOT ambiguous — verified.)
//
// Invariant: each `color` MUST be a thunk that reads `palette.<role>` when
// called, never the chalk instance itself. `palette` is a live view swapped
// in place by `applyTheme()` (palette.ts), but this map is built at module
// scope — ESM hoists it above the first `applyTheme()` call, so capturing
// `color: palette.success` would freeze the card on the dark tones forever.
const STYLES: Record<TerminalKind, KindStyle> = {
  done: {
    color: (s) => palette.success(s),
    chip: '✓ Done',
    affordance: 'Objective satisfied - review evidence and close.',
  },
  blocked: {
    color: (s) => palette.error(s),
    chip: '⊘ Blocked',
    affordance: 'External dependency - unblock above to resume.',
  },
  asking: {
    color: (s) => palette.warning(s),
    chip: '? Asking',
    affordance: 'Waiting on you - answer above to continue.',
  },
  interrupted: {
    // Neutral terminal state — see verdict-ledger.ts for rationale. Meta
    // grey conveys "this happened, low salience," not "informational event."
    color: (s) => palette.meta(s),
    chip: '⏸ Interrupted',
    affordance: 'Halted with state preserved - resume when ready.',
  },
};

/**
 * Optional performance/cost metadata to show inside the verdict card.
 * All fields are optional — omit to render no stats line at all.
 */
export interface VerdictMeta {
  durationMs?: number;
  totalCostUsd?: number;
  toolCount?: number;
}

/** Format milliseconds as a compact human-readable duration string. */
function formatDuration(ms: number): string {
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return secs === 0 ? `${mins}m` : `${mins}m ${secs}s`;
}

/**
 * Build a compact dim stats string from VerdictMeta, or null when nothing
 * is worth rendering (all fields absent or zero).
 */
function buildStatsLine(meta: VerdictMeta): string | null {
  const parts: string[] = [];
  if (meta.totalCostUsd !== undefined && meta.totalCostUsd > 0) {
    parts.push(formatCost(meta.totalCostUsd));
  }
  if (meta.durationMs !== undefined && meta.durationMs > 0) {
    parts.push(formatDuration(meta.durationMs));
  }
  if (meta.toolCount && meta.toolCount > 0) {
    parts.push(`${meta.toolCount} ${meta.toolCount === 1 ? 'tool call' : 'tool calls'}`);
  }
  return parts.length > 0 ? parts.join(' · ') : null;
}

/**
 * Derive a context-specific affordance string from the terminal state.
 * Returns null to signal "use the static fallback from STYLES".
 *
 * Invariant: returned strings must be ASCII-only (same rule as STYLES
 * affordances — see note at line 37). Use `...` for truncation, NOT `…`.
 */
function deriveAffordance(state: TerminalState, innerW: number): string | null {
  let prefix: string;
  let body: string | undefined;

  switch (state.kind) {
    case 'done':
      if (!state.evidence) return null;
      prefix = 'Review: ';
      body = state.evidence;
      break;
    case 'blocked':
      if (!state.unblockCondition) return null;
      prefix = 'Unblock: ';
      body = state.unblockCondition;
      break;
    case 'asking':
      if (!state.question) return null;
      prefix = 'Answer: ';
      body = state.question;
      break;
    case 'interrupted':
      return null;
  }

  if (!body) return null;

  // When the source field contains block-level markdown (GFM tables, code
  // fences), it cannot be meaningfully compressed to a one-line affordance.
  // Fall back to the static default so the affordance row stays clean.
  if (/^\|[-| :]+\|$/m.test(body) || /^```/m.test(body)) return null;

  const budget = innerW - prefix.length;
  if (budget <= 0) return null;
  const truncated =
    displayWidth(body) > budget
      ? truncateDisplayWidth(body, budget - 3) + '...'
      : body;
  return prefix + truncated;
}

/**
 * Render the terminal-state card. Returns a multi-line string (no trailing
 * newline) that the caller writes via the configured Writer / compositor.
 *
 * The renderer prefers labelled bullets (extracted by the parser) over the
 * raw body. When no labelled fields are present, it falls back to a single
 * "summary" row containing the trimmed raw body, so the card still carries
 * meaning rather than rendering as an empty chip.
 */
export function renderVerdictCard(state: TerminalState, meta?: VerdictMeta): string {
  const style = STYLES[state.kind];

  // Invariant: every rendered row is `innerW + 6` columns wide
  //   (│ + 2 sp + content + 2 sp + │ = 6 chrome + innerW content).
  // The terminal width budget must subtract that full 6, otherwise the card
  // overflows and the terminal wraps the trailing │/╮/╯ to the next visible
  // row, producing the orphaned-gutter "broken box" rendering. Floor at 34 so
  // a 40-col terminal still emits a closed card (34 + 6 = 40). Upper bound at
  // 100 keeps the card from sprawling across very wide terminals.
  const innerW = Math.max(34, Math.min(getTerminalWidth() - 6, 100));
  const barLen = innerW + 4;

  const top =
    style.color('╭─') +
    style.color.call(null, ` ${style.chip} `) +
    style.color(
      '─'.repeat(Math.max(0, barLen - 1 - displayWidth(` ${style.chip} `))) + '╮',
    );
  const bot = style.color('╰' + '─'.repeat(barLen) + '╯');
  const pipe = style.color('│');
  const blankRow = pipe + ' '.repeat(innerW + 4) + pipe;

  const rows = collectRows(state);

  // Compute label column width so values align cleanly.
  const labelW = rows.reduce((m, r) => Math.max(m, displayWidth(r.label)), 0);
  const valueW = Math.max(8, innerW - labelW - 2);

  const lines: string[] = [top, blankRow];

  if (rows.length === 0) {
    // No structured fields parsed — the model's bullets lacked the colon
    // separator the parser needs, or it wrote free-form prose. Show up to
    // MAX_FALLBACK_LINES non-empty body lines so the card still carries the
    // substance of the verdict. Capping keeps the card from sprawling when the
    // model wrote a long paragraph; the full text is always in scrollback.
    const MAX_FALLBACK_LINES = 5;
    const bodyLines = state.rawBody
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .slice(0, MAX_FALLBACK_LINES);
    const summary =
      bodyLines.length > 0 ? bodyLines.join('\n') : `${state.kind} (no structured fields)`;
    // Keep renderCardLine's tolerance for a common malformed bold opener.
    // `** ` and `__ ` cannot open CommonMark emphasis, so the block renderer
    // would otherwise display the orphaned marker literally. The whitespace
    // guard deliberately leaves globs and identifiers untouched.
    const normalizedSummary = summary.replace(/^(?:\*\*|__)\s/, '');
    const rendered = renderMarkdownToTerminal(normalizedSummary, { maxWidth: innerW });
    const wrapped = wrapToWidth(rendered, innerW, { breakLongWords: true }).split('\n');
    for (const wl of wrapped) {
      if (wl === '') continue; // drop empty trailing lines from block terminators
      lines.push(pipe + '  ' + padDisplayRight(wl, innerW) + '  ' + pipe);
    }
  } else {
    for (const row of rows) {
      const label = palette.dim(padDisplayRight(row.label, labelW));
      const rendered = renderMarkdownToTerminal(row.value, { maxWidth: valueW });
      const wrapped = wrapToWidth(rendered, valueW, { breakLongWords: true }).split('\n');
      // Filter trailing empty lines from block-level markdown terminators
      // (e.g. tables, paragraphs emit a trailing '\n' that produces an empty
      // entry after split). Without this the card would show a blank row at
      // the bottom of every value that contained block-level markup.
      while (wrapped.length > 0 && wrapped[wrapped.length - 1] === '') wrapped.pop();
      const first = wrapped[0] ?? '';
      lines.push(
        pipe + '  ' + label + '  ' + padDisplayRight(first, valueW) + '  ' + pipe,
      );
      for (const cont of wrapped.slice(1)) {
        lines.push(
          pipe + '  ' + ' '.repeat(labelW) + '  ' + padDisplayRight(cont, valueW) + '  ' + pipe,
        );
      }
    }
  }

  lines.push(blankRow);

  // Optional stats line — dim, compact, between the structured rows and the
  // affordance. Skipped entirely when meta is absent or all fields are zero.
  if (meta) {
    const statsStr = buildStatsLine(meta);
    if (statsStr) {
      const statsLine = palette.dim(truncateDisplayWidth(statsStr, innerW));
      lines.push(pipe + '  ' + padDisplayRight(statsLine, innerW) + '  ' + pipe);
    }
  }

  // Affordance row — dim, underneath the structured rows, before the bottom
  // border. This is the one line a user scanning the transcript needs.
  const affordanceText = deriveAffordance(state, innerW) ?? style.affordance;
  const affordance = palette.dim(truncateDisplayWidth(affordanceText, innerW));
  lines.push(pipe + '  ' + padDisplayRight(affordance, innerW) + '  ' + pipe);
  lines.push(bot);

  return lines.join('\n');
}

interface Row {
  label: string;
  value: string;
}

/**
 * Translate the parsed TerminalState into the row vector the box expects.
 * Field order is fixed per kind so cards from different turns are visually
 * comparable.
 */
function collectRows(state: TerminalState): Row[] {
  const rows: Row[] = [];
  const push = (label: string, value: string | undefined) => {
    if (!value) return;
    const trimmed = value.trim();
    // Skip values that are purely residual markup noise — orphaned bold/
    // underscore markers (`**`, `****`, `__`, `____`) that survived the
    // parser's strip pass. They carry no semantic content and would render
    // as literal asterisks in the card.
    if (trimmed.length === 0 || /^(?:\*{2,4}|_{2,4})$/.test(trimmed)) return;
    rows.push({ label, value: trimmed });
  };
  switch (state.kind) {
    case 'done':
      push('done', state.whatWasDone);
      push('evidence', state.evidence);
      push('changed', state.whatChanged);
      // Skip a deferred row that merely echoes the done field — models
      // sometimes emit identical text for both, producing a confusing
      // duplicate row in the card.
      if (state.deferred?.trim() !== state.whatWasDone?.trim()) {
        push('deferred', state.deferred);
      }
      break;
    case 'blocked':
      push('blocks', state.whatBlocks);
      push('unblock', state.unblockCondition);
      push('progress', state.alreadyDone);
      break;
    case 'asking':
      push('question', state.question);
      push('resolves', state.assumption);
      push('after', state.followup);
      break;
    case 'interrupted':
      push('was doing', state.whatWasInProgress);
      push('saved at', state.stateLocation);
      push('resume', state.resumeRequires);
      break;
  }
  return rows;
}

/**
 * Compact one-line representation of a terminal state. Used by the verdict
 * ledger rail rendered above the prompt between turns. Format:
 *
 *     ✓ done           — short summary
 *     ⊘ blocked        — short summary
 *     ? asking         — short summary
 *     ⏸ interrupted    — short summary
 *
 * The summary is the first labelled field if present, else the first line of
 * the raw body, capped to a sensible width.
 */
export function summarizeVerdict(state: TerminalState, maxWidth: number): string {
  const style = STYLES[state.kind];
  const summary = pickSummary(state);
  const head = style.color(style.chip);
  const tail = summary ? palette.dim(' — ' + summary) : '';
  const composed = head + tail;
  return truncateDisplayWidth(composed, maxWidth);
}

function pickSummary(state: TerminalState): string {
  const candidates: Array<string | undefined> = [];
  switch (state.kind) {
    case 'done':
      candidates.push(state.whatWasDone, state.evidence);
      break;
    case 'blocked':
      candidates.push(state.whatBlocks, state.unblockCondition);
      break;
    case 'asking':
      candidates.push(state.question, state.assumption);
      break;
    case 'interrupted':
      candidates.push(state.whatWasInProgress, state.resumeRequires);
      break;
  }
  for (const c of candidates) {
    if (c && c.trim().length > 0) return c.trim();
  }
  const firstBody = state.rawBody.split('\n')[0]?.trim();
  return firstBody ?? '';
}
