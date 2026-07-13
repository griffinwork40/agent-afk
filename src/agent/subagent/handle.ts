/**
 * Subagent handle implementation: lifecycle, message routing, and cancellation.
 *
 * Wraps a child `AgentSession` with status management, timeout handling,
 * abort-graph wiring, and optional hook dispatch on stop.
 *
 * @module agent/subagent/handle
 */

import type { ZodType } from 'zod';
import { AbortGraph } from '../abort-graph.js';
import { debugLog } from '../../utils/debug.js';
import { TimeoutError } from '../../utils/errors.js';
import type { HookRegistry } from '../hooks.js';
import { withTimeout } from '../timeout.js';
import type { IAgentSession, Message } from '../types.js';
import type { OutputEvent, SubagentProgressSink, SubagentProgressMeta } from '../types/session-types.js';
import { getCurrentSink } from '../_lib/skill-sink-channel.js';
import { dispatchSubagentStop } from '../subagent-hooks.js';
import { emitSubagentLifecycle } from '../trace/emit.js';
import type { TraceWriter } from '../trace/index.js';
import {
  buildResultFromMessage,
  buildResultFromError,
  createEmptyTrace,
  STREAM_INCOMPLETE,
  type SubagentResult,
  type SubagentStatus,
  type SubagentTrace,
} from './result.js';

export interface SubagentHandle<T = unknown> {
  /** Stable ID for tracking. */
  readonly id: string;
  /** Current status. */
  readonly status: SubagentStatus;
  /** Underlying child session (created eagerly). */
  readonly session: IAgentSession;
  /** Start a single turn against the child. Resolves to the raw assistant message. */
  run(prompt: string): Promise<Message>;
  /** Run and return a {@link SubagentResult} (honors `outputSchema` if set). */
  runToResult(prompt: string): Promise<SubagentResult<T>>;
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
}

/**
 * @internal
 * Concrete implementation of {@link SubagentHandle}. Not part of the public
 * API — constructor argument order may change between releases without a
 * semver bump. External code should depend on the {@link SubagentHandle}
 * interface only.
 */
export class SubagentHandleImpl<T> implements SubagentHandle<T> {
  private currentStatus: SubagentStatus = 'idle';
  private inFlight: Promise<Message> | null = null;
  private lastMessage: string | undefined;
  private lastDurationMs: number | undefined;
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
  private stopDispatched = false;
  /**
   * The `SubagentStop.injectContext` captured for in-turn delivery by the
   * caller — set only when {@link dispatchStopAndRelease} ran with
   * `deferInjectContextToCaller: true` and the hook produced a non-empty
   * context that was NOT suppressed by the abort-precedence guard. When set,
   * the queue push is skipped, so this and the queue are mutually exclusive
   * (exactly-once delivery). Read by the caller via
   * {@link getLastStopInjectContext} after `teardown()` resolves.
   */
  private lastStopInjectContext: string | undefined;
  /** Optional sink for streaming progress events. Never mutated after construction. */
  private readonly progressSink: SubagentProgressSink | undefined;
  /** Optional parent session ID for context injection tracing. */
  private parentId: string | undefined;
  /** Accumulated execution trace for the most recent run. */
  private currentTrace: SubagentTrace = createEmptyTrace();
  /**
   * Assistant text streamed during the most recent run. Captured as an
   * instance field (rather than a local in streamToFinalMessage) so the
   * accumulated content survives the throw boundary when the stream is
   * aborted, errored, or timed out. Surfaced as `SubagentResult.partialOutput`
   * by `runToResult` so the parent receives whatever findings the child
   * managed to produce instead of just the error.
   */
  private lastStreamedContent: string = '';
  /**
   * The provider's terminal stop reason captured from the most recent run's
   * `done` event (e.g. `'end_turn'`, `'tool_use_loop_capped'`). Persisted as
   * an instance field so `runToResult` can attach it to the built
   * {@link SubagentResult}, letting callers distinguish a capped partial from
   * a genuine completion. Reset at the start of `run()` (before the
   * `cancelled` short-circuit) so a re-invoked or cancelled handle never
   * surfaces a prior run's stop reason on the error result.
   */
  private lastStopReason: string | undefined;

  /** @internal — positional argument order is not part of any public contract. */
  constructor(
    public readonly id: string,
    public readonly session: IAgentSession,
    private readonly controller: AbortController,
    private readonly abortGraph: AbortGraph,
    private readonly outputSchema: ZodType<T> | undefined,
    private readonly timeoutMs: number,
    private readonly hookRegistry: HookRegistry | undefined,
    private readonly onTerminal: () => void,
    private readonly parentInputStreamRef?: ReturnType<IAgentSession['getInputStreamRef']>,
    private readonly parentAbortSignal?: AbortSignal,
    private readonly agentType?: string,
    progressSink?: SubagentProgressSink,
    parentId?: string,
    private readonly traceWriter?: TraceWriter,
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
  ) {
    this.progressSink = progressSink;
    this.parentId = parentId;
  }

  get status(): SubagentStatus {
    return this.currentStatus;
  }

  async run(prompt: string, sinkOverride?: SubagentProgressSink): Promise<Message> {
    if (this.currentStatus === 'running') throw new Error(`Subagent ${this.id} is already running`);
    // Invariant: reset the captured stop reason here — after the `running`
    // guard, before the `cancelled` short-circuit — so a re-invoked or
    // cancelled handle never surfaces a PRIOR run's stopReason on the error
    // result built by `runToResult`'s catch. Past the `running` guard
    // `currentStatus` is never `running` (and there is no `await` before it is
    // set below), so no in-flight run owns this value for us to clobber.
    this.lastStopReason = undefined;
    if (this.currentStatus === 'cancelled') throw new Error(`Subagent ${this.id} is cancelled`);

    this.currentStatus = 'running';
    const startTime = Date.now();
    const p = withTimeout(this.streamToFinalMessage(prompt, sinkOverride), this.timeoutMs, {
      controller: this.controller,
      label: this.id,
    });
    this.inFlight = p;
    try {
      const msg = await p;
      this.lastMessage = msg.content;
      this.lastDurationMs = Date.now() - startTime;
      this.currentStatus = 'succeeded';
      this.latestTerminalStatus = 'succeeded';
      // Witness layer: subagent_lifecycle.succeeded MUST be awaited before
      // onTerminal(). onTerminal() may trigger the owning session's immediate
      // teardown, which calls writer.seal(); once sealed, writer.write() throws
      // and emitSubagentLifecycle swallows it, silently dropping this terminal
      // record (the "lost terminal trace event" orphan bug). Awaiting here
      // guarantees the succeeded event is enqueued+persisted on the writer's
      // FIFO queue BEFORE any seal can run. Safe: write() is a bounded FS append
      // and emitSubagentLifecycle already swallows errors, so the await cannot
      // introduce a new failure mode or an unbounded hang.
      await emitSubagentLifecycle(this.traceWriter, {
        transition: 'succeeded',
        subagentId: this.id,
        durationMs: this.lastDurationMs,
        turnCount: this.currentTrace.turnCount,
        outputBytes: Buffer.byteLength(this.lastMessage, 'utf8'),
        // Record the terminal stop reason so trace forensics can distinguish a
        // clean completion from a capped/truncated partial (tool_use_loop_capped
        // / stream_incomplete) WITHOUT recomputing marker byte-lengths. Absent
        // when the provider reported no stop reason (a plain clean end).
        ...(this.lastStopReason !== undefined && { stopReason: this.lastStopReason }),
      });
      // Propagate usage and cost to the parent session's rollup accumulators.
      // Fire synchronously before onTerminal() so the session_sealed event
      // always captures this subagent's contribution even if onTerminal()
      // triggers an immediate session teardown.
      //
      // `msg.metadata.totalCostUsd` is populated by the provider's
      // stream-consumer (turn.completed retroactively mutates the assistant
      // message's metadata in place — see stream-consumer.ts), so by the time
      // `run()` reads `msg` here the cost is present for providers that report
      // it. It is `undefined` for backends without pricing data, which
      // `recordSubagentCompletion` already tolerates.
      const costUsd =
        typeof msg.metadata?.totalCostUsd === 'number' ? msg.metadata.totalCostUsd : undefined;
      this.onSubagentSucceeded?.(this.currentTrace.usage, costUsd);
      this.onTerminal();
      return msg;
    } catch (err) {
      this.lastDurationMs = Date.now() - startTime;
      // Wall-clock budget expiry: withTimeout aborts our controller with the
      // TimeoutError as the abort REASON before its race rejects, and abort
      // listeners fire synchronously — so the stream often unwinds with an
      // incidental AbortError in the same tick. The signal reason, not the
      // thrown error, is the authoritative cause. Surface the budget error
      // to callers and classify it as a failure below.
      const timeoutReason =
        this.controller.signal.aborted && this.controller.signal.reason instanceof TimeoutError
          ? this.controller.signal.reason
          : undefined;
      const surfacedErr = timeoutReason ?? err;
      // currentStatus is 'cancelled' only when cancel() already ran and
      // emitted its own lifecycle event. In that case we suppress the
      // failed event here to avoid a double-emit for the same termination.
      if ((this.currentStatus as string) !== 'cancelled') {
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
        if (this.controller.signal.aborted && timeoutReason === undefined) {
          await emitSubagentLifecycle(this.traceWriter, {
            transition: 'cancelled',
            subagentId: this.id,
            source: 'cascade',
          });
          this.currentStatus = 'cancelled';
          this.latestTerminalStatus = 'cancelled';
        } else {
          await emitSubagentLifecycle(this.traceWriter, {
            transition: 'failed',
            subagentId: this.id,
            errorClass: surfacedErr instanceof Error ? surfacedErr.constructor.name : 'Unknown',
            errorMessage: surfacedErr instanceof Error ? surfacedErr.message : String(surfacedErr),
            partialOutputBytes: Buffer.byteLength(this.lastStreamedContent, 'utf8'),
          });
          this.currentStatus = 'failed';
          this.latestTerminalStatus = 'failed';
        }
      }
      this.onTerminal();
      throw surfacedErr;
    } finally {
      this.inFlight = null;
    }
  }

  /**
   * Consume the streaming message iterator, forward events to progressSink,
   * and reconstruct the final Message from terminal events.
   *
   * @param sinkOverride — per-invocation sink that takes precedence over
   *   `this.progressSink`. Used by `runInBackground` to tee events to the
   *   caller's `onProgress` without permanently mutating the handle's field.
   */
  private async streamToFinalMessage(
    prompt: string,
    sinkOverride?: SubagentProgressSink,
  ): Promise<Message> {
    let finalMessage: Message | undefined;
    let streamError: Error | undefined;

    // Reset partial-content accumulator before each run. Surviving across the
    // throw boundary is the whole point — the local `streamedContent` of the
    // previous version got dropped on the floor when the iterator threw.
    this.lastStreamedContent = '';
    this.currentTrace = createEmptyTrace();

    const activeSink = sinkOverride ?? this.progressSink ?? getCurrentSink();

    const meta: SubagentProgressMeta = {
      subagentId: this.id,
      ...(this.parentId !== undefined && { parentId: this.parentId }),
      ...(this.agentType !== undefined && { agentType: this.agentType }),
    };

    for await (const event of this.session.sendMessageStream(prompt)) {
      if (activeSink) {
        activeSink(event, meta);
      }

      if (event.type === 'chunk') {
        const chunk = event.chunk;
        if (chunk.type === 'content') {
          this.lastStreamedContent += chunk.content;
        } else if (chunk.type === 'tool_use_detail') {
          this.currentTrace.toolCalls.push({
            id: chunk.toolUseId,
            name: chunk.toolName,
            // Privacy: store byte length only — never raw input content, which
            // routinely contains secrets (tokens, file contents, env vars).
            inputBytes: Buffer.byteLength(chunk.toolInput, 'utf8'),
          });
        } else if (chunk.type === 'tool_result') {
          this.currentTrace.toolResults.push({
            toolUseId: chunk.toolUseId,
            isError: chunk.isError,
            truncated: chunk.truncated,
            sizeBytes: chunk.sizeBytes,
          });
        } else if (chunk.type === 'thinking') {
          this.currentTrace.thinkingPresent = true;
        }
      }

      if (event.type === 'message') {
        finalMessage = event.message;
        // Count the turn as soon as the assistant message is received; this
        // ensures error-path traces (where 'done' is never reached) also
        // reflect completed turns.
        this.currentTrace.turnCount++;
      } else if (event.type === 'error') {
        streamError = event.error;
        break;
      } else if (event.type === 'done') {
        // Capture the turn's stop reason so the post-loop fallback can tell a
        // tool-use-cap termination (which yields a `done` with no assistant
        // message) apart from a genuinely empty stream — and so `runToResult`
        // can surface it on the SubagentResult (persisted on the handle).
        if (typeof event.metadata?.stopReason === 'string') {
          this.lastStopReason = event.metadata.stopReason;
        }
        if (typeof event.metadata?.usage === 'object' && event.metadata.usage !== null) {
          const u = event.metadata.usage as Record<string, unknown>;
          this.currentTrace.usage = {
            inputTokens: typeof u['input_tokens'] === 'number' ? u['input_tokens'] : undefined,
            outputTokens: typeof u['output_tokens'] === 'number' ? u['output_tokens'] : undefined,
            cacheReadTokens: typeof u['cache_read_input_tokens'] === 'number' ? u['cache_read_input_tokens'] : undefined,
            cacheCreationTokens: typeof u['cache_creation_input_tokens'] === 'number' ? u['cache_creation_input_tokens'] : undefined,
          };
        }
        break;
      }
    }

    if (streamError) throw streamError;
    if (finalMessage) return finalMessage;
    if (this.lastStreamedContent.length > 0) {
      // The stream ended with partial assistant text but no terminal `message`
      // event: the child was cut off mid-output (an abort, an early/abnormal
      // provider-stream close, or a provider that ended without a final
      // message). Mark the run non-clean so `runToResult` surfaces it as an
      // incomplete partial (via `stopReason`) instead of a silent success —
      // consumers prepend a parent-visible marker (annotateIfIncomplete). Use
      // `??=` so a real terminal stopReason (if one somehow arrived) is never
      // clobbered; reaching here implies none did.
      this.lastStopReason ??= STREAM_INCOMPLETE;
      return { role: 'assistant', content: this.lastStreamedContent, timestamp: new Date() };
    }
    // Anti-hang fallback (see SUBAGENT_DEFAULT_MAX_TOOL_USE_ITERATIONS in
    // subagent.ts): a child that hits its tool-use cap normally returns a real
    // summary — the provider runs a tools-stripped wind-down round on the cap
    // (see loop.ts) whose text lands as `finalMessage`/`lastStreamedContent`
    // above. This branch is the RARE fallback for when that wind-down produced
    // no text at all: surface the cap as a terminal "capped" message instead of
    // throwing, so `runToResult` reports a capped *partial* result (status
    // 'succeeded') rather than an opaque subagent failure.
    if (this.lastStopReason === 'tool_use_loop_capped') {
      return {
        role: 'assistant',
        content:
          `[subagent ${this.id} reached its tool-use iteration cap before ` +
          `producing a final message; returning a capped partial result]`,
        timestamp: new Date(),
      };
    }
    throw new Error(`Subagent ${this.id} produced no terminal message`);
  }

  async runToResult(prompt: string, sinkOverride?: SubagentProgressSink): Promise<SubagentResult<T>> {
    try {
      const message = await this.run(prompt, sinkOverride);
      return buildResultFromMessage(
        this.id,
        this.currentStatus,
        message,
        this.outputSchema,
        this.currentTrace,
        this.lastStopReason,
      );
    } catch (err) {
      const result = buildResultFromError<T>(
        this.id,
        this.currentStatus,
        err,
        this.currentTrace,
        this.lastStopReason,
      );
      // Preserve any assistant text streamed before the failure so the parent
      // receives partial findings rather than just an opaque error. The
      // raw string fragment is the best we have when a structured parse
      // never got a chance to run. `partialOutput` is typed as `T | string`
      // on `SubagentResult` so this assignment is honest — no cast needed.
      if (this.lastStreamedContent.length > 0) {
        result.partialOutput = this.lastStreamedContent;
      }
      return result;
    }
  }

  runInBackground(
    prompt: string,
    onResult?: (result: SubagentResult<T>) => void,
    onProgress?: (event: OutputEvent) => void,
  ): void {
    let sinkOverride: SubagentProgressSink | undefined;
    if (onProgress) {
      // Build a tee sink that is local to this invocation. We capture the
      // existing sink now and forward to both without touching this.progressSink,
      // so foreground callers (run / runToResult) are unaffected and repeated
      // runInBackground calls don't accumulate nested wrappers on the field.
      const baseSink = this.progressSink ?? getCurrentSink();
      sinkOverride = (event, meta) => {
        onProgress(event);
        baseSink?.(event, meta);
      };
    }
    // R1: .catch() is required — if onResult throws, or if a bug allows an
    // error to escape runToResult's own try/catch, the unhandled rejection
    // would leak into the daemon and leave the handle stuck in 'running'.
    // External constraint: Node process-level 'unhandledRejection' — any
    // naked void promise that rejects terminates the process in strict mode.
    void this.runToResult(prompt, sinkOverride).then((result) => {
      onResult?.(result);
    }).catch((err: unknown) => {
      debugLog('runInBackground: unexpected rejection after runToResult', err);
      console.error('Subagent runInBackground failed unexpectedly:', err);
    });
  }

  async cancel(): Promise<void> {
    // Two idempotency paths: a prior `cancel()` flipped `currentStatus`; a
    // prior `teardown()` already fired the stop hook without touching status.
    // Either case means nothing to do here.
    if (this.currentStatus === 'cancelled' || this.stopDispatched) return;

    // Preserve the real terminal status for SubagentStop — a successful run
    // followed by a teardown-cancel is still a 'succeeded' subagent from the
    // hook's perspective. Falls back to 'cancelled' when no run resolved.
    const reportedStatus: SubagentStatus = this.latestTerminalStatus ?? 'cancelled';
    this.currentStatus = 'cancelled';

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
    void emitSubagentLifecycle(this.traceWriter, {
      transition: 'cancelled',
      subagentId: this.id,
      source: 'explicit',
    });

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
      await this.dispatchStopAndRelease(reportedStatus);
    }
  }

  async teardown(options?: { deferInjectContextToCaller?: boolean }): Promise<void> {
    // Idempotent — once the stop hook has fired (via either path), teardown
    // is a no-op. Intentional: `handle.status` stays truthful for succeeded
    // runs; no abort-graph notification, no currentStatus mutation.
    if (this.stopDispatched) return;

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
    try {
      await this.session.close();
    } finally {
      await this.dispatchStopAndRelease(reportedStatus, options);
    }
  }

  getLastStopInjectContext(): string | undefined {
    return this.lastStopInjectContext;
  }

  /**
   * Dispatch `SubagentStop` and release the handle from the manager's active
   * map. Shared by `cancel()` and `teardown()` — the only difference between
   * those is pre-work (abort-graph notification, currentStatus mutation).
   * Guarded by `stopDispatched` so concurrent paths fire the hook exactly once.
   *
   * @param options.deferInjectContextToCaller — see {@link teardown}. When
   *   true, a produced (non-suppressed) `injectContext` is recorded on
   *   {@link lastStopInjectContext} for the caller to deliver in-turn INSTEAD
   *   of pushing it to the parent's input-stream/queue channel.
   */
  private async dispatchStopAndRelease(
    reportedStatus: SubagentStatus,
    options?: { deferInjectContextToCaller?: boolean },
  ): Promise<void> {
    if (this.stopDispatched) {
      // The other path already fired the hook. onTerminal() is idempotent on
      // the manager's active-map delete, so calling it again is safe — but we
      // do NOT re-dispatch the hook.
      this.onTerminal();
      return;
    }
    this.stopDispatched = true;

    const decision = await dispatchSubagentStop(
      this.hookRegistry,
      {
        event: 'SubagentStop',
        subagentId: this.id,
        status: reportedStatus,
        lastMessage: this.lastMessage,
        agentType: this.agentType,
        durationMs: this.lastDurationMs,
        // Always emit the trace, even when empty. SubagentResult.trace is always
        // populated; emitting undefined here created an inconsistent contract
        // where tool-free subagents looked traceless to hook consumers.
        trace: this.currentTrace,
      },
      this.traceWriter ? { traceWriter: this.traceWriter } : {},
    );

    // Invariant: SubagentStop.injectContext is a framework-generated note, not
    // the foreground subagent result and not human-authored text. The final
    // subagent answer has already returned through the `agent` tool result;
    // this side-channel carries only supplemental hook context for the parent.
    //
    // Delivery MUST reach the parent through EXACTLY ONE channel and MUST be
    // gated by abort precedence — a single ordered decision, checked here in
    // strict order so the two channels can never both fire and never both drop:
    //
    //   1. No injectContext produced        → nothing to deliver.
    //   2. Parent is aborting                → suppress (both channels). The
    //        parent's query loop unwinds before it could consume the note;
    //        queuing OR recording it would be a dead letter. Matches the
    //        abort-graph.ts "abort-signal check is unconditional" invariant.
    //   3. deferInjectContextToCaller = true → record on lastStopInjectContext
    //        for the CALLER to deliver in-turn (foreground agent/skill append
    //        it to the returned tool_result). SKIP the queue push — this is the
    //        suppression half of exactly-once. No parentInputStreamRef needed:
    //        the caller owns delivery.
    //   4. Otherwise (queue channel)         → ride along with the parent's
    //        next real user message (queueFrameworkContext). Never a standalone
    //        input-stream message: the provider consumes exactly one
    //        input-stream message per turn, so a pushed message that lands after
    //        the parent's turn ends displaces the user's next real message by
    //        one queue position — every later send is then answered by the
    //        message before it, and the injected text never appears in the
    //        ledger. `pushUserMessage` remains only as a fallback for narrow
    //        parent refs that predate the queue channel.
    // Injection failures are logged, not propagated.
    if (decision.injectContext) {
      if (this.parentAbortSignal?.aborted) {
        debugLog(
          `Skipping SubagentStop injectContext for ${this.id}: parent is aborted`,
        );
      } else if (options?.deferInjectContextToCaller) {
        // In-turn delivery: hand the note to the caller (tool_result append)
        // and deliberately do NOT push to the queue — exactly-once.
        this.lastStopInjectContext = decision.injectContext;
      } else if (this.parentInputStreamRef) {
        try {
          const ref = this.parentInputStreamRef;
          if (ref.queueFrameworkContext) {
            ref.queueFrameworkContext(decision.injectContext);
          } else {
            ref.pushUserMessage(decision.injectContext);
          }
        } catch (err) {
          debugLog(`Failed to inject context from SubagentStop handler: ${String(err)}`);
        }
      }
    }

    this.onTerminal();
  }
}
