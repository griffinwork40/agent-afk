/**
 * Curated model-id hint lists for the `/model` picker surface.
 *
 * Extracted from `model-slots.ts` to keep that file within the 350-code-line
 * ceiling. Import these from `model-slots.ts` (which re-exports them); do not
 * import this file directly — it intentionally does NOT import from
 * `model-slots.ts` to avoid a circular dependency.
 *
 * The tier names and alias keys are inlined here rather than imported.  When
 * `model-slots.ts` changes {@link SLOT_NAMES} or {@link DIRECT_MODEL_ALIASES},
 * update the inlined copies below accordingly (they are pure string literals
 * with no runtime risk of drift — the type-checker would catch a mismatch if
 * the exported types were used).
 *
 * @module agent/session/model-slots.hints
 */

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

// Invariant: these must stay in sync with SLOT_NAMES and
// Object.keys(DIRECT_MODEL_ALIASES) in model-slots.ts.  They are inlined to
// avoid a circular import (model-slots → model-slots.hints → model-slots).
const _SLOT_NAMES = ['local', 'small', 'medium', 'large'] as const;
const _DIRECT_ALIAS_KEYS = [
  'opus', 'opus_1m', 'opus-5.5', 'opus-5.5_1m',
  'sonnet', 'sonnet_1m',
  'haiku',
  'fable',
  'grok',
  // OpenAI family aliases (sol/luna/astra/terra → latest flagship per family).
  'sol', 'luna', 'astra', 'terra',
] as const;

/**
 * User-facing model handles shown by the `/model` picker (REPL + Telegram) and
 * accepted by name. DERIVED from three stable layers:
 *   1. Capability TIERS (local/small/medium/large)
 *   2. Fixed-identity Claude/xAI aliases (haiku/sonnet/opus/fable/grok/…)
 *   3. Curated OpenAI wire ids ({@link OPENAI_MODEL_HINTS})
 *
 * The three-part ordering keeps Claude/tier handles at the top (most users),
 * followed by OpenAI models. Raw wire ids and `org/model` ids are also accepted
 * at the `/model` surface — this list is the discoverable subset, not the whole
 * acceptable set. Both the CLI (`/model`) and Telegram surfaces import it rather
 * than re-declaring it; it is the single source of truth for the picker.
 */
export const MODEL_ALIASES_HINT: readonly string[] = [
  ..._SLOT_NAMES,
  ..._DIRECT_ALIAS_KEYS,
  ...OPENAI_MODEL_HINTS,
];
