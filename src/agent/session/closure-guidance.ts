/**
 * Actionable recovery guidance for anomalous {@link ClosureReason}s.
 *
 * The runtime classifies WHY a session/subagent ended (`closure-reason.ts`)
 * and emits that reason on the `closure` trace event. But knowing the reason
 * is not the same as knowing what to DO about it: an AFK operator reviewing a
 * trace after the fact sees `abort` with no next step. This module is the
 * guardrail for the `closure-anomaly` failure pattern — it maps an anomalous
 * closure reason to a short, concrete recovery hint that `emitClosure`
 * attaches to the closure event and `afk trace` renders.
 *
 * Mirrors the `subagent-block` guardrail (`skill-depth-message.ts`): a pure,
 * deterministic builder, wired at one production site and exercised directly
 * by an `afk improve eval-run` contract (no LLM, no network).
 *
 * Scope — first concrete subtype only: only `abort` carries guidance today.
 * The detector flags six anomalous reasons; covering all six in one change
 * would couple the fix to six distinct recovery stories. The rest (timeout,
 * budget_exceeded, hook_blocked, iteration_cap, max_turns_exceeded) each get
 * their own hint in a follow-up. Benign reasons (model_end_turn, truncated)
 * never carry guidance — a clean close needs no recovery action.
 *
 * @module agent/session/closure-guidance
 */

import type { ClosureReason } from '../trace/index.js';

/**
 * Recovery hint for an `abort` closure. Names a concrete next action: AFK
 * preserves the transcript + witness trace on abort, so an interrupted
 * session can be resumed rather than restarted from scratch.
 */
export const CLOSURE_ABORT_RECOVERY_HINT =
  'Session ended via abort before reaching a terminal state. The transcript and ' +
  'witness trace are preserved — resume with `afk --resume <sessionId>` to continue ' +
  'from saved state, or re-run the task if the interruption was intentional.';

/**
 * Map a closure reason to an actionable recovery hint, or `null` when no
 * guidance applies (benign closes, and anomalous reasons not yet covered).
 *
 * Pure and deterministic: no I/O, no clock, no randomness — safe to call from
 * the hot closure-emission path and to exercise directly from an eval-run
 * contract.
 */
export function buildClosureGuidance(reason: ClosureReason): string | null {
  switch (reason) {
    case 'abort':
      return CLOSURE_ABORT_RECOVERY_HINT;
    default:
      return null;
  }
}
