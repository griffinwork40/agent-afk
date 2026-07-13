/**
 * Pure closure-reason classification for {@link AgentSession}.
 *
 * Extracted from the session so the precedence rules can be unit-tested
 * without constructing a live session + provider (mirrors the pure
 * `shouldAutoCompact` helper). `AgentSession.deriveClosureReason` pre-classifies
 * the abort-signal reason — which needs the concrete error classes — and
 * delegates the decision tree to {@link classifyClosureReason}.
 *
 * Precedence (first match wins):
 *  1. `maxTurnsHit`  → `max_turns_exceeded` — the per-session turn cap tripped
 *     in `assertCanSend`. Checked first because the resulting throw surfaces as
 *     a generic `'error'`/`'close'` dispatch reason that would otherwise mask
 *     the specific cause.
 *  2. `hookBlocked`  → `hook_blocked` — a SessionStart hook threw
 *     `HookBlockedError` during init (same masking rationale).
 *  3. `dispatchReason === 'error'` → `abort` — generic init/runtime error.
 *     Preserves the prior behaviour where an init-time error outranks the
 *     abort-signal classification below.
 *  4. a classified abort signal → `budget_exceeded` | `timeout` | `abort`.
 *  5. `sawProviderError` → `abort` — the provider emitted a terminal `error`
 *     event (HTTP / auth / stream failure) as the session's last turn outcome,
 *     yet the surface then closed the session cleanly (`dispatchReason` is
 *     `'close'`/`'reset'`, no abort signal). Without this a provider failure on
 *     an otherwise-clean close is silently sealed as `model_end_turn`.
 *  6. `lastStopReason === 'tool_use_loop_capped'` → `iteration_cap` — the
 *     tool-use round budget fired (the subagent default, or an explicit
 *     `max_tool_use_iterations`). The provider runs a tools-stripped wind-down
 *     round first, so the session still carries the model's final summary; this
 *     reason records that the turn was nonetheless cut short by the cap.
 *  7. a truncation stop reason (`max_tokens` / `length`) on an otherwise clean
 *     close → `truncated` — the model's final turn was cut off by the
 *     output-token ceiling, previously indistinguishable from a clean end.
 *  8. otherwise → `model_end_turn`.
 *
 * @module agent/session/closure-reason
 */

import type { ClosureReason } from '../trace/index.js';

/**
 * Provider stop reasons that mean the response was cut off by the output-token
 * cap rather than completing naturally. Anthropic emits `'max_tokens'`;
 * OpenAI-compatible providers emit `'length'`.
 */
export function isTruncationStopReason(stopReason: string | undefined): boolean {
  return stopReason === 'max_tokens' || stopReason === 'length';
}

export interface ClosureReasonInputs {
  /** The reason string passed to `dispatchSessionEndOnce` (close/reset/error). */
  dispatchReason: string;
  /** True when the per-session turn cap tripped in `assertCanSend`. */
  maxTurnsHit: boolean;
  /** True when a SessionStart hook threw `HookBlockedError` during init. */
  hookBlocked: boolean;
  /**
   * The abort-signal reason pre-classified by the caller, or `null` when the
   * session was not aborted (or aborted only with the benign `'closed'`
   * reason). Keeps the `instanceof` error-class checks in the session, where
   * the concrete error classes are in scope.
   */
  abort: 'budget_exceeded' | 'timeout' | 'abort' | null;
  /** The provider's last `stop_reason` / `finish_reason`, if any. */
  lastStopReason: string | undefined;
  /**
   * True when the provider emitted a terminal `error` event (an HTTP / auth /
   * stream failure that ended a turn or init without a completed turn) as the
   * session's most recent turn outcome. Set at the error-observation sites in
   * `AgentSession` and cleared by a subsequent completed turn, so it reflects
   * whether the LAST turn ended in an error — not whether any turn ever did.
   * Surfaces as `abort` so a provider failure on an otherwise-clean close is
   * not misclassified as `model_end_turn`.
   */
  sawProviderError: boolean;
}

/**
 * Map terminal session signals to a {@link ClosureReason}. Pure — see the
 * module docstring for the precedence rules.
 */
export function classifyClosureReason(i: ClosureReasonInputs): ClosureReason {
  if (i.maxTurnsHit) return 'max_turns_exceeded';
  if (i.hookBlocked) return 'hook_blocked';
  if (i.dispatchReason === 'error') return 'abort';
  if (i.abort !== null) return i.abort;
  if (i.sawProviderError) return 'abort';
  if (i.lastStopReason === 'tool_use_loop_capped') return 'iteration_cap';
  if (isTruncationStopReason(i.lastStopReason)) return 'truncated';
  return 'model_end_turn';
}
