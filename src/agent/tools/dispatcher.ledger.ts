/**
 * Dispatch-boundary wiring for the session-scoped {@link ToolCallLedger}
 * (issue #4476, "Wired at the dispatch boundary").
 *
 * Extracted as a sibling of `dispatcher.ts` (which sits at the 350-code-line
 * ceiling). Owns three things:
 *
 *   1. The ONE ledger instance for a session plus the session's tool-round
 *      counter (the ledger's `turnIndex`).
 *   2. A failure-isolated `record` path: a ledger error is swallowed, so it can
 *      never fail, alter, or delay a tool call.
 *   3. A read accessor ({@link ToolCallLedgerWiring.lookup} /
 *      {@link ToolCallLedgerWiring.ledger}) for future consumers (cross-turn
 *      repeat-failure suppression, pre-flight resource gate, observability).
 *
 * Invariant: OBSERVE-ONLY. Nothing here intercepts, skips, or rewrites a call
 * or a result, and nothing emits a trace event. All judgment belongs in the
 * consumers that will read the ledger.
 *
 * ## Turn index
 *
 * The ledger's `turnIndex` is a session-scoped TOOL-ROUND ordinal: it advances
 * once per dispatcher entry from the provider loop (one `executeBatch()` call,
 * or one direct `execute()` call), i.e. once per model tool-use round. It is
 * monotonic across `query()` calls and per-query dispatcher rebuilds because
 * the wiring is owned by the provider (one per session) and handed to every
 * dispatcher it builds. The batch fast path (`executeBatch` with one call)
 * delegates to `execute()`, which advances the round itself; `executeBatchImpl`
 * advances it only for the multi-call path, so a round is never double-counted.
 *
 * ## Input hash
 *
 * Recording reuses the normalized fingerprint `RepeatFailureGuard.note()`
 * already computes for the same settled result (`repeatFailureFingerprint`:
 * sha256 over `name \0 canonicalJSON(input minus volatile timeout keys)`), so
 * the ledger adds no second hash on the hot path, and a future cross-turn
 * suppression consumer keys on exactly what the per-turn guard keys on.
 *
 * @module agent/tools/dispatcher.ledger
 */

import { debugLog } from '../../utils/debug.js';
import { errorMessage } from '../../utils/errors.js';
import type { ToolCall, ToolResult } from '../providers/anthropic-direct/types.js';
import { repeatFailureFingerprint, type RepeatFailureGuard } from './repeat-failure-guard.js';
import { ToolCallLedger, type LedgerHistory } from './tool-call-ledger.js';

/**
 * Session-scoped holder of one {@link ToolCallLedger} and the tool-round
 * counter used as its turn index. One instance per session (owned by the
 * provider); a dispatcher constructed without one creates its own.
 */
export class ToolCallLedgerWiring {
  /** The underlying ledger. Read-only for consumers; written only via {@link record}. */
  readonly ledger: ToolCallLedger;
  /** -1 until the first round begins; then the 0-based current tool round. */
  private round = -1;

  constructor(ledger: ToolCallLedger = new ToolCallLedger()) {
    this.ledger = ledger;
  }

  /** The current tool-round ordinal (0 before any round has begun). */
  get currentRound(): number {
    return Math.max(0, this.round);
  }

  /**
   * Advance to the next tool round and prune entries outside the turn window.
   * Failure-isolated: a throwing ledger is logged and ignored.
   */
  beginRound(): void {
    this.round += 1;
    try {
      this.ledger.prune(this.round);
    } catch (err) {
      debugLog(`[tool-call-ledger #4476] prune failed (ignored): ${errorMessage(err)}`);
    }
  }

  /**
   * Record a settled result under `(toolName, inputHash)` at the current round.
   * Failure-isolated: a throwing ledger is logged and ignored, so recording can
   * never fail or alter the tool call it observes.
   */
  record(toolName: string, inputHash: string, result: ToolResult): void {
    try {
      this.ledger.record(toolName, inputHash, result, this.currentRound);
    } catch (err) {
      debugLog(`[tool-call-ledger #4476] record failed (ignored): ${errorMessage(err)}`);
    }
  }

  /**
   * Read accessor for consumers: prior settled observations of this exact
   * (normalized) call within the turn window, oldest first. Hashes the call
   * with the same fingerprint the recording path uses.
   */
  lookup(call: ToolCall): LedgerHistory {
    return this.ledger.lookup(call.name, repeatFailureFingerprint(call), this.currentRound);
  }
}

/**
 * Observe one settled tool result at the dispatch boundary: advance the
 * per-turn {@link RepeatFailureGuard} exactly as before, then record the same
 * outcome in the session ledger under the fingerprint the guard just computed.
 * Called at every site that previously called `repeatFailureGuard.note()`.
 */
export function noteSettledOutcome(
  guard: RepeatFailureGuard,
  wiring: ToolCallLedgerWiring,
  call: ToolCall,
  result: ToolResult,
): void {
  const fingerprint = guard.note(call, result);
  wiring.record(call.name, fingerprint, result);
}
