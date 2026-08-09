/**
 * Turn-scoped accumulators for the anthropic-direct loop.
 *
 * Contract: everything here lives for the WHOLE turn and is never reset
 * between tool-use rounds — the deliberate contrast with
 * {@link ../loop/retry-budget.RoundRetryBudget}, whose every field is released
 * at each clean round boundary. Keeping the two lifetimes in separate objects
 * is what makes "which state survives a `continue`?" answerable by reading a
 * type instead of tracing a thousand-line function.
 *
 * @module agent/providers/anthropic-direct/loop/turn-accumulator
 */

import { randomUUID } from 'node:crypto';
import type { ProviderUsage } from '../../../provider.js';
import type { SOFT_DEADLINE_WIND_DOWN } from '../../shared/soft-deadline.js';
import type { TOOL_USE_LOOP_CAPPED } from '../../shared/tool-loop-cap.js';
import { sumProviderUsage } from '../types.js';

/**
 * Which budget tripped the single tools-stripped wind-down round, or `null`
 * while the turn is still running normally.
 *
 * Contract: this doubles as the terminal `stopReason` stamped on
 * `turn.completed`, so the two triggers stay distinguishable downstream —
 * `session/closure-reason.ts` maps ROUND exhaustion to `iteration_cap` and TIME
 * exhaustion to `timeout`, which call for different operator responses (narrow
 * the task vs. raise the budget).
 */
export type WindDownReason =
  | typeof TOOL_USE_LOOP_CAPPED
  | typeof SOFT_DEADLINE_WIND_DOWN;

/**
 * Mutable per-turn tallies plus the wall-clock origin every terminal event is
 * measured against.
 */
export class TurnAccumulator {
  /** Usage summed across every round of this turn. */
  usage: ProviderUsage = { stopReason: null };

  /** Completed tool-use ROUNDS. Compared against the iteration cap. */
  iterations = 0;

  /**
   * Cumulative count of tool CALLS dispatched across the whole turn — distinct
   * from {@link iterations}. A single round can batch several parallel
   * `tool_use` blocks, so rounds ≠ calls. Surfaced as the progress event's
   * `toolUses` so the CLI's `formatToolCallStat` renders a truthful
   * "N tool calls" even when a round runs several at once (PR 508 review, P2).
   */
  toolCallCount = 0;

  /**
   * Non-null once a budget has been spent — the tool-use ROUND cap or the SOFT
   * wall-clock deadline. The loop then runs ONE final "wind-down" round with
   * tools stripped, so the model produces a real answer from what it gathered
   * instead of being cut off mid-round — a silent stop with no final message is
   * indistinguishable from a hang (the same failure mode the `refusal` branch
   * guards against).
   *
   * Contract: holds the REASON rather than a bare boolean so the terminal
   * `stopReason` names which budget ran out. Truthiness is the "wind-down
   * armed" test every read site uses; the value is only consulted at the
   * terminal yields.
   *
   * Invariant: written at the END of round N and read at the START of round
   * N+1, so it must outlive a `continue`.
   */
  windDownReason: WindDownReason | null = null;

  /** Correlation id for this turn's trace events. */
  readonly taskId: string = randomUUID();

  /** Wall-clock origin for `durationMs` on every terminal event. */
  readonly startedAt: number = Date.now();

  /** Milliseconds elapsed since the turn began. */
  elapsedMs(): number {
    return Date.now() - this.startedAt;
  }

  /**
   * Stamp `durationMs` onto a usage payload.
   *
   * Single point of truth for the turn-end wall-clock measurement that lands in
   * the REPL footer's `◦ Xs · $cost · N tok` line via
   * `ResponseMetadata.durationMs` → `printTurnFooter`. Before this existed the
   * terminal yield sites all passed bare accumulated usage, and neither
   * `toProviderUsage` nor `sumProviderUsage` ever wrote `durationMs` — so the
   * footer rendered as just `◦ N tok` for every anthropic-direct turn.
   */
  withDuration(usage: ProviderUsage): ProviderUsage {
    return { ...usage, durationMs: this.elapsedMs() };
  }

  /**
   * The common terminal payload: accumulated usage stamped with the turn
   * duration. Use {@link withDuration} directly at the few sites that override
   * `stopReason` (overload-exhausted, tool-use-capped).
   */
  terminalUsage(): ProviderUsage {
    return this.withDuration(this.usage);
  }

  /**
   * Fold one round's usage into the turn total and re-stamp the context-window
   * footprint.
   *
   * Contract: `contextWindowTokens` is THIS round's full input occupancy, not a
   * cumulative sum. Anthropic's `input_tokens` excludes cache (docs: "tokens
   * which were not read from or used to create a cache"), so the window total
   * is input + cache_read + cache_creation + output for the latest call.
   * Computed from the single round because cumulative `inputTokens` would
   * double-count tokens already present in the latest `cache_read`.
   * `sumProviderUsage` discards the field (it builds a fresh object), so it is
   * re-stamped every round and reflects only the last one.
   */
  addRoundUsage(roundUsage: ProviderUsage): void {
    this.usage = sumProviderUsage(this.usage, roundUsage);
    this.usage.contextWindowTokens =
      (roundUsage.inputTokens ?? 0) +
      (roundUsage.outputTokens ?? 0) +
      (roundUsage.cachedInputTokens ?? 0) +
      (roundUsage.cacheCreationTokens ?? 0);
  }
}
