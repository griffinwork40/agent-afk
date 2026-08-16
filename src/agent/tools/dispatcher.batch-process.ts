/**
 * Batch-execution helpers for {@link SessionToolDispatcher.executeBatch}.
 *
 * Extracted from `dispatcher.ts` to reduce nesting depth in the two execution
 * branches of the batch loop:
 *  - {@link runConcurrentBatch} — `isConcurrencySafe` wave-admission loop.
 *  - {@link runSequentialBatch} — sequential (concurrency-unsafe) loop.
 *
 * Both functions receive their dispatcher-state dependencies through an explicit
 * {@link BatchExecDeps} object rather than through closure, so the concerns are
 * isolable and unit-testable without constructing a full dispatcher.
 *
 * @module agent/tools/dispatcher.batch-process
 */

import { abortFailureClass } from '../abort-reason.js';
import { settleWithConcurrencyLimit } from '../concurrency-pool.js';
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
  return verdict ? verdict.result : null;
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
    const settled = await settleWithConcurrencyLimit(
      wave,
      deps.maxConcurrentSafeCalls,
      async (batchIdx) => {
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
        const result = await deps.executeCore(call);
        return { result, originalIndex };
      },
    );

    for (const outcome of settled) {
      if (outcome.status === 'fulfilled') {
        results[outcome.value.originalIndex] = outcome.value.result;
      } else {
        // Invariant: executeCore catches today; retain this safety net
        // for a future refactor that permits a rejection to escape.
        const msg =
          outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
        const batchIdx = wave[settled.indexOf(outcome)]!;
        results[executableCalls[batchIdx]!.originalIndex] = {
          content: `Tool execution error: ${msg}`,
          isError: true,
        };
      }
    }

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
