/**
 * AFK-mode system-prompt addendum — provider-neutral.
 *
 * When the session is in `'autonomous'` permission mode (AFK mode), this module
 * supplies a single text block that the provider's `composeSystem()` appends to
 * the system payload. The addendum is the *posture* half of AFK mode — its
 * companion is the hook-layer refusal in {@link module:agent/afk-mode-gate},
 * which is the *enforcement* half (the mechanical safety ceiling).
 *
 * Design notes:
 *  - The posture is **bounded autonomy, not YOLO.** It tells the model to act
 *    on reversible work without waiting, but to STOP at one-way doors
 *    (irreversible / external / genuinely ambiguous forks) and surface an
 *    Asking summary to Telegram instead of guessing. The text explicitly defers
 *    to the gate: the model is told a mechanical layer refuses high-risk ops
 *    regardless of what it decides, so it should not treat the posture as a
 *    licence to bypass safety.
 *  - The channel to the operator is Telegram via the `send_telegram` tool —
 *    `send_telegram` is the one outbound op the gate never blocks.
 *  - The block carries no `cache_control` of its own — `withSystemBreakpoint`
 *    in `cache-policy.ts` floats the breakpoint to whichever block is last, so
 *    toggling AFK mode busts the cache once (correct) and same-mode turns hit
 *    cleanly. This mirrors the plan-mode addendum's cache behaviour exactly.
 *  - AFK mode and plan mode are mutually exclusive permission modes, so at most
 *    one of the two addenda is ever appended in a turn.
 *
 * Previously located at `anthropic-direct/afk-mode-addendum.ts`. Moved here
 * because both the anthropic-direct and openai-compatible providers consume
 * these exports. The original file now re-exports from this location so
 * existing imports continue to resolve without change.
 *
 * @module agent/providers/shared/afk-mode-addendum
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';

export const AFK_MODE_ADDENDUM_TEXT = [
  '## AFK mode is active',
  '',
  'The operator is away from keyboard. Your channel to them is Telegram via the `send_telegram` tool — not this transcript, which no one is watching live. At the end of each turn, push your terminal state (Done / Blocked / Asking) to Telegram so the operator can review asynchronously.',
  '',
  'Posture — bounded autonomy, not unchecked action:',
  '  - Proceed autonomously on reversible work. Do not stop to confirm actions you are already authorized to take and can undo (edits, reads, tests, local commits, non-force pushes, installs).',
  '  - At a one-way door — anything irreversible, externally visible, credential- or payment-touching, or where multiple readings lead to materially different work — do NOT guess. Push a concise Asking summary to Telegram naming the decision and your recommended default, then stop and end the turn in the Asking state.',
  '  - A mechanical gate refuses high-risk and irreversible operations at the hook layer regardless of this text. Treat a gate refusal as a signal to surface the decision to the operator, not an obstacle to work around.',
  '',
  'Communication discipline:',
  '  - Batch updates. Send a Telegram message at terminal state (and at a genuinely blocking fork), not a play-by-play — the operator gets a push notification for every message.',
  '  - Keep pushes short and scannable: what happened, what changed, what (if anything) you need. Never paste raw tool output, logs, secrets, or full file contents into a push.',
  '',
  'Exit: the operator returns and runs `/afk off` (or Shift+Tab) to restore default permissions and terminal-channel interaction.',
].join('\n');

/**
 * Returns the addendum block when the session is in `'autonomous'` (AFK) mode,
 * else `null`. The block is a plain text content block with no `cache_control`
 * stamp (the breakpoint stamper handles cache markers).
 */
export function buildAfkModeAddendumBlock(
  mode: string | undefined,
): ContentBlockParam | null {
  if (mode !== 'autonomous') return null;
  return { type: 'text', text: AFK_MODE_ADDENDUM_TEXT };
}
