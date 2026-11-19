/**
 * Abandoned-turn settlement for {@link TurnStreamRunner}.
 *
 * Contract: one send owns one provider turn, up to and including that turn's
 * terminal event. The provider iterator is SHARED across turns, so a consumer
 * that stops reading before the terminal event leaves the provider generator
 * parked mid-turn. Unless the session reads the rest itself, the next send
 * resumes that old turn, takes its tail and its `done` as its own, and ends
 * without running the new message; the new message stays queued in the
 * provider's input stream and every later send answers the previous one.
 *
 * History: this is the "ESC, send a message, it looks sent but nothing runs,
 * then replies are one message behind" report. The REPL soft-stop loop breaks
 * on the first event after ESC (so a slow tool cannot make ESC feel dead),
 * and `interrupt()` marks the session idle at once, so the next send was
 * accepted while the interrupted turn had not yet produced its terminal.
 * Field trace: session 830f0aa1 (2026-11-13), where the message after ESC
 * received the interrupted turn's own `done` 128 ms after it was sent.
 *
 * @module agent/session/turn-stream-runner.abandoned-turn
 */

import { debugLog } from '../../utils/debug.js';
import type { ProviderEvent } from '../provider.js';
import type { OutputEvent } from '../types.js';

/**
 * True for the provider event that ends a turn. Decided on the PROVIDER event,
 * not the transformed output: once the provider has yielded its terminal it is
 * parked between turns, and pulling again would block on the next user
 * message, so "has this turn's terminal been pulled" must never be guessed.
 */
export function isTerminalProviderEvent(event: ProviderEvent): boolean {
  return event.type === 'turn.completed' || event.type === 'error';
}

/** What `settleAbandonedTurn` needs; every member is supplied by the runner. */
export interface AbandonedTurnSettlement {
  /**
   * The iterator the abandoned turn was reading. Captured at abandonment, not
   * re-read: a session reset swaps the live iterator, and the turn to settle
   * belongs to the old one (which then simply reports `done`).
   */
  iterator: AsyncIterator<ProviderEvent>;
  /**
   * Handle one provider event exactly as the live loop does (transform,
   * accounting, Stop dispatch, ledger, broadcast) minus the yield, since the
   * consumer that would have received it is gone.
   */
  consume: (event: ProviderEvent) => Promise<OutputEvent | null>;
  /**
   * Stop the turn first. Supplied ONLY when nobody has interrupted it yet: a
   * turn with no reader must not keep running tools unobserved. Omitted when
   * the session already interrupted it, because a second request against an
   * already-aborted turn is parked by the provider and would pre-abort the
   * NEXT turn (see `AbortCoordinator.requestAbort`).
   */
  interrupt?: () => Promise<void>;
  /** Called when the turn ended without a real `done`, to record a synthetic one. */
  recordMissingDone: () => void;
}

/**
 * Read an abandoned provider turn through to its terminal event.
 *
 * Never rejects: the next send awaits this before it pushes its own message,
 * and a settlement failure must not turn into a failed send. A provider that
 * errors or closes mid-settlement ends the turn just as well.
 */
export async function settleAbandonedTurn(settlement: AbandonedTurnSettlement): Promise<void> {
  let sawDone = false;
  try {
    if (settlement.interrupt) await settlement.interrupt();
    while (true) {
      const result = await settlement.iterator.next();
      if (result.done) break;
      const terminal = isTerminalProviderEvent(result.value);
      const output = await settlement.consume(result.value);
      if (output?.type === 'done') sawDone = true;
      if (terminal) break;
    }
  } catch (err) {
    debugLog(
      `AgentSession: abandoned-turn settlement ended on an error: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  } finally {
    if (!sawDone) settlement.recordMissingDone();
  }
}
