/**
 * Contract: CLI configuration loader — facade.
 *
 * Merges three config tiers (env vars / afk.config.json / AFK.md) plus
 * explicit overrides into a resolved `CliConfig`, and re-exports every
 * public symbol of the tier modules so NO consumer import path changes.
 *
 * The implementation is split across `config/` siblings (#368):
 *   - `config/types.ts`       — `CliConfig`/`ConfigFileSchema` + `DEFAULT_CONFIG`,
 *                               `DEFAULT_CLI_PERMISSION_MODE`
 *   - `config/env-tier.ts`    — `.env`/process-env tier (`loadEnvConfig`,
 *                               `loadCredential`, `normalizeOpenAIBaseUrl`);
 *                               home of `envConfigCache`, `dotenvLoaded`, and
 *                               the OpenAI base-URL warn-once tracker
 *   - `config/json-tier.ts`   — afk.config.json tier (`loadJsonConfig`);
 *                               home of `jsonConfigCache`
 *   - `config/afk-md-tier.ts` — AFK.md auto-discovery tier (`loadAfkMd`);
 *                               home of `afkMdCache`
 *
 * Invariant: each module-scope cache lives in EXACTLY ONE tier module.
 * `_resetConfigCache()` below reaches each tier's real state through the
 * reset function that tier exports — ESM importers cannot reassign an
 * imported binding, so the tier modules own all reassignment (same pattern
 * as `setState()` in the #366 plugin-skills split).
 */

import { getModelId, isValidModel } from '../agent/session/model-resolution.js';
import {
  computeSlotBindings,
  setSlotBindings,
} from '../agent/session/model-slots.js';
import { providerForModel, type BundledProviderName } from '../agent/providers/index.js';
import type { PermissionMode } from '../agent/types/sdk-types.js';
import type { ImportFromConfig, ImportSourceBinary } from '../config/import-sources.js';
import {
  DEFAULT_CLI_PERMISSION_MODE,
  DEFAULT_CONFIG,
  type CliConfig,
} from './config/types.js';
import { loadEnvConfig, resetEnvConfigCache } from './config/env-tier.js';
import { loadJsonConfig, resetJsonConfigCache } from './config/json-tier.js';
import { loadAfkMd, resetAfkMdCache } from './config/afk-md-tier.js';

export type { ImportFromConfig, ImportSourceBinary };

export { getModelId, isValidModel };

export type { AutoRoutingConfig, CliConfig } from './config/types.js';
export { DEFAULT_CLI_PERMISSION_MODE } from './config/types.js';
export {
  loadCredential,
  normalizeOpenAIBaseUrl,
  _resetOpenAIBaseUrlWarnCache,
} from './config/env-tier.js';

/**
 * Clear the in-memory config-disk caches. Exposed for tests that mock the
 * filesystem per-case and for any future "config changed" invalidation
 * hook (currently none — config is reread on next CLI process).
 *
 * Also clears the env-config cache so tests that mutate `process.env`
 * between cases see the new values; in production this matters less since
 * env vars don't change mid-process, but the keychain credential read
 * inside `loadEnvConfig` is a measurable cost we'd rather not pay 3× per
 * `afk chat` invocation.
 */
export function _resetConfigCache(): void {
  resetJsonConfigCache();
  resetAfkMdCache();
  resetEnvConfigCache();
  // Intentionally NOT resetting `dotenvLoaded` — env-var precedence is
  // process-lifetime by design and unrelated to JSON/AFK.md tier caching.
}

/**
 * Load and merge configuration from all sources
 * Priority: CLI args > JSON config > .env > defaults
 *
 * Intentionally does NOT throw when no API key is present. Provider
 * selection is model-based (see `providerForModel`); a missing
 * `ANTHROPIC_API_KEY` is only fatal for the Anthropic path, and callers
 * running Codex get a friendlier message from the provider itself.
 */
/**
 * Read the parsed `telegram` block from afk.config.json (cwd → ~/.afk/config →
 * legacy), or `{}` when absent. Backed by the memoized `loadJsonConfig`, so it
 * is side-effect-free — unlike `loadConfig`, which installs process-global
 * model-slot bindings and can throw on a misconfigured `local-*` model, neither
 * of which belongs on the notification push path. The `AFK_TELEGRAM_PRIMARY_CHAT_ID`
 * env override is merged separately in `src/telegram/notify-routing.ts`.
 */
export function loadTelegramConfig(): NonNullable<CliConfig['telegram']> {
  return loadJsonConfig().config.telegram ?? {};
}

/**
 * Resolve the effective CLI permission mode for display / status surfaces:
 * the afk.config.json `permissionMode` when set, else the new-install default
 * (`DEFAULT_CLI_PERMISSION_MODE` = bypass). Reads the memoized JSON directly so
 * it is side-effect-free and never throws on the `local-*`-model guard that the
 * full `loadConfig` enforces — same rationale as `loadTelegramConfig`. This is
 * the canonical answer to "what mode would a fresh `afk chat`/`afk i` run in?"
 * and the single source the status displays read so they stop hardcoding bypass.
 */
export function resolveCliPermissionMode(): PermissionMode {
  return loadJsonConfig().config.permissionMode ?? DEFAULT_CLI_PERMISSION_MODE;
}

export function loadConfig(overrides?: Partial<CliConfig>): CliConfig {
  const envConfig = loadEnvConfig();
  const { config: jsonConfig, sourcePath: jsonSourcePath, modelsPartial } = loadJsonConfig();

  // Last-wins shallow merge for nested daemon — see Gap B spec. The schema
  // stays flat for top-level fields; the `daemon` block is treated as a
  // single value, so a later layer that sets `daemon` replaces it whole.
  const merged: Partial<CliConfig> = {
    ...DEFAULT_CONFIG,
    ...envConfig,
    ...jsonConfig,
    ...overrides,
  };

  // Determine systemPromptSource for all three tiers.
  // Tier 1: env var (highest precedence)
  // Tier 2: JSON config file
  // Tier 3: AFK.md auto-discovery (lowest precedence; fills gap when tiers 1+2 unset)
  let systemPromptSource: string | undefined;
  if (envConfig.systemPrompt !== undefined) {
    systemPromptSource = 'env:AFK_SYSTEM_PROMPT';
  } else if (jsonConfig.systemPrompt !== undefined && jsonSourcePath !== undefined) {
    systemPromptSource = `file:${jsonSourcePath}`;
  } else if (merged.systemPrompt === undefined) {
    // Neither env nor JSON set systemPrompt — try AFK.md.
    // Strict `=== undefined`: an explicit empty-string override (`systemPrompt: ""`)
    // is treated as "unset" and falls through to AFK.md discovery. Callers that
    // truly want "no prompt" should omit the field rather than pass "".
    const afkMd = loadAfkMd();
    if (afkMd !== null) {
      merged.systemPrompt = afkMd.content;
      systemPromptSource = `afk-md:${afkMd.path}`;
    }
  }

  const config: CliConfig = {
    model: merged.model ?? DEFAULT_CONFIG.model,
    maxTokens: merged.maxTokens ?? DEFAULT_CONFIG.maxTokens,
    temperature: merged.temperature ?? DEFAULT_CONFIG.temperature,
    updatePolicy: merged.updatePolicy ?? DEFAULT_CONFIG.updatePolicy,
    ...(merged.apiKey !== undefined ? { apiKey: merged.apiKey } : {}),
    ...(merged.baseUrl !== undefined ? { baseUrl: merged.baseUrl } : {}),
    ...(merged.openaiBaseUrl !== undefined ? { openaiBaseUrl: merged.openaiBaseUrl } : {}),
    ...(merged.systemPrompt !== undefined ? { systemPrompt: merged.systemPrompt } : {}),
    ...(systemPromptSource !== undefined ? { systemPromptSource } : {}),
    // New-install default is bypass (DEFAULT_CLI_PERMISSION_MODE); an explicit
    // afk.config.json / env / override `permissionMode` still wins.
    permissionMode: merged.permissionMode ?? DEFAULT_CLI_PERMISSION_MODE,
    ...(merged.autoRouting !== undefined ? { autoRouting: merged.autoRouting } : {}),
    ...(merged.daemon !== undefined ? { daemon: merged.daemon } : {}),
    ...(merged.telegram !== undefined ? { telegram: merged.telegram } : {}),
    ...(merged.bgSummaries !== undefined ? { bgSummaries: merged.bgSummaries } : {}),
    ...(merged.maxSummaryCallsPerSession !== undefined
      ? { maxSummaryCallsPerSession: merged.maxSummaryCallsPerSession }
      : {}),
    ...(merged.interactive !== undefined ? { interactive: merged.interactive } : {}),
    ...(merged.hooks !== undefined ? { hooks: merged.hooks } : {}),
    ...(merged.enableShellHooks !== undefined ? { enableShellHooks: merged.enableShellHooks } : {}),
    ...(merged.importFrom !== undefined ? { importFrom: merged.importFrom } : {}),
  };

  // Resolve + install the process-global model-slot bindings (Stage 1).
  // Precedence: explicit `overrides.models` > afk.config.json `models` block
  // ← `AFK_MODEL_{SMALL,MEDIUM,LARGE}` env (env wins, mirroring AFK_MODEL >
  // afk.config.json). Installed globally so every routing call site resolves
  // tier aliases without per-site plumbing — see model-slots.ts.
  const slotBindings = overrides?.models ?? computeSlotBindings(modelsPartial);
  setSlotBindings(slotBindings);
  config.models = slotBindings;

  // Fail loud when a `local-*` model is requested without a local server
  // configured. Catching this here saves a confused 401 from api.anthropic.com.
  if (
    typeof config.model === 'string' &&
    config.model.toLowerCase().startsWith('local-') &&
    (config.baseUrl === undefined || config.baseUrl.length === 0)
  ) {
    throw new Error(
      `Model '${config.model}' requires AFK_LOCAL_BASE_URL to be set ` +
        `(e.g. AFK_LOCAL_BASE_URL=http://127.0.0.1:8080). Point it at your ` +
        `local Anthropic-Messages-compatible server.`,
    );
  }

  return config;
}

/**
 * Resolve the bundled provider for a given config. Returns the harness
 * provider name (`anthropic` | `openai-compatible`) — useful when CLI
 * surfaces need to tailor error messages to the active backend.
 */
export function resolvedProviderName(config: CliConfig): BundledProviderName {
  return providerForModel(config.model as string);
}
