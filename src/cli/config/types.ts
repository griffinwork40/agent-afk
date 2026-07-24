// Contract: shared type declarations + compile-time defaults for the CLI
// config loader family (#368 split). This module is types + constants only —
// no I/O, no caches. The three tier loaders (`env-tier.ts`, `json-tier.ts`,
// `afk-md-tier.ts`) and the `config.ts` facade all import from here; nothing
// in this module imports a tier, so it can never participate in a cycle.
// External consumers keep importing these symbols from `./config.js` — the
// facade re-exports everything public verbatim.

import type { ModelSlots } from '../../agent/session/model-slots.js';
import type { AgentModelInput } from '../../agent/types.js';
import type { PermissionMode } from '../../agent/types/sdk-types.js';
import type { RawHooksConfig } from '../../agent/hooks/config-loader.js';
import type { ImportFromConfig, ImportSourceBinary } from '../../config/import-sources.js';

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
  /**
   * Session permission mode. Sourced from afk.config.json `permissionMode`.
   * `'bypassPermissions'` disables path containment + the path-approval prompt
   * (the agent reads/writes anywhere). Defaults to `'default'` at the session
   * layer when unset. Validated on load — invalid strings are ignored.
   */
  permissionMode?: PermissionMode;
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
    /**
     * Daemon-surface "Done" verification gate (opt-in; default off when
     * omitted). When true, a cron-tick completion push whose response
     * self-certifies `Done` is relabelled "⚠️ Done (unverified)" (with a caveat
     * line) unless the tick produced corroborating evidence — a successful file
     * write/edit or executed command (see `doneHasCorroboratingEvidence` in
     * `commands/interactive/afk-push.ts`). The daemon analog of
     * `telegram.verifyDone` (which is REPL-only): the daemon is single-turn-per-
     * tick, so the only honest enforcement is relabelling the outgoing push, not
     * bouncing a next turn. Off ⇒ the push is byte-identical to today.
     */
    verifyDone?: boolean;
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
    /**
     * AFK-mode "Done" verification gate (opt-in; default off when omitted). When
     * true, a terminal-state push whose kind is `Done` is relabelled
     * "⚠️ Done (unverified)" unless the turn produced corroborating evidence — a
     * successful file write/edit or executed command (see
     * `doneHasCorroboratingEvidence` in `afk-push.ts`). Keeps the "get pinged
     * when it finishes" notification honest without blocking the turn.
     */
    verifyDone?: boolean;
    /**
     * Per-chat "tag-only" response policy (opt-in; default: bot answers every
     * non-command message in every allowlisted chat). For each chat ID listed
     * here, the bot responds to a non-command text/photo message ONLY when it is
     * addressed to the bot — i.e. the message replies to one of the bot's own
     * messages, @mentions the bot's username, or carries a `text_mention` entity
     * resolving to the bot's id. Slash-commands are unaffected. Chats not listed
     * behave exactly as before.
     *
     * Requires Telegram privacy mode to be OFF for the bot (via @BotFather →
     * /setprivacy → Disable) so that non-addressed group messages are actually
     * delivered to the bot; otherwise Telegram never sends them and the policy is
     * moot. Env override: `AFK_TELEGRAM_TAG_ONLY_CHAT_IDS` (config value wins).
     */
    tagOnlyChats?: number[];
    /**
     * Named-chat aliases for outbound targeting. Maps a human-friendly name
     * (e.g. `"ops"`, `"family"`) to a Telegram chat ID. Consulted when a
     * caller targets a specific chat by name — the `send_telegram` tool's
     * `chat` param and a scheduled task's `notifyChat` both accept an alias
     * from this map in place of a raw numeric ID. Strictly additive: when a
     * caller omits an explicit target, aliases are never consulted and routing
     * is unchanged (see `resolveConfiguredNotifyTargets`). An explicitly-targeted
     * send must still resolve to an allowlisted chat ID (fail-closed) — see
     * `isChatAllowed` in `src/telegram/allowlist.ts`.
     */
    chatAliases?: Record<string, number>;
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
    /**
     * Persistent default for how the interactive REPL renders extended-thinking
     * blocks: `'summary' | 'live' | 'digest' | 'off'`. Display-only — never
     * changes whether thinking runs (cost/latency unaffected).
     *
     * Env override: `AFK_THINKING_UI`. CLI override: `--thinking-ui`.
     * Precedence: CLI flag > env > this config value > `'live'`.
     * Runtime-mutable per session via the `/thinking` slash command.
     */
    thinkingUi?: 'summary' | 'live' | 'digest' | 'off';
  };
  updatePolicy: 'notify' | 'auto' | 'off';
  /**
   * TUI color palette: `'dark' | 'light' | 'auto'`. Display-only — swaps the
   * semantic color palette, never behavior. Left undefined unless explicitly
   * set, so it ranks BELOW `AFK_THEME` in precedence (a defaulted value would
   * masquerade as a deliberate user choice and wrongly beat the env var).
   * Env override: `AFK_THEME`. CLI override: `--theme`.
   * Precedence: `--theme` flag > env > this config value > auto-detect > dark.
   * Runtime-mutable per session via the `/theme` slash command.
   */
  theme?: 'dark' | 'light' | 'auto';
  /**
   * When true (the default), the CLI auto-waits for the OAuth subscription
   * reset and replays the failed turn rather than surfacing a raw 429 error.
   * Propagated to `AgentConfig.autoResumeOnUsageLimit`.
   */
  autoResumeOnUsageLimit?: boolean;
  /**
   * AFK-mode terminal-state enforcement gate (opt-in; default off when omitted).
   * When true, in autonomous mode a turn that self-certifies `Done` with no
   * corroborating evidence — a successful file write/edit or executed command
   * (see `doneHasCorroboratingEvidence` in `afk-push.ts`) — gets a framework
   * correction injected into the NEXT turn, which must substantiate or downgrade
   * the claim (issue #237). Human-tier: a self-honesty check the agent must not
   * disable on its own config (same rationale as `telegram.verifyDone`). The
   * sibling `telegram.verifyDone` only relabels the Telegram push; this one
   * bounces the turn.
   */
  enforceDoneEvidence?: boolean;
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
   * User-global trust gate for Claude Code plugin-contributed hooks
   * (`<plugin>/hooks/hooks.json`). Independent of `enableShellHooks`. Human-tier
   * (the agent's `config_set` cannot flip it). See
   * `src/agent/hooks/config-loader.ts`.
   */
  enablePluginHooks?: boolean;
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
export interface ModelSlotConfigEntry {
  id?: string;
  name?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
}

export interface ConfigFileSchema {
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
  /** Session permission mode (validated on load): default | plan | autonomous | bypassPermissions. */
  permissionMode?: string;
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
    verifyDone?: boolean;
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
    /** Opt-in AFK "Done" verification gate; default off. See `CliConfig.telegram.verifyDone`. */
    verifyDone?: boolean;
    /** Opt-in per-chat "tag-only" response policy. See `CliConfig.telegram.tagOnlyChats`. */
    tagOnlyChats?: number[];
    /** Named-chat aliases for outbound targeting. See `CliConfig.telegram.chatAliases`. */
    chatAliases?: Record<string, number>;
  };
  interactive?: {
    worktreeAutoname?: boolean;
    worktreeBranchPrefix?: string;
    worktreeBase?: string;
    suggestGhost?: boolean;
    thinkingUi?: 'summary' | 'live' | 'digest' | 'off';
  };
  updatePolicy?: 'notify' | 'auto' | 'off';
  /** TUI color palette (validated on load): dark | light | auto. See `CliConfig.theme`. */
  theme?: 'dark' | 'light' | 'auto';
  autoResumeOnUsageLimit?: boolean;
  /** Opt-in AFK terminal-state enforcement gate; default off. See `CliConfig.enforceDoneEvidence`. */
  enforceDoneEvidence?: boolean;
  bgSummaries?: boolean;
  maxSummaryCallsPerSession?: number;
  hooks?: RawHooksConfig;
  enableShellHooks?: boolean;
  enablePluginHooks?: boolean;
  /**
   * Cross-tool asset import. Each known source binary maps to either a bare
   * `true` (shorthand: import all asset types) or an object with per-asset
   * toggles. Normalized by `parseImportFromConfig`.
   */
  importFrom?: Partial<
    Record<ImportSourceBinary, boolean | { plugins?: boolean; skills?: boolean; mcp?: boolean }>
  >;
}

export const DEFAULT_CONFIG: Omit<CliConfig, 'apiKey'> = {
  model: 'sonnet',
  maxTokens: 4096,
  temperature: 1.0,
  updatePolicy: 'notify',
};

/**
 * Invariant: the CLI-surface default permission mode. When `afk.config.json`
 * sets no `permissionMode`, the human-driven CLI surfaces (`afk chat` and
 * `afk interactive`) start in `bypassPermissions` — path containment and the
 * path-approval prompt are OFF, so the agent reads/writes anywhere with no
 * confirmation. This is the new-install default and it persists every session
 * until the operator changes it (`afk config set permissionMode default`, a
 * `permissionMode` key in afk.config.json, `--dangerously-skip-permissions`, or
 * the live `/bypass` toggle).
 *
 * Scope is deliberately narrow: this default lives at the loadConfig() layer,
 * which only `afk chat` + `afk interactive` consume via `cliConfig.permissionMode`.
 * The deeper session-layer fallback stays `'default'` (see
 * `src/agent/session/session-setup.ts`) so Telegram (which omits permissionMode
 * and relies on hook-based enforcement), embedded/library `AgentSession` use, and
 * subagents that inherit no explicit mode all remain contained. The daemon sets
 * `bypassPermissions` explicitly and is unaffected.
 */
export const DEFAULT_CLI_PERMISSION_MODE: PermissionMode = 'bypassPermissions';
