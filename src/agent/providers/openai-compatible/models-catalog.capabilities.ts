/**
 * Per-model capability answers read from the Codex models catalog
 * (`~/.codex/models_cache.json`, parsed by `models-catalog.ts`).
 *
 * The hand-maintained tables in `model-capabilities.ts` and `model-limits.ts`
 * go stale every time OpenAI ships a family (the gpt-6 line shipped with no
 * table entries, so pasted images were silently replaced by a text notice).
 * The catalog is refreshed by Codex itself and declares, per model, the input
 * modalities, reasoning levels, and context window. These helpers expose those
 * facts as tri-state answers.
 *
 * Contract:
 *   - Every helper returns `undefined` when the catalog is unavailable, the
 *     model is absent from it, or the relevant field is missing. `undefined`
 *     means "the catalog has no opinion": callers MUST fall back to their
 *     static tables, never treat it as `false`.
 *   - Never throws (inherits `loadModelsCatalog`'s contract).
 *   - Leaf module: imports only `models-catalog.ts`, so `model-capabilities.ts`
 *     and `model-limits.ts` can consult it without an import cycle.
 *
 * @module agent/providers/openai-compatible/models-catalog.capabilities
 */

import { loadModelsCatalog, type CatalogModel, type CatalogReaderDeps } from './models-catalog.js';

/**
 * Known provider prefixes that may appear before the model slug in a
 * provider-qualified id (e.g. `openai/gpt-6-sol`). Only these prefixes are
 * stripped — an arbitrary org prefix like `acme/gpt-reserve` is NOT touched,
 * so it does not inherit a catalog entry it does not own.
 */
const KNOWN_PROVIDER_PREFIXES = ['openai/', 'openrouter/'];

/**
 * Find the catalog entry for `model`. Matches the exact slug first, then the
 * lower-cased id with any known provider prefix stripped, so
 * `openai/gpt-6-sol` and `GPT-6-SOL` resolve like `gpt-6-sol`.
 */
export function catalogEntryFor(
  model: string | undefined,
  deps: CatalogReaderDeps = {},
): CatalogModel | undefined {
  if (!model) return undefined;
  const trimmed = model.trim();
  if (!trimmed) return undefined;
  const catalog = loadModelsCatalog(deps);
  if (catalog.size === 0) return undefined;
  const exact = catalog.get(trimmed);
  if (exact !== undefined) return exact;
  const lowered = trimmed.toLowerCase();
  let bare = lowered;
  for (const prefix of KNOWN_PROVIDER_PREFIXES) {
    if (lowered.startsWith(prefix)) {
      bare = lowered.slice(prefix.length);
      break;
    }
  }
  return catalog.get(bare);
}

/**
 * Does the catalog say `model` accepts image input? `true` / `false` when the
 * entry declares `input_modalities`; `undefined` otherwise.
 */
export function catalogSupportsImages(
  model: string | undefined,
  deps: CatalogReaderDeps = {},
): boolean | undefined {
  const modalities = catalogEntryFor(model, deps)?.input_modalities;
  if (modalities === undefined) return undefined;
  return modalities.some((m) => m.toLowerCase() === 'image');
}

/**
 * Does the catalog say `model` is a reasoning model (accepts a reasoning
 * effort, and so speaks the `max_completion_tokens` request contract)?
 * `true` when it lists at least one reasoning level, `false` when it lists
 * none, `undefined` when the field or entry is absent.
 */
export function catalogIsReasoningModel(
  model: string | undefined,
  deps: CatalogReaderDeps = {},
): boolean | undefined {
  const levels = catalogEntryFor(model, deps)?.supported_reasoning_levels;
  if (levels === undefined) return undefined;
  return levels.length > 0;
}

/** The catalog's default context window for `model`, or `undefined`. */
export function catalogContextWindow(
  model: string | undefined,
  deps: CatalogReaderDeps = {},
): number | undefined {
  return catalogEntryFor(model, deps)?.context_window;
}
