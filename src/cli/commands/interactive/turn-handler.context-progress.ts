/**
 * Context-progress throttle helper extracted from turn-handler.ts.
 *
 * Fires `onContextProgress` at most once per CONTEXT_PROGRESS_MIN_INTERVAL_MS
 * on each tool_result so the status line gets fresh context-usage data without
 * hammering the SDK on every tool call. Async — awaits the callback when it
 * returns a Promise (the typical case: a quota / sampler cache refresh).
 *
 * Extracted to keep turn-handler.ts within its code-line baseline.
 */

import { isDebugEnabled } from '../../../utils/debug.js';
import { palette } from '../../palette.js';

export const CONTEXT_PROGRESS_MIN_INTERVAL_MS = 3_000;

/**
 * Throttled context-progress tick. Returns the new `lastContextProgressMs`
 * timestamp (updated when the callback fires, unchanged when throttled).
 *
 * @param onContextProgress - callback from TurnHandles; absent when not wired.
 * @param lastMs            - timestamp of the last callback invocation.
 */
export async function tickContextProgress(
  onContextProgress: (() => void | Promise<void>) | undefined,
  lastMs: number,
): Promise<number> {
  if (!onContextProgress) return lastMs;
  const now = Date.now();
  if (now - lastMs < CONTEXT_PROGRESS_MIN_INTERVAL_MS) return lastMs;
  try {
    const r = onContextProgress();
    if (r instanceof Promise) await r;
  } catch (err) {
    // Best-effort: never let a status refresh break the turn.
    if (isDebugEnabled()) {
      console.error('  ' + palette.error('onContextProgress (status refresh) failed:'), err);
    }
  }
  return now;
}
