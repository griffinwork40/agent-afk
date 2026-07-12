// Contract: the env tier of the CLI config loader (#368 split). This module
// is the SINGLE home of the env-tier caches: `envConfigCache`, `dotenvLoaded`,
// and the `warnedOpenAIBaseUrlSuffix` warn-once tracker. Sibling modules and
// the `config.ts` facade must never duplicate this state — the facade resets
// `envConfigCache` only through `resetEnvConfigCache()` exported here, because
// ESM importers cannot reassign an imported binding (same pattern as
// `setState()` in the #366 plugin-skills split).

import { existsSync } from 'fs';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { isValidModel } from '../../agent/session/model-resolution.js';
import { providerForModel } from '../../agent/providers/index.js';
import { getEnvConfigPath, getLegacyEnvConfigPath } from '../../paths.js';
import { loadAnthropicCredential } from '../../agent/auth/credential-resolver.js';
import { env } from '../../config/env.js';
import type { CliConfig } from './types.js';

// Track if dotenv has been loaded to avoid reloading
let dotenvLoaded = false;

/**
 * Resolve an Anthropic credential from the environment, falling back to the
 * Claude Code keychain entry written by `claude login` when neither env var
 * is present.
 *
 * Precedence:
 *   1. `ANTHROPIC_API_KEY` env
 *   2. `CLAUDE_CODE_OAUTH_TOKEN` env
 *   3. macOS Keychain (`Claude Code-credentials`) / `~/.claude/.credentials.json`
 *
 * Returns `undefined` when no credential is available so Codex-only paths
 * and unauthenticated startup keep working. The keychain fallback is read
 * fresh on each call — Claude Code refreshes the entry on its own launches,
 * so a long-running afk process picks up new tokens without restart.
 *
 * Delegates to `loadAnthropicCredential` in `src/agent/auth/credential-resolver.ts`
 * — the canonical implementation now lives there so the agent layer can call
 * it directly without an upward import into `src/cli/`.
 */
export function loadCredential(): string | undefined {
  return loadAnthropicCredential();
}

/**
 * Load configuration from .env file(s).
 *
 * Layered precedence (highest first wins; later layers fill gaps via
 * `override: false`):
 *   1. Project `.env` in `process.cwd()` — per-repo overrides.
 *   2. `~/.afk/config/afk.env` (user-scope) — the canonical place for
 *      Telegram tokens, allowlists, default model, etc.
 *   3. Legacy `~/.afk.env` — back-compat for pre-`~/.afk/config/` layouts.
 *
 * This mirrors what `src/cli/index.ts` does for CLI entry points, and
 * removes the long-standing asymmetry where the Telegram bot entry
 * (which doesn't run the CLI boot sequence) only saw the first `.env`
 * found and ignored user-scope config. Telegram, daemon, chat, and
 * interactive all share `loadConfig()` and now share env layering too.
 *
 * `AFK_MODEL` is the canonical env var; `CLAUDE_MODEL` is retained as a
 * compatibility alias so existing Claude-only deployments keep working.
 */
let envConfigCache: Partial<CliConfig> | undefined;

/**
 * Tracks raw `AFK_OPENAI_BASE_URL` values that have already triggered the
 * `/chat/completions`-suffix warning. Keyed on the *raw* (pre-strip) value
 * so re-warning happens iff the operator sets a different bad value. Module
 * scope is deliberate: warn-once-per-process semantics survive the
 * `envConfigCache` reset path used by tests.
 */
const warnedOpenAIBaseUrlSuffix = new Set<string>();

/**
 * Normalize `AFK_OPENAI_BASE_URL` for the OpenAI-compatible provider.
 *
 * The OpenAI SDK appends `/chat/completions` itself, so a value ending in
 * that suffix resolves to `…/v1/chat/completions/chat/completions` at the
 * wire — a recurring user stumble. Strip the suffix and emit a one-shot
 * stderr warning naming the corrected value. The warning is emitted at
 * most once per unique raw value per process so test-driven mutations
 * don't flood stderr.
 *
 * Why strip rather than throw: this is a config-time normalization, not a
 * security boundary. The user's intent is unambiguous from the URL shape,
 * and a stripped-with-warning UX is strictly better than a 404 / 405 the
 * user has to diagnose at request time.
 */
export function normalizeOpenAIBaseUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return trimmed;
  const suffix = '/chat/completions';
  if (trimmed.endsWith(suffix)) {
    const stripped = trimmed.slice(0, -suffix.length);
    if (!warnedOpenAIBaseUrlSuffix.has(trimmed)) {
      warnedOpenAIBaseUrlSuffix.add(trimmed);
      // eslint-disable-next-line no-console -- one-shot operator UX warning
      console.warn(
        `[afk] AFK_OPENAI_BASE_URL: stripped trailing "/chat/completions" — the OpenAI SDK appends it automatically.\n` +
          `      Effective base URL: ${stripped}`,
      );
    }
    return stripped;
  }
  return trimmed;
}

/** Test-only hook to reset the warn-once tracker. Internal API. */
export function _resetOpenAIBaseUrlWarnCache(): void {
  warnedOpenAIBaseUrlSuffix.clear();
}

export function loadEnvConfig(): Partial<CliConfig> {
  if (envConfigCache !== undefined) return envConfigCache;
  if (!dotenvLoaded) {
    // Order matters: dotenv processes in this order with override:false,
    // meaning the first occurrence wins. Project `.env` is loaded first
    // and any keys it sets stick; user-scope and legacy fill the rest.
    const envPaths = [
      join(process.cwd(), '.env'),
      getEnvConfigPath(),
      getLegacyEnvConfigPath(),
    ];

    for (const envPath of envPaths) {
      if (existsSync(envPath)) {
        dotenvConfig({ path: envPath, override: false });
      }
    }

    dotenvLoaded = true;
  }

  const config: Partial<CliConfig> = {};

  const modelRaw = env.AFK_MODEL ?? env.CLAUDE_MODEL;
  if (modelRaw) {
    const lowered = modelRaw.toLowerCase();
    // Only normalize casing for known Claude short aliases; non-Claude model
    // ids (`gpt-5.4`, `codex-fast-1`) pass through unchanged so the provider
    // router sees exactly what the user typed.
    config.model = isValidModel(lowered) ? lowered : modelRaw;
  }

  // Provider-aware credential loading.
  //
  // History: `loadCredential()` walks ANTHROPIC_API_KEY → CLAUDE_CODE_OAUTH_TOKEN →
  // macOS Keychain (`Claude Code-credentials` written by `claude login`). Before
  // this gate, the credential was written into `config.apiKey` unconditionally,
  // which silently leaked the Anthropic OAuth token into the openai-compatible
  // provider's `resolveOpenAIAuth(config.apiKey)` — short-circuiting before it
  // could read `OPENAI_API_KEY` from env. Operators running
  // `AFK_PROVIDER=openai-compatible AFK_OPENAI_BASE_URL=… AFK_MODEL=qwen3.5-plus`
  // with a stale Claude-Code keychain entry saw their OpenAI Bearer header set
  // to `sk-ant-oat01-…`, which OpenAI-compatible endpoints rejected as 401. The
  // error mapper then stamped a generic "Verify ANTHROPIC_API_KEY" hint on the
  // failure, hiding the real cause. See e2e test `oauth-token-keychain-leak`.
  //
  // Gating on `providerForModel(modelRaw)` (which honors `AFK_PROVIDER` and the
  // `AFK_OPENAI_BASE_URL` env-hint tier) means the Anthropic credential is only
  // surfaced when an Anthropic-shaped provider will actually consume it. The
  // openai-compatible provider then sees `config.apiKey === undefined` and its
  // own auth resolver correctly reads `OPENAI_API_KEY` / `~/.codex/auth.json`.
  const providerName = providerForModel(modelRaw);
  if (providerName === 'anthropic-direct') {
    const credential = loadCredential();
    if (credential !== undefined) {
      config.apiKey = credential;
    }
  }

  // Local-server mode. `AFK_LOCAL_BASE_URL` points at an Anthropic-compatible
  // shim; presence is the sole runtime trigger for the local-mode codepath in
  // AnthropicDirectProvider. Real Anthropic credentials are NOT forwarded —
  // overwrite `apiKey` with a placeholder so a stray ANTHROPIC_API_KEY never
  // reaches a local server. Validation of `local-*` model + missing baseUrl
  // happens in `loadConfig()` after overrides are merged.
  const localBaseUrlRaw = env.AFK_LOCAL_BASE_URL;
  if (localBaseUrlRaw && localBaseUrlRaw.length > 0) {
    config.baseUrl = localBaseUrlRaw;
    config.apiKey = env.AFK_LOCAL_API_KEY || 'local';
  }

  if (env.AFK_MAX_TOKENS) {
    // Only assign when finite — a non-numeric value parses to NaN, which would
    // otherwise win the `??` merge over DEFAULT_CONFIG.maxTokens and poison
    // every request (see cli/config.ts merge site).
    const maxTokens = parseInt(env.AFK_MAX_TOKENS, 10);
    if (Number.isFinite(maxTokens)) config.maxTokens = maxTokens;
  }

  if (env.AFK_TEMPERATURE) {
    // Same NaN guard as AFK_MAX_TOKENS above.
    const temperature = parseFloat(env.AFK_TEMPERATURE);
    if (Number.isFinite(temperature)) config.temperature = temperature;
  }

  if (env.AFK_SYSTEM_PROMPT) {
    config.systemPrompt = env.AFK_SYSTEM_PROMPT;
  }

  if (env.AFK_AUTO_ROUTING) {
    const val = env.AFK_AUTO_ROUTING.toLowerCase() === 'true';
    config.autoRouting = { interactive: val, chat: val, telegram: val, daemon: val };
  }

  // OpenAI-compatible endpoint override. Documented in
  // `agent/types/config-types.ts:openaiBaseUrl` — points the
  // openai-compatible provider at a local server (mlx_lm.server, Ollama
  // OpenAI-compat, vLLM, LM Studio, llama.cpp) instead of api.openai.com.
  //
  // The auth side is intentionally NOT shadowed here: the OpenAI provider's
  // auth resolver (providers/openai-compatible/auth.ts) already reads
  // OPENAI_API_KEY directly from env, and many local shims accept any
  // non-empty key. Document AFK_OPENAI_API_KEY as a future no-op alias if
  // demand surfaces — for now, callers pass OPENAI_API_KEY directly.
  if (env.AFK_OPENAI_BASE_URL) {
    config.openaiBaseUrl = normalizeOpenAIBaseUrl(env.AFK_OPENAI_BASE_URL);
  }

  envConfigCache = config;
  return config;
}

/**
 * Clear this tier's memoized env config. Called (only) by
 * `_resetConfigCache()` in the `config.ts` facade — the cache binding lives
 * here and cannot be reassigned by importers under ESM live-binding rules.
 *
 * Intentionally does NOT reset `dotenvLoaded` — env-var precedence is
 * process-lifetime by design and unrelated to JSON/AFK.md tier caching.
 */
export function resetEnvConfigCache(): void {
  envConfigCache = undefined;
}
