/**
 * Shared predicate for output-token truncation stop reasons.
 *
 * A turn is "truncated" when the provider cut it off at the output-token cap
 * rather than the model finishing on its own. Anthropic emits `'max_tokens'`;
 * OpenAI-compatible providers emit `'length'`.
 *
 * Lives in `providers/shared/` — the leaf both layers that need it import from
 * *downward*: `session/closure-reason.ts` re-exports it for closure
 * classification, the anthropic-direct terminal path uses it to surface a
 * truncation notice, and the subagent result path uses it to mark a truncated
 * child's output as an incomplete partial. Keeping one definition prevents the
 * `'max_tokens' || 'length'` literals from drifting across those three sites.
 *
 * @module agent/providers/shared/truncation
 */

/**
 * True when `stopReason` means the response was cut off by the output-token cap
 * (`'max_tokens'` on Anthropic, `'length'` on OpenAI-compatible) rather than
 * completing naturally. Accepts `null` so callers holding a `string | null`
 * stop reason (e.g. `TurnResult.stopReason`) need not pre-coalesce.
 */
export function isTruncationStopReason(stopReason: string | null | undefined): boolean {
  return stopReason === 'max_tokens' || stopReason === 'length';
}
