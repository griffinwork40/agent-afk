import type { ToolResultChunk } from '../../../agent/types/message-types.js';
import { displayWidth, stripAnsi, truncateDisplayWidth } from '../../display.js';
import { formatOutcome } from './tool-lane-format.js';

/**
 * The pieces of a completed tool row's head line, kept apart so the row can be
 * fitted by priority instead of clipped blindly from the right.
 *
 *   <lead><label><sep><outcome first line><suffix>
 *   `   ` `▸ bash git fetch …` ` — ✗ ` `2 lines · exit 128` ` ∥1/2`
 */
export interface OutcomeHead {
  /** Indent / connector / spine chrome. Never truncated. */
  lead: string;
  /** The tool call (`glyph name args`). The first thing to give up width. */
  label: string;
  /** Separator plus status glyph (` — ✗ `). Never truncated. */
  sep: string;
  /** Badges appended after the outcome (batch, child-failure). Never truncated. */
  suffix?: string;
}

export interface OutcomeRowsOptions {
  /** Spine-aware indent prepended to every continuation row. */
  continuationIndent: string;
  /** Row width budget (normally `toolLaneWidth()`). */
  cols: number;
  homeDir?: string;
  toolName?: string;
}

/**
 * Width the tool label keeps before the outcome may claim more of the head
 * row: enough to recognise the call (`▸ bash git fetch -q origin…`) even when
 * the outcome is long.
 */
const LABEL_FLOOR = 24;

/** `formatOutcome` prefixes each continuation row with a 4-column gutter. */
const CONT_GUTTER_WIDTH = 4;

/** Floor for any content budget, so a pathological narrow terminal still shows text. */
const MIN_BUDGET = 20;

/**
 * Invariant: continuation rows (tail preview, hidden-lines notice) sit on
 * their OWN rows beneath the head line, so their width budget is the row
 * minus the continuation indent and gutter. It is never derived from the head
 * line's width. Deriving it from the head line (the pre-fix behaviour) gave
 * every error line the 20-column floor whenever the command itself filled the
 * row, e.g. `▌ fatal: Needed a sin…` on a 120-column terminal.
 */
export function outcomeTailWidth(cols: number, continuationIndent: string): number {
  return Math.max(MIN_BUDGET, cols - displayWidth(stripAnsi(continuationIndent)) - CONT_GUTTER_WIDTH);
}

/**
 * Fit `label` and `outcome` into `avail` columns. If both fit, neither is
 * touched. Otherwise the shorter side keeps its full width when it fits in
 * half the row, and the longer side takes what remains. When both exceed
 * half, they split the row evenly. Exported for tests.
 */
export function fitLabelAndOutcome(label: string, outcome: string, avail: number): [string, string] {
  const wl = displayWidth(stripAnsi(label));
  const wo = displayWidth(stripAnsi(outcome));
  if (wl + wo <= avail) return [label, outcome];
  const half = Math.floor(avail / 2);
  if (wo <= half) return [truncateDisplayWidth(label, avail - wo), outcome];
  if (wl <= half) return [label, truncateDisplayWidth(outcome, avail - wl)];
  return [truncateDisplayWidth(label, half), truncateDisplayWidth(outcome, avail - half)];
}

/**
 * Format a completed tool result and push its rows into `lines`: one head row
 * fitted by priority, then continuation rows at full row width.
 *
 * Priority on the head row, highest first: chrome and status glyph (`lead`,
 * `sep`, `suffix`), then the outcome headline (`2 lines · exit 128`, or the
 * single-line preview), then the tool label. Before this change the composed
 * row was clamped from the right, so a long command pushed the status glyph
 * and exit code off-screen, which is the most important information on the
 * row. Every emitted row is still clamped to `cols` as a final wrap guard.
 */
export function pushOutcomeRows(
  lines: string[],
  head: OutcomeHead,
  result: ToolResultChunk,
  opts: OutcomeRowsOptions,
): void {
  const { continuationIndent, cols } = opts;
  const suffix = head.suffix ?? '';
  const fixed = displayWidth(stripAnsi(head.lead)) +
    displayWidth(stripAnsi(head.sep)) +
    displayWidth(stripAnsi(suffix));
  const avail = Math.max(0, cols - fixed);
  const labelWidth = displayWidth(stripAnsi(head.label));
  // The single-line preview may use everything except the label's floor;
  // fitLabelAndOutcome then settles the real split.
  const previewBudget = Math.max(MIN_BUDGET, avail - Math.min(labelWidth, LABEL_FLOOR));
  const outcome = formatOutcome(
    result,
    opts.homeDir,
    previewBudget,
    opts.toolName,
    outcomeTailWidth(cols, continuationIndent),
  );
  const parts = outcome.split('\n');
  const [label, first] = fitLabelAndOutcome(head.label, parts[0] ?? '', avail);
  // truncateDisplayWidth is clampLineToTerminal's body; called directly so
  // this module never imports tool-lane-render.ts (which re-exports the
  // children module that imports this one).
  lines.push(truncateDisplayWidth(head.lead + label + head.sep + first + suffix, cols));
  for (let i = 1; i < parts.length; i++) {
    lines.push(truncateDisplayWidth(continuationIndent + parts[i]!, cols));
  }
}
