import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { config as dotenvConfig } from 'dotenv';
import { getModelId, isValidModel } from '../agent/session/model-resolution.js';
import {
  computeSlotBindings,
  parseModelsConfig,
  setSlotBindings,
  type ModelSlotBinding,
  type ModelSlots,
  type SlotName,
} from '../agent/session/model-slots.js';
import { providerForModel, type BundledProviderName } from '../agent/providers/index.js';
import type { AgentModelInput } from '../agent/types.js';
import {
  getAfkHome,
  getEnvConfigPath,
  getJsonConfigPath,
  getLegacyEnvConfigPath,
  getLegacyJsonConfigPath,
} from '../paths.js';
import { loadAnthropicCredential } from '../agent/auth/credential-resolver.js';
import { validateBranchPrefix, validateBaseRef } from './commands/interactive/worktree.js';
import { env } from '../config/env.js';
import type { RawHooksConfig } from '../agent/hooks/config-loader.js';
import {
  parseImportFromConfig,
  type ImportFromConfig,
  type ImportSourceBinary,
} from '../config/import-sources.js';

export type { ImportFromConfig, ImportSourceBinary };

export { getModelId, isValidModel };

/**
 * Resolved CLI configuration.
 *
 * `apiKey` is optional and only populated when an explicit key is available
 * in the environment or the user's config file. Providers that need a key
 * but don't get one (e.g. Anthropic without OAuth state) surface the
 * failure lazily at session-construction time, not up front — this is how
 * we support `AFK_MODEL=gpt-5.4` without an `ANTHROPIC_API_KEY` present.
 */
export interface AutoRoutingConfig {
  interactive?: boolean;
  chat?: boolean;
  telegram?: boolean;
  daemon?: boolean;
}

export interface CliConfig {
  apiKey?: string;
  /**
   * Base URL for the Anthropic Messages API. When set, traffic is routed to
   * a self-hosted Anthropic-compatible server (e.g. vllm-mlx serving a local
   * MLX model). Sourced from `AFK_LOCAL_BASE_URL`. The SDK appends
   * `/v1/messages` to whatever value is supplied.
   *
   * When set, the resolved `apiKey` is forced to a non-Anthropic placeholder
   * sourced from `AFK_LOCAL_API_KEY` (default `'local'`) so real Anthropic
   * credentials never leak to a local server.
   */
  baseUrl?: string;
  model: AgentModelInput;
  /**
   * Resolved model-slot bindings (defaults ← afk.config.json `models` block ←
   * `AFK_MODEL_{SMALL,MEDIUM,LARGE}` env). Always populated by `loadConfig()`,
   * which also installs them process-globally via `setSlotBindings`.
   */
  models?: ModelSlots;
  maxTokens: number;
  temperature: number;
  /**
   * OpenAI-compatible endpoint override. Sourced from `AFK_OPENAI_BASE_URL`.
   * Threaded into `OpenAICompatibleProvider({ baseURL })` so local shims
   * (mlx_lm.server, Ollama OpenAI-compat, vLLM, LM Studio, llama.cpp) work
   * out of the box. When unset, the OpenAI SDK uses its default
   * `https://api.openai.com/v1`.
   */
  openaiBaseUrl?: string;
  systemPrompt?: string;
  /**
   * Provenance string for `systemPrompt` — e.g. `"env:AFK_SYSTEM_PROMPT"`,
   * `"file:/abs/path/afk.config.json"`, `"afk-md:/abs/path/AFK.md"`.
   * Populated by `loadConfig()` for all three tiers. Consumed by the
   * prompt-dump debug feature; not forwarded to the SDK.
   */
  systemPromptSource?: string;
  autoRouting?: AutoRoutingConfig;
  /**
   * Daemon defaults sourced from afk.config.json. Stays `undefined` when
   * the user has no `daemon` block — the daemon-options resolver owns the
   * compiled fallback. See Daemon Gap B Wave 1 Lane B.
   */
  daemon?: {
    task?: string;
    taskId?: string;
    worktreePrune?: {
      enabled: boolean;
      cron: string;
      maxAgeDaysClean: number;
      maxAgeDaysDirty: number;
      scope: string;
    };
  };
  /**
   * Telegram outbound notification routing, sourced from afk.config.json
   * `telegram.notify`. Stays `undefined` when the user has no `telegram` block —
   * the resolver in `src/telegram/notify-routing.ts` owns the defaults (deliver
   * to the primary/DM chat). See `loadTelegramConfig()`.
   */
  telegram?: {
    notify?: {
      mode?: 'primary' | 'broadcast' | 'custom';
      primaryChatId?: number;
      targets?: number[];
    };
  };
  /**
   * `afk interactive` defaults.
   *
   * Currently scopes worktree auto-naming knobs; future interactive-only
   * settings should land here too.
   */
  interactive?: {
    /**
     * When true (default), the first non-slash user message in a session
     * launched with `afk i --worktree` (and no explicit branch name) is
     * sent through a cheap haiku call to derive a kebab-case slug, then
     * the worktree dir + branch are renamed in place. Set false to skip
     * the rename and keep the timestamp-based name forever.
     *
     * Env override: `AFK_WORKTREE_AUTONAME=0` (off) / unset|1 (on).
     * CLI override: `--no-worktree-autoname`.
     */
    worktreeAutoname?: boolean;
    /**
     * Branch namespace for AFK-managed worktrees. The created branch is
     * `<prefix><slug>` (or `<prefix><timestamp>-<hex>` for the initial
     * pre-rename name). Default `'afk/'`. Set to `''` to drop the prefix.
     *
     * Env override: `AFK_WORKTREE_BRANCH_PREFIX`.
     *
     * Cosmetic only — no part of AFK (sweep, release CI, telemetry) keys
     * off the branch name. Useful when downstream users' teams already
     * own `afk/*` as a real branch namespace.
     */
    worktreeBranchPrefix?: string;
    /**
     * Override the base git ref for worktrees created with `--worktree`.
     * By default AFK bases worktrees on the remote's default branch
     * (e.g. `origin/main`), fetched fresh, so they start from upstream
     * rather than whatever the local checkout is on. Set this to pin a
     * different ref, or to `HEAD` to base on the local checkout.
     *
     * Env override: `AFK_WORKTREE_BASE`. CLI override: `--worktree-base`.
     * Precedence: CLI flag > env > this config value > remote-default detection.
     */
    worktreeBase?: string;
    /**
     * Master toggle for REPL ghost-text suggestions (Tier-1 history +
     * optional Tier-2 LLM). Mirrors `AFK_SUGGEST_GHOST` env var.
     * `undefined` = not set (default-on). `false` = disable all ghost text.
     */
    suggestGhost?: boolean;
  };
  updatePolicy: 'notify' | 'auto' | 'off';
  /**
   * When true (the default), the CLI auto-waits for the OAuth subscription
   * reset and replays the failed turn rather than surfacing a raw 429 error.
   * Propagated to `AgentConfig.autoResumeOnUsageLimit`.
   */
  autoResumeOnUsageLimit?: boolean;
  /**
   * When true, the REPL constructs a BackgroundSummarizer that periodically
   * asks Haiku to summarize each running background subagent job's transcript
   * tail. Summaries appear in `/bgsub:list` on an indented second line.
   * Default: false (opt-in).
   *
   * ── DATA-EGRESS CONTRACT ──────────────────────────────────────────────────
   * Enabling this flag causes redacted transcript tails (≤`maxInputTokens`×4
   * bytes, default ~4 KB) to be sent to `claude-haiku-4-5` via the Anthropic
   * API. Before transmission, `redactSecrets()` strips bearer tokens, Anthropic
   * API keys, and long opaque hex/base64 strings. No conversation history,
   * system prompts, or tool results outside the transcript ring buffer are ever
   * included. Session-wide call volume is bounded by `maxSummaryCallsPerSession`
   * (default 200). Do NOT enable in air-gapped or secret-sensitive environments.
   */
  bgSummaries?: boolean;
  /**
   * Session-wide budget for BackgroundSummarizer LLM calls. When this many
   * calls have been made, further refreshes are skipped silently.
   * Default: 200. Maximum: 500.
   */
  maxSummaryCallsPerSession?: number;
  /**
   * Raw hook definitions from `afk.config.json`. The full tiered merge is
   * performed by `loadHooksConfig()` in `src/agent/hooks/config-loader.ts` —
   * this field carries only what was in the first-found `afk.config.json`
   * file and is provided for completeness of the config surface. Callers
   * that want the merged, validated config should call `loadHooksConfig()`.
   */
  hooks?: RawHooksConfig;
  /**
   * When true (and set in a user-global config file), enables execution of
   * shell-command hooks defined in the `hooks` block. Must be in a user-global
   * file to take effect — project-local files are silently ignored for this
   * flag to prevent cloned repos from auto-executing scripts.
   *
   * This is the master switch only. A second user-global gate,
   * `allowProjectHooks` (read directly by `loadHooksConfig()`), governs whether
   * hook *definitions* sourced from project-local files are admitted; it
   * defaults to false so repo-local hooks stay dropped even once shell hooks
   * are globally enabled. See `src/agent/hooks/config-loader.ts`.
   */
  enableShellHooks?: boolean;
  /**
   * Cross-tool asset import. Maps each trusted source binary to the asset
   * types AFK should live-read from that binary's install location. Populated
   * by `afk migrate`; resolved to concrete scan roots by
   * `resolveImportedRoots()` in `src/cli/commands/migrate/sources.ts`.
   * `undefined` / absent = nothing imported (strict opt-in).
   */
  importFrom?: ImportFromConfig;
}

/** One per-tier model binding in afk.config.json's `models` block. */
interface ModelSlotConfigEntry {
  id?: string;
  name?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
}

interface ConfigFileSchema {
  model?: string;
  /**
   * Per-tier model bindings. Each slot accepts a bare id string
   * (`"small": "gpt-4o-mini"`) or an object with an optional custom `name` and
   * optional Stage 2 per-slot provider credentials
   * (`"small": { "id": "gpt-4o-mini", "name": "fast", "provider": "openai",
   * "baseUrl": "http://localhost:8080/v1", "apiKey": "…" }`). Parsed defensively
   * by `parseModelsConfig`; unknown keys / malformed entries are ignored.
   */
  models?: {
    small?: string | ModelSlotConfigEntry;
    medium?: string | ModelSlotConfigEntry;
    large?: string | ModelSlotConfigEntry;
  };
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
  autoRouting?: {
    interactive?: boolean;
    chat?: boolean;
    telegram?: boolean;
    daemon?: boolean;
  };
  daemon?: {
    task?: string;
    taskId?: string;
    worktreePrune?: {
      enabled?: boolean;
      cron?: string;
      maxAgeDaysClean?: number;
      maxAgeDaysDirty?: number;
      scope?: string;
    };
  };
  /**
   * Telegram outbound notification routing. Separate from the inbound allowlist
   * (`AFK_TELEGRAM_ALLOWED_CHAT_IDS`, which gates who may command the bot).
   * Parsed defensively below; consumed via `loadTelegramConfig()` →
   * `src/telegram/notify-routing.ts`.
   */
  telegram?: {
    notify?: {
      mode?: 'primary' | 'broadcast' | 'custom';
      primaryChatId?: number;
      targets?: number[];
    };
  };
  interactive?: {
    worktreeAutoname?: boolean;
    worktreeBranchPrefix?: string;
    worktreeBase?: string;
    suggestGhost?: boolean;
  };
  updatePolicy?: 'notify' | 'auto' | 'off';
  autoResumeOnUsageLimit?: boolean;
  bgSummaries?: boolean;
  maxSummaryCallsPerSession?: number;
  hooks?: RawHooksConfig;
  enableShellHooks?: boolean;
  /**
   * Cross-tool asset import. Each known source binary maps to either a bare
   * `true` (shorthand: import all asset types) or an object with per-asset
   * toggles. Normalized by `parseImportFromConfig`.
   */
  importFrom?: Partial<
    Record<ImportSourceBinary, boolean | { plugins?: boolean; skills?: boolean; mcp?: boolean }>
  >;
}

const DEFAULT_CONFIG: Omit<CliConfig, 'apiKey'> = {
  model: 'sonnet',
  maxTokens: 4096,
  temperature: 1.0,
  updatePolicy: 'notify',
};

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

function loadEnvConfig(): Partial<CliConfig> {
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
    config.maxTokens = parseInt(env.AFK_MAX_TOKENS, 10);
  }

  if (env.AFK_TEMPERATURE) {
    config.temperature = parseFloat(env.AFK_TEMPERATURE);
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
 * Process-lifetime caches for the disk-backed config tiers. `afk chat` calls
 * `loadConfig()` 2× per invocation (CLI bootstrap reads `updatePolicy`, then
 * the command handler reads `systemPromptSource`) and `loadConfigSystemPrompt()`
 * walks the same JSON + AFK.md tiers a third time. The disk layout doesn't
 * change between those calls in normal operation, so we memoize the file
 * reads and serve subsequent calls in O(1).
 *
 * Tests that mutate `HOME` / `process.cwd()` / fs mocks between cases must
 * call `_resetConfigCache()` in `beforeEach` — the cache is keyed on
 * neither, so stale entries would survive otherwise. Future plugin-install
 * style hooks that mutate config files should call this too.
 */
let jsonConfigCache:
  | {
      config: Partial<CliConfig>;
      sourcePath: string | undefined;
      modelsPartial: Partial<Record<SlotName, ModelSlotBinding>>;
    }
  | undefined;
let afkMdCache: { value: { content: string; path: string } | null } | undefined;

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
  jsonConfigCache = undefined;
  afkMdCache = undefined;
  envConfigCache = undefined;
  // Intentionally NOT resetting `dotenvLoaded` — env-var precedence is
  // process-lifetime by design and unrelated to JSON/AFK.md tier caching.
}

/**
 * Load configuration from afk.config.json.
 *
 * `model` accepts any string — the Claude short-alias set is validated
 * only for the purpose of preserving the previous behaviour of ignoring
 * unknown short aliases ("sonnet_pro" → fall through to default). Non-
 * Claude model ids still pass through untouched because `isValidModel`
 * returns false and we only gate on it for the short-alias case.
 *
 * Returns `{ config, sourcePath }` where `sourcePath` is the absolute path
 * of the file that was actually read, or `undefined` when no config file
 * was found. Used by `loadConfig()` to populate `systemPromptSource`.
 *
 * Memoized via `jsonConfigCache` — see the cache block above for the
 * invalidation contract.
 */
function loadJsonConfig(): {
  config: Partial<CliConfig>;
  sourcePath: string | undefined;
  modelsPartial: Partial<Record<SlotName, ModelSlotBinding>>;
} {
  if (jsonConfigCache !== undefined) return jsonConfigCache;
  const configPaths = [
    join(process.cwd(), 'afk.config.json'),
    getJsonConfigPath(),
    getLegacyJsonConfigPath(),
  ];

  for (const configPath of configPaths) {
    if (existsSync(configPath)) {
      try {
        const content = readFileSync(configPath, 'utf-8');
        const json: ConfigFileSchema = JSON.parse(content);

        const config: Partial<CliConfig> = {};
        const modelsPartial = parseModelsConfig(json.models);

        if (typeof json.model === 'string' && json.model.length > 0) {
          const loweredModel = json.model.toLowerCase();
          config.model = isValidModel(loweredModel) ? loweredModel : json.model;
        }

        if (typeof json.maxTokens === 'number') {
          config.maxTokens = json.maxTokens;
        }

        if (typeof json.temperature === 'number') {
          config.temperature = json.temperature;
        }

        if (json.systemPrompt) {
          config.systemPrompt = json.systemPrompt;
        }

        if (json.autoRouting && typeof json.autoRouting === 'object') {
          const ar: AutoRoutingConfig = {};
          if (typeof json.autoRouting.interactive === 'boolean') ar.interactive = json.autoRouting.interactive;
          if (typeof json.autoRouting.chat === 'boolean') ar.chat = json.autoRouting.chat;
          if (typeof json.autoRouting.telegram === 'boolean') ar.telegram = json.autoRouting.telegram;
          if (typeof json.autoRouting.daemon === 'boolean') ar.daemon = json.autoRouting.daemon;
          config.autoRouting = ar;
        }

        if (json.daemon && typeof json.daemon === 'object') {
          const daemon: {
            task?: string;
            taskId?: string;
            worktreePrune?: {
              enabled: boolean;
              cron: string;
              maxAgeDaysClean: number;
              maxAgeDaysDirty: number;
              scope: string;
            };
          } = {};
          if (typeof json.daemon.task === 'string') {
            daemon.task = json.daemon.task;
          }
          if (typeof json.daemon.taskId === 'string') {
            daemon.taskId = json.daemon.taskId;
          }
          const wp = json.daemon.worktreePrune;
          if (wp && typeof wp === 'object') {
            daemon.worktreePrune = {
              enabled: typeof wp.enabled === 'boolean' ? wp.enabled : true,
              cron: typeof wp.cron === 'string' ? wp.cron : '0 4 * * *',
              maxAgeDaysClean: typeof wp.maxAgeDaysClean === 'number' ? wp.maxAgeDaysClean : 14,
              maxAgeDaysDirty: typeof wp.maxAgeDaysDirty === 'number' ? wp.maxAgeDaysDirty : 30,
              scope: typeof wp.scope === 'string' ? wp.scope : 'all',
            };
          }
          config.daemon = daemon;
        }

        if (json.telegram && typeof json.telegram === 'object') {
          const telegram: NonNullable<ConfigFileSchema['telegram']> = {};
          const notify = json.telegram.notify;
          if (notify && typeof notify === 'object') {
            const parsed: NonNullable<NonNullable<ConfigFileSchema['telegram']>['notify']> = {};
            if (notify.mode === 'primary' || notify.mode === 'broadcast' || notify.mode === 'custom') {
              parsed.mode = notify.mode;
            }
            if (typeof notify.primaryChatId === 'number' && Number.isFinite(notify.primaryChatId)) {
              parsed.primaryChatId = notify.primaryChatId;
            }
            if (Array.isArray(notify.targets)) {
              const targets = notify.targets.filter(
                (t): t is number => typeof t === 'number' && Number.isFinite(t),
              );
              if (targets.length > 0) parsed.targets = targets;
            }
            telegram.notify = parsed;
          }
          config.telegram = telegram;
        }

        if (json.updatePolicy && ['notify', 'auto', 'off'].includes(json.updatePolicy)) {
          config.updatePolicy = json.updatePolicy as 'notify' | 'auto' | 'off';
        }

        if (typeof json.autoResumeOnUsageLimit === 'boolean') {
          config.autoResumeOnUsageLimit = json.autoResumeOnUsageLimit;
        }

        if (typeof json.bgSummaries === 'boolean') {
          config.bgSummaries = json.bgSummaries;
        }

        if (typeof json.maxSummaryCallsPerSession === 'number') {
          // Clamp to [1, 500] — prevents runaway API spend from misconfigured values.
          config.maxSummaryCallsPerSession = Math.min(500, Math.max(1, json.maxSummaryCallsPerSession));
        }

        // Pass hooks through as-is (the hooks loader validates it fully).
        if (json.hooks !== null && typeof json.hooks === 'object' && !Array.isArray(json.hooks)) {
          config.hooks = json.hooks as RawHooksConfig;
        }

        if (typeof json.enableShellHooks === 'boolean') {
          config.enableShellHooks = json.enableShellHooks;
        }

        // Security: `importFrom` is a user-global-only trust grant — it lets AFK
        // live-read/execute another tool's assets (see loadImportFromConfig). A
        // project-local afk.config.json must NOT be able to set it, so honor it
        // only from the user-global / legacy config, never `<cwd>/afk.config.json`.
        //
        // Note: `config.importFrom` is exposed on `CliConfig` for completeness and
        // inspection (e.g. `--dump-prompt` tooling), but runtime asset scanners
        // deliberately call `loadImportFromConfig()` directly — the agent layer
        // cannot import from `src/cli/` without a circular-dependency violation.
        // The project-local exclusion guard below is intentional defense-in-depth
        // that mirrors `loadImportFromConfig`'s own user-global-only path restriction.
        if (configPath !== join(process.cwd(), 'afk.config.json')) {
          const importFrom = parseImportFromConfig(json.importFrom);
          if (importFrom !== undefined) {
            config.importFrom = importFrom;
          }
        }

        if (json.interactive && typeof json.interactive === 'object') {
          const interactive: NonNullable<CliConfig['interactive']> = {};
          if (typeof json.interactive.worktreeAutoname === 'boolean') {
            interactive.worktreeAutoname = json.interactive.worktreeAutoname;
          }
          if (typeof json.interactive.worktreeBranchPrefix === 'string') {
            // Validate at config-read time — the value is concatenated into
            // a `git worktree add -b <prefix><slug>` invocation, so a value
            // starting with `--` or containing shell metacharacters would
            // turn an attacker-writable JSON file into a CLI-flag injection.
            // Allowlist matches `AFK_WORKTREE_BRANCH_PREFIX` env handling.
            interactive.worktreeBranchPrefix = validateBranchPrefix(
              json.interactive.worktreeBranchPrefix,
              `${configPath}#/interactive/worktreeBranchPrefix`,
            );
          }
          if (
            typeof json.interactive.worktreeBase === 'string' &&
            json.interactive.worktreeBase.trim().length > 0
          ) {
            // Validate at config-read time — the value is spliced into
            // `git fetch` / `git rev-parse` / `git worktree add` invocations,
            // so a value starting with `-` could be parsed by git as a flag.
            validateBaseRef(
              json.interactive.worktreeBase,
              `${configPath}#/interactive/worktreeBase`,
            );
            interactive.worktreeBase = json.interactive.worktreeBase;
          }
          if (typeof json.interactive.suggestGhost === 'boolean') {
            interactive.suggestGhost = json.interactive.suggestGhost;
          }
          if (Object.keys(interactive).length > 0) {
            config.interactive = interactive;
          }
        }

        jsonConfigCache = { config, sourcePath: configPath, modelsPartial };
        return jsonConfigCache;
      } catch (error) {
        console.error(`Warning: Failed to parse ${configPath}:`, error);
      }
    }
  }

  jsonConfigCache = { config: {}, sourcePath: undefined, modelsPartial: {} };
  return jsonConfigCache;
}

/**
 * Try to load a system prompt from `AFK.md`.
 *
 * Search order (first non-empty file wins):
 *   1. `<cwd>/AFK.md`   — project-scope
 *   2. `$AFK_HOME/AFK.md` (default `~/.afk/AFK.md`) — user-scope
 *
 * Returns `{ content, path }` with trimmed content, or `null` when no
 * readable non-empty `AFK.md` exists. Empty / whitespace-only files are
 * treated as absent so an accidental blank file doesn't silently wipe the
 * system prompt.
 *
 * Memoized via `afkMdCache` — see the cache block above `loadJsonConfig`
 * for the invalidation contract.
 */
function loadAfkMd(): { content: string; path: string } | null {
  if (afkMdCache !== undefined) return afkMdCache.value;
  const candidates = [
    join(process.cwd(), 'AFK.md'),
    join(getAfkHome(), 'AFK.md'),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const content = readFileSync(p, 'utf-8').trim();
      if (content.length > 0) {
        afkMdCache = { value: { content, path: p } };
        return afkMdCache.value;
      }
    } catch {
      // skip unreadable files
    }
  }
  afkMdCache = { value: null };
  return afkMdCache.value;
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
