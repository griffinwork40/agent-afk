/**
 * Mid-stream overload (529) exhaustion policy: the terminal sentinel, the
 * classification arm the retry layer keys on, and the wall-clock pause ceiling.
 *
 * Split out of `loop.ts` / `query/retry-layer.ts` so both sides share one
 * source of truth for the contract, and so neither file grows past its LOC
 * budget (`loop.ts` is a tracked 350-LOC offender, #360).
 *
 * # Why a sentinel on `turn.completed` and not an `error` event
 *
 * Before this module, an exhausted mid-stream overload fell through `loop.ts`'s
 * unconditional tail (`yield out.event; translatorErrored = true`) as a generic
 * fatal `error`. That propagated to `sawProviderError` → `closure {reason:
 * 'abort'}` → `session_sealed {status:'failed'}` with **`finalTurnCount: 0`**:
 * the turn never reached a `done`, so the session's accumulated work was
 * unresumable. See issue #762.
 *
 * The fix routes exhaustion through a CLEAN terminal (`turn.completed`) carrying
 * {@link OVERLOAD_EXHAUSTED} in `usage.stopReason`, which makes the turn
 * commit (`turnCount++`) so `afk --resume <sessionId>` restarts from saved state.
 * The failure stays loud because `session/closure-reason.ts` maps the sentinel to
 * an `abort` closure and `session/closure-emitter.ts` maps it to a `failed` seal —
 * exactly the `tool_use_loop_capped` → `iteration_cap` precedent. A companion
 * operator-facing `assistant.message` renders the 529 in human-readable form
 * instead of the raw `{"type":"overloaded_error"}` envelope.
 *
 * @module agent/providers/anthropic-direct/overload-pause
 */

import { env } from '../../../config/env.js';
import type { ProviderEvent } from '../../provider.js';

/**
 * Terminal `stopReason` stamped on the `turn.completed` that ends a turn whose
 * mid-stream overload retry budget was exhausted.
 *
 * Consumed by three places, all of which must stay in agreement:
 *   - `query/retry-layer.ts` — {@link classifyOverloadExhaustion} keys the pause
 *     arm on it.
 *   - `session/closure-reason.ts` — maps it to the `abort` closure reason.
 *   - `session/closure-emitter.ts` — maps it to a `failed` seal status.
 */
export const OVERLOAD_EXHAUSTED = 'overload_exhausted';

/**
 * Operator-facing copy for an exhausted overload. Emitted as a display-only
 * `assistant.message` (never pushed into history — it is operator context, not
 * model context), mirroring the `stop_reason: 'refusal'` notice in `loop.ts`.
 *
 * Exists because the raw SSE envelope (`{"type":"error","error":{"type":
 * "overloaded_error"}}`) reached operators verbatim and was misread as a
 * TypeScript error across five failed resume attempts (#762).
 */
export const OVERLOAD_EXHAUSTED_NOTICE =
  "Anthropic is overloaded (HTTP 529) and did not recover within this turn's retry budget. " +
  'This is an upstream capacity event, not an afk error. The turn was committed, so the ' +
  'conversation so far is preserved — resume with `afk --resume <sessionId>` to continue ' +
  'from saved state once capacity frees up.';

/** Default wall-clock pause ceiling on an interactive surface (repl/cli/telegram). */
export const OVERLOAD_PAUSE_CEILING_MS = 10 * 60 * 1000;

/**
 * Probe cadence bounds. A 529 carries **no reset timestamp**, so unlike
 * `waitForReset` there is no authoritative deadline to key on — the only honest
 * strategy is to re-probe on a jittered interval until the plain wall-clock
 * ceiling. Jittered across a wide band so parallel sessions/subagents that all
 * hit the same capacity event de-synchronize instead of re-hammering in lockstep
 * (trace `3cc7a468` shows three subagents at `attempt:1|2|3` inside one second).
 */
export const OVERLOAD_PROBE_MIN_MS = 60 * 1000;
export const OVERLOAD_PROBE_MAX_MS = 120 * 1000;

/**
 * Fraction of the base backoff used as jitter width for the in-loop overload
 * ladder. `retry-layer.ts` already jitters its transient-429 waits for the same
 * de-synchronization reason; this applies the equivalent spread to the
 * `5s → 10s → 20s` overload ladder, which was purely deterministic before.
 */
const OVERLOAD_JITTER_RATIO = 0.25;

/**
 * Add proportional jitter to a backoff delay: returns `baseMs` plus a random
 * 0…25% of `baseMs`. Additive-only (never shortens the base wait) so the
 * documented minimum backoff still holds while concurrent retriers spread out.
 *
 * @param baseMs Deterministic backoff for this attempt.
 * @param random Injectable RNG for deterministic tests. Defaults to `Math.random`.
 */
export function jitterBackoff(baseMs: number, random: () => number = Math.random): number {
  return baseMs + Math.floor(random() * baseMs * OVERLOAD_JITTER_RATIO);
}

/**
 * Pick the next probe delay: a uniform draw from
 * [{@link OVERLOAD_PROBE_MIN_MS}, {@link OVERLOAD_PROBE_MAX_MS}].
 *
 * @param random Injectable RNG for deterministic tests.
 */
export function nextProbeDelayMs(random: () => number = Math.random): number {
  const span = OVERLOAD_PROBE_MAX_MS - OVERLOAD_PROBE_MIN_MS;
  return OVERLOAD_PROBE_MIN_MS + Math.floor(random() * span);
}

/**
 * The new classification arm. A mid-stream 529 arrives as
 * `new APIError(undefined, <parsed SSE body>, …)` with `status === undefined`, so
 * `classifyUsageLimitError` rejects it at `usage-limit.ts:111`
 * (`if (!('status' in error)) return null;`) and every existing pause branch is
 * structurally unreachable for it (#762). Rather than loosening the status check —
 * which would let unrelated status-less errors into the 2-hour usage-limit
 * park — exhaustion is classified off the terminal `turn.completed` sentinel
 * `loop.ts` stamps.
 *
 * @returns `true` iff `event` is the clean terminal of a turn whose mid-stream
 *          overload budget was exhausted.
 */
export function classifyOverloadExhaustion(event: ProviderEvent): boolean {
  return event.type === 'turn.completed' && event.usage.stopReason === OVERLOAD_EXHAUSTED;
}

/** Surfaces on which parking on an upstream capacity event is acceptable. */
const INTERACTIVE_SURFACES = new Set(['cli', 'repl', 'telegram']);

/**
 * Resolve the wall-clock pause ceiling for a surface.
 *
 * Invariant: a daemon/cron session must NEVER park on a capacity event. An
 * always-on runner that silently parks is strictly worse than one that fails and
 * notifies — the operator has no ESC to press and no panel to read, and two
 * sessions in the #762 incident already hung 38 and 63 minutes with no terminal
 * event. So non-interactive surfaces default to `0` (fail fast) and must be
 * opted in deliberately via `AFK_OVERLOAD_PAUSE_MS`.
 *
 * `AFK_OVERLOAD_PAUSE_MS` overrides BOTH the gate and the ceiling for every
 * surface: `0` disables the pause everywhere (pure fail-fast, the pre-#762
 * timing minus the fatal closure), a positive integer enables it with that
 * ceiling in milliseconds. A non-numeric or negative value is ignored.
 *
 * @param surface `AgentConfig.surface` as plumbed through the provider
 *                (`index.ts` → `query.ts` → `RetryLayer`). `undefined` is
 *                treated as non-interactive.
 * @returns Ceiling in ms; `0` means "do not pause, surface the terminal now".
 */
export function resolveOverloadPauseCeilingMs(surface: string | undefined): number {
  const raw = env.AFK_OVERLOAD_PAUSE_MS;
  if (raw !== undefined && raw.trim() !== '') {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed >= 0) return Math.floor(parsed);
  }
  return surface !== undefined && INTERACTIVE_SURFACES.has(surface)
    ? OVERLOAD_PAUSE_CEILING_MS
    : 0;
}
