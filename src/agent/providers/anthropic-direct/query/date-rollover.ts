/**
 * Mid-session date-rollover refresh for the `# Environment` block.
 *
 * Invariant: the `- Date:` line the model reads must name TODAY, not the day
 * the session happened to start. The assembled system prompt is built once per
 * `provider.query()` — i.e. once per session — and re-spliced only by
 * `setCwd()` (`query/cwd-dependents.ts`), so a session that outlives local
 * midnight otherwise reports its start date for the rest of its life. That hits
 * exactly the surfaces that stay resident: an overnight REPL, the long-lived
 * Telegram bot's per-chat session, and any resumed session. One-shot `chat` and
 * daemon cron ticks are unaffected — each builds a fresh prompt.
 *
 * The refresh is gated on the RENDERED DATE STRING changing, never on the clock
 * ticking: {@link refreshEnvironmentDate} returns its input by reference on
 * every turn within the same local day, so the prompt-cache breakpoint stamped
 * on the system block is invalidated at most once per midnight crossing rather
 * than once per turn. PR #268 accepted the staleness precisely to avoid a
 * per-turn cache bust; that rationale conflated "recompute the date" with "emit
 * a different date", and only the latter costs anything. `setCwd()` already
 * re-splices this same block mid-session, so a mid-session mutation here is not
 * a new class of event.
 *
 * @module agent/providers/anthropic-direct/query/date-rollover
 */

import { formatEnvironmentDateLine } from '../../../awareness/index.js';

const ENV_ANCHOR = '# Environment\n- Working directory: ';
const DATE_PREFIX = '- Date: ';

/**
 * Return `systemPrompt` with its `# Environment` date line re-rendered for
 * `now`, or the identical string when nothing needs to change.
 *
 * Contract:
 * - Returns the input by reference when the rendered date is unchanged, when
 *   the `# Environment` anchor is absent, or when the block's shape does not
 *   match what `formatEnvironmentFragment` emits. Never throws; a prompt it
 *   cannot parse is passed through untouched, so an unrecognised shape
 *   degrades to today's (stale-date) behaviour rather than to a corrupt
 *   prompt.
 * - Rewrites exactly one line and preserves every other byte, including the
 *   trailing `- Session:` / `- Workspace:` lines and the manifest that follows.
 * - Anchors on the LAST `# Environment\n- Working directory: ` occurrence. The
 *   assembler (`query/system-prompt.ts`) always splices the real fragment
 *   second-to-last, after the operator overlay and hot memory, so a decoy block
 *   inside user-supplied text can never win.
 *
 * @param systemPrompt Assembled system prompt from `assembleSystemPrompt`.
 * @param now Clock, injectable for deterministic tests. Defaults to `new Date()`.
 * @param timeZone IANA zone; defaults to the host zone, as at assembly time.
 */
export function refreshEnvironmentDate(
  systemPrompt: string,
  now?: Date,
  timeZone?: string,
): string {
  const anchor = systemPrompt.lastIndexOf(ENV_ANCHOR);
  if (anchor === -1) return systemPrompt;

  // The cwd line runs to its own newline; the date line is the next one.
  const cwdLineEnd = systemPrompt.indexOf('\n', anchor + ENV_ANCHOR.length);
  if (cwdLineEnd === -1) return systemPrompt;

  const dateLineStart = cwdLineEnd + 1;
  if (!systemPrompt.startsWith(DATE_PREFIX, dateLineStart)) return systemPrompt;

  const nextNewline = systemPrompt.indexOf('\n', dateLineStart);
  const dateLineEnd = nextNewline === -1 ? systemPrompt.length : nextNewline;

  const current = systemPrompt.slice(dateLineStart + DATE_PREFIX.length, dateLineEnd);
  const fresh = formatEnvironmentDateLine(now ?? new Date(), timeZone);
  if (current === fresh) return systemPrompt;

  return (
    systemPrompt.slice(0, dateLineStart + DATE_PREFIX.length) +
    fresh +
    systemPrompt.slice(dateLineEnd)
  );
}
