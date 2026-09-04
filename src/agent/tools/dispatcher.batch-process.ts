/**
 * Batch-execution helpers for {@link SessionToolDispatcher.executeBatch}.
 *
 * Extracted from `dispatcher.ts` to reduce nesting depth in the two execution
 * branches of the batch loop:
 *  - {@link runConcurrentBatch} — `isConcurrencySafe` wave-admission loop.
 *  - {@link runSequentialBatch} — sequential (concurrency-unsafe) loop.
 *  - {@link reconcileOutcomes} — post-wave result writing from settled promises.
 *  - {@link stampBatchMetadata} — batch-membership annotation on each result.
 *
 * Both functions receive their dispatcher-state dependencies through an explicit
 * {@link BatchExecDeps} object rather than through closure, so the concerns are
 * isolable and unit-testable without constructing a full dispatcher.
 *
 * @module agent/tools/dispatcher.batch-process
 */

import { abortFailureClass } from '../abort-reason.js';
import { settleWithConcurrencyLimit } from '../concurrency-pool.js';
import { debugLog } from '../../utils/debug.js';
import {
  REPEAT_FAILURE_REFUSAL_THRESHOLD,
  repeatFailureFingerprint,
} from './repeat-failure-guard.js';
import type { RepeatFailureGuard } from './repeat-failure-guard.js';
import type { ToolCall, ToolResult } from '../providers/anthropic-direct/types.js';
import type { SubagentExecutor } from './subagent-executor.js';
import type { Batch } from './dispatch-batching.js';

/**
 * Indexed entry produced by `executeBatch`'s phase-1 loop. Each element pairs
 * an original `ToolCall` with its position in the `calls[]` input array so
 * results can be written back at the correct index regardless of execution order.
 *
 * @internal
 */
export interface IndexedCall {
  call: ToolCall;
  originalIndex: number;
}

/**
 * Dependency surface threaded into both batch helpers so they can operate on
 * live dispatcher state without holding a reference to the whole class.
 *
 * Every field maps 1:1 to a private member or private method of
 * {@link SessionToolDispatcher}; the names are intentionally identical so the
 * call-sites in `executeBatch` read as thin wrappers rather than deep
 * transformations.
 *
 * @internal
 */
export interface BatchExecDeps {
  /** Guard that refuses a call after N identical consecutive failures. */
  repeatFailureGuard: RepeatFailureGuard;
  /** Tool names exempt from repeat-failure/circuit-breaker short-circuits. */
  repeatBreakerExemptTools: ReadonlySet<string>;
  /** Core execution: agent routing + handler dispatch + PostToolUse hook. */
  executeCore: (call: ToolCall) => Promise<ToolResult>;
  /** Subagent executor for wave-manifest notifications; `undefined` when unavailable. */
  subagentExecutor: SubagentExecutor | undefined;
  /** Session id passed to `notifyWaveStart`; empty-string when unavailable. */
  sessionId: string | undefined;
  /** Ceiling on simultaneously in-flight calls within one admission wave. */
  maxConcurrentSafeCalls: number;
  /**
   * Called whenever the set of ACTUALLY-RUNNING calls changes — a worker
   * starting or a worker settling — with the ids currently in flight.
   *
   * Invariant: this reports observed membership, never a prediction. It fires
   * only from inside the worker body, so an id appears exactly when its handler
   * has begun and disappears exactly when its handler has returned. A call that
   * is deferred by the repeat-failure guard, blocked by a hook, refused
   * pre-abort, or still queued behind the concurrency ceiling is absent by
   * construction — nothing is announced before it starts.
   *
   * Consumers derive the count from `activeIds.length`; the dispatcher does not
   * pass a separate width, so the two can never disagree. An empty array is a
   * legitimate terminal update (the wave drained) and is what clears the badge.
   * Optional: omit to suppress activity reporting entirely.
   */
  onActivity?: (activeIds: readonly string[]) => void;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Check the repeat-failure guard for a single call. Returns the blocking
 * `ToolResult` when the guard refuses the call, or `null` to proceed. Honours
 * the exempt-tools set so calls intentionally repeated are never blocked.
 */
function checkRepeatGuard(
  call: ToolCall,
  guard: RepeatFailureGuard,
  exempt: ReadonlySet<string>,
): ToolResult | null {
  if (exempt.has(call.name)) return null;
  const verdict = guard.check(call);
  if (verdict === null) return null;
  debugLog(
    `[repeat-failure-guard #723] refused ${verdict.tool} after ${verdict.count} identical failures`,
  );
  return verdict.result;
}

/**
 * Live-activity tracker for one concurrent wave.
 *
 * Invariant: `enter` is called from INSIDE the worker body (after the pool has
 * dequeued the item) and `leave` from its `finally`, so the tracked set is the
 * set of handlers actually running. It can therefore never announce a call that
 * has not started — the property that distinguishes this from a predicted
 * partition. Membership is a `Set` keyed by tool-use id, and the callback
 * receives a fresh snapshot array so a consumer cannot retain a mutating
 * reference.
 *
 * Invariant: notifications are edge-triggered on every enter and every leave,
 * including the final leave that empties the set. Consumers that badge a
 * parallel wave rely on that terminal empty snapshot to clear.
 *
 * @internal
 */
function createActivityTracker(
  onActivity: ((activeIds: readonly string[]) => void) | undefined,
): { enter: (id: string) => void; leave: (id: string) => void } {
  if (!onActivity) {
    // No consumer: both hooks degrade to no-ops so the worker body stays
    // allocation-free on the common (non-TTY / no-callback) path.
    return { enter: () => {}, leave: () => {} };
  }
  const active = new Set<string>();
  const notify = (): void => {
    try {
      onActivity([...active]);
    } catch {
      // Fire-and-forget: a misbehaving display consumer must never abort a
      // tool wave. Mirrors the notifyWaveStart/notifyWaveEnd contract below.
    }
  };
  return {
    enter: (id) => {
      active.add(id);
      notify();
    },
    leave: (id) => {
      active.delete(id);
      notify();
    },
  };
}

/**
 * Per-call execution unit dispatched by `settleWithConcurrencyLimit`.
 *
 * Performs the per-call abort check inline so a call whose signal fires
 * AFTER the wave is admitted still produces a clean abort result rather
 * than being dispatched to `executeCore`. Returns `{ result, originalIndex }`
 * so `reconcileOutcomes` can write results back at the correct position in
 * a way that is order-independent.
 *
 * Invariant: the pre-abort branch returns WITHOUT entering the activity
 * tracker, so a call refused before dispatch is never reported as active.
 * Every path that does begin work leaves the tracker in its `finally`.
 */
async function executeCallUnit(
  batchIdx: number,
  executableCalls: readonly IndexedCall[],
  executeCore: BatchExecDeps['executeCore'],
  activity?: { enter: (id: string) => void; leave: (id: string) => void },
): Promise<{ result: ToolResult; originalIndex: number }> {
  const { call, originalIndex } = executableCalls[batchIdx]!;
  if (call.signal.aborted) {
    return {
      result: {
        content: 'Tool call aborted',
        isError: true,
        failureClass: abortFailureClass(call.signal),
      } as ToolResult,
      originalIndex,
    };
  }
  activity?.enter(call.id);
  try {
    const result = await executeCore(call);
    return { result, originalIndex };
  } finally {
    activity?.leave(call.id);
  }
}

// ---------------------------------------------------------------------------
// Exported post-execution helpers (used by executeBatch in dispatcher.ts)
// ---------------------------------------------------------------------------

/**
 * Write settled promise results back into the shared `results` array.
 *
 * Each fulfilled entry writes `value.result` at `value.originalIndex`.
 * Each rejected entry constructs an error result; the original index is
 * recovered via `wave[settled.indexOf(outcome)]` (rejection carries no payload
 * by design — `executeCore` catches internally, so rejections are unexpected
 * safety-net paths only).
 *
 * Invariant: `executeCore` never rejects today; this function retains the
 * safety net for a future refactor that permits a rejection to escape.
 *
 * @internal Called only by {@link runConcurrentBatch}.
 */
export function reconcileOutcomes(
  settled: PromiseSettledResult<{ result: ToolResult; originalIndex: number }>[],
  wave: readonly number[],
  executableCalls: readonly IndexedCall[],
  results: ToolResult[],
): void {
  for (const outcome of settled) {
    if (outcome.status === 'fulfilled') {
      results[outcome.value.originalIndex] = outcome.value.result;
    } else {
      const msg =
        outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
      const batchIdx = wave[settled.indexOf(outcome)]!;
      results[executableCalls[batchIdx]!.originalIndex] = {
        content: `Tool execution error: ${msg}`,
        isError: true,
      };
    }
  }
}

/**
 * Stamp batch-membership metadata onto each result in `batch.indices`.
 *
 * Downstream consumers (TUI tool-lane render + `tool_call` completed trace
 * event) use `batchIndex`/`batchSize` to distinguish a genuine parallel wave
 * from back-to-back sequential dispatches — which are otherwise
 * indistinguishable once a fast root commits to scrollback ahead of a slow one.
 * 1-based `batchIndex` = ordinal within the batch; `batchSize` = number of
 * calls dispatched together. A concurrency-unsafe tool (bash, write_file, …)
 * is always its own singleton batch, so it lands `batchSize=1` and is never
 * badged. Blocked / short-circuited calls are excluded from `executableCalls`,
 * so they correctly carry no batch info at all.
 *
 * @internal Called by {@link SessionToolDispatcher.executeBatch} after each
 *   batch's execution branch completes.
 */
export function stampBatchMetadata(
  batch: Batch,
  executableCalls: readonly IndexedCall[],
  results: ToolResult[],
): void {
  const batchSize = batch.indices.length;
  for (let pos = 0; pos < batch.indices.length; pos++) {
    const batchIdx = batch.indices[pos]!;
    const r = results[executableCalls[batchIdx]!.originalIndex];
    if (r) {
      r.batchIndex = pos + 1;
      r.batchSize = batchSize;
    }
  }
}

// ---------------------------------------------------------------------------
// Concurrent branch
// ---------------------------------------------------------------------------

/**
 * Execute a concurrency-safe batch using wave-admission and bounded concurrency.
 *
 * Invariant: Each fingerprint admitted into a wave is gated by the remaining
 * failure-streak capacity — so a duplicate fan-out cannot exhaust its retry budget
 * across parallel calls before any prior result is known. Calls that exceed the
 * admission capacity are deferred to the next wave.
 *
 * Mutates `results[originalIndex]` for every call in `batch.indices`.
 */
export async function runConcurrentBatch(
  batch: Batch,
  executableCalls: IndexedCall[],
  results: ToolResult[],
  deps: BatchExecDeps,
): Promise<void> {
  // Admit calls in waves. Each normalized fingerprint gets only enough
  // slots to reach the threshold, so a duplicate fan-out cannot run past
  // the guard before its earlier results are known. Independent calls
  // retain the existing bounded concurrency.
  let pending = [...batch.indices];
  while (pending.length > 0) {
    const admittedByFingerprint = new Map<string, number>();
    const wave: number[] = [];
    const deferred: number[] = [];

    for (const batchIdx of pending) {
      const { call, originalIndex } = executableCalls[batchIdx]!;
      const refusal = checkRepeatGuard(call, deps.repeatFailureGuard, deps.repeatBreakerExemptTools);
      if (refusal) {
        results[originalIndex] = refusal;
        continue;
      }
      if (deps.repeatBreakerExemptTools.has(call.name)) {
        wave.push(batchIdx);
        continue;
      }
      const fingerprint = repeatFailureFingerprint(call);
      const capacity =
        REPEAT_FAILURE_REFUSAL_THRESHOLD - deps.repeatFailureGuard.streakFor(call);
      const admitted = admittedByFingerprint.get(fingerprint) ?? 0;
      if (admitted < capacity) {
        admittedByFingerprint.set(fingerprint, admitted + 1);
        wave.push(batchIdx);
      } else {
        deferred.push(batchIdx);
      }
    }
    pending = deferred;

    // Wave manifest: notify the subagent executor when ≥2 agent calls
    // are about to run concurrently so it can persist dispatch state for
    // interrupted-session recovery. Fire-and-forget; never throws.
    const agentCallsInWave = wave
      .map((batchIdx) => executableCalls[batchIdx]?.call)
      .filter((c): c is ToolCall => c !== undefined && c.name === 'agent');
    if (agentCallsInWave.length >= 2 && deps.subagentExecutor) {
      try {
        deps.subagentExecutor.notifyWaveStart(agentCallsInWave, deps.sessionId ?? '', null);
      } catch {
        // Fire-and-forget: manifest errors must never abort a wave.
      }
    }

    // Bounded concurrency remains in force within each admission wave.
    //
    // Invariant: the pool is work-conserving — a settling worker refills its
    // slot from the queue IMMEDIATELY, so the wave never stalls behind a slow
    // call. Live activity is reported from inside the worker body (see
    // createActivityTracker) rather than from a pre-computed partition, which
    // is what makes the reported set the genuinely-running one under exactly
    // this immediate-refill schedule. Do NOT replace the pool with barriered
    // chunks to make reporting easier: that changes the schedule (a chunk waits
    // for its slowest member) and is a real throughput regression.
    const activity = createActivityTracker(deps.onActivity);
    const settled = await settleWithConcurrencyLimit(
      wave,
      deps.maxConcurrentSafeCalls,
      (batchIdx) => executeCallUnit(batchIdx, executableCalls, deps.executeCore, activity),
    );

    reconcileOutcomes(settled, wave, executableCalls, results);

    // Apply observations only after every handler settles, and in the
    // batch's original call order rather than completion order.
    for (const batchIdx of wave) {
      const { call, originalIndex } = executableCalls[batchIdx]!;
      const result = results[originalIndex];
      if (result !== undefined && result.failureClass !== 'abort') {
        deps.repeatFailureGuard.note(call, result);
      }
    }

    // Wave manifest: clear the active wave after all units settled.
    if (agentCallsInWave.length >= 2 && deps.subagentExecutor) {
      try {
        deps.subagentExecutor.notifyWaveEnd();
      } catch {
        // Fire-and-forget.
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Sequential branch
// ---------------------------------------------------------------------------

/**
 * Execute a concurrency-unsafe batch sequentially.
 *
 * Each call in `batch.indices` runs after the prior one completes. Aborted calls
 * and repeat-failure refusals are handled inline without invoking `executeCore`.
 *
 * Mutates `results[originalIndex]` for every call in `batch.indices`.
 */
export async function runSequentialBatch(
  batch: Batch,
  executableCalls: IndexedCall[],
  results: ToolResult[],
  deps: BatchExecDeps,
): Promise<void> {
  for (const batchIdx of batch.indices) {
    const { call, originalIndex } = executableCalls[batchIdx]!;
    if (call.signal.aborted) {
      results[originalIndex] = {
        content: 'Tool call aborted',
        isError: true,
        failureClass: abortFailureClass(call.signal),
      };
      continue;
    }
    const refusal = checkRepeatGuard(call, deps.repeatFailureGuard, deps.repeatBreakerExemptTools);
    if (refusal) {
      results[originalIndex] = refusal;
      continue;
    }
    const result = await deps.executeCore(call);
    results[originalIndex] = result;
    deps.repeatFailureGuard.note(call, result);
  }
}
