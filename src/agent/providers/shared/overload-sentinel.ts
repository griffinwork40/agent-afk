/**
 * Provider-neutral overload-exhaustion sentinel.
 *
 * `OVERLOAD_EXHAUSTED` is the `stopReason` stamped on the clean
 * `turn.completed` that `loop.ts` emits when a mid-stream 529 exhausts its
 * retry budget. Extracting it here (rather than leaving it in
 * `anthropic-direct/overload-pause.ts`) lets provider-neutral modules —
 * `session/closure-reason.ts`, `session/closure-emitter.ts`, and
 * `agent/subagent/result.ts` — consume the constant without importing from
 * a provider-specific path (#762 review item M4).
 *
 * The anthropic-direct modules continue to import from their own
 * `overload-pause.ts`, which re-exports this value, so every consumer sees
 * the same string and no coordination is needed across the two import paths.
 *
 * @module agent/providers/shared/overload-sentinel
 */

/**
 * Terminal `stopReason` stamped on the `turn.completed` that ends a turn
 * whose mid-stream overload retry budget was exhausted.
 *
 * Consumed by:
 *   - `anthropic-direct/query/retry-layer.ts` — classification arm.
 *   - `session/closure-reason.ts` — maps it to the `abort` closure reason.
 *   - `session/closure-emitter.ts` — maps it to a `failed` seal status.
 *   - `agent/subagent/result.ts` — maps it to a non-success subagent result.
 */
export const OVERLOAD_EXHAUSTED = 'overload_exhausted';
