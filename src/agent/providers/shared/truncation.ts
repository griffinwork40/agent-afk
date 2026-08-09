/**
 * Invariant: shared predicate for output-token truncation stop reasons.
 *
 * A turn is "truncated" when the provider cut it off at the output-token cap
 * rather than the model finishing on its own. The sentinel is set by the wire
 * format, not by us, so all three spellings must be recognised:
 *
 *   - `'max_tokens'`        — Anthropic Messages API `stop_reason`.
 *   - `'length'`            — OpenAI **Chat Completions** `finish_reason`.
 *   - `'max_output_tokens'` — OpenAI **Responses** API. That wire has no
 *     `finish_reason`; `responses-translate.ts` derives the stop reason from
 *     `response.incomplete_details.reason` on a `response.incomplete` event,
 *     and the reason string it hands back is `'max_output_tokens'` — a third
 *     spelling of the same event, not a variant of `'length'`.
 *
 * Missing the Responses spelling is not cosmetic: it silently un-classifies
 * every truncated turn on that wire, so the closure classifier records a
 * non-truncated reason and a truncated subagent returns to its parent with no
 * partial-result banner — exactly the invisibility #952 exists to remove.
 *
 * Lives in `providers/shared/` — the leaf both layers that need it import from
 * *downward*: `session/closure-reason.ts` re-exports it for closure
 * classification, the anthropic-direct terminal path uses it to surface a
 * truncation notice, and the subagent result path uses it to mark a truncated
 * child's output as an incomplete partial. Keeping one definition prevents the
 * sentinel literals from drifting across those sites.
 *
 * @module agent/providers/shared/truncation
 */

/**
 * The exact stop-reason strings that mean "cut off at the output-token cap",
 * one per wire format. Exported so tests can assert the set itself rather than
 * re-listing literals that would then drift from the predicate.
 */
export const TRUNCATION_STOP_REASONS: readonly string[] = [
  'max_tokens', // Anthropic Messages
  'length', // OpenAI Chat Completions
  'max_output_tokens', // OpenAI Responses (incomplete_details.reason)
];

/**
 * True when `stopReason` means the response was cut off by the output-token cap
 * rather than completing naturally. Accepts `null` so callers holding a
 * `string | null` stop reason (e.g. `TurnResult.stopReason`) need not
 * pre-coalesce.
 */
export function isTruncationStopReason(stopReason: string | null | undefined): boolean {
  return stopReason != null && TRUNCATION_STOP_REASONS.includes(stopReason);
}
