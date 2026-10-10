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

/** Cost already counted against `maxBudgetUsd`: own turns + completed subagents. */
function seededBudgetCost(accounting: AccountingAccumulator): number {
  const acct = accounting.snapshot();
  return acct.sessionRunningCostUsd + acct.subagentRunningCostUsd;
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

  constructor(deps: TurnRunnerDeps) {
    this.deps = deps;
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

    try {
      while (true) {
        const result = await this.deps.getProviderIterator().next();
        if (result.done) break;
        const event = result.value;
        this.deps.observeProviderEvent?.(event);
        const output = transformProviderEvent(event, deps);

        if (output) {
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
          yield output;
          if (output.type === 'done' || output.type === 'error') break;
        }
      }
    } finally {
      // Clear the active deps ref when the turn ends (clean, abort, or error).
      this._activeDeps = null;
      // Invariant: `finally` is the ONLY path an aborted or timed-out child
      // takes — closing the generator runs it while `break` does not reach it.
      if (this.deps.getState() === 'streaming') {
        this.deps.setState('idle');
      }
    }
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
