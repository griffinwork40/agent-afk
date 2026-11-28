/**
 * Provider-turn ownership for {@link TurnStreamRunner}.
 *
 * Contract: one send owns one provider turn, up to and including that turn's
 * terminal event. {@link ProviderTurns} holds the one authoritative answer to
 * "is a provider turn still in flight?". Session state cannot answer it:
 * `idle` means "input is accepted" and flips the moment the user interrupts,
 * while the provider turn stays alive until its terminal event is pulled. Both
 * entry points consult this fact instead of the state:
 *   - a send waits until no turn is in flight before it pushes its message;
 *   - an interrupt reaches the provider at most once per turn, and only while
 *     that turn is in flight. A redundant interrupt is PARKED by the provider
 *     (`AbortCoordinator.requestAbort`) and aborts the NEXT turn before it
 *     starts, which ends the provider generator and with it the session.
 *
 * Those two questions have different answers at the end of a turn. Once the
 * terminal event is pulled the provider has nothing left to interrupt
 * (`OpenTurn.terminal`), but the session still has to finish the turn: Stop
 * hooks, then the ledger `done` and the broadcast. The turn stays in flight
 * for sends until that is done (`endTurn`), so the next turn's records never
 * land ahead of this turn's `done`.
 *
 * Invariant: the provider iterator is SHARED across turns, so a consumer that
 * stops reading before the terminal event leaves the provider generator parked
 * mid-turn. The session then reads the rest of that turn itself ("settles"
 * it); otherwise the next send would take the old turn's tail and `done` as
 * its own and end without running the new message.
 *
 * History: the "ESC, send a message, it looks sent but nothing runs, then
 * replies are one message behind" report (session 830f0aa1, 2026-11-13: the
 * message after ESC received the interrupted turn's own `done` 128 ms after it
 * was sent), and its sibling "ESC, send, ESC again: the session never answers
 * again", where the second interrupt was forwarded while the first turn was
 * still stopping.
 *
 * @module agent/session/turn-stream-runner.abandoned-turn
 */

import { debugLog } from '../../utils/debug.js';
import { SETTLE_DRAIN_TIMEOUT_MS, raceWithDrainTimeout } from '../timeout.js';
import type { ProviderEvent } from '../provider.js';
import type { OutputEvent } from '../types.js';
import type { TransformDeps } from './stream-consumer.js';
import { emitSessionPhase } from '../trace/emit.js';
import type { TraceSink } from '../trace/writer.js';

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
  /** The iterator the abandoned turn was reading. */
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
export async function settleAbandonedTurn(
  settlement: AbandonedTurnSettlement,
  traceWriter?: TraceSink,
): Promise<void> {
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
    const message = err instanceof Error ? err.message : String(err);
    debugLog(`AgentSession: abandoned-turn settlement ended on an error: ${message}`);
    // R1.7 (#5174): emit a trace event so a settlement failure is visible in
    // the witness layer. The send waiting behind this turn is unaffected —
    // settleAbandonedTurn never rejects.
    void emitSessionPhase(traceWriter, {
      phase: 'settle_error',
      metadata: { error: message.slice(0, 200) },
    });
  } finally {
    if (!sawDone) settlement.recordMissingDone();
  }
}

/** A provider turn the session started whose terminal event is not pulled yet. */
export interface OpenTurn {
  readonly deps: TransformDeps;
  readonly iterator: AsyncIterator<ProviderEvent>;
  readonly turnStartMs: number;
  /** An interrupt for this turn has already been forwarded to the provider. */
  interrupted: boolean;
  /**
   * Its terminal event has been pulled, so the provider has no turn left to
   * interrupt, though the session may still be finishing it.
   */
  terminal: boolean;
  /** Its consumer stopped reading before the terminal event. */
  abandoned: boolean;
  /** The session has started reading the rest of it. */
  settling: boolean;
  /** A `done` for this turn is in the ledger (real or synthetic). */
  doneRecorded: boolean;
  /** The ledger was sealed under this turn: discard whatever it still emits. */
  sealed: boolean;
  /**
   * A provider `error` event was seen during settlement. When true, the
   * synthetic `done` must use `buildFatalDone` rather than `buildInterruptedDone`
   * even though `settle()` sets `interrupted = true` unconditionally.
   */
  hadProviderError: boolean;
  /** Resolves once the turn's terminal event has been pulled. */
  readonly ended: Promise<void>;
  readonly markEnded: () => void;
}

/** A send that has not pushed its message to the provider yet. */
export interface PendingSend {
  /** Position in the session's send order; see {@link ProviderTurns.hasNewerSend}. */
  readonly id: number;
  cancelled: boolean;
  readonly whenCancelled: Promise<void>;
  readonly cancel: () => void;
}

/** What an interrupt request found to act on. */
export type InterruptTarget = 'provider' | 'pending-send' | 'none';

/** Runner-supplied effects; the tracker itself only keeps the bookkeeping. */
export interface ProviderTurnHooks {
  /** Handle one event exactly as the live loop does, minus the yield. */
  consume: (event: ProviderEvent, deps: TransformDeps) => Promise<OutputEvent | null>;
  interruptProvider: () => Promise<void>;
  /** Write a ledger `done` for a turn that will not record a real one. */
  recordSyntheticDone: (turn: OpenTurn) => void;
  /**
   * Optional trace sink for `session_phase` observability events (R1.7).
   * When present, `drain_timeout` is emitted on force-end and `settle_error`
   * is emitted when settlement catches a provider error. Absent in tests that
   * do not wire a trace writer.
   */
  traceWriter?: TraceSink;
}

/** Tracks the provider turn in flight and the send waiting behind it. */
export class ProviderTurns {
  private readonly hooks: ProviderTurnHooks;
  private open: OpenTurn | null = null;
  private pending: PendingSend | null = null;
  private sendSeq = 0;

  constructor(hooks: ProviderTurnHooks) {
    this.hooks = hooks;
  }

  /** The id the next `beginSend` will hand out. */
  get nextSendId(): number {
    return this.sendSeq + 1;
  }

  /**
   * True when a send was registered after send `id`. A send that waits behind
   * an earlier turn has already marked the session busy, so the earlier send
   * must not mark it idle again when its own reader finally lets go: only the
   * most recent send owns that transition.
   */
  hasNewerSend(id: number): boolean {
    return this.sendSeq > id;
  }

  /** Deps of the turn in flight, for the `beforeTurnEnd` provider seam. */
  get openDeps(): TransformDeps | null {
    return this.open?.deps ?? null;
  }

  /** Register a send. Until `startTurn`, an interrupt cancels it. */
  beginSend(): PendingSend {
    let resolve: () => void = () => {};
    const whenCancelled = new Promise<void>((r) => {
      resolve = r;
    });
    const send: PendingSend = {
      id: ++this.sendSeq,
      cancelled: false,
      whenCancelled,
      cancel: () => {
        send.cancelled = true;
        resolve();
      },
    };
    this.pending = send;
    return send;
  }

  /**
   * Resolve once the session is initialized and no provider turn is in
   * flight, or as soon as `send` is cancelled; the caller checks
   * `send.cancelled`. Rejects only if `init` rejects before either.
   */
  async untilClear(send: PendingSend, init: Promise<void> | null): Promise<void> {
    const clear = (async (): Promise<void> => {
      if (init) await init;
      await this.drain();
    })();
    // A cancelled send stops waiting, but the drain it started keeps going.
    clear.catch(() => {});
    await Promise.race([clear, send.whenCancelled]);
  }

  /** Drop a send that will not start a turn (cancelled, or its wait threw). */
  withdraw(send: PendingSend): void {
    if (this.pending === send) this.pending = null;
  }

  /** `send` is pushing its message now: its provider turn is in flight. */
  startTurn(
    send: PendingSend,
    deps: TransformDeps,
    iterator: AsyncIterator<ProviderEvent>,
    turnStartMs: number,
  ): OpenTurn {
    this.withdraw(send);
    let markEnded: () => void = () => {};
    const ended = new Promise<void>((r) => {
      markEnded = r;
    });
    const turn: OpenTurn = {
      deps,
      iterator,
      turnStartMs,
      interrupted: false,
      terminal: false,
      abandoned: false,
      settling: false,
      doneRecorded: false,
      sealed: false,
      hadProviderError: false,
      ended,
      markEnded: () => markEnded(),
    };
    this.open = turn;
    return turn;
  }

  isOpen(turn: OpenTurn): boolean {
    return this.open === turn;
  }

  /**
   * The turn's terminal event has been pulled: an interrupt must no longer be
   * forwarded for it. The turn is not over for waiting sends until `endTurn`.
   */
  markTerminal(turn: OpenTurn): void {
    turn.terminal = true;
  }

  /**
   * The session is finished with `turn`: its terminal event has been fully
   * handled (or it can produce none). Releases a send waiting behind it.
   */
  endTurn(turn: OpenTurn): void {
    if (this.open === turn) this.open = null;
    turn.markEnded();
  }

  /**
   * The consumer stopped reading `turn` before its terminal event. A turn that
   * was already interrupted is stopping, so the session reads the rest right
   * away, normally before the user has typed the next message. One nobody
   * interrupted stays parked; the next send stops it and reads it out.
   */
  abandon(turn: OpenTurn): void {
    turn.abandoned = true;
    if (turn.interrupted) void this.settle(turn);
  }

  /**
   * Decide what an interrupt request acts on, and claim it so the same thing
   * is never interrupted twice. A send still waiting to start is cancelled
   * here and never reaches the provider. `provider` means the caller must
   * forward the interrupt; `none` means there is nothing left to stop.
   */
  claimInterrupt(): InterruptTarget {
    const send = this.pending;
    if (send && !send.cancelled) {
      send.cancel();
      return 'pending-send';
    }
    const turn = this.open;
    if (turn && !turn.interrupted && !turn.terminal) {
      turn.interrupted = true;
      return 'provider';
    }
    return 'none';
  }

  /**
   * The conversation is ending (close, reset, abort): its ledger is about to
   * close. A send still waiting to start is cancelled, so it neither hangs on
   * a turn that will never end nor pushes its message into a finished
   * session. An abandoned turn that has not recorded its `done` records it
   * now, and its remaining events are kept away from a closed session or the
   * next conversation's ledger; it stays tracked so it is still read off the
   * iterator.
   */
  seal(): void {
    const send = this.pending;
    if (send && !send.cancelled) send.cancel();
    const turn = this.open;
    if (!turn || !turn.abandoned) return;
    turn.sealed = true;
    this.recordDone(turn);
  }

  /**
   * Wait until no provider turn is in flight, reading out abandoned ones.
   *
   * Each iteration races `turn.ended` against {@link SETTLE_DRAIN_TIMEOUT_MS}
   * so a provider that never yields a terminal after interrupt cannot block
   * every later send forever (R1.11, Refs #5174). On timeout the stuck turn
   * is force-ended via `endTurn`, which resolves `turn.ended` and unblocks
   * any send waiting behind it. The settlement loop (`settle`) keeps running
   * in the background and will eventually call `endTurn` itself — the extra
   * call is a no-op because `endTurn` guards on `this.open === turn`.
   */
  private async drain(): Promise<void> {
    for (let turn = this.open; turn !== null; turn = this.open) {
      if (turn.abandoned && !turn.settling) void this.settle(turn);
      await raceWithDrainTimeout(turn.ended, SETTLE_DRAIN_TIMEOUT_MS);
      // If an ABANDONED turn is still open after the timeout, record its done
      // and force-end it so the waiting send is not blocked indefinitely (the
      // settlement continues in the background and the second endTurn call is
      // a no-op). Non-abandoned turns with a live reader are NOT force-ended:
      // they are legitimately waiting and would suffer shared-iterator crossover
      // if two readers pulled from the same iterator concurrently.
      if (this.open === turn && turn.abandoned) {
        debugLog(
          `AgentSession: drain timed out after ${SETTLE_DRAIN_TIMEOUT_MS}ms waiting for an abandoned turn to end; force-ending it`,
        );
        // R1.7 (#5174): emit a trace event so a send stuck behind a provider
        // is visible in the witness layer rather than going silent.
        void emitSessionPhase(this.hooks.traceWriter, {
          phase: 'drain_timeout',
          durationMs: SETTLE_DRAIN_TIMEOUT_MS,
        });
        this.recordDone(turn);
        this.endTurn(turn);
      }
    }
  }

  private recordDone(turn: OpenTurn): void {
    if (turn.doneRecorded) return;
    turn.doneRecorded = true;
    this.hooks.recordSyntheticDone(turn);
  }

  /** Read `turn` through to its terminal event; never rejects. */
  private settle(turn: OpenTurn): Promise<void> {
    turn.settling = true;
    // A turn with no reader must not keep running unobserved, so one nobody
    // interrupted is stopped first. One already interrupted must NOT get a
    // second request (see the parking hazard in the module header).
    const interruptFirst = !turn.interrupted;
    turn.interrupted = true;
    return settleAbandonedTurn(
      {
        iterator: turn.iterator,
        consume: async (event) => {
          if (turn.sealed) return null;
          // Track whether the provider reported an error so the synthetic done
          // can distinguish a provider error from a clean interrupt (#5173 R1.3).
          if (event.type === 'error') turn.hadProviderError = true;
          const output = await this.hooks.consume(event, turn.deps);
          if (output?.type === 'done') turn.doneRecorded = true;
          return output;
        },
        ...(interruptFirst ? { interrupt: () => this.hooks.interruptProvider() } : {}),
        recordMissingDone: () => this.recordDone(turn),
      },
      this.hooks.traceWriter,
    ).finally(() => this.endTurn(turn));
  }
}
