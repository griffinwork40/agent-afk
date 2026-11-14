/**
 * Handles `notice` output events in the interactive turn stream.
 *
 * Extracted from turn-handler.stream-events.ts to keep that file within the
 * 350-code-line ceiling. Specifically handles `model-fallback` notices, which
 * require updating `stats.model` so the status line, `/info`, and `/where`
 * immediately reflect the new model the session switched to.
 *
 * @module cli/commands/interactive/turn-handler.notice
 */

import type { OutputEvent } from '../../../agent/types.js';
import type { SessionStats } from '../../slash/types.js';
import type { TurnHandles } from './shared.js';

/** Narrowed type for the `notice` output event. */
export type NoticeEvent = Extract<OutputEvent, { type: 'notice' }>;

/**
 * Handle a `notice` event in the interactive turn stream.
 *
 * For `model-fallback` notices: updates `stats.model` to `fallback.to` so
 * every reader of `stats.model` (status line, `/info`, `/where`) is current,
 * then fires `h.onModelFallback` so the REPL repaints the status line.
 *
 * All other notice kinds are no-ops here — the renderer's generic notice path
 * handles their display.
 *
 * Contract: `h.onModelFallback` is best-effort; errors are swallowed.
 */
export function handleNoticeEvent(
  event: NoticeEvent,
  stats: SessionStats,
  h: Pick<TurnHandles, 'onModelFallback'>,
): void {
  if (event.kind === 'model-fallback' && event.fallback) {
    stats.model = event.fallback.to as SessionStats['model'];
    try { h.onModelFallback?.(event.fallback.to); } catch { /* best-effort */ }
  }
}
