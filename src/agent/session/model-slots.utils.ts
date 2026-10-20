/**
 * Shared low-level helpers used by both `model-slots.ts` (loader path) and
 * `model-slots.coerce.ts` (writer-path validation).
 *
 * Extracted to eliminate the private-helper duplication flagged in #4120.
 *
 * @module agent/session/model-slots.utils
 */

/**
 * Canonical provider discriminants — kept in sync with `SlotProvider` in
 * model-slots.ts (a string union, so duplicating it here avoids a circular
 * import between this utils sibling and model-slots.ts).
 */
type SlotProvider = 'anthropic' | 'openai' | 'chatgpt-oauth' | 'xai' | 'xai-oauth';

/**
 * Normalise a raw provider string to one of the canonical `SlotProvider`
 * values, or `undefined` when unrecognised.
 */
export function normalizeSlotProvider(value: unknown): SlotProvider | undefined {
  if (typeof value !== 'string') return undefined;
  const lowered = value.trim().toLowerCase();
  if (lowered === 'anthropic' || lowered === 'anthropic-direct') return 'anthropic';
  if (lowered === 'openai' || lowered === 'openai-compatible') return 'openai';
  if (lowered === 'chatgpt-oauth' || lowered === 'chatgpt') return 'chatgpt-oauth';
  if (lowered === 'xai') return 'xai';
  if (lowered === 'xai-oauth' || lowered === 'xai_oauth') return 'xai-oauth';
  return undefined;
}

/**
 * Return the trimmed string value of `value`, or `''` when it is not a
 * string.
 */
export function parseStringField(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
