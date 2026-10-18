/**
 * Per-slot `maxOutputTokens` override lookup (#3964).
 *
 * Extracted from `model-slots.ts` to keep that file within the 350-code-line
 * ceiling. Import from `model-slots.ts` — it re-exports this function so
 * existing call sites need no path change.
 *
 * @module agent/session/model-slots.output-override
 */

import { SLOT_NAMES, getSlotBindings } from './model-slots.js';
import type { ModelSlots } from './model-slots.js';

/**
 * Return the per-slot `maxOutputTokens` override for a concrete model id
 * (already resolved), scanning all active slot bindings. Returns `undefined`
 * when no binding carries a matching override. Used by `maxOutputTokensFor` in
 * `model-limits.ts` to honour per-slot output-cap overrides on the real
 * provider path.
 *
 * Tie-breaking mirrors `contextWindowOverrideFor`: when two slots bind the
 * SAME id with different values, the first slot in `SLOT_NAMES` order
 * (`local → small → medium → large`) wins.
 */
export function maxOutputTokensOverrideFor(
  concreteId: string,
  bindings: ModelSlots = getSlotBindings(),
): number | undefined {
  for (const slot of SLOT_NAMES) {
    const b = bindings[slot];
    if (b.maxOutputTokens !== undefined && b.id === concreteId) return b.maxOutputTokens;
  }
  return undefined;
}
