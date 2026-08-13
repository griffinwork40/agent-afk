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
 * Coverage: `abort`, `iteration_cap`, and `timeout` carry guidance today.
 * The detector flags six anomalous reasons; the remaining three
 * (budget_exceeded, hook_blocked, max_turns_exceeded) each get their own
 * hint in a follow-up. Benign reasons (model_end_turn, truncated) never
 * carry guidance — a clean close needs no recovery action.
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
 * Recovery hint for an `iteration_cap` closure. The tool-use round budget was
 * exhausted — the session did real work but ran out of runway. The wind-down
 * round already fired, so the transcript holds partial progress.
 */
export const CLOSURE_ITERATION_CAP_RECOVERY_HINT =
  'Session hit the tool-use iteration cap before reaching a terminal state. ' +
  'Partial work is preserved in the transcript and witness trace. Resume with ' +
  '`afk --resume <sessionId>` to continue from where it stopped, or re-run ' +
  'with a higher budget (`--max-turns` or `max_tool_use_iterations`).';

/**
 * Recovery hint for a `timeout` closure. The wall-clock cap fired — unlike
 * iteration_cap the session may have been idle (waiting on a slow tool) or
 * actively working when the deadline hit.
 */
export const CLOSURE_TIMEOUT_RECOVERY_HINT =
  'Session was terminated by the wall-clock timeout before reaching a terminal ' +
  'state. The transcript and witness trace are preserved — resume with ' +
  '`afk --resume <sessionId>` to continue, or re-run with a longer timeout. ' +
  'Check the trace for whether the timeout hit during active work or while ' +
  'waiting on a slow tool call.';

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
    case 'iteration_cap':
      return CLOSURE_ITERATION_CAP_RECOVERY_HINT;
    case 'timeout':
      return CLOSURE_TIMEOUT_RECOVERY_HINT;
    default:
      return null;
  }
}
