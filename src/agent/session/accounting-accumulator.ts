/**
 * Accounting accumulator for per-session cost, token, and terminal-cause
 * state, extracted from {@link AgentSession}.
 *
 * Owns the 10 private fields that track cumulative spend, per-turn and
 * per-subagent token rollups, and boolean terminal-cause flags. `AgentSession`
 * holds a single `private readonly accounting = new AccountingAccumulator()`
 * instance and delegates all reads and writes through the named methods here —
 * no back-reference to `AgentSession` is held.
 *
 * @module agent/session/accounting-accumulator
 */

import type { ClosureSignals } from './closure-emitter.js';
import type { ResponseMetadata } from '../types.js';

/** Mutable token counter tuple used for both session and subagent rollups. */
interface TokenCounters {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

/** Read-only snapshot of the accumulator's current state. */
export interface AccountingSnapshot {
  sessionRunningCostUsd: number;
  sessionRunningTokens: Readonly<TokenCounters>;
  subagentCompletedCount: number;
  subagentRunningTokens: Readonly<TokenCounters>;
  subagentRunningCostUsd: number;
}

function zeroCounters(): TokenCounters {
  return { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

export class AccountingAccumulator {
  /** Cumulative USD cost across all turns this session. Mirrored from
   *  per-turn `metadata.totalCostUsd` so the trace writer's
   *  `session_sealed` payload can report the final figure without
   *  reaching into `TransformDeps`. */
  private sessionRunningCostUsd = 0;
  /** Cumulative token counters across all turns. Mirrored from each
   *  turn's `metadata.usage` so the `closure` event can report the final
   *  tuple. Per-counter optionality on the schema lets us emit a partial
   *  tuple when a provider doesn't report cache breakdowns. */
  private sessionRunningTokens: TokenCounters = zeroCounters();
  /** Last `stopReason` the provider reported on a `turn.completed` event.
   *  Threaded into the `closure` trace payload so a reader can see what
   *  the model said about the end of the final turn (e.g. `end_turn`,
   *  `tool_use_loop_capped`, `max_tokens`). Undefined when no turn
   *  completed in this session. */
  private lastStopReason: string | undefined;
  /**
   * Terminal-cause flags set at their origin sites so `deriveClosureReason`
   * reports the specific reason instead of a generic abort. Reset by `reset()`.
   */
  private maxTurnsHit = false;
  private hookBlocked = false;
  /**
   * True when the provider emitted a terminal `error` event (an HTTP / auth /
   * stream failure) as the session's last turn outcome. Set at the two
   * error-observation sites — `pullInitialization` (init-phase error) and
   * `sendMessageStreamInternal` (per-turn error) — and cleared by a subsequent
   * completed turn so it reflects the FINAL turn's result, not any error
   * earlier in the session. Read by `deriveClosureReason` (→ `abort`) and
   * `deriveSealStatus` (→ `failed`) so a provider failure on an otherwise-clean
   * `close()` is not sealed as a silent `succeeded` / `model_end_turn`. Reset
   * by `reset()`.
   */
  private sawProviderError = false;
  /**
   * Wall-clock timestamp captured at construction — used to compute the
   * `session_init_done` phase duration and the `session_init_start` emit.
   */
  readonly sessionStartedAt: number = Date.now();
  /** Number of subagent forks that reached `succeeded` status. */
  private subagentCompletedCount = 0;
  /** Cumulative token counters rolled up from completed subagents. */
  private subagentRunningTokens: TokenCounters = zeroCounters();
  /** Cumulative USD cost rolled up from completed subagents. */
  private subagentRunningCostUsd = 0;

  /**
   * Reset all mutable accounting state for a new SDK lifecycle cycle
   * (i.e. after `/clear`). `sessionStartedAt` is intentionally NOT reset —
   * it anchors the phase-duration computation from construction, not from
   * the most recent cycle.
   */
  reset(): void {
    this.sessionRunningCostUsd = 0;
    this.sessionRunningTokens = zeroCounters();
    this.lastStopReason = undefined;
    this.maxTurnsHit = false;
    this.hookBlocked = false;
    this.sawProviderError = false;
    this.subagentCompletedCount = 0;
    this.subagentRunningTokens = zeroCounters();
    this.subagentRunningCostUsd = 0;
  }

  /**
   * Mirror per-turn cost/token metadata into the session-wide accumulators.
   * Called by `buildTransformDeps().setLastResponseMetadata` on every completed
   * turn.
   *
   * Contract: numeric guards match the original inline logic — non-finite or
   * missing values are silently skipped so a provider quirk never NaN-poisons
   * the running total.
   */
  recordTurnMetadata(m: ResponseMetadata): void {
    if (typeof m.totalCostUsd === 'number' && Number.isFinite(m.totalCostUsd)) {
      this.sessionRunningCostUsd += m.totalCostUsd;
    }
    const usage = m.usage;
    if (usage && typeof usage === 'object') {
      const u = usage as Record<string, unknown>;
      const addCounter = (key: string, target: keyof TokenCounters): void => {
        const v = u[key];
        if (typeof v === 'number' && Number.isFinite(v)) {
          this.sessionRunningTokens[target] += v;
        }
      };
      addCounter('input_tokens', 'input');
      addCounter('output_tokens', 'output');
      addCounter('cache_read_input_tokens', 'cacheRead');
      addCounter('cache_creation_input_tokens', 'cacheCreation');
    }
    if (typeof m.stopReason === 'string') {
      this.lastStopReason = m.stopReason;
    }
  }

  /** Set when a SessionStart hook throws {@link HookBlockedError}. */
  markHookBlocked(): void {
    this.hookBlocked = true;
  }

  /**
   * Set when `assertCanSend` detects that `config.maxTurns` has been reached.
   * Read by `deriveClosureReason` so the closure is labelled
   * `max_turns_exceeded` rather than a generic abort.
   */
  markMaxTurnsHit(): void {
    this.maxTurnsHit = true;
  }

  /**
   * Set on a terminal provider error (init-phase or per-turn). Flips the
   * eventual clean close from `succeeded / model_end_turn` to
   * `failed / abort`. See field-level comment for the FINAL-turn-only semantics.
   */
  markProviderError(): void {
    this.sawProviderError = true;
  }

  /**
   * Clear the provider-error flag after a successful turn so the seal status
   * reflects the FINAL turn's outcome, not any earlier error in the session.
   */
  clearProviderError(): void {
    this.sawProviderError = false;
  }

  /**
   * Accumulate token and cost data from a completed subagent into the
   * session-level rollup included in `session_sealed`.
   *
   * Called by the `SubagentManager` (or any caller constructing a
   * `SubagentHandle`) after each fork reaches `succeeded` status.
   * Thread-safe for sequential single-session use (no concurrent mutation).
   *
   * @param usage   - Token breakdown from {@link SubagentTrace.usage}.
   * @param costUsd - Optional USD cost for this subagent (from
   *                  {@link SubagentSucceededPayload.totalCostUsd}).
   */
  recordSubagentCompletion(
    usage?: {
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
    },
    costUsd?: number,
  ): void {
    this.subagentCompletedCount++;

    if (usage) {
      const add = (v: number | undefined, key: keyof TokenCounters): void => {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
          this.subagentRunningTokens[key] += v;
        }
      };
      add(usage.inputTokens, 'input');
      add(usage.outputTokens, 'output');
      add(usage.cacheReadTokens, 'cacheRead');
      add(usage.cacheCreationTokens, 'cacheCreation');
    }

    if (typeof costUsd === 'number' && Number.isFinite(costUsd) && costUsd > 0) {
      this.subagentRunningCostUsd += costUsd;
    }
  }

  /**
   * Snapshot the terminal-cause signals the closure emitters read.
   *
   * `signal` and `dispatchReason` originate in `AgentSession` and are passed
   * in as arguments rather than stored here — the accumulator owns the boolean
   * flags but not the abort controller or the dispatch-reason string.
   */
  closureSignals(signal: AbortSignal, dispatchReason: string): ClosureSignals {
    return {
      dispatchReason,
      signal,
      maxTurnsHit: this.maxTurnsHit,
      hookBlocked: this.hookBlocked,
      lastStopReason: this.lastStopReason,
      sawProviderError: this.sawProviderError,
    };
  }

  /**
   * Return a read-only snapshot of all accumulated state for use in
   * `dispatchSessionEndOnce` (feeds `emitClosureEvent` and `sealTraceWriter`).
   */
  snapshot(): AccountingSnapshot {
    return {
      sessionRunningCostUsd: this.sessionRunningCostUsd,
      sessionRunningTokens: { ...this.sessionRunningTokens },
      subagentCompletedCount: this.subagentCompletedCount,
      subagentRunningTokens: { ...this.subagentRunningTokens },
      subagentRunningCostUsd: this.subagentRunningCostUsd,
    };
  }
}
