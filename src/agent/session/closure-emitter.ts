/**
 * Session-closure trace emission, extracted from {@link AgentSession}.
 *
 * These are the terminal-classification + trace-seal helpers that
 * `AgentSession.dispatchSessionEndOnce` fires when a session ends: they map the
 * session's accumulated run counters and terminal-cause flags into the
 * `closure` and `session_sealed` witness records.
 *
 * Kept as free functions taking an explicit deps snapshot (mirroring
 * `stream-consumer.ts`'s `transformProviderEvent(deps)`) rather than lifted
 * into a stateful owner: the counters they read (`sessionRunningTokens`,
 * `sessionRunningCostUsd`, the terminal-cause flags) are mutated across several
 * AgentSession sites — construction/reset, the `buildTransformDeps` callback,
 * and the per-turn stream loop — so moving the state here would widen the
 * shared-mutable-state surface, not shrink it. The session keeps ownership of
 * the fields and passes a read snapshot at seal time.
 *
 * @module agent/session/closure-emitter
 */

import { BudgetExceededError, TimeoutError } from '../../utils/errors.js';
import { emitClosure } from '../trace/emit.js';
import type { ClosureReason } from '../trace/index.js';
import type { TraceWriter } from '../trace/writer.js';
import { buildClosureGuidance } from './closure-guidance.js';
import { classifyClosureReason } from './closure-reason.js';

/** Cumulative token tuple mirrored into the `closure` / `session_sealed` payloads. */
export interface ClosureTokenCounters {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/**
 * Terminal-cause snapshot shared by closure-reason and seal-status derivation.
 * `dispatchReason` doubles as the seal `reason` — both derivations receive the
 * identical string `dispatchSessionEndOnce` was called with (close/reset/error).
 */
export interface ClosureSignals {
  /** The reason string passed to `dispatchSessionEndOnce` (close/reset/error). */
  dispatchReason: string;
  /** The session's internal abort signal; its `.aborted`/`.reason` drive classification. */
  signal: AbortSignal;
  maxTurnsHit: boolean;
  hookBlocked: boolean;
  lastStopReason: string | undefined;
  sawProviderError: boolean;
}

/**
 * Pre-classify the abort-signal reason (this needs the concrete error classes
 * in scope), then delegate the precedence decision tree to the pure
 * {@link classifyClosureReason}. Wired reasons: `model_end_turn`, `truncated`,
 * `abort`, `timeout`, `budget_exceeded`, `hook_blocked`, `max_turns_exceeded`.
 */
export function deriveClosureReason(s: ClosureSignals): ClosureReason {
  let abort: 'budget_exceeded' | 'timeout' | 'abort' | null = null;
  const signal = s.signal;
  if (signal.aborted && signal.reason !== 'closed') {
    const r = signal.reason;
    if (r instanceof BudgetExceededError) abort = 'budget_exceeded';
    else if (r instanceof TimeoutError) abort = 'timeout';
    // Some abort paths pass the error's message string rather than the error
    // instance — match the well-known prefixes as a fallback so the
    // classification stays accurate when the abort reason was stringified.
    else if (typeof r === 'string' && r.startsWith('Budget ')) abort = 'budget_exceeded';
    else if (typeof r === 'string' && r.includes('timed out')) abort = 'timeout';
    else abort = 'abort';
  }
  return classifyClosureReason({
    dispatchReason: s.dispatchReason,
    maxTurnsHit: s.maxTurnsHit,
    hookBlocked: s.hookBlocked,
    abort,
    lastStopReason: s.lastStopReason,
    sawProviderError: s.sawProviderError,
  });
}

/**
 * Map a session-end reason to the `session_sealed` status.
 *  - reason `'error'` → `'failed'`
 *  - any reason with an aborted signal (reason !== `'closed'`) → `'cancelled'`
 *    (abort beats the reason string, matching the abort-precedence invariant)
 *  - a final-turn provider error → `'failed'` (checked after abort so a genuine
 *    cancel/budget/timeout keeps its more-specific `cancelled` status)
 *  - otherwise → `'succeeded'`
 * `close()` aborts its own controller with reason `'closed'` as normal
 * teardown — that is NOT a cancellation.
 */
export function deriveSealStatus(s: ClosureSignals): 'succeeded' | 'failed' | 'cancelled' {
  if (s.dispatchReason === 'error') return 'failed';
  const signal = s.signal;
  if (signal.aborted && signal.reason !== 'closed') return 'cancelled';
  if (s.sawProviderError) return 'failed';
  return 'succeeded';
}

/** Session-run counters read into the terminal `closure` / `session_sealed` payloads. */
export interface ClosureTotals {
  finalTurnCount: number;
  finalCostUsd: number;
}

/** Inputs for {@link emitClosureEvent}: terminal signals + session-run totals. */
export interface EmitClosureInput extends ClosureSignals, ClosureTotals {
  runningTokens: ClosureTokenCounters;
}

/**
 * Emit the `closure` trace event with the session's terminal classification.
 * No-op when the writer is absent. Attaches a recovery `guidance` hint for
 * anomalous reasons (benign reasons omit the field).
 */
export async function emitClosureEvent(
  writer: TraceWriter | undefined,
  input: EmitClosureInput,
): Promise<void> {
  if (!writer) return;
  const reasonValue = deriveClosureReason(input);
  const finalTokens: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheCreation?: number;
  } = {};
  const t = input.runningTokens;
  if (t.input > 0) finalTokens.input = t.input;
  if (t.output > 0) finalTokens.output = t.output;
  if (t.cacheRead > 0) finalTokens.cacheRead = t.cacheRead;
  if (t.cacheCreation > 0) finalTokens.cacheCreation = t.cacheCreation;

  const guidance = buildClosureGuidance(reasonValue);

  await emitClosure(writer, {
    reason: reasonValue,
    finalTurnCount: input.finalTurnCount,
    finalCostUsd: input.finalCostUsd,
    finalTokens,
    ...(input.lastStopReason !== undefined ? { lastStopReason: input.lastStopReason } : {}),
    ...(guidance !== null ? { guidance } : {}),
  });
}

/** Inputs for {@link sealTraceWriter}: terminal signals + totals + subagent rollup. */
export interface SealTraceInput extends ClosureSignals, ClosureTotals {
  subagentCompletedCount: number;
  subagentRunningTokens: ClosureTokenCounters;
  subagentRunningCostUsd: number;
}

/**
 * Seal the trace writer with the terminal `session_sealed` record. No-op when
 * the writer is absent. The optional subagent-rollup fields are present only
 * when at least one subagent completed and reported the corresponding data.
 */
export async function sealTraceWriter(
  writer: TraceWriter | undefined,
  input: SealTraceInput,
): Promise<void> {
  if (!writer) return;
  const status = deriveSealStatus(input);

  const subagentCount =
    input.subagentCompletedCount > 0 ? input.subagentCompletedCount : undefined;

  const tok = input.subagentRunningTokens;
  const hasSubagentTokens =
    tok.input > 0 || tok.output > 0 || tok.cacheRead > 0 || tok.cacheCreation > 0;
  const subagentTokens = hasSubagentTokens
    ? {
        ...(tok.input > 0 ? { input: tok.input } : {}),
        ...(tok.output > 0 ? { output: tok.output } : {}),
        ...(tok.cacheRead > 0 ? { cacheRead: tok.cacheRead } : {}),
        ...(tok.cacheCreation > 0 ? { cacheCreation: tok.cacheCreation } : {}),
      }
    : undefined;

  const subagentCostUsd =
    input.subagentRunningCostUsd > 0 ? input.subagentRunningCostUsd : undefined;

  await writer.seal({
    status,
    finalCostUsd: input.finalCostUsd,
    finalTurnCount: input.finalTurnCount,
    closedAt: new Date().toISOString(),
    ...(subagentCount !== undefined ? { subagentCount } : {}),
    ...(subagentTokens !== undefined ? { subagentTokens } : {}),
    ...(subagentCostUsd !== undefined ? { subagentCostUsd } : {}),
  });
}
