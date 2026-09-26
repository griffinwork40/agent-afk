/**
 * Batch orchestration for {@link SessionToolDispatcher.executeBatch}.
 *
 * Extracted from `dispatcher.ts` to keep the class below the 350-code-line
 * ceiling. Owns Phase 1 (gate partitioning + parallel/sequential dispatch) and
 * Phase 2 (batch-partition + execute loop) of `executeBatch`, delegating the
 * individual batch runners to `dispatcher.batch-process.ts`.
 *
 * The free function {@link executeBatchImpl} receives all dispatcher state
 * through an explicit {@link ExecuteBatchDeps} interface -- no class reference,
 * same pattern as `dispatcher.core-exec.ts` and `dispatcher.pre-dispatch-gates.ts`.
 *
 * @module agent/tools/dispatcher.execute-batch
 */

import { abortFailureClass } from '../abort-reason.js';
import { partitionIntoBatches } from './dispatch-batching.js';
import {
  runConcurrentBatch,
  runSequentialBatch,
  runParallelGates,
  stampBatchMetadata,
} from './dispatcher.batch-process.js';
import type { IndexedCall, BatchExecDeps } from './dispatcher.batch-process.js';
import {
  accountDenialBreakerPostGate,
  replayObserveSuspectedLoopPostGate,
} from './dispatcher.pre-dispatch-gates.js';
import type {
  RunPreDispatchGatesOpts,
  PreDispatchGateDeps,
} from './dispatcher.pre-dispatch-gates.js';
import { emitSessionPhase } from '../trace/emit.js';
import type { TraceSink } from '../trace/index.js';
import type { ToolCall, ToolResult } from '../providers/anthropic-direct/types.js';
import type { ToolActivityReporter } from '../providers/shared/tool-activity.js';
import type { RepeatFailureGuard } from './repeat-failure-guard.js';
import type { SubagentExecutor } from './subagent-executor.js';
import type { ConcurrencyClassifier } from './types.js';

/**
 * Dependency surface for {@link executeBatchImpl}. Every field maps 1:1 to a
 * private member or method of `SessionToolDispatcher`; wired at the call site
 * in `executeBatch()` so the free function is class-agnostic.
 */
export interface ExecuteBatchDeps {
  /** Single-call executor (for the length-1 fast path). */
  execute: (call: ToolCall) => Promise<ToolResult>;
  /** Concurrency classifier to partition safe vs. unsafe. */
  classifier: ConcurrencyClassifier;
  /**
   * Pre-dispatch gate chain (hooks, permissions, circuit breakers).
   * The `opts` parameter allows the parallel-gate path to pass
   * `{ parallelSafe: true }` to skip race-prone read-modify-write counters;
   * the denial-breaker counter is accounted sequentially after the wave
   * settles via `accountDenialBreakerPostGate`; the repeat-breaker is
   * intentionally dropped (consecutive ordering is undefined for calls
   * emitted in one model turn; Phase 2's wave-admission loop re-checks via
   * the repeat-failure guard before execution).
   */
  runPreDispatchGates: (call: ToolCall, opts?: RunPreDispatchGatesOpts) => Promise<ToolResult | null>;
  /** Reset the denial-breaker on progress. */
  resetDenialBreaker: () => void;
  /** Repeat-failure guard threaded into batch deps. */
  repeatFailureGuard: RepeatFailureGuard;
  /** Repeat-breaker exempt tools set. */
  repeatBreakerExemptTools: ReadonlySet<string>;
  /** Core execution path per tool. */
  executeCore: (call: ToolCall) => Promise<ToolResult>;
  /** Subagent executor (for batch deps). */
  subagentExecutor: SubagentExecutor | undefined;
  /** Session id (for batch deps). */
  sessionId: string | undefined;
  /** Max concurrent safe calls ceiling. */
  maxConcurrentSafeCalls: number;
  /**
   * Gate dependency bundle for post-parallel denial-breaker accounting.
   * Required when the parallel gate path (safe calls) blocks a call via a
   * hook-block denial — `accountDenialBreakerPostGate` needs it to update
   * `state.denialBreaker` sequentially after `runParallelGates` returns.
   */
  gateDeps: () => PreDispatchGateDeps;
  /**
   * Witness trace writer. When present, `executeBatchImpl` emits a
   * `gate_shape` session-phase event after Phase 1 gate execution, carrying
   * `{ safeCount, unsafeCount, parallelGatesMs }`. Fire-and-forget; absent
   * trace writers suppress the event with no side effects.
   */
  traceWriter: TraceSink | undefined;
}

/**
 * Execute a batch of tool calls with parallel dispatch for concurrency-safe
 * tools. Unsafe tools run sequentially. Results are returned in the same
 * order as the input `calls` array regardless of completion order.
 *
 * Hook ordering: PreToolUse fires for every call BEFORE execution starts.
 * For concurrency-safe calls (agent, skill, compose, reads), gates run in
 * parallel since their hooks are independent; for unsafe calls (bash,
 * write_file), gates run sequentially to preserve interactive-prompt
 * ordering. Blocked calls get an immediate error result and are excluded
 * from execution. PostToolUse fires per-tool after completion.
 *
 * Implementation: the two execution branches (concurrent wave-admission and
 * sequential loop) are extracted into {@link runConcurrentBatch} and
 * {@link runSequentialBatch} in `dispatcher.batch-process.ts` to reduce
 * nesting depth. This function retains the phase-1 gate loop, batch
 * partitioning, batch-stamp pass, and the reset-on-success denial-breaker
 * reset.
 *
 * `onActivity` is the live in-flight channel (issue #516). It fires from
 * inside the concurrency pool's worker body on every start and every settle,
 * carrying the ids ACTUALLY running at that moment -- so a caller can badge a
 * genuine parallel wave while it is still in flight. It is never called with
 * a predicted or queued set: the single-call fast path returns before the pool
 * is reached (a lone call is not a parallel wave), and the sequential branch
 * never reports (one call runs at a time by definition).
 */
export async function executeBatchImpl(
  calls: ToolCall[],
  deps: ExecuteBatchDeps,
  onActivity?: ToolActivityReporter,
): Promise<ToolResult[]> {
  if (calls.length === 0) return [];
  if (calls.length === 1) return [await deps.execute(calls[0]!)];

  const results: ToolResult[] = new Array(calls.length);
  const blocked = new Set<number>();

  // Phase 1: PreToolUse + permission gates for all calls.
  // Blocked calls get error results immediately and skip execution.
  //
  // Concurrency-safe calls run their gates in parallel: their hooks are
  // independent (path-approval auto-denies forks without prompting, so
  // no human interaction serializes them), and the per-call state they
  // read (permissions, read-only-bash mode) is immutable within a turn.
  // The repeat-circuit-breaker is sequential-sensitive, but for parallel
  // calls the "consecutive" ordering is arbitrary (the model emitted
  // them in one turn), and Phase 2's wave-admission loop already
  // re-checks the repeat-failure guard before execution begins.
  //
  // Note: the parallel safety claim applies to the built-in PreToolUse
  // hook registry. Callers who supply a `canUseTool` with an interactive
  // `onAsk` callback (see permissions.ts) should ensure their callback
  // is concurrency-safe, as safe-classified tools may invoke it in
  // parallel during Phase 1.
  //
  // Unsafe calls still run sequentially: their hooks MAY prompt (the
  // path-approval hook on an interactive surface), so ordering matters.
  const safeIndices: number[] = [];
  const unsafeIndices: number[] = [];
  for (let i = 0; i < calls.length; i++) {
    const call = calls[i]!;
    if (call.signal.aborted) {
      results[i] = { content: 'Tool call aborted', isError: true, failureClass: abortFailureClass(call.signal) };
      blocked.add(i);
      continue;
    }
    if (deps.classifier(call.name, call.input)) {
      safeIndices.push(i);
    } else {
      unsafeIndices.push(i);
    }
  }

  // Gate concurrency-safe calls in parallel.
  // Pass parallelSafe: true so runPreDispatchGates skips the race-prone
  // read-modify-write counters (state.repeatBreaker, state.denialBreaker).
  // Denial-breaker accounting runs sequentially after the wave settles.
  // Time the parallel wave for gate_shape telemetry (#1924).
  const parallelGatesStart = Date.now();
  await runParallelGates(
    safeIndices, calls, results, blocked,
    (call) => deps.runPreDispatchGates(call, { parallelSafe: true }),
  );
  const parallelGatesMs = Date.now() - parallelGatesStart;

  // Post-parallel denial-breaker accounting for blocked safe calls.
  // recordForkReadDenial was skipped inside the parallel closures to avoid a
  // concurrent read-modify-write race. Replay it now, sequentially, for each
  // safe index that was blocked. The result may be upgraded to a denial-breaker
  // error when the threshold is reached — update results[i] accordingly.
  const gateDeps = deps.gateDeps();
  for (const i of safeIndices) {
    if (!blocked.has(i)) continue;
    const blockResult = results[i]!;
    // Only hook-block denials feed the denial breaker; permission-denied and
    // other gate results (bash-blocked, repeat-breaker) do not.
    if (blockResult.failureClass !== 'hook-block') continue;
    // Use the original err.reason preserved as blockReason — it is the exact
    // string isSubagentContainmentDenial checks. When blockReason is undefined
    // (err.reason was undefined), pass undefined rather than falling back to
    // blockResult.content: the sequential path passes err.reason directly, and
    // isSubagentContainmentDenial(undefined) returns false. Falling back to
    // content would create an asymmetry because the composite content string
    // includes injectContext, which could false-positive the sentinel check.
    results[i] = accountDenialBreakerPostGate(
      calls[i]!,
      blockResult.blockReason,
      blockResult,
      gateDeps,
    );
  }

  // Post-parallel suspected-loop observer replay for non-blocked safe calls.
  // observeSuspectedLoop was skipped inside the parallel closures to avoid a
  // concurrent read-modify-write race on the sliding window state. Replay it
  // now, sequentially, for each safe index that was NOT blocked — matching the
  // sequential path where the observer runs after a call passes the gate.
  // This closes the coverage gap for sessions (e.g. read-heavy recon agents)
  // that only issue safe tool calls and never hit the sequential gate path.
  for (const i of safeIndices) {
    if (blocked.has(i)) continue;
    replayObserveSuspectedLoopPostGate(calls[i]!, gateDeps);
  }

  // Gate-shape telemetry (#1924): emit partition sizes + parallel-gate wall-clock
  // immediately after the parallel wave settles (before the sequential unsafe
  // loop), so parallelGatesMs reflects only the parallel portion of Phase 1.
  // Fire-and-forget; no effect on dispatch.
  void emitSessionPhase(deps.traceWriter, {
    phase: 'gate_shape',
    metadata: {
      safeCount: safeIndices.length,
      unsafeCount: unsafeIndices.length,
      parallelGatesMs,
    },
  });

  // Gate unsafe calls sequentially (may prompt on interactive surfaces).
  for (const i of unsafeIndices) {
    const gateResult = await deps.runPreDispatchGates(calls[i]!);
    if (gateResult) {
      results[i] = gateResult;
      blocked.add(i);
    }
  }

  // Phase 2: partition non-blocked calls into batches and execute.
  const executableCalls: IndexedCall[] = calls
    .map((call, i) => ({ call, originalIndex: i }))
    .filter((_, i) => !blocked.has(i));

  if (executableCalls.length === 0) return results;

  const batches = partitionIntoBatches(
    executableCalls.map((e) => e.call),
    deps.classifier,
  );

  // Dependency bundle threaded into the extracted batch helpers.
  // Per-call abort check, not batch-level: each ToolCall carries its own
  // `signal` and they are not type-constrained to be identical across a
  // batch. Checking only `calls[0]!.signal` was correct by coincidence
  // because the provider loop currently assigns the same per-turn signal
  // to every call, but a future refactor to per-tool signals would
  // silently misbehave in both directions -- falsely aborting fresh calls
  // when call[0] is stale, and falsely dispatching aborted calls when
  // call[0] is fresh. Both helpers perform per-call abort checks.
  const batchDeps: BatchExecDeps = {
    repeatFailureGuard: deps.repeatFailureGuard,
    repeatBreakerExemptTools: deps.repeatBreakerExemptTools,
    executeCore: (call) => deps.executeCore(call),
    subagentExecutor: deps.subagentExecutor,
    sessionId: deps.sessionId,
    maxConcurrentSafeCalls: deps.maxConcurrentSafeCalls,
    onActivity,
  };

  for (const batch of batches) {
    if (batch.isConcurrencySafe) {
      await runConcurrentBatch(batch, executableCalls, results, batchDeps);
    } else {
      await runSequentialBatch(batch, executableCalls, results, batchDeps);
    }

    // Stamp batch membership onto each result. See stampBatchMetadata in
    // dispatcher.batch-process.ts for full rationale and field semantics.
    stampBatchMetadata(batch, executableCalls, results);
  }

  // Reset-on-success (#546): if any call in this batch executed successfully,
  // the fork made progress, so the denial breaker's consecutive-denial count
  // restarts. Blocked/denied calls carry isError:true and never reset. See
  // recordForkReadDenial.
  if (results.some((r) => r !== undefined && r.isError !== true)) {
    deps.resetDenialBreaker();
  }

  return results;
}
