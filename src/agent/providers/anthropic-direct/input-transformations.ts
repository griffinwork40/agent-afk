/**
 * Observable handling for `input_transformations` — the Anthropic
 * thinking-binding-controls beta's signal that thinking blocks were dropped
 * before the model read them.
 *
 * Wire shape (documented at
 * https://platform.claude.com/docs/en/build-with-claude/preserved-thinking):
 *
 *   input_transformations?: Array<{
 *     type: 'thinking_dropped' | 'thinking_mismatch_allowed' | string;
 *     path: string;                 // e.g. 'messages.1.content.0'
 *     reason:
 *       | 'prefix_binding_mismatch'
 *       | 'model_binding_mismatch'
 *       | 'organization_binding_mismatch'
 *       | string;                   // forward-compat: ignore unknowns
 *   }>
 *
 * Placement:
 *   - `message_start.message.input_transformations` — all drops for this request.
 *   - `message_delta` final event — carries the serving model's entries after a
 *     server-side fallback (may duplicate or augment the message_start list).
 *
 * `thinking_dropped`           — the block was removed; the model did not see it.
 * `thinking_mismatch_allowed`  — the block failed the prefix check but was NOT
 *                                dropped (older account, no enforcement). NOT a drop.
 *
 * Per the spec: "Ignore entries whose type or reason you don't recognize."
 *
 * @module agent/providers/anthropic-direct/input-transformations
 */

/** Known `thinking_dropped` reason values. Future-proof: unknown reasons are counted but not named. */
export const KNOWN_DROP_REASONS = new Set([
  'prefix_binding_mismatch',
  'model_binding_mismatch',
  'organization_binding_mismatch',
]);

/**
 * Maximum number of `input_transformations` warnings emitted per process
 * lifetime. Avoids log-flooding when drop_block fires on every turn of a
 * long session.
 */
const MAX_WARN_COUNT = 10;
let warnCount = 0;

/**
 * Emit a bounded diagnostic when the server reports dropped thinking blocks
 * via `input_transformations` (thinking-binding-controls beta, `drop_block`
 * policy).
 *
 * Safe contract:
 * - Logs ONLY the count of dropped blocks and their known reason categories.
 * - Does NOT log `path` values (they contain message/content indices that are
 *   internal structural metadata — not secrets, but unvalidated, so omitted
 *   per the bounded-warning contract).
 * - Does NOT log thinking text, signature bytes, or any content.
 * - `thinking_mismatch_allowed` entries are IGNORED — they mean the block was
 *   NOT dropped and the model still read it.
 * - Unknown `type` or `reason` values are counted but not named (forward-compat).
 * - Capped at {@link MAX_WARN_COUNT} total warnings per process.
 *
 * @param transformations - The raw `input_transformations` array from the API.
 * @param source - Label for the stream position (`message_start` or `message_delta`).
 */
export function warnOnDroppedThinkingBlocks(
  transformations: unknown,
  source: 'message_start' | 'message_delta',
): void {
  if (!Array.isArray(transformations) || transformations.length === 0) return;

  // Count only entries with type === 'thinking_dropped' — NOT 'thinking_mismatch_allowed'
  // (those mean NOT dropped, the block reached the model on an older account).
  const dropped = transformations.filter(
    (t): t is Record<string, unknown> =>
      typeof t === 'object' &&
      t !== null &&
      (t as Record<string, unknown>)['type'] === 'thinking_dropped',
  );
  if (dropped.length === 0) return;

  // Tally known vs. unknown reasons (do not log path or raw values).
  const reasonCounts: Record<string, number> = {};
  let unknownReasonCount = 0;
  for (const entry of dropped) {
    const reason = typeof entry['reason'] === 'string' ? entry['reason'] : '';
    if (KNOWN_DROP_REASONS.has(reason)) {
      reasonCounts[reason] = (reasonCounts[reason] ?? 0) + 1;
    } else {
      unknownReasonCount++;
    }
  }

  if (warnCount >= MAX_WARN_COUNT) return;
  warnCount++;

  const reasonSummary = [
    ...Object.entries(reasonCounts).map(([r, n]) => `${n} ${r}`),
    ...(unknownReasonCount > 0 ? [`${unknownReasonCount} unknown_reason`] : []),
  ].join(', ');

  const capNote = warnCount === MAX_WARN_COUNT ? ' (further drops will not be logged)' : '';

  // eslint-disable-next-line no-console
  console.warn(
    `[afk] drop_block (${source}): ${dropped.length} thinking block(s) were omitted by the ` +
      `server before this request — prior reasoning was not available for this turn` +
      (reasonSummary ? ` [${reasonSummary}]` : '') +
      `.${capNote}`,
  );
}

/**
 * Reset the warn counter. Exposed for tests only — do not call in production code.
 * @internal
 */
export function _resetWarnCountForTest(): void {
  warnCount = 0;
}
