/**
 * Main-session fallback model (`models.fallback` in afk.config.json).
 *
 * Contract: returns the configured fallback as a raw model INPUT string (an
 * identity alias such as `sonnet`, a tier name such as `local`, or a concrete
 * id), or `undefined` when unset/empty. It is deliberately NOT resolved here:
 * callers hand it to the same model-input path as any other model string
 * (`resolveBinding` / `providerForModel`), so a tier name carries that slot's
 * per-slot provider/baseUrl/apiKey exactly as it would for `/model local`.
 *
 * Reads the memoized JSON tier side-effect-free (same rationale as
 * `resolveAutoResumeOnUsageLimit` in cli/config.ts): `loadConfig()` would
 * re-install the process-global slot bindings on every call. No env var and
 * no CLI flag feed this value by design.
 *
 * @module agent/session/fallback-model
 */
import { loadJsonConfig } from '../../cli/config/json-tier.js';
import type { ModelProvider } from '../provider.js';
import type { AgentConfig } from '../types/config-types.js';

/** The configured main-session fallback model input, or `undefined` when unset. */
export function getConfiguredFallbackModel(): string | undefined {
  const value = loadJsonConfig().config.fallbackModel;
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}

/**
 * Whether a session that INJECTS a ready-made provider should still be driven
 * through `ProviderRouter`, the only component that can switch to the fallback.
 *
 * Contract: true only when the surface also declared how to build an equally
 * wired provider for another model (`providerFactory`), a fallback is
 * configured, and the session is not a subagent fork. In every other case the
 * injected provider is called directly, exactly as before this feature, so a
 * session with no fallback configured never gains a router. A surface that
 * passes no factory is never routed: the router's bare provider path would
 * build a fallback without the surface's executors, stores and MCP tools.
 */
export function routesInjectedProviderForFallback(
  config: Pick<AgentConfig, 'providerFactory' | 'isSubagentFork'>,
): boolean {
  return (
    config.providerFactory !== undefined &&
    config.isSubagentFork !== true &&
    getConfiguredFallbackModel() !== undefined
  );
}

/**
 * Wrap a surface's provider factory so the injected instance always serves its
 * own provider family. The session's primary provider is then the very object
 * the surface built and holds, whether or not its factory memoizes.
 */
export function injectedFirstFactory(
  injected: ModelProvider,
  factory: (model: string | undefined) => ModelProvider,
): (model: string | undefined) => ModelProvider {
  return (model) => {
    const built = factory(model);
    return built.name === injected.name ? injected : built;
  };
}
