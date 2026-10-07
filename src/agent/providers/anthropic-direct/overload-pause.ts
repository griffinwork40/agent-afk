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

import type { ProviderEvent } from '../../provider.js';

// Imported for local use (classifyOverloadExhaustion) and re-exported so
// existing `from './overload-pause.js'` import sites keep working (M4: the
// three provider-neutral consumers have been updated to import from the shared
// module directly, but anthropic-direct-internal consumers like loop.ts still
// import from here).
import { OVERLOAD_EXHAUSTED as _OVERLOAD_EXHAUSTED } from '../shared/overload-sentinel.js';
export { OVERLOAD_EXHAUSTED } from '../shared/overload-sentinel.js';

// Provider-neutral timing helpers live in shared/ so both the Anthropic-direct
// and OpenAI-compatible overload-pause tiers can import them without crossing
// the provider boundary. Re-exported from here for backward compatibility with
// all existing `from '…/anthropic-direct/overload-pause.js'` import sites.
export {
  OVERLOAD_PAUSE_CEILING_MS,
  OVERLOAD_PAUSE_MAX_MS,
  OVERLOAD_PROBE_MIN_MS,
  OVERLOAD_PROBE_MAX_MS,
  jitterBackoff,
  nextProbeDelayMs,
  resolveOverloadPauseCeilingMs,
} from '../shared/overload-pause-shared.js';

/**
 * Operator-facing copy for an exhausted overload. Emitted as an
 * `assistant.message`, mirroring the `stop_reason: 'refusal'` notice in
 * `loop.ts`. Unlike the refusal notice, this IS visible to the model on
 * `--resume`: `session/stream-consumer.ts` materializes non-empty
 * `assistant.message` events into `conversationHistory`, which threads back
 * as model context on the next turn. See `loop.ts:204-210` for the
 * corrected contract.
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
  return event.type === 'turn.completed' && event.usage.stopReason === _OVERLOAD_EXHAUSTED;
}
