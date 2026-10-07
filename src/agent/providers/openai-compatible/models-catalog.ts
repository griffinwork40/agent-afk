/**
 * Reader for the Codex CLI local models catalog (`~/.codex/models_cache.json`).
 *
 * Used by the OpenAI fast-mode eligibility check to determine whether the
 * active model supports priority-tier (fast) requests, and by the per-model
 * capability lookups in `models-catalog.capabilities.ts` (vision, reasoning
 * contract, context window). The catalog is the source-of-truth Codex itself
 * uses; falling back to static tables ensures every check still works when the
 * catalog is absent or malformed.
 *
 * Contract:
 *   - Never throws — every I/O or parse error returns `undefined`/empty.
 *   - Never logs the `identity` field (user-identifying data).
 *   - Cached per process (process-scope singleton); call `resetCatalogCache`
 *     in tests to start clean between cases.
 *   - Does not use AFK paths: `~/.codex/` is NOT an AFK path.
 *
 * @module agent/providers/openai-compatible/models-catalog
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** A single model entry from the catalog (only the fields we need). */
export interface CatalogModel {
  slug: string;
  /** Service tiers the model supports (e.g. `[{id:'priority'}]`). */
  service_tiers?: Array<{ id: string; name?: string; description?: string }>;
  default_service_tier?: string;
  /** Accepted input kinds, e.g. `['text', 'image']`. Absent = unknown. */
  input_modalities?: string[];
  /** Reasoning effort levels the model accepts (`effort` values). Absent = unknown. */
  supported_reasoning_levels?: string[];
  /** Default context window in tokens. Absent = unknown. */
  context_window?: number;
}

/** Parsed shape of `~/.codex/models_cache.json` (only the fields we need). */
interface ModelsCacheJson {
  /** Intentionally excluded: `identity` field is user-identifying — never read. */
  models?: unknown[];
}

/** Injectable deps for tests (avoids real fs reads and homedirs). */
export interface CatalogReaderDeps {
  homedir?: () => string;
  readFile?: (path: string) => string | null;
}

/**
 * Process-scope catalog cache. Populated once on first call, reused for the
 * lifetime of the process.
 *
 * Known staleness: if Codex rewrites `~/.codex/models_cache.json` while AFK
 * is running (e.g. after a `codex refresh`) the cached map is NOT refreshed.
 * In practice this window is harmless — fast-mode eligibility for the current
 * model does not change mid-session — but tests should call `resetCatalogCache`
 * between cases to start from a clean state.
 */
let catalogCache: Map<string, CatalogModel> | undefined;

/** Test-only: clear the process-scope cache so tests start from a fresh state. */
export function resetCatalogCache(): void {
  catalogCache = undefined;
}

/** Default file reader: returns null on any error rather than throwing. */
function defaultReadFile(path: string): string | null {
  try {
    return readFileSync(path, 'utf-8');
  } catch {
    return null;
  }
}

/**
 * Parse a `models_cache.json` string into the catalog map.
 *
 * Tolerates any parse / shape error: unknown keys are ignored, a missing or
 * malformed file returns an empty map. The `identity` field is never accessed.
 */
function parseCatalogJson(raw: string): Map<string, CatalogModel> {
  const result = new Map<string, CatalogModel>();
  try {
    const parsed = JSON.parse(raw) as ModelsCacheJson;
    if (!Array.isArray(parsed.models)) return result;
    for (const entry of parsed.models) {
      if (typeof entry !== 'object' || entry === null) continue;
      const e = entry as Record<string, unknown>;
      const slug = typeof e['slug'] === 'string' ? e['slug'] : '';
      if (!slug) continue;
      const model: CatalogModel = { slug };
      if (Array.isArray(e['service_tiers'])) {
        model.service_tiers = (e['service_tiers'] as unknown[]).filter(
          (t): t is { id: string } => typeof t === 'object' && t !== null && typeof (t as Record<string, unknown>)['id'] === 'string',
        );
      }
      if (typeof e['default_service_tier'] === 'string') {
        model.default_service_tier = e['default_service_tier'];
      }
      parseCapabilityFields(e, model);
      result.set(slug, model);
    }
  } catch {
    // Malformed JSON — return empty map (caller falls back to static regex).
  }
  return result;
}

/**
 * Copy the capability fields (modalities, reasoning levels, context window)
 * onto `model`. Each field is set only when its shape is valid, so a field the
 * catalog omits or mangles stays `undefined` ("unknown"), never a false claim.
 */
function parseCapabilityFields(e: Record<string, unknown>, model: CatalogModel): void {
  const modalities = e['input_modalities'];
  if (Array.isArray(modalities)) {
    model.input_modalities = modalities.filter((m): m is string => typeof m === 'string');
  }
  const levels = e['supported_reasoning_levels'];
  if (Array.isArray(levels)) {
    model.supported_reasoning_levels = levels
      .map((l) => (typeof l === 'object' && l !== null ? (l as Record<string, unknown>)['effort'] : l))
      .filter((l): l is string => typeof l === 'string');
  }
  const window = e['context_window'];
  if (typeof window === 'number' && Number.isFinite(window) && window > 0) {
    model.context_window = window;
  }
}

/**
 * Load (and cache) the Codex models catalog from `~/.codex/models_cache.json`.
 *
 * Returns an empty map when the file is missing or unparseable — callers must
 * treat an empty result as "catalog unavailable" and fall back to the static
 * allowlist regex.
 *
 * Contract: the `identity` key in the JSON is never read or surfaced.
 */
export function loadModelsCatalog(deps: CatalogReaderDeps = {}): Map<string, CatalogModel> {
  if (catalogCache !== undefined) return catalogCache;
  const home = (deps.homedir ?? homedir)();
  const readFile = deps.readFile ?? defaultReadFile;
  const path = join(home, '.codex', 'models_cache.json');
  const raw = readFile(path);
  catalogCache = raw !== null ? parseCatalogJson(raw) : new Map();
  return catalogCache;
}

/**
 * Check whether a model is eligible for the priority (fast) service tier
 * using the catalog as the source of truth.
 *
 * A model is eligible iff its `service_tiers` array contains an entry with
 * `id === 'priority'` OR `id === 'fast'` (OpenAI uses `priority` on the wire;
 * `fast` is an alias accepted by the API per the Codex reference).
 *
 * Returns `undefined` when the model is absent from the catalog — callers
 * should fall back to the static regex in that case.
 */
export function isCatalogModelPriorityEligible(
  modelSlug: string,
  deps: CatalogReaderDeps = {},
): boolean | undefined {
  const catalog = loadModelsCatalog(deps);
  if (catalog.size === 0) return undefined;
  const entry = catalog.get(modelSlug);
  if (entry === undefined) return undefined;
  const tiers = entry.service_tiers ?? [];
  return tiers.some((t) => t.id === 'priority' || t.id === 'fast');
}
