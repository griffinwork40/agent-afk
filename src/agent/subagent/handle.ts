/**
 * Subagent handle implementation: lifecycle, message routing, and cancellation.
 *
 * Wraps a child `AgentSession` with status management, timeout handling,
 * abort-graph wiring, and optional hook dispatch on stop.
 *
 * @module agent/subagent/handle
 */

import type { ZodType } from 'zod';
import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import { AbortGraph } from '../abort-graph.js';
import { TimeoutError } from '../../utils/errors.js';
import type { HookRegistry } from '../hooks.js';
import { withTimeout } from '../timeout.js';
import type { IAgentSession, Message } from '../types.js';
import type { OutputEvent, SubagentProgressSink, SubagentProgressMeta } from '../types/session-types.js';
import { dispatchSubagentStop as _dispatchSubagentStop } from '../subagent-hooks.js';
import { emitSessionPhase, emitSubagentLifecycle } from '../trace/emit.js';
import type { TraceSink } from '../trace/index.js';
import { PauseAwareCeiling, SUBAGENT_MAX_PAUSE_EXTENSION_MS } from './pause-ceiling.js';
import {
  createEmptyTrace,
  type SubagentResult,
  type SubagentStatus,
  type SubagentTrace,
} from './result.js';
import {
  streamToFinalMessage,
  runToResult as runToResultImpl,
  runInBackground as runInBackgroundImpl,
  dispatchStopAndRelease,
} from './handle.streaming.js';

// Re-export so external callers importing debugLog-depending path still work.
export type { SubagentProgressMeta };

export interface SubagentHandle<T = unknown> {
  /** Stable ID for tracking. */
  readonly id: string;
  /** Current status. */
  readonly status: SubagentStatus;
  /** Underlying child session (created eagerly). */
  readonly session: IAgentSession;
  /** Start a single turn against the child. Resolves to the raw assistant message. */
  run(prompt: string | ContentBlockParam[]): Promise<Message>;
  /** Run and return a {@link SubagentResult} (honors `outputSchema` if set). */
  runToResult(prompt: string | ContentBlockParam[]): Promise<SubagentResult<T>>;
  /** Fire-and-forget run with optional completion callback and per-event progress hook. */
  runInBackground(
    prompt: string,
    onResult?: (result: SubagentResult<T>) => void,
    onProgress?: (event: OutputEvent) => void,
  ): void;
  /** Interrupt and close the child session. */
  cancel(): Promise<void>;
  /**
   * Release the child session after its run has resolved on its own. Fires
   * `SubagentStop` with the true terminal status (`'succeeded'`/`'failed'`,
   * or `'cancelled'` as fallback if no run completed). Unlike {@link cancel},
   * this does NOT mutate `status` or notify the abort-graph — it is the
   * explicit "work is done, tear down quietly" lifecycle endpoint used after
   * a successful `run()` / `runToResult()`. Idempotent; composes with
   * `cancel()` via the shared `stopDispatched` guard.
   *
   * @param options.deferInjectContextToCaller — when true, a non-empty
   *   `SubagentStop.injectContext` produced by this teardown is NOT pushed to
   *   the parent's input-stream/queue channel. Instead it is recorded and made
   *   readable via {@link getLastStopInjectContext} so the caller can deliver
   *   it in-turn (e.g. appended to the foreground `agent`/`skill` tool_result).
   *   The abort-precedence guard still applies: when the parent is aborting,
   *   nothing is recorded (the parent will unwind before it could consume it).
   *   Delivery is exactly-once — deferring here suppresses the queue push.
   */
  teardown(options?: { deferInjectContextToCaller?: boolean }): Promise<void>;
  /**
   * The `SubagentStop.injectContext` captured by the most recent teardown that
   * was invoked with `deferInjectContextToCaller: true`. `undefined` when no
   * context was produced, when delivery went through the queue channel, or
   * when suppressed by the abort-precedence guard. Read once after `teardown`
   * resolves; the caller owns delivery of the returned string.
   */
  getLastStopInjectContext(): string | undefined;
  /** Wall-clock duration of the most recent completed run in ms; `undefined` before any run finishes. */
  readonly durationMs: number | undefined;

  /**
   * Queue a user message for delivery as the subagent's next turn.
   * The message is buffered via `pushUserMessage` on the child session's
   * input stream. It will be consumed by `driveTurns` after the current
   * tool-use loop completes -- not injected mid-stream.
   *
   * If `run()` is configured to drain pending messages (via the
   * `pendingInput` callback), the subagent will automatically start a
   * new turn with this message after its current turn resolves.
   */
  sendMessage(text: string): void;
  /**
   * Inject a steering message at the child agent's next tool-call boundary.
   * The message is buffered in a ring buffer (capacity 3) and delivered by
   * the provider loop's inter-round hook. Silently dropped when the subagent
   * has reached a terminal state or the controller is aborted.
   */
  steer(text: string): void;
}

/**
 * @internal
 * Concrete implementation of {@link SubagentHandle}. Not part of the public
 * API — constructor argument order may change between releases without a
 * semver bump. External code should depend on the {@link SubagentHandle}
 * interface only.
 *
 * Fields prefixed with `_` are package-internal accessors used by the
 * extracted functions in `handle.streaming.ts`. They are technically `public`
 * but carry `@internal` JSDoc so consumers of the `SubagentHandle` interface
 * cannot observe them without importing the concrete class directly. Do not
 * use them outside this package directory.
 */
export class SubagentHandleImpl<T> implements SubagentHandle<T> {
  /** @internal */ _currentStatus: SubagentStatus = 'idle';
  private inFlight: Promise<Message> | null = null;
  /** @internal */ _lastMessage: string | undefined;
  /** @internal */ _lastDurationMs: number | undefined;
  /**
   * The latest non-running / non-idle status reached by the handle. Captured
   * on every `run()` resolution so a subsequent `cancel()` can dispatch
   * `SubagentStop` with the *true* terminal status ('succeeded' / 'failed')
   * instead of clobbering it to 'cancelled'. Unset until the first run
   * resolves — if the handle is cancelled before any run, the status is
   * genuinely 'cancelled'.
   */
  private latestTerminalStatus: SubagentStatus | undefined;
  /** Guard so teardown-side SubagentStop fires exactly once per handle. */
  /** @internal */ _stopDispatched = false;
  /**
   * The `SubagentStop.injectContext` captured for in-turn delivery by the
   * caller — set only when {@link dispatchStopAndRelease} ran with
   * `deferInjectContextToCaller: true` and the hook produced a non-empty
   * context that was NOT suppressed by the abort-precedence guard. When set,
   * the queue push is skipped, so this and the queue are mutually exclusive
   * (exactly-once delivery). Read by the caller via
   * {@link getLastStopInjectContext} after `teardown()` resolves.
   */
  /** @internal */ _lastStopInjectContext: string | undefined;
  /** Optional sink for streaming progress events. Never mutated after construction. */
  /** @internal */ readonly _progressSink: SubagentProgressSink | undefined;
  /** Optional parent session ID for context injection tracing. */
  /** @internal */ _parentId: string | undefined;
  /** Accumulated execution trace for the most recent run. */
  /** @internal */ _currentTrace: SubagentTrace = createEmptyTrace();
  /**
   * Assistant text streamed during the most recent run. Captured as an
   * instance field (rather than a local in streamToFinalMessage) so the
   * accumulated content survives the throw boundary when the stream is
   * aborted, errored, or timed out. Surfaced as `SubagentResult.partialOutput`
   * by `runToResult` so the parent receives whatever findings the child
   * managed to produce instead of just the error.
   */
  /** @internal */ _lastStreamedContent: string = '';
  /**
   * Pause-aware extension policy for the CURRENT run's wall-clock ceiling.
   * Created in `run()` (which owns `withTimeout`) but fed from the stream loop
   * in `streamToFinalMessage`, so — like `lastStreamedContent` — it lives as an
   * instance field to bridge those two scopes. `undefined` between runs and
   * whenever no wall-clock budget applies (`timeoutMs <= 0`), in which case
   * there is no ceiling to extend.
   */
  /** @internal */ _pauseCeiling: PauseAwareCeiling | undefined;
  /**
   * The provider's terminal stop reason captured from the most recent run's
   * `done` event (e.g. `'end_turn'`, `'tool_use_loop_capped'`). Persisted as
   * an instance field so `runToResult` can attach it to the built
   * {@link SubagentResult}, letting callers distinguish a capped partial from
   * a genuine completion. Reset at the start of `run()` (before the
   * `cancelled` short-circuit) so a re-invoked or cancelled handle never
   * surfaces a prior run's stop reason on the error result.
   */
  /** @internal */ _lastStopReason: string | undefined;
  /** @internal — per-subagent conversation log writer. Set by SubagentManager after construction. */
  /** @internal */ _logWriter?: { write(event: OutputEvent): void; close(): Promise<void> };

  /** @internal — positional argument order is not part of any public contract. */
  constructor(
    public readonly id: string,
    public readonly session: IAgentSession,
    /** @internal */ public readonly _controller: AbortController,
    private readonly abortGraph: AbortGraph,
    /** @internal */ public readonly _outputSchema: ZodType<T> | undefined,
    private readonly timeoutMs: number,
    /** @internal */ public readonly _hookRegistry: HookRegistry | undefined,
    /** @internal */ public readonly _onTerminal: () => void,
    /** @internal */ public readonly _parentInputStreamRef?: ReturnType<IAgentSession['getInputStreamRef']>,
    /** @internal */ public readonly _parentAbortSignal?: AbortSignal,
    /** @internal */ public readonly _agentType?: string,
    progressSink?: SubagentProgressSink,
    parentId?: string,
    /** @internal */ public readonly _traceWriter?: TraceSink,
    /**
     * Optional callback invoked after a successful `run()`. Carries the
     * subagent's token usage and optional cost so the parent session can
     * accumulate them into the `session_sealed` rollup fields without
     * reaching back into the handle's private state.
     */
    private readonly onSubagentSucceeded?: (
      usage: SubagentTrace['usage'],
      costUsd: number | undefined,
    ) => void,
    /**
     * Progress-aware idle-watchdog window (ms) for this fork's turn. `0` (or
     * any non-positive value) disables the watchdog; the wall-clock
     * {@link timeoutMs} still applies. Runs concurrently with `withTimeout` and
     * aborts the SAME controller, so an idle-fire flows through the identical
     * classification + partial-output path. Resolved at the fork site
     * (`config.idleTimeoutMs ?? resolveSubagentIdleTimeoutMs()`). Defaults to
     * `0` for the rare direct constructor callers (tests/bare harnesses), which
     * keeps the watchdog opt-in there — the production fork path always supplies
     * the resolved value.
     */
    /** @internal */ public readonly _idleTimeoutMs: number = 0,
  ) {
    this._progressSink = progressSink;
    this._parentId = parentId;
  }

  get status(): SubagentStatus {
    return this._currentStatus;
  }

  get durationMs(): number | undefined {
    return this._lastDurationMs;
  }

  async run(prompt: string | ContentBlockParam[], sinkOverride?: SubagentProgressSink): Promise<Message> {
    if (this._currentStatus === 'running') throw new Error(`Subagent ${this.id} is already running`);
    // Invariant: reset the captured stop reason here — after the `running`
    // guard, before the `cancelled` short-circuit — so a re-invoked or
    // cancelled handle never surfaces a PRIOR run's stopReason on the error
    // result built by `runToResult`'s catch. Past the `running` guard
    // `currentStatus` is never `running` (and there is no `await` before it is
    // set below), so no in-flight run owns this value for us to clobber.
    this._lastStopReason = undefined;
    if (this._currentStatus === 'cancelled') throw new Error(`Subagent ${this.id} is cancelled`);

    this._currentStatus = 'running';
    const startTime = Date.now();
    // Pause-aware wall-clock ceiling. The ceiling is still un-resettable BY THE
    // CHILD — only a provider-reported pause (`paused` w/ resetsAt, `rate_limit`
    // w/ retryAfterMs) can move it, each grant is bounded by that reported
    // window, and total accumulated extension is capped by
    // SUBAGENT_MAX_PAUSE_EXTENSION_MS, so worst-case lifetime stays finite and
    // predictable. Without pause events the extender grants nothing and
    // withTimeout behaves exactly as before. Skipped entirely when no budget
    // applies (`timeoutMs <= 0`): there is no ceiling to extend.
    const pauseCeiling =
      Number.isFinite(this.timeoutMs) && this.timeoutMs > 0
        ? new PauseAwareCeiling(this.timeoutMs, SUBAGENT_MAX_PAUSE_EXTENSION_MS, (info) => {
            // Witness-layer: each non-zero pause extension is now observable in
            // the trace, not just in the eventual terminal timeout error. Fire-
            // and-forget so a slow trace write can never delay the deadline
            // re-arm (mirrors the `idle_watchdog_fired` emit a few lines down).
            void emitSessionPhase(this._traceWriter, {
              phase: 'pause_extension_granted',
              metadata: {
                subagentId: this.id,
                grantMs: info.grantMs,
                totalGrantedMs: info.totalGrantedMs,
                remainingCapMs: info.remainingCapMs,
                grantCount: info.grantCount,
                ...(info.pauseDescription !== undefined && {
                  pauseDescription: info.pauseDescription,
                }),
              },
            });
          })
        : undefined;
    this._pauseCeiling = pauseCeiling;
    const p = withTimeout(streamToFinalMessage(this, prompt, sinkOverride), this.timeoutMs, {
      controller: this._controller,
      label: this.id,
      ...(pauseCeiling !== undefined && { extender: pauseCeiling }),
    });
    this.inFlight = p;
    try {
      const msg = await p;
      this._lastMessage = msg.content;
      this._lastDurationMs = Date.now() - startTime;
      this._currentStatus = 'succeeded';
      this.latestTerminalStatus = 'succeeded';

      // Item 7: Drain pending user messages queued via sendMessage(). Each
      // message starts a new turn in the same subagent conversation.
      // driveTurns already supports multi-turn; we just keep calling
      // streamToFinalMessage with each queued message. _onTerminal is
      // deferred so the handle stays in the active map while draining.
      // Status stays 'succeeded' during drain (no flip back to 'running').
      let lastMsg = msg;
      // FIX-2: Open the drain window so sendMessage() can still accept
      // pushes while status is 'succeeded'.
      this._drainingMessages = true;
      try {
        while (this._pendingUserMessages.length > 0) {
          // Item 7c: abort-signal guard — stop draining if cancelled.
          if (this._controller.signal.aborted) break;
          const next = this._pendingUserMessages.shift()!;
          lastMsg = await streamToFinalMessage(this, next, sinkOverride);
          this._lastMessage = lastMsg.content;
          this._currentTrace.turnCount++;
        }
      } catch {
        // Item 7b: drain error — clear remaining queue and fall through to
        // lifecycle events, which will use accumulated usage/cost so far.
        this._pendingUserMessages.length = 0;
      }
      // FIX-2: Close the drain window — subsequent sendMessage() calls after
      // the drain loop completes are dropped as normal terminal-state messages.
      this._drainingMessages = false;

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
      await emitSubagentLifecycle(this._traceWriter, {
        transition: 'succeeded',
        subagentId: this.id,
        durationMs: Date.now() - startTime,
        turnCount: this._currentTrace.turnCount,
        outputBytes: Buffer.byteLength(this._lastMessage, 'utf8'),
        // Record the terminal stop reason so trace forensics can distinguish a
        // clean completion from a capped/truncated partial (tool_use_loop_capped
        // / stream_incomplete) WITHOUT recomputing marker byte-lengths. Absent
        // when the provider reported no stop reason (a plain clean end).
        ...(this._lastStopReason !== undefined && { stopReason: this._lastStopReason }),
      });
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
      this.onSubagentSucceeded?.(this._currentTrace.usage, costUsd);

      this._onTerminal();
      return lastMsg;
    } catch (err) {
      this._lastDurationMs = Date.now() - startTime;
      // Invariant: own-budget timeouts classify 'failed', inherited (cascaded)
      // timeouts stay 'cancelled'. Wall-clock budget expiry — withTimeout
      // aborts our controller with the TimeoutError as the abort REASON before
      // its race rejects, and abort listeners fire synchronously — so the
      // stream often unwinds with an incidental AbortError in the same tick.
      // The signal reason, not the thrown error, is the authoritative cause.
      // Surface the budget error to callers and classify it as a failure below.
      //
      // Origin guard: only OUR OWN budget expiry counts. An ancestor's
      // TimeoutError cascades down UNWRAPPED (AbortGraph.linkChild / abort()
      // reuse the same reason object), so an inherited timeout would otherwise
      // be misread as this handle's own budget and wrongly classified 'failed'
      // — a nested subagent torn down because an ANCESTOR timed out did no
      // wrong. isCascading(this.id) is true exactly when the graph aborted us
      // as a descendant; exclude that case so cascaded timeouts stay
      // 'cancelled'.
      const timeoutReason =
        this._controller.signal.aborted &&
        this._controller.signal.reason instanceof TimeoutError &&
        !this.abortGraph.isCascading(this.id)
          ? this._controller.signal.reason
          : undefined;
      const surfacedErr = timeoutReason ?? err;
      // currentStatus is 'cancelled' only when cancel() already ran and
      // emitted its own lifecycle event. In that case we suppress the
      // failed event here to avoid a double-emit for the same termination.
      if ((this._currentStatus as string) !== 'cancelled') {
        // Invariant: cascade classification. When our controller's signal is
        // aborted at this point AND cancel() didn't fire (otherwise status
        // would already be 'cancelled') AND the abort reason is not our own
        // wall-clock budget, the throw unwound because an ancestor cascade
        // hit our controller. Treat this as 'cancelled', not 'failed' — the
        // subagent did no wrong; it was torn down externally. The trace and
        // the result-object status must agree so downstream consumers
        // (operator dashboard, future ActiveWorkRegistry) can correctly
        // attribute cascade terminations vs. genuine failures.
        //
        // Budget expiry is the deliberate carve-out: a TimeoutError abort
        // reason means THIS run exceeded its own budget — a failure of the
        // run, not an external teardown. Classifying it 'cancelled' made
        // background timeouts vanish entirely: BgResultNotifier is
        // notice-only for cancelled jobs (it never injects them into the
        // parent context), so the timeout error promised by the fork-budget
        // contract was recorded but never delivered (P2 review finding on
        // #465). 'failed' flows through runToResult → registry → notifier
        // injection with partial output intact.
        //
        // Awaited (not fire-and-forget) for the same reason as the success
        // path: onTerminal() below may seal the owning session's trace, and a
        // seal that lands before this write is enqueued would drop the terminal
        // record. Awaiting guarantees the event is persisted first.
        if (this._controller.signal.aborted && timeoutReason === undefined) {
          // Annotate a timeout-driven cascade: `timeoutReason` is undefined here
          // (this branch's guard), so a TimeoutError on the signal means the
          // origin guard above classified it as CASCADED (isCascading true) —
          // i.e. an ANCESTOR's wall-clock budget expired and the abort came down
          // to us. Flag it so a trace reader can tell a timeout cascade from an
          // ordinary parent/explicit cancel. Not our own budget → still
          // 'cancelled', not 'failed'.
          const cascadeTimedOut = this._controller.signal.reason instanceof TimeoutError;
          await emitSubagentLifecycle(this._traceWriter, {
            transition: 'cancelled',
            subagentId: this.id,
            source: 'cascade',
            ...(cascadeTimedOut ? { timeout: true } : {}),
          });
          this._currentStatus = 'cancelled';
          this.latestTerminalStatus = 'cancelled';
        } else {
          await emitSubagentLifecycle(this._traceWriter, {
            transition: 'failed',
            subagentId: this.id,
            errorClass: surfacedErr instanceof Error ? surfacedErr.constructor.name : 'Unknown',
            errorMessage: surfacedErr instanceof Error ? surfacedErr.message : String(surfacedErr),
            partialOutputBytes: Buffer.byteLength(this._lastStreamedContent, 'utf8'),
            // Classify our OWN wall-clock budget expiry as a timeout failure.
            // `timeoutReason` is set (see the origin-guarded detection above)
            // exactly when THIS handle's controller was aborted with a
            // TimeoutError that is NOT a cascade — the guillotined-by-budget
            // case #583/this PR targets. Absent for any other failure.
            ...(timeoutReason !== undefined ? { failureClass: 'timeout' as const } : {}),
          });
          this._currentStatus = 'failed';
          this.latestTerminalStatus = 'failed';
        }
      }
      this._onTerminal();
      throw surfacedErr;
    } finally {
      this.inFlight = null;
    }
  }

  async runToResult(
    prompt: string | ContentBlockParam[],
    sinkOverride?: SubagentProgressSink,
  ): Promise<SubagentResult<T>> {
    return runToResultImpl(this, prompt, sinkOverride);
  }

  runInBackground(
    prompt: string,
    onResult?: (result: SubagentResult<T>) => void,
    onProgress?: (event: OutputEvent) => void,
  ): void {
    return runInBackgroundImpl(this, prompt, onResult, onProgress);
  }

  async cancel(): Promise<void> {
    // Two idempotency paths: a prior `cancel()` flipped `currentStatus`; a
    // prior `teardown()` already fired the stop hook without touching status.
    // Either case means nothing to do here.
    if (this._currentStatus === 'cancelled' || this._stopDispatched) return;

    // Preserve the real terminal status for SubagentStop — a successful run
    // followed by a teardown-cancel is still a 'succeeded' subagent from the
    // hook's perspective. Falls back to 'cancelled' when no run resolved.
    const reportedStatus: SubagentStatus = this.latestTerminalStatus ?? 'cancelled';
    this._currentStatus = 'cancelled';

    // Witness layer: emit subagent_lifecycle.cancelled BEFORE the abort
    // cascade fires. Two reasons for the ordering:
    //   1. Trace ordering preserves causality — the cancelled lifecycle
    //      record is the explicit user-initiated termination; the
    //      cascade abort events that follow descend from it.
    //   2. If the cascade triggers a child's run() to throw, the child's
    //      catch block sees `currentStatus === 'cancelled'` and skips
    //      its own failed-emission. Without emitting first, the child's
    //      failed event would race with our cancelled event.
    // source='explicit' marks this as a caller-initiated cancel — distinct
    // from cascade-driven cancellation which will be emitted by the
    // abort-graph wiring in a follow-up commit.
    void emitSubagentLifecycle(this._traceWriter, {
      transition: 'cancelled',
      subagentId: this.id,
      source: 'explicit',
    });

    this._steeringMessages.length = 0;
    try {
      this.abortGraph.abort(this.id, 'cancelled');
    } catch {
      // graph abort is best-effort
    }
    try {
      if (this.inFlight) await this.session.interrupt();
    } catch {
      // ignore interrupt errors
    }
    try {
      await this.session.close();
    } finally {
      await dispatchStopAndRelease(this, reportedStatus);
    }
  }

  async teardown(options?: { deferInjectContextToCaller?: boolean }): Promise<void> {
    // Idempotent — once the stop hook has fired (via either path), teardown
    // is a no-op. Intentional: `handle.status` stays truthful for succeeded
    // runs; no abort-graph notification, no currentStatus mutation.
    if (this._stopDispatched) return;

    // Use the real terminal status when available. Never-ran handles fall
    // back to 'cancelled' — same fallback as cancel() for consistency.
    const reportedStatus: SubagentStatus = this.latestTerminalStatus ?? 'cancelled';

    try {
      // Defensive: teardown on an in-flight run is not the primary use case
      // (callers should `cancel()` instead), but if it happens, interrupt so
      // `session.close()` doesn't hang on the live query.
      if (this.inFlight) await this.session.interrupt();
    } catch {
      // ignore interrupt errors
    }
    this._steeringMessages.length = 0;
    try {
      await this.session.close();
    } finally {
      await dispatchStopAndRelease(this, reportedStatus, options);
    }
  }

  getLastStopInjectContext(): string | undefined {
    return this._lastStopInjectContext;
  }

  /** Pending user messages queued via sendMessage(). */
  readonly _pendingUserMessages: string[] = [];
  /**
   * FIX-2: True while the drain loop is executing so sendMessage() can
   * still accept pushes even though _currentStatus is already 'succeeded'.
   */
  private _drainingMessages = false;

  sendMessage(text: string): void {
    // FIX-4: Discard empty/whitespace-only messages before any other check.
    if (!text.trim()) return;
    // Item 8: silently drop messages when the subagent has already reached a
    // terminal state. The task-view UI may call this while the subagent races
    // to completion; throwing here would surface a confusing error.
    // FIX-2: Allow pushes while the drain loop is running (_drainingMessages),
    // even though _currentStatus has already flipped to 'succeeded'.
    if (
      (this._currentStatus === 'succeeded' ||
        this._currentStatus === 'failed' ||
        this._currentStatus === 'cancelled') &&
      !this._drainingMessages
    ) {
      return;
    }
    this._pendingUserMessages.push(text);
  }

  /** Ring buffer of pending steering messages (capacity: 3). Consumed by _beforeNextRound. */
  readonly _steeringMessages: string[] = [];

  steer(text: string): void {
    if (!text.trim()) return;
    if (
      (this._currentStatus === 'succeeded' ||
        this._currentStatus === 'failed' ||
        this._currentStatus === 'cancelled') &&
      !this._drainingMessages
    ) {
      return;
    }
    if (this._controller.signal.aborted) return;
    if (this._steeringMessages.length >= 3) this._steeringMessages.shift();
    this._steeringMessages.push(text);
  }

  /**
   * Stable closure shifted by the provider loop's inter-round hook.
   * Returns the oldest pending steering message and removes it, or undefined.
   * @internal
   */
  get _beforeNextRound(): () => string | undefined {
    return () => this._steeringMessages.shift();
  }
}
