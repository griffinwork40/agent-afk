/**
 * Test helper: pin the process-scope Codex models catalog to a fixture.
 *
 * `loadModelsCatalog` caches its first result for the process, and vitest does
 * not redirect HOME, so a test that reaches a catalog-backed capability check
 * (`supportsVision`, `isReasoningModel`, `contextLimitFor`) would otherwise read
 * the developer's real `~/.codex/models_cache.json` and pass or fail by machine.
 * Calling this in `beforeEach` primes the cache deterministically.
 *
 * @param models  Catalog `models[]` entries, or `null` for "no catalog file".
 */
import { loadModelsCatalog, resetCatalogCache } from '../agent/providers/openai-compatible/models-catalog.js';

export function useCodexCatalog(models: readonly Record<string, unknown>[] | null): void {
  resetCatalogCache();
  const raw = models === null ? null : JSON.stringify({ models });
  loadModelsCatalog({ homedir: () => '/nonexistent-home', readFile: () => raw });
}
