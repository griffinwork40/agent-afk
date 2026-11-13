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

/** The configured main-session fallback model input, or `undefined` when unset. */
export function getConfiguredFallbackModel(): string | undefined {
  const value = loadJsonConfig().config.fallbackModel;
  return value !== undefined && value.trim().length > 0 ? value : undefined;
}
