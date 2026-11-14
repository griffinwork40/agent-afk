/**
 * Curated model-id hint lists for the `/model` picker surface.
 *
 * Extracted from `model-slots.ts` to keep that file within the 350-code-line
 * ceiling. Import these from `model-slots.ts` (which re-exports them); do not
 * import this file directly.
 *
 * @module agent/session/model-slots.hints
 */

import { SLOT_NAMES, DIRECT_MODEL_ALIASES } from './model-slots.js';

/**
 * Curated OpenAI model ids surfaced in the `/model` picker. Wire ids only —
 * no short aliases (OpenAI has no stable short alias layer like `sonnet`).
 * Ordered flagship → balanced → mini so the most-common choices appear first.
 * `gpt-5.5` is included as the prior-generation baseline.
 *
 * This list is deliberately narrow: it covers models agent-afk already has
 * explicit metadata for (context limits, capability flags, max-output overrides
 * in `model-limits.ts` / `model-capabilities.ts`). Any raw OpenAI id not listed
 * here is still accepted at the `/model` surface — this is the discoverable
 * subset, not the whole acceptable set.
 */
export const OPENAI_MODEL_HINTS: readonly string[] = [
  'gpt-6.1-sol',
  'gpt-6-astra',
  'gpt-6-sol',
  'gpt-6-luna',
  'gpt-5.6-sol',
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
];

// Lazily built on first use to avoid the circular-init TDZ: model-slots.hints
// is imported by model-slots.ts before SLOT_NAMES / DIRECT_MODEL_ALIASES have
// finished initialising. Using a getter defers array construction until the
// first call, by which point the circular initialisation is complete.
// Pattern mirrors model-slots.coerce.ts:26-41.
let _slotNames: readonly string[] | undefined;
function getSlotNames(): readonly string[] {
  return (_slotNames ??= [...SLOT_NAMES]);
}

let _directAliasKeys: readonly string[] | undefined;
function getDirectAliasKeys(): readonly string[] {
  return (_directAliasKeys ??= Object.keys(DIRECT_MODEL_ALIASES));
}

let _modelAliasesHint: readonly string[] | undefined;

/**
 * User-facing model handles shown by the `/model` picker (REPL + Telegram) and
 * accepted by name. DERIVED from three stable layers:
 *   1. Capability TIERS (local/small/medium/large/subagent)
 *   2. Fixed-identity Claude/xAI aliases (haiku/sonnet/opus/fable/grok/…)
 *   3. Curated OpenAI wire ids ({@link OPENAI_MODEL_HINTS})
 *
 * The three-part ordering keeps Claude/tier handles at the top (most users),
 * followed by OpenAI models. Raw wire ids and `org/model` ids are also accepted
 * at the `/model` surface — this list is the discoverable subset, not the whole
 * acceptable set. Both the CLI (`/model`) and Telegram surfaces import
 * {@link MODEL_ALIASES_HINT} (re-exported from `model-slots.ts`) rather than
 * re-declaring it; it is the single source of truth for the picker.
 *
 * Returned as a real array built lazily on first call to avoid the
 * circular-init TDZ (see module comment). Callers receive a plain array;
 * consumed by `model-slots.ts` as {@link MODEL_ALIASES_HINT}.
 */
export function getModelAliasesHint(): readonly string[] {
  return (_modelAliasesHint ??= [
    ...getSlotNames(),
    ...getDirectAliasKeys(),
    ...OPENAI_MODEL_HINTS,
  ]);
}
