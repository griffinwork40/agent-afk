/**
 * Success-path helper for SubagentHandleImpl.run: pending-message drain
 * and lifecycle emission after the initial turn completes.
 *
 * Extracted from handle.ts to bring SubagentHandleImpl.run under the
 * 200-line function ceiling (refs #1865).
 *
 * @module agent/subagent/handle.run-success
 */

import type { SubagentProgressSink } from '../types/session-types.js';
import type { Message } from '../types.js';
import { emitSuccessfulHandoff } from './capped-handoff.js';
import { takeUnreportedBilling } from './handle.billing.js';
import { streamToFinalMessage } from './handle.streaming.js';
import type { SubagentHandleImpl } from './handle.js';

/**
 * Drain any pending user messages queued via sendMessage(), emit the
 * succeeded lifecycle event, propagate usage/cost to the parent, call
 * _onTerminal(), and return the final message.
 *
 * Ordering invariants preserved (must match the inline code they replace):
 *   1. Drain loop runs with _drainingMessages=true so sendMessage() accepts
 *      pushes while status is already 'succeeded'.
 *   2. emitSuccessfulHandoff is awaited BEFORE _onTerminal() to guarantee the
 *      succeeded trace event is persisted before any writer.seal() can run.
 *   3. onSubagentSucceeded fires synchronously before _onTerminal() so the
 *      session_sealed rollup always captures this subagent's contribution.
 */
export async function drainAndEmitSuccess(
  handle: SubagentHandleImpl<unknown>,
  firstMsg: Message,
  startTime: number,
  sinkOverride: SubagentProgressSink | undefined,
): Promise<Message> {
  // Item 7: Drain pending user messages queued via sendMessage(). Each
  // message starts a new turn in the same subagent conversation.
  // driveTurns already supports multi-turn; we just keep calling
  // streamToFinalMessage with each queued message. _onTerminal is
  // deferred so the handle stays in the active map while draining.
  // Status stays 'succeeded' during drain (no flip back to 'running').
  let lastMsg = firstMsg;
  // FIX-2: Open the drain window so sendMessage() can still accept
  // pushes while status is 'succeeded'.
  handle._drainingMessages = true;
  try {
    while (handle._pendingUserMessages.length > 0) {
      // Item 7c: abort-signal guard — stop draining if cancelled.
      if (handle._controller.signal.aborted) break;
      const next = handle._pendingUserMessages.shift()!;
      lastMsg = await streamToFinalMessage(handle, next, sinkOverride);
      handle._lastMessage = lastMsg.content;
      handle._currentTrace.turnCount++;
    }
  } catch {
    // Item 7b: drain error — clear remaining queue and fall through to
    // lifecycle events, which will use accumulated usage/cost so far.
    handle._pendingUserMessages.length = 0;
  }
  // FIX-2: Close the drain window — subsequent sendMessage() calls after
  // the drain loop completes are dropped as normal terminal-state messages.
  handle._drainingMessages = false;

  // Item 7a: Emit lifecycle + propagate usage AFTER all drain turns so
  // turnCount and cost reflect the full conversation.
  //
  // Witness layer: subagent_lifecycle.succeeded MUST be awaited before
  // onTerminal(). onTerminal() may trigger the owning session's immediate
  // teardown, which calls writer.seal(); once sealed, writer.write() throws
  // and emitSubagentLifecycle swallows it, silently dropping this terminal
  // record (the "lost terminal trace event" orphan bug). Awaiting here
  // guarantees the succeeded event is enqueued+persisted on the writer's
  // FIFO queue BEFORE any seal can run. Safe: write() is a bounded FS append
  // and emitSubagentLifecycle already swallows errors, so the await cannot
  // introduce a new failure mode or an unbounded hang.
  await emitSuccessfulHandoff(handle, lastMsg, startTime);
  // Propagate usage and cost to the parent session's rollup accumulators.
  // Fire synchronously before onTerminal() so the session_sealed event
  // always captures this subagent's contribution even if onTerminal()
  // triggers an immediate session teardown.
  //
  // `lastMsg` reflects the final drain turn (or the initial turn when no
  // drain occurred). `lastMsg.metadata.totalCostUsd` is populated by the
  // provider's stream-consumer (turn.completed retroactively mutates the
  // assistant message's metadata in place — see stream-consumer.ts), so by
  // the time `run()` reads `lastMsg` here the cost is present for providers
  // that report it. It is `undefined` for backends without pricing data,
  // which `recordSubagentCompletion` already tolerates.
  const costUsd =
    typeof lastMsg.metadata?.totalCostUsd === 'number' ? lastMsg.metadata.totalCostUsd : undefined;
  // Billing (#3878) spans every turn of the run, initial + drain turns.
  // `_currentTrace.usage` also carries the run's cumulative `billing`; strip
  // it and attach only the UNREPORTED delta (handle.billing.ts): a cancel()
  // that landed during the awaits above may already have settled part of it.
  // Taking the delta records it as reported, so a later cancel()/failure
  // reports only spend that accrues after this point — counted exactly once.
  const { billing: _traceBilling, ...legacy } = handle._currentTrace.usage ?? {};
  const billing = takeUnreportedBilling(handle);
  const usage = handle._currentTrace.usage === undefined && billing === undefined ? undefined : legacy;
  handle.onSubagentSucceeded?.(billing !== undefined ? { ...usage, billing } : usage, costUsd);

  handle._onTerminal();
  return lastMsg;
}
