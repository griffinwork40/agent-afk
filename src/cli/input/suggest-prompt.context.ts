/**
 * Structured context extraction for the empty-prompt suggestion.
 *
 * Split from `./suggest-prompt` so the prompt builder stays under the
 * 350-code-line ceiling. This module owns two concerns:
 * 1. Extracting the terminal-state block (Done/Blocked/Asking/Interrupted)
 *    from a verbose assistant response.
 * 2. Condensing all user messages into a compact workflow-arc string.
 *
 * Both are pure functions — no provider, no lifecycle, no IO.
 *
 * @module cli/input/suggest-prompt.context
 */

import type { SuggestContext } from './suggest-types.js';

/** Budget for the terminal-state block extracted from the assistant's last response. */
const OUTCOME_BUDGET = 600;

/**
 * Budget for the user-arc section (all user messages, truncated individually).
 * Enough to see the session trajectory; small enough to stay cheap.
 */
const ARC_BUDGET = 400;

/** Per-message cap within the user arc to keep individual entries short. */
const ARC_PER_MESSAGE_CAP = 80;

/** Max user-arc messages to include before the arc itself is truncated. */
const ARC_MAX_MESSAGES = 8;

/**
 * Extract the terminal-state block (Done/Blocked/Asking/Interrupted) from the
 * assistant's last response. Falls back to the last portion of the response
 * when no terminal-state heading is found — the final paragraph is still more
 * informative than the opening narration the old raw-slice approach returned.
 */
export function extractOutcome(assistantText: string): string {
  if (assistantText.trim().length === 0) return '';

  // Invariant: terminal-state headings are **bold markdown** at the END of
  // the response. A response may contain an earlier corrected verdict followed
  // by the real final verdict, so we must find the LAST match, not the first.
  const terminalPattern = /\n\*\*(?:Done|Blocked|Asking|Interrupted)\*\*\s*\n/gi;
  let match: RegExpExecArray | null;
  let lastMatch: RegExpExecArray | null = null;
  while ((match = terminalPattern.exec(assistantText)) !== null) {
    lastMatch = match;
  }
  if (lastMatch) {
    const block = assistantText.slice(lastMatch.index).trim();
    return block.slice(0, OUTCOME_BUDGET);
  }

  // No terminal-state heading found — take the last OUTCOME_BUDGET chars.
  // The tail is more likely to contain the conclusion than the head.
  if (assistantText.length <= OUTCOME_BUDGET) return assistantText.trim();
  return assistantText.slice(-OUTCOME_BUDGET).trim();
}

/**
 * Build a condensed arc of all user messages this session. Each message is
 * truncated to keep the total compact. Returns an empty string when no arc
 * data is available.
 */
export function buildUserArc(ctx: SuggestContext): string {
  const messages = ctx.getUserArc?.();
  if (!messages || messages.length === 0) return '';

  // Take the most recent N messages. Iterate newest-first so that when the
  // budget is exhausted, the NEWEST messages survive (not the oldest). The
  // retained entries are then reversed back to chronological order for display.
  const recent = messages.slice(-ARC_MAX_MESSAGES);
  let total = 0;
  const kept: string[] = [];
  for (let i = recent.length - 1; i >= 0; i--) {
    const msg = recent[i]!;
    const truncated =
      msg.length > ARC_PER_MESSAGE_CAP ? msg.slice(0, ARC_PER_MESSAGE_CAP) + '…' : msg;
    if (total + truncated.length > ARC_BUDGET) break;
    kept.push(truncated);
    total += truncated.length;
  }
  kept.reverse();
  return kept.join(' → ');
}
