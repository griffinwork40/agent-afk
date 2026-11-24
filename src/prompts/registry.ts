/**
 * Prompt registry for cache invalidation.
 *
 * The PromptRegistry discovers all prompts via filesystem walk. Callers that
 * load prompt content at import time (vendored agent wrappers, plugin skill
 * loaders) call `notifyPromptLoaded()` so the registry invalidates its cache
 * and re-discovers on the next access.
 *
 * @module prompts/registry
 */

/** Mutable cache slot — `null` means stale / not yet populated. */
let cache: null | unknown = null;

/**
 * Invalidate the prompt registry cache.
 *
 * Call after loading any prompt content so the registry re-discovers prompts
 * on its next access instead of serving a stale snapshot.
 */
export function notifyPromptLoaded(): void {
  cache = null; // invalidate so next access re-discovers
}

/**
 * Exposed for tests only — allows resetting the cache slot to a known state.
 * @internal
 */
export function _getCache(): null | unknown {
  return cache;
}
