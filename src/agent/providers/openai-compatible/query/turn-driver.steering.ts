/**
 * Inter-round steering injection for the openai-compatible provider.
 *
 * Extracted from `turn-driver.ts` (350-code-line ceiling). Owns the two
 * exported functions that inject steering text and pause notes between tool
 * rounds: `applyBeforeNextRound` (raw message mutation) and
 * `applyAndSyncSteering` (full inter-round seam called by the turn driver).
 *
 * @module agent/providers/openai-compatible/query/turn-driver.steering
 */

import { emitQueuedUserMessage } from '../../../trace/emit.js';
import { PauseController, formatPauseNote } from '../../../session/pause-controller.js';
import type { TraceSink } from '../../../trace/writer.js';
import type { OpenAIMessage } from '../messages.js';
import type { TurnDriverContext } from './turn-driver.js';

/**
 * Inject inter-round steering text from `beforeNextRound()` onto the last
 * tool-result user message, mirroring anthropic-direct/loop/inter-round.ts.
 */
export function applyBeforeNextRound(
  priorTurns: OpenAIMessage[],
  steeringText: string | undefined,
  traceWriter: TraceSink | undefined,
  subagentId: string | undefined,
): void {
  if (!steeringText) return;
  const last = priorTurns.at(-1);
  // Invariant: OpenAI tool results are `role:'tool'` messages, so after an
  // ordinary tool round the tail is NOT a user message. The callback has
  // already drained the steering queue, so returning here would lose the
  // text; append a fresh user turn instead (valid after tool{} messages —
  // dispatch-append.ts uses the same shape for queued/image follow-ups).
  if (!last || last.role !== 'user') {
    priorTurns.push({ role: 'user', content: steeringText } as OpenAIMessage);
  } else if (typeof last.content === 'string') {
    last.content = last.content + '\n\n' + steeringText;
  } else if (Array.isArray(last.content)) {
    (last.content as Array<{ type: string; text: string }>).push({ type: 'text', text: steeringText });
  }
  void emitQueuedUserMessage(traceWriter, {
    jobId: subagentId ?? '',
    subagentId: subagentId ?? '',
    byteLength: Buffer.byteLength(steeringText, 'utf8'),
  });
}

/**
 * Apply inter-round steering and immediately sync the journal.
 *
 * Invariant: `dispatchAndAppend` already synced the journal at round-end, but
 * steering text appended AFTER that sync is invisible to JournalSync (same object
 * reference, no diff detected). Syncing here ensures the steering content is
 * persisted before the next model request — mirrors anthropic-direct's
 * inter-round sync (loop/inter-round.ts).
 *
 * Pause note: `consumeLastPauseDuration()` is one-shot. When a pause occurs
 * mid-turn the note is prepended here at the first round boundary after resume
 * so the model sees it before its next reply — rather than waiting for the next
 * top-level turn start (issue #4693).
 */
export function applyAndSyncSteering(ctx: TurnDriverContext): void {
  let steeringText = ctx.beforeNextRound?.();
  // Consume any pending pause duration and prepend its note.
  const pauseMs = PauseController.instance().consumeLastPauseDuration();
  const pauseNote = pauseMs !== undefined ? formatPauseNote(pauseMs) : undefined;
  if (pauseNote) {
    steeringText = steeringText ? pauseNote + '\n\n' + steeringText : pauseNote;
  }
  // Record pause time on the turn bracket so loop_end carries pausedMs.
  if (pauseMs !== undefined) ctx.turnTrace?.addPaused(pauseMs);
  applyBeforeNextRound(ctx.priorTurns, steeringText, ctx.traceWriter, ctx.opts.config.subagentId);
  if (steeringText) ctx.journal.sync(ctx.priorTurns);
}
