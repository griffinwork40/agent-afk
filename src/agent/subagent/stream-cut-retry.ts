/**
 * Bounded re-dispatch of a sub-agent whose model stream was cut mid-flight with
 * NOTHING to salvage.
 *
 * The provider loop already re-drives a mid-stream clean close twice per
 * tool-use round (`STREAM_INCOMPLETE_MAX_RETRIES` in
 * `providers/anthropic-direct/loop.ts`). When that budget is spent the child
 * dies and — until this module — no layer above it retried: the parent received
 * an `isError` payload and only the parent MODEL could choose to re-call the
 * tool. `subagent/handle.ts`'s own throw message states the intended contract
 * ("the parent should retry or fall back"); this module implements it.
 *
 * @module agent/subagent/stream-cut-retry
 */

import type { ToolResult } from '../tools/types.js';
import { sleepWithAbort } from '../providers/shared/sleep-with-abort.js';
import { STREAM_INCOMPLETE } from './result.js';

/**
 * Fresh-fork re-dispatches allowed per `agent` tool call, beyond the first
 * attempt. Deliberately `1`, not the provider loop's `2`: by the time a failure
 * reaches this layer the provider has ALREADY spent its own per-round budget, so
 * this is a last-resort clean-slate attempt rather than the primary defence. A
 * re-dispatch re-runs the child's whole prompt from scratch (potentially many
 * minutes and the full tool budget), so a second one costs far more here than a
 * provider-level re-drive of a single round.
 */
export const STREAM_CUT_MAX_REDISPATCH = 1;

/** Settle delay before a fresh fork. Short: a dropped connection is not an
 *  overload signal, so reconnect promptly without hammering a flapping proxy. */
export const STREAM_CUT_REDISPATCH_DELAY_MS = 1_000;

/**
 * Contract: `true` only for the ZERO-OUTPUT stream-cut failure — a run that
 * produced no assistant text before the cut.
 *
 * IMPORTANT: this predicate is necessary but NOT sufficient to justify a retry.
 * "Zero output" means zero assistant TEXT, not zero side effects: `handle.ts`
 * accumulates streamed content and tool calls separately, so a write-capable
 * child can run dozens of tool calls — file writes, `git commit`, HTTP POSTs —
 * emit no final message, get cut, and land here. Re-running it would double-fire
 * every non-idempotent effect. Callers MUST additionally gate on the child being
 * side-effect-free (see `canRedispatch` in {@link StreamCutRetryOptions}); this
 * function only classifies the transport failure.
 *
 * `subagent/result.ts` documents that `STREAM_INCOMPLETE` surfaces in two
 * shapes, and the distinction is load-bearing here:
 *
 *   - BUFFERED PARTIAL -> `status: 'succeeded'`. The child streamed real
 *     assistant text before the cut; that partial is salvaged and annotated for
 *     the parent. It never reaches this predicate as an error, and MUST NOT be
 *     retried — a re-dispatch would discard findings the child actually
 *     produced in exchange for a coin-flip at reproducing them.
 *   - ZERO OUTPUT -> `status: 'failed'` (a thrown `StreamIncompleteError`),
 *     delivered as `isError` with `incompleteReason: 'stream_incomplete'`.
 *     Nothing was produced, so re-running is strictly non-destructive.
 *
 * `tool_use_loop_capped` is the OTHER value `incompleteReason` can hold and is
 * deliberately excluded: that is a budget ceiling the caller asked for, not a
 * transport failure, and retrying it would burn a second full tool budget to
 * hit the same wall.
 */
export function isZeroOutputStreamCut(result: ToolResult): boolean {
  return result.isError === true && result.incompleteReason === STREAM_INCOMPLETE;
}

/**
 * Mutable out-param a dispatcher fills in mid-attempt so the retry wrapper —
 * which sits OUTSIDE the dispatch and cannot see the child's resolved config —
 * can decide whether a re-dispatch is safe.
 *
 * Always construct it as `{ sideEffectFree: false }`: a dispatch that fails
 * before resolving the child's tool surface must leave the retry disabled.
 */
export interface StreamCutProbe {
  /**
   * `true` only when the child was confirmed to have NO write-capable tools, so
   * re-running its prompt cannot mutate the filesystem, the repo, or anything
   * external. A write-capable child is never re-dispatched, however little text
   * it produced.
   */
  sideEffectFree: boolean;
}

export interface StreamCutRetryOptions {
  /**
   * Performs ONE full dispatch attempt. Must fork a FRESH child (new session,
   * new trace) per call — a spent `SubagentHandle` cannot be re-run, so
   * re-invoking a closure that reuses one handle would not actually retry.
   * `attempt` is 0-based.
   */
  dispatch: (attempt: number) => Promise<ToolResult>;
  /** Parent turn signal. An aborted signal suppresses further attempts. */
  signal: AbortSignal;
  /** Override the re-dispatch budget. Defaults to {@link STREAM_CUT_MAX_REDISPATCH}. */
  maxRedispatch?: number;
  /** Override the settle delay. Tests pass `0`. */
  delayMs?: number;
  /**
   * Safety gate consulted AFTER a cut is detected and immediately before each
   * re-dispatch. Return `false` to suppress the retry. Two things must be
   * asserted here, and both are the caller's responsibility because only the
   * caller can know them:
   *
   *   1. The dead child was SIDE-EFFECT-FREE (no write-capable tools). A retry
   *      re-runs the whole prompt, so a child that may have written files,
   *      committed, or POSTed must never be re-dispatched — zero assistant text
   *      does not imply zero mutations.
   *   2. No cancellation arrived while this call was between attempts. The
   *      in-flight handle maps are empty across that gap, so a cancel routed
   *      through them is a silent no-op and `signal.aborted` can still read
   *      false.
   *
   * Defaults to always-allow when omitted, so the pure-logic unit tests can
   * exercise the loop directly; every production caller passes a real gate.
   */
  canRedispatch?: () => boolean;
  /** Observability hook, fired before each re-dispatch. `attempt` is 1-based. */
  onRedispatch?: (attempt: number) => void;
}

/**
 * Run `dispatch`, re-forking once if the child died to a zero-output stream cut.
 *
 * Returns the LAST attempt's result. When every attempt is cut, the final
 * `isError` payload is returned unchanged, so a caller that cannot be rescued
 * still sees the same structured failure it saw before this wrapper existed —
 * the retry is purely additive.
 */
export async function runWithStreamCutRetry(opts: StreamCutRetryOptions): Promise<ToolResult> {
  const budget = opts.maxRedispatch ?? STREAM_CUT_MAX_REDISPATCH;
  const delayMs = opts.delayMs ?? STREAM_CUT_REDISPATCH_DELAY_MS;

  let result = await opts.dispatch(0);

  for (let attempt = 1; attempt <= budget; attempt += 1) {
    if (!isZeroOutputStreamCut(result)) return result;
    // Invariant: an aborted parent turn must not spawn a fresh child. The user
    // (or a cascade) has already asked for this work to stop, and a re-dispatch
    // would start a brand-new session that outlives the abort. Checked BEFORE
    // the delay as well as after, so an abort that lands during the settle wait
    // cannot slip a fork through.
    if (opts.signal.aborted) return result;
    // Side-effect + cancellation gate (see `canRedispatch`). Re-checked after
    // the delay too: both facts it asserts can change while we wait.
    if (opts.canRedispatch !== undefined && !opts.canRedispatch()) return result;

    if (delayMs > 0) await sleepWithAbort(delayMs, opts.signal);
    if (opts.signal.aborted) return result;
    if (opts.canRedispatch !== undefined && !opts.canRedispatch()) return result;

    opts.onRedispatch?.(attempt);
    result = await opts.dispatch(attempt);
  }

  return result;
}
