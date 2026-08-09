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

/**
 * Contract: render the wire-accurate field name for a truncation sentinel, so
 * the notice below quotes something the operator can actually grep for in
 * provider docs. Each wire names the field differently and only one of the
 * three is literally called `finish_reason`.
 */
function sentinelLabel(stopReason: string | null | undefined): string {
  switch (stopReason) {
    case 'max_tokens':
      return 'stop_reason "max_tokens"';
    case 'length':
      return 'finish_reason "length"';
    case 'max_output_tokens':
      return 'incomplete_details.reason "max_output_tokens"';
    default:
      return 'the provider output-token cap';
  }
}

/**
 * Operator-facing notice for a turn cut off at the output-token cap (#952).
 *
 * Shared by both providers on purpose. The anthropic-direct terminal path and
 * the openai-compatible turn loop reach truncation through very different
 * machinery (a `TurnResult.toolUseBlocks` array vs. a derived
 * `finalizedToolCalls(state)` view), but the operator-visible consequence is
 * identical, so the WORDING must not fork. A half-mirrored notice — one
 * provider naming the dropped tool, the other not — is itself a form of
 * provider drift, which is why this text lives here rather than in either
 * provider's terminal module.
 *
 * `droppedToolNames` are the tool calls that were truncated mid-request and
 * therefore never dispatched. When non-empty the model announced an action that
 * did not run, which otherwise reads to the operator as the agent stalling.
 *
 * Display-only in both callers: appended to the yielded `assistant.message`
 * text, never pushed into conversation history. It is an operator warning, not
 * model context — feeding it back would teach the model it had been cut off
 * when the transcript it sees is already complete.
 */
export function truncationNotice(
  droppedToolNames: string[],
  stopReason?: string | null,
): string {
  const base =
    `⚠ This turn was cut off at the output-token limit (${sentinelLabel(stopReason)}) before the ` +
    'model finished — anything above is partial, not a complete answer.';
  if (droppedToolNames.length > 0) {
    const names = [...new Set(droppedToolNames)].join(', ');
    return (
      `${base} A tool call was truncated mid-request and was NOT dispatched (${names}); ` +
      'that action did not run. Raise --max-output-tokens / AFK_MAX_OUTPUT_TOKENS, then retry.'
    );
  }
  return `${base} Raise --max-output-tokens / AFK_MAX_OUTPUT_TOKENS to allow a longer reply.`;
}
