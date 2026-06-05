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
import { renderCardLine } from '../../formatter.js';
import { wrapToWidth } from '../../wrap.js';

interface KindStyle {
  color: (s: string) => string;
  chip: string;
  affordance: string;
}

const STYLES: Record<TerminalKind, KindStyle> = {
  done: {
    color: palette.success,
    chip: '✓ Done',
    affordance: 'Objective satisfied — review evidence and close.',
  },
  blocked: {
    color: palette.error,
    chip: '⊘ Blocked',
    affordance: 'External dependency — unblock above to resume.',
  },
  asking: {
    color: palette.warning,
    chip: '? Asking',
    affordance: 'Waiting on you — answer above to continue.',
  },
  interrupted: {
    // Neutral terminal state — see verdict-ledger.ts for rationale. Meta
    // grey conveys "this happened, low salience," not "informational event."
    color: palette.meta,
    chip: '⏸ Interrupted',
    affordance: 'Halted with state preserved — resume when ready.',
  },
};

/**
 * Render the terminal-state card. Returns a multi-line string (no trailing
 * newline) that the caller writes via the configured Writer / compositor.
 *
 * The renderer prefers labelled bullets (extracted by the parser) over the
 * raw body. When no labelled fields are present, it falls back to a single
 * "summary" row containing the trimmed raw body, so the card still carries
 * meaning rather than rendering as an empty chip.
 */
export function renderVerdictCard(state: TerminalState): string {
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
    // No structured fields parsed. Item #9: synthesize a single-line summary
    // from the first non-empty rawBody line rather than dumping all prose into
    // the card — the card is a glance surface, not a prose viewer. The full
    // assistant text is already in scrollback above this card.
    //
    // Using the first non-empty line (not the whole body) keeps the card
    // compact on long unstructured responses (e.g. the model wrote a paragraph
    // as its verdict body — a common failure mode when the system prompt isn't
    // followed strictly). Full prose remains readable in scrollback.
    const firstLine = state.rawBody.split('\n').find(l => l.trim().length > 0)?.trim() ?? '';
    const summary = firstLine.length > 0 ? firstLine : `${state.kind} (no structured fields)`;
    const wrapped = wrapToWidth(renderCardLine(summary), innerW).split('\n');
    for (const wl of wrapped) {
      lines.push(pipe + '  ' + padDisplayRight(wl, innerW) + '  ' + pipe);
    }
  } else {
    for (const row of rows) {
      const label = palette.dim(padDisplayRight(row.label, labelW));
      const wrapped = wrapToWidth(renderCardLine(row.value), valueW).split('\n');
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
  // Affordance row — dim, underneath the structured rows, before the bottom
  // border. This is the one line a user scanning the transcript needs.
  const affordance = palette.dim(truncateDisplayWidth(style.affordance, innerW));
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
    if (value && value.trim().length > 0) rows.push({ label, value: value.trim() });
  };
  switch (state.kind) {
    case 'done':
      push('done', state.whatWasDone);
      push('evidence', state.evidence);
      push('deferred', state.deferred);
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
