import type { ModelProvider } from '../../../agent/provider.js';

/**
 * Wrap a provider builder in a per-key (per-family) memoization cache.
 *
 * The REPL installs a `ProviderRouter` (when `config.providerFactory` is set and
 * `config.provider` is unset) that calls the factory to resolve the active
 * provider for the current model's family. Bootstrap ALSO calls the factory once
 * up front to obtain the `startupProvider` it wires `/allow-dir` to. Without
 * memoization those two call sites mint SEPARATE provider instances for the same
 * family: per-instance state added to one — most importantly the `/allow-dir`
 * read/write grant roots (`addReadRoot` / `addWriteRoot`) — is invisible to the
 * instance the router actually runs queries on, so grants are silently dropped.
 *
 * Memoizing by family keeps `startupProvider` identical to the router's turn-1
 * inner, so grants reach the query runner, and lets a Claude→GPT→Claude `/model`
 * swap reuse the cached Claude instance with its grants intact.
 *
 * Invariant: caching by family is safe because the bundled providers do not pin
 * construction-time model state — the per-turn model is read from
 * `innerConfig.model` on each `query()` call, not at construction. The caller is
 * responsible for supplying a `keyForModel` that maps each model to the family
 * `buildProvider` would actually construct (i.e. honoring any `--provider`
 * override) so a cache key never aliases two different provider families.
 *
 * @param buildProvider - Constructs a fully-wired provider for a model. Invoked
 *   at most once per distinct key.
 * @param keyForModel - Maps a model string to its provider-family cache key.
 * @returns A factory that returns the cached provider for a model's family,
 *   building (and caching) it on first use.
 */
export function createMemoizedProviderFactory(
  buildProvider: (model: string | undefined) => ModelProvider,
  keyForModel: (model: string | undefined) => string,
): (model: string | undefined) => ModelProvider {
  const cache = new Map<string, ModelProvider>();
  return (model: string | undefined): ModelProvider => {
    const key = keyForModel(model);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const built = buildProvider(model);
    cache.set(key, built);
    return built;
  };
}
