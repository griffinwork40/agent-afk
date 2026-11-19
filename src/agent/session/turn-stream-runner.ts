/**
 * Turn-stream execution, extracted from {@link AgentSession}.
 *
 * Owns the cluster of methods that constitute a single outbound provider turn:
 *   - `buildTransformDeps()` — wires per-turn callbacks into the stream consumer
 *   - `runStream()` — the core `sendMessageStreamInternal` loop
 *   - `assertCanSend()` — pre-turn guard (state, abort, maxTurns)
 *   - `summarize()` — content-block-array → history-string collapse
 *   - `withPendingContext()` — FIFO drain of queued framework context
 *   - `ensureLedger()` — lazy ledger-writer creation on first turn
 *
 * No back-reference to {@link AgentSession}: all mutable state is accessed
 * through the {@link TurnRunnerDeps} context supplied at construction.
 *
 * @module agent/session/turn-stream-runner
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { AbortError } from '../../utils/errors.js';
import { debugLog } from '../../utils/debug.js';
import { buildFatalDone } from './turn-stream-runner.fatal-done.js';
import {
  isTerminalProviderEvent,
  settleAbandonedTurn,
} from './turn-stream-runner.abandoned-turn.js';
import { transformProviderEvent, type TransformDeps } from './stream-consumer.js';
import type { AccountingAccumulator } from './accounting-accumulator.js';
import type { LedgerLifecycle } from './ledger-lifecycle.js';
import type { OutputBroadcast } from './output-broadcast.js';
import type { SessionStateManager } from './session-state.js';
import type {
  AgentConfig,
  OutputEvent,
  ResponseMetadata,
  SessionState,
} from '../types.js';
import type { ProviderQuery, ProviderEvent } from '../provider.js';
import type { Message } from '../types.js';
import type { ToolEventMin } from '../done-evidence.js';
import { dispatchTurnStop } from './turn-stream-runner.stop.js';
import type { StopWiring } from '../types/session-types.js';

/**
 * Cost already counted against `maxBudgetUsd`: own turns + completed subagents,
 * summed across ALL lifecycle cycles so a REPL `/clear` does not re-zero the
 * budget (#3882 cause 4).
 */
function seededBudgetCost(accounting: AccountingAccumulator): number {
  const acct = accounting.snapshot();
  return acct.lifetimeSessionCostUsd + acct.lifetimeSubagentCostUsd;
}

/**
 * Context bag passed to {@link TurnStreamRunner} at construction.
 * Most mutable fields are accessed via their owning objects — no raw
 * primitive refs that would diverge on reset. Exception: `conversationHistory`
 * is a raw array reference, but this is safe because the runner is always
 * reconstructed when the history array is replaced on reset, so the ref can
 * never point to a stale array.
 */
export interface TurnRunnerDeps {
  getConfig: () => AgentConfig;
  getAbortController: () => AbortController;
  getProviderIterator: () => AsyncIterator<ProviderEvent>;
  stateManager: SessionStateManager;
  accounting: AccountingAccumulator;
  ledger: LedgerLifecycle;
  outputBroadcast: OutputBroadcast;
  conversationHistory: Message[];
  getInitPromise: () => Promise<void> | null;
  getSessionId: () => string | undefined;
  getState: () => SessionState;
  setState: (s: SessionState) => void;
  getLastResponseMetadata: () => ResponseMetadata | null;
  setLastResponseMetadata: (m: ResponseMetadata) => void;
  getPendingFrameworkContext: () => string[];
  setPendingFrameworkContext: (v: string[]) => void;
  getInboundMessageCount: () => number;
  incInboundMessageCount: () => number;
  getTurnCount: () => number;
  incTurnCount: () => void;
  getProviderQuery: () => ProviderQuery;
  getLedgerMetadata: () => ReturnType<SessionStateManager['getSessionMetadata']>;
  /**
   * Optional raw provider-event observer, called in stream order BEFORE the
   * event is transformed. Feeds the `exit_plan_mode` visible-text gate
   * (`PlanTextTracker.observe`); must be synchronous and must not throw.
   */
  observeProviderEvent?: (event: ProviderEvent) => void;
  /**
   * The surface's CURRENT Stop wiring, read at every turn end (surfaces wire
   * after construction). `undefined` means the surface has not opted in and
   * Stop is not dispatched.
   */
  getStopWiring?: () => StopWiring | undefined;
}

/** A provider turn whose consumer stopped reading before its terminal event. */
interface AbandonedTurn {
  deps: TransformDeps;
  /**
   * The iterator and provider query the turn ran on, captured at abandonment
   * so settlement never acts on a provider the session swapped in later. An
   * interrupt sent to a provider with no turn in flight is parked and
   * pre-aborts that provider's next turn.
   */
  iterator: AsyncIterator<ProviderEvent>;
  providerQuery: ProviderQuery;
  turnStartMs: number;
  /** A `done` for this turn is already in the ledger (real or synthetic). */
  doneRecorded: boolean;
  /** The ledger was sealed under this turn: discard whatever it still emits. */
  sealed: boolean;
}

/**
 * Runs a single provider-turn stream, accumulates output events, and yields
 * each {@link OutputEvent}. Constructed once per session; `deps.getProviderIterator()`
 * is re-read on every call so the runner works across resets.
 */
export class TurnStreamRunner {
  private readonly deps: TurnRunnerDeps;
  /**
   * Mutable ref to the active turn's `TransformDeps`. Set when a turn starts,
   * cleared when it ends. Exposed via `getActiveTurnToolEvents()` so the
   * `beforeTurnEnd` provider seam (issue #2714) can read the tool events the
   * session has already accumulated for the in-flight turn.
   *
   * Ordering invariant: the provider calls `beforeTurnEnd` AFTER all tool
   * output events for the turn have been yielded (tool rounds complete before
   * the model emits its final `end_turn`). The session processes those tool
   * events via `transformProviderEvent` before the provider yields
   * `turn.completed`, so `_activeDeps._turnToolEvents` is fully populated by
   * the time the provider calls this seam.
   */
  private _activeDeps: TransformDeps | null = null;
  /**
   * The abandoned turn that has not reached its terminal event yet, if any:
   * either being settled right now (`settling` set) or parked until the next
   * send. See turn-stream-runner.abandoned-turn.ts.
   */
  private abandoned: AbandonedTurn | null = null;
  /** In-flight settlement of `abandoned`; null when it is parked or absent. */
  private settling: Promise<void> | null = null;

  constructor(deps: TurnRunnerDeps) {
    this.deps = deps;
    // Every seal path (close, reset, abort) must leave the ledger with this
    // turn's `done`, even when settlement has not finished (#4830).
    deps.ledger.setBeforeSeal(() => this.sealAbandonedTurn());
  }

  /** Return the current turn's accumulated tool events, or [] when no turn is active. */
  getActiveTurnToolEvents(): readonly ToolEventMin[] {
    return (this._activeDeps as { _turnToolEvents?: ToolEventMin[] } | null)?._turnToolEvents ?? [];
  }

  /** Pre-turn guard: throws when the session cannot accept a new message. */
  assertCanSend(): void {
    const { getState, getAbortController, getConfig, getTurnCount, accounting } = this.deps;
    const state = getState();
    if (state === 'closed') throw new Error('Cannot send message: session is closed');
    if (getAbortController().signal.aborted) {
      throw new AbortError('Cannot send message: session aborted');
    }
    if (state === 'processing' || state === 'streaming' || state === 'compacting') {
      throw new Error('Cannot send message: session is busy');
    }
    const config = getConfig();
    if (config.maxTurns && getTurnCount() >= config.maxTurns) {
      // Origin signal for `max_turns_exceeded`: the throw surfaces as a
      // generic dispatch error; flag the cause for closure classification.
      accounting.markMaxTurnsHit();
      throw new Error(`Maximum turns (${config.maxTurns}) exceeded`);
    }
  }

  /** Collapse a content-block array into a single history summary string. */
  summarize(blocks: ContentBlockParam[]): string {
    const textParts: string[] = [];
    let imageCount = 0;
    for (const block of blocks) {
      if (block.type === 'text') textParts.push(block.text);
      else if (block.type === 'image') imageCount++;
    }
    let summary = textParts.join(' ');
    if (imageCount > 0) {
      summary = summary
        ? `${summary} [+ ${imageCount} image(s)]`
        : `[+ ${imageCount} image(s)]`;
    }
    return summary || '[content block(s)]';
  }

  /**
   * Drain queued framework context, prepending it to the outbound content
   * (FIFO). Clears the queue so context is delivered exactly once.
   */
  withPendingContext(
    content: string | ContentBlockParam[],
  ): string | ContentBlockParam[] {
    const { getPendingFrameworkContext, setPendingFrameworkContext } = this.deps;
    const pending = getPendingFrameworkContext();
    if (pending.length === 0) return content;
    const prefix = pending.join('\n\n');
    setPendingFrameworkContext([]);
    if (typeof content === 'string') return `${prefix}\n\n${content}`;
    return [{ type: 'text', text: prefix }, ...content];
  }

  /** Create the session ledger writer on first use. */
  ensureLedger(): void {
    const { getConfig, getSessionId, ledger, getLedgerMetadata } = this.deps;
    const config = getConfig();
    ledger.ensure({
      depth: config.depth,
      parentSessionId: config.parentSessionId,
      sessionId: getSessionId(),
      fallbackModel: String(config.model),
      tracePath: config.traceWriter?.getTracePath(),
      getMetadata: getLedgerMetadata,
      credentialSource: config.credentialSource,
    });
  }

  /**
   * Build the per-turn `TransformDeps` bag that wires session callbacks into
   * the stream consumer. A fresh instance per turn prevents cross-turn
   * state leakage (the `_successfulToolNames` accumulator is turn-scoped).
   */
  buildTransformDeps(): TransformDeps {
    const {
      getConfig,
      getAbortController,
      stateManager,
      accounting,
      setLastResponseMetadata,
      conversationHistory,
    } = this.deps;
    const config = getConfig();
    return {
      // Fresh per-turn accumulator for successful tool names (see
      // TransformDeps._successfulToolNames). Initialized here — one deps
      // object per turn — so it never leaks across turns.
      _successfulToolNames: [],
      conversationHistory,
      getSessionMetadata: () => stateManager.getSessionMetadata(),
      setSessionMetadata: (updater) => stateManager.setSessionMetadata(updater),
      updateSessionIdentity: (sid) => stateManager.updateSessionIdentity(sid),
      resolveInitialization: () => stateManager.resolveInitializationOnce(),
      setLastResponseMetadata: (m) => {
        setLastResponseMetadata(m);
        // Mirror per-turn cost/token/stopReason into the session-wide
        // accumulator so the trace writer's `session_sealed` payload
        // reports cumulative spend.
        accounting.recordTurnMetadata(m);
      },
      // Budget enforcement (C6): wire maxBudgetUsd from config so the
      // stream consumer can abort when cumulative cost crosses the ceiling.
      maxBudgetUsd: config.maxBudgetUsd,
      // Tree budget (#3442): seed the per-turn accumulator with everything
      // already spent (prior turns + completed subagents) so the ceiling is
      // cumulative across turns and shared with the subagent tree.
      ...(config.maxBudgetUsd !== undefined ? { _runningCostUsd: seededBudgetCost(accounting) } : {}),
      abortBudget: (reason) => {
        const ctrl = getAbortController();
        if (!ctrl.signal.aborted) ctrl.abort(reason);
      },
      // Witness layer: thread the writer so the stream consumer can emit
      // the `budget` trace event on the turn that crosses maxBudgetUsd.
      ...(config.traceWriter ? { traceWriter: config.traceWriter } : {}),
    };
  }

  /**
   * Core turn-stream loop: pushes `content` onto the input stream, drains
   * the provider iterator for this turn's events, and yields each
   * {@link OutputEvent}. Awaits `initPromise` first so the session id exists.
   *
   * Corresponds to `AgentSession.sendMessageStreamInternal`.
   */
  async *runStream(
    content: string | ContentBlockParam[],
    inputStream: { pushUserMessage: (c: string | ContentBlockParam[]) => void },
  ): AsyncIterableIterator<OutputEvent> {
    const initPromise = this.deps.getInitPromise();
    if (initPromise) await initPromise;

    // Contract: one send owns one provider turn. Finish any turn a previous
    // consumer abandoned BEFORE this message is pushed, so this send can only
    // ever read its own turn's events.
    await this.settlePreviousTurn();

    const effectiveContent = this.withPendingContext(content);
    const historySummary =
      typeof effectiveContent === 'string'
        ? effectiveContent
        : this.summarize(effectiveContent);

    const userMessage: Message = {
      role: 'user',
      content: historySummary,
      timestamp: new Date(),
    };
    this.deps.conversationHistory.push(userMessage);
    inputStream.pushUserMessage(effectiveContent);

    this.ensureLedger();
    // `content` is the caller's own message; `effectiveContent` may carry
    // drained framework context in front of it. Record both so the web
    // session list can title the session from what the user actually typed.
    const inputSummary = typeof content === 'string' ? content : this.summarize(content);
    this.deps.ledger.recordUser(historySummary, inputSummary);

    this.deps.incInboundMessageCount();

    const deps = this.buildTransformDeps();
    // Expose this turn's deps via _activeDeps so the beforeTurnEnd provider
    // seam can read _turnToolEvents (stop-hook-continuation rule, issue #2714).
    this._activeDeps = deps;

    // Finding 2: reset the per-turn runtime flag so the guard below
    // correctly distinguishes "seam fired this turn" from a prior turn.
    const wiring = this.deps.getStopWiring?.();
    if (wiring) wiring.stopDispatchedBySeam = false;

    // Invariant (#4830): exactly one terminal `done` per turn. The normal path
    // yields `done` from `handleTurnCompleted`. Fatal paths (provider 4xx,
    // stream stall, connection error, budget ceiling) emit `error` and exit
    // without a `done`, leaving cost/duration/stopReason unrecorded. The
    // `finally` block below records a synthetic `done` to the ledger ONLY on
    // those paths. Contract: live stream consumers keep `error` as their single
    // terminal (unchanged from main); the ledger gets exactly one `done` per
    // turn so events.jsonl readers always record cost/duration/stopReason.
    let doneYielded = false;
    // Whether THIS turn's terminal provider event has been pulled, and whether
    // the loop itself threw. Reaching `finally` with neither means the consumer
    // closed the stream mid-turn: the turn is abandoned and must be settled.
    let terminalPulled = false;
    let threw = false;
    let turnIterator: AsyncIterator<ProviderEvent> | null = null;

    // Record the wall-clock start of this turn so the synthetic `done` can
    // carry a partial elapsed duration even when the provider never reported one.
    const turnStartMs = Date.now();

    try {
      while (true) {
        turnIterator = this.deps.getProviderIterator();
        const result = await turnIterator.next();
        if (result.done) {
          terminalPulled = true;
          break;
        }
        // Set before the event is handled or yielded: a consumer may close the
        // stream exactly at the terminal yield, which is a completed turn.
        const terminal = isTerminalProviderEvent(result.value);
        if (terminal) terminalPulled = true;
        const output = await this.consumeProviderEvent(result.value, deps);
        if (output) {
          if (output.type === 'done') doneYielded = true;
          yield output;
        }
        if (terminal) break;
      }
    } catch (err) {
      threw = true;
      throw err;
    } finally {
      const stateAtExit = this.deps.getState();
      // Invariant: `finally` is the ONLY path an aborted or timed-out child
      // takes — closing the generator runs it while `break` does not reach it.
      if (stateAtExit === 'streaming') {
        this.deps.setState('idle');
      }
      const abandoned =
        !terminalPulled && !threw && turnIterator !== null && stateAtExit !== 'closed';
      if (abandoned && turnIterator !== null) {
        // The real `done` is recorded by the settlement, so no synthetic one
        // here (#4830: exactly one `done` per turn).
        this.abandonTurn(
          {
            deps,
            iterator: turnIterator,
            providerQuery: this.deps.getProviderQuery(),
            turnStartMs,
            doneRecorded: false,
            sealed: false,
          },
          stateAtExit,
        );
      } else {
        // Clear the active deps ref when the turn ends (clean, abort, or error).
        this._activeDeps = null;
        // Invariant (#4830): ledger gets exactly one `done` per turn. When the
        // loop exits via a fatal path (provider 4xx, stream stall, connection
        // error, budget ceiling, or any unhandled throw) `doneYielded` is still
        // false. Record a synthetic `done` to the ledger ONLY — no yield, no
        // outputBroadcast push — so live stream consumers keep `error` as their
        // single terminal while events.jsonl readers always see a `done` with
        // stopReason / durationMs. See turn-stream-runner.fatal-done.ts for the
        // stopReason mapping.
        if (!doneYielded) this.recordSyntheticDone(turnStartMs);
      }
    }
  }

  /**
   * Handle one provider event: transform, per-turn accounting, Stop dispatch,
   * ledger, broadcast. Returns the output to yield, or null. Shared by the live
   * loop and abandoned-turn settlement so a turn's events are processed the
   * same way whether or not a consumer is still reading.
   */
  private async consumeProviderEvent(
    event: ProviderEvent,
    deps: TransformDeps,
  ): Promise<OutputEvent | null> {
    this.deps.observeProviderEvent?.(event);
    const output = transformProviderEvent(event, deps);
    if (!output) return null;

    if (output.type === 'done') {
      this.deps.incTurnCount();
      // A completed turn clears a prior error so the seal status
      // reflects the FINAL turn's outcome, not any earlier error.
      this.deps.accounting.clearProviderError();

      // Contract: Stop fires exactly once per top-level turn, from the
      // session layer, so every surface (REPL, Telegram, daemon/cron,
      // chat) gets it. It runs BEFORE `done` is yielded, so a surface
      // never finalizes a turn whose Stop hooks are still running; the
      // wait is bounded by STOP_HOOK_HANDLER_TIMEOUT_MS. Forks and
      // un-wired surfaces are no-ops inside dispatchTurnStop.
      //
      // Finding 2: when the provider exposes setBeforeTurnEnd AND stop
      // wiring is active, the provider seam (stop-hook-continuation.ts)
      // already dispatched Stop BEFORE turn.completed was yielded —
      // dispatching it again here would fire Stop twice per turn.
      // Skip dispatchTurnStop in that case.
      // Finding 2: use the runtime flag set by buildBeforeTurnEnd
      // when the seam actually fired this turn. The old static check
      // (`setBeforeTurnEnd !== undefined`) wrongly suppressed dispatch
      // when the provider exposed the seam but it never ran.
      const seamAlreadyDispatched =
        this.deps.getStopWiring?.()?.stopDispatchedBySeam === true;
      if (!seamAlreadyDispatched) {
        await dispatchTurnStop({
          config: this.deps.getConfig(),
          wiring: this.deps.getStopWiring?.(),
          sessionId: this.deps.getSessionId(),
          signal: this.deps.getAbortController().signal,
          conversationHistory: this.deps.conversationHistory,
          toolEvents: deps._turnToolEvents ?? [],
        });
      }
    } else if (output.type === 'error') {
      // Terminal-cause flag: a per-turn provider error must flip the
      // eventual clean close from `succeeded` to `failed`.
      this.deps.accounting.markProviderError();
    }
    this.deps.ledger.recordEvent(output);
    this.deps.outputBroadcast.push(output);
    return output;
  }

  /** Ledger-only synthetic `done` for a turn that ended without a real one. */
  private recordSyntheticDone(turnStartMs: number): void {
    const signal = this.deps.getAbortController().signal;
    this.deps.ledger.recordEvent(buildFatalDone(signal, Date.now() - turnStartMs));
  }

  /**
   * Take ownership of a turn its consumer stopped reading.
   *
   * `idle` at exit means `interrupt()` already ran (it is the only thing that
   * leaves a live stream idle), so the turn is stopping and is settled right
   * away, in the background, without a second interrupt. Any other state means
   * nobody stopped it: it stays parked and the next send stops and settles it.
   */
  private abandonTurn(turn: AbandonedTurn, stateAtExit: SessionState): void {
    this.abandoned = turn;
    if (stateAtExit === 'idle') {
      void this.settle(turn, false);
    } else {
      this._activeDeps = null;
    }
  }

  /** Read `turn` through to its terminal event; never rejects. */
  private settle(turn: AbandonedTurn, interruptFirst: boolean): Promise<void> {
    // The turn is still in flight for the provider: keep its tool events
    // readable by the beforeTurnEnd seam until it has actually ended.
    this._activeDeps = turn.deps;
    const settled: Promise<void> = settleAbandonedTurn({
      iterator: turn.iterator,
      consume: async (event) => {
        if (turn.sealed) return null;
        const output = await this.consumeProviderEvent(event, turn.deps);
        if (output?.type === 'done') turn.doneRecorded = true;
        return output;
      },
      ...(interruptFirst ? { interrupt: () => turn.providerQuery.interrupt() } : {}),
      recordMissingDone: () => this.recordAbandonedDone(turn),
    }).finally(() => {
      if (this._activeDeps === turn.deps) this._activeDeps = null;
      if (this.abandoned === turn) this.abandoned = null;
      if (this.settling === settled) this.settling = null;
    });
    this.settling = settled;
    return settled;
  }

  /** Synthetic `done` for an abandoned turn, at most once per turn. */
  private recordAbandonedDone(turn: AbandonedTurn): void {
    if (turn.doneRecorded) return;
    turn.doneRecorded = true;
    this.recordSyntheticDone(turn.turnStartMs);
  }

  /**
   * Pre-seal hook: the ledger is about to close under an abandoned turn that
   * has not recorded its `done`. Record it now, and stop that turn's remaining
   * events from reaching a closed session or the next conversation's ledger.
   * The turn stays tracked so a later send still reads it off the iterator.
   */
  private sealAbandonedTurn(): void {
    const turn = this.abandoned;
    if (!turn) return;
    turn.sealed = true;
    this.recordAbandonedDone(turn);
  }

  /** Wait for, or perform, settlement of a turn a previous consumer abandoned. */
  private async settlePreviousTurn(): Promise<void> {
    if (this.settling) await this.settling;
    const parked = this.abandoned;
    if (parked) await this.settle(parked, true);
  }

  /**
   * Queue hook-generated framework context for delivery with the next real
   * outbound user message. See the displacement-bug rationale in AgentSession.
   */
  queueFrameworkContext(text: string): void {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    const pending = this.deps.getPendingFrameworkContext();
    this.deps.setPendingFrameworkContext([...pending, trimmed]);
    debugLog(
      `AgentSession: queued framework context (${trimmed.length} chars) for the next user message`,
    );
  }
}
