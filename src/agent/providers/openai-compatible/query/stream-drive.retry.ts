/**
 * Shared emit-and-sleep helper for the three retry-backoff sites in
 * {@link driveStream}.
 *
 * Each retry site needs to:
 *   1. fire a `rate_limit` session-phase trace event,
 *   2. sleep for the computed delay (aborting early on the caller's signal), and
 *   3. return whether the outer signal was aborted during the sleep.
 *
 * Extracted from stream-drive.ts to bring {@link driveStream} under the 200-line
 * function ceiling. All parameters are explicit — no closure over locals.
 *
 * @module agent/providers/openai-compatible/query/stream-drive.retry
 */

import { emitSessionPhase } from '../../../trace/emit.js';
import type { TraceSink } from '../../../trace/index.js';
import { sleepWithAbort } from '../../shared/sleep-with-abort.js';

/**
 * Emit a `rate_limit` session-phase event and sleep for `delayMs`.
 *
 * @param traceWriter   - The session trace sink (may be undefined).
 * @param resolvedModel - The model name for the trace event.
 * @param delayMs       - How long to sleep.
 * @param sleepSignal   - Signal to abort the sleep early (watchdog or user).
 * @param userSignal    - The turn-level user abort signal checked after sleep.
 * @param meta          - Metadata attached to the trace event.
 * @returns `true` when the user signal was aborted after (or during) the sleep,
 *   meaning the caller must `return null`. `false` when the sleep completed
 *   cleanly and the retry should proceed.
 */
export async function emitAndSleepRetry(
  traceWriter: TraceSink | undefined,
  resolvedModel: string,
  delayMs: number,
  sleepSignal: AbortSignal,
  userSignal: AbortSignal,
  meta: Record<string, string | number | boolean>,
): Promise<boolean> {
  void emitSessionPhase(traceWriter, {
    phase: 'rate_limit',
    durationMs: delayMs,
    resolvedModel,
    metadata: meta,
  });
  await sleepWithAbort(delayMs, sleepSignal);
  return userSignal.aborted;
}
