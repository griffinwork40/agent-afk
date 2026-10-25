/**
 * Per-slot override lookups (`maxOutputTokens`, `contextWindow`).
 *
 * Extracted from `model-slots.ts` to keep that file within the 350-code-line
 * ceiling. Import from `model-slots.ts` — it re-exports these functions so
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
    if (b?.maxOutputTokens !== undefined && b.id === concreteId) return b.maxOutputTokens;
  }
  return undefined;
}

/**
 * Return the context-window override for a concrete model id (already resolved),
 * scanning all active slot bindings. Returns `undefined` when no binding carries
 * a matching `contextWindow`. Used by `contextLimitFor` in `model-limits.ts` to
 * honour per-slot overrides on the real provider path (the provider passes the
 * resolved concrete id, not the tier alias).
 *
 * Tie-breaking: when two slots bind the SAME id but different `contextWindow`
 * values, the first slot in `SLOT_NAMES` order wins. This is deterministic and
 * intentional — the lower-tier slot is more user-configured and more specific.
 */
export function contextWindowOverrideFor(
  concreteId: string,
  bindings: ModelSlots = getSlotBindings(),
): number | undefined {
  for (const slot of SLOT_NAMES) {
    const b = bindings[slot];
    if (b?.contextWindow !== undefined && b.id === concreteId) return b.contextWindow;
  }
  return undefined;
}
