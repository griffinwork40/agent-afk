/**
 * Pure helper: construct the synthetic `done` event emitted to the ledger when
 * a turn ends fatally (provider 4xx, stream stall, connection error, budget
 * ceiling) without producing a real `turn.completed`.
 *
 * Contract:
 *   - Live stream consumers see `error` as their single terminal (unchanged).
 *   - The ledger gets exactly one `done` per turn so events.jsonl readers
 *     (cost reports, sidecar totals, schedule telemetry, web projection) always
 *     record stopReason / durationMs.
 *
 * stopReason mapping (from the session abort signal's `.reason`):
 *   - signal not aborted                          → 'error'
 *   - reason is a string OR name === 'AbortError' → 'interrupted'
 *   - name === 'BudgetExceededError'              → 'budget_ceiling'
 *   - name === 'IdleWatchdogError'                → 'stalled'
 *   - anything else                               → 'error'
 *
 * Uses `.name` string checks (no error-class imports) to stay dependency-free.
 *
 * @module agent/session/turn-stream-runner.fatal-done
 */

import type { OutputEvent } from '../types.js';

/** Fatal stopReason values written to the ledger by the synthetic done. */
export type FatalStopReason = 'error' | 'interrupted' | 'budget_ceiling' | 'stalled';

/**
 * Derive the ledger `stopReason` from an abort signal.
 *
 * Only consults `signal.reason` when `signal.aborted` is true.
 */
export function fatalStopReason(signal: AbortSignal): FatalStopReason {
  if (!signal.aborted) return 'error';
  const reason = signal.reason as unknown;
  // Plain string reasons (session.abort('interrupted'), sigint/sigterm)
  if (typeof reason === 'string') return 'interrupted';
  if (reason !== null && typeof reason === 'object') {
    const name = (reason as { name?: unknown }).name;
    if (name === 'AbortError') return 'interrupted';
    if (name === 'BudgetExceededError') return 'budget_ceiling';
    if (name === 'IdleWatchdogError') return 'stalled';
  }
  return 'error';
}

/**
 * Build a synthetic `done` OutputEvent for the ledger-only fatal path.
 *
 * @param signal     - The session's current AbortSignal (may or may not be aborted).
 * @param elapsedMs  - Partial wall-clock duration since turn start.
 */
export function buildFatalDone(signal: AbortSignal, elapsedMs: number): OutputEvent {
  return {
    type: 'done',
    metadata: {
      stopReason: fatalStopReason(signal),
      durationMs: elapsedMs,
    },
  };
}
