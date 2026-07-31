/**
 * Telegram stall badge for in-flight subagents.
 *
 * Telegram already reinvents a per-child summary from the same event stream
 * (`renderSubagentFooter` in ./streaming.ts) but had no notion of a child having
 * gone QUIET — that judgement existed only as private state inside the REPL
 * renderer. A Telegram operator watching a fan-out therefore could not tell a
 * healthy wave from a wedged one, which is the single question they most want
 * answered while away from the terminal.
 *
 * Lives in its own module rather than inside streaming.ts because that file is
 * ~1175 lines — far past the 350-line ceiling — so new behaviour goes beside it,
 * not into it.
 *
 * @module telegram/streaming-stall-badge
 */

import type { ActivityTracker } from '../agent/progress/activity-tracker.js';

/**
 * Silence threshold for the Telegram badge.
 *
 * Deliberately higher than the REPL's 30s: a terminal user is watching live and
 * wants early warning, whereas a Telegram push is an interruption, so the bar for
 * spending one is higher. Each surface owning its own cutoff is precisely why
 * `ActivityTracker` reports raw elapsed silence instead of a `stalled` boolean.
 */
export const TELEGRAM_STALL_THRESHOLD_MS = 60_000;

/** Format whole seconds/minutes compactly — Telegram has no width budget to spare. */
function shortDuration(ms: number): string {
  const totalSec = Math.max(0, Math.round(ms / 1000));
  if (totalSec < 60) return `${totalSec}s`;
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

/**
 * Render the badge, or `''` when nothing is stalled.
 *
 * Returning the empty string on the healthy path keeps the caller a plain
 * concatenation with no conditional — matching `renderSubagentFooter`'s existing
 * contract in streaming.ts.
 *
 * Names at most two children: the badge is an alarm, not a report, and a long
 * list in a push notification reads as noise.
 */
export function renderStallBadge(
  tracker: Pick<ActivityTracker, 'stalled'>,
  now: number = Date.now(),
  thresholdMs: number = TELEGRAM_STALL_THRESHOLD_MS,
): string {
  const stalled = tracker.stalled(thresholdMs, now);
  if (stalled.length === 0) return '';

  const named = stalled
    .slice(0, 2)
    .map((s) => `${s.agentType ?? s.subagentId} (${shortDuration(s.silentMs)})`)
    .join(', ');
  const rest = stalled.length > 2 ? ` +${stalled.length - 2} more` : '';
  const noun = stalled.length === 1 ? 'sub-agent' : 'sub-agents';
  return `\n⏳ ${stalled.length} ${noun} quiet: ${named}${rest}`;
}
