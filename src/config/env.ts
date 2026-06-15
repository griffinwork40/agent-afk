/**
 * Centralized environment-variable registry and read-point.
 *
 * Every `process.env[...]` access in `src/` outside this file is a CI failure
 * (enforced by `scripts/audit-env-access.ts`, gated in `.github/workflows/ci.yml`).
 * The audit script maintains a tiny allowlist for legitimate dynamic-access call
 * sites (envvar loops, child-process env forwarding); see `AUDIT_ALLOWLIST` in
 * that script for the canonical list with rationale.
 *
 * ## Why this exists
 *
 * `agent-afk` reads ~70 distinct env vars across ~50 files. Before this module
 * landed, those reads were scattered raw `process.env['AFK_X']` calls with no
 * source of truth, no machine-readable catalogue, and no path to runtime
 * validation. This module fixes all three at once:
 *
 *   - `env` object: typed lazy getters, one per var. `env.AFK_MODEL` replaces
 *     `process.env['AFK_MODEL']` at every call site.
 *   - `ENV_REGISTRY`: typed metadata array consumed by `pnpm scan:env` (renders
 *     `docs/env-registry.{json,md}`) and `/doctor` (warns on missing required
 *     vars at startup).
 *   - Audit gate: CI fails if a new direct `process.env` read sneaks in.
 *
 * ## Lazy getters, raw strings
 *
 * Getters re-read `process.env` on every access — no caching layer. Two reasons:
 *
 *   1. Tests mutate `process.env` per-case via `beforeEach`. Eager constants
 *      would freeze test state at import time.
 *   2. `dotenv` loads inside `loadConfig()`, which runs AFTER module import.
 *      Eager reads would see undefined for any var sourced from `~/.afk/config/afk.env`.
 *
 * Getters return raw `string | undefined`. Parsing (`parseInt`, `=== '1'`, etc.)
 * stays at call sites for now — this keeps migration purely mechanical. A future
 * refactor can wrap each getter in a zod schema; that's a single-file change
 * here and orthogonal to call-site code.
 *
 * ## Adding a new env var
 *
 *   1. Add a getter to the `env` object.
 *   2. Add a matching entry to `ENV_REGISTRY` — name, description, type, required.
 *   3. The `env-registry.test.ts` test enforces that every getter has a registry
 *      entry and vice versa.
 *   4. Run `pnpm scan:env` to regenerate `docs/env-registry.{json,md}`.
 */

export type EnvVarType = 'string' | 'number' | 'boolean' | 'json';

export type EnvVarCategory =
  | 'model'
  | 'auth'
  | 'telegram'
  | 'paths'
  | 'debug'
  | 'daemon'
  | 'worktree'
  | 'mcp'
  | 'routing'
  | 'browser'
  | 'process'
  | 'misc';

export interface EnvVarMeta {
  readonly name: string;
  readonly description: string;
  readonly type: EnvVarType;
  readonly required: boolean;
  readonly default?: string;
  readonly example?: string;
  readonly category: EnvVarCategory;
  /**
   * When true, the var is read but no human-authored description exists yet.
   * Surfaced in `/doctor` and registry docs so contributors can backfill.
   */
  readonly describedTodo?: boolean;
  /**
   * When true, this var holds a credential (API key, bearer token, OAuth token).
   * Two enforcement effects:
   *   1. The corresponding getter on `env` is defined non-enumerable, so
   *      `JSON.stringify(env)`, `console.log(env)`, `Object.keys(env)`, and
   *      `for...in env` do NOT surface the value. Direct access (`env.X`)
   *      still works — this only blocks accidental serialization.
   *   2. Renderers MUST NOT publish an `example` value for secret entries —
   *      credential-format strings committed to git survive history forever
   *      and trigger downstream secret scanners.
   */
  readonly secret?: boolean;
}

/**
 * Canonical catalogue of every env var the runtime reads. Sorted alphabetically
 * by `name` to keep diffs readable. Mirror order in the `env` object below so
 * the file is easy to navigate by name.
 *
 * `describedTodo: true` marks entries that need a human-written description.
 * Backfill them as you touch the relevant code path.
 */
export const ENV_REGISTRY: readonly EnvVarMeta[] = [
  // ── Model / agent runtime ─────────────────────────────────────────────────
  {
    name: 'AFK_COMPACT_KEEP_LAST_TURNS',
    description: 'Number of recent turns the compactor keeps verbatim during /compact. Default tuned in compact-handler.ts.',
    type: 'number',
    required: false,
    example: '6',
    category: 'model',
  },
  {
    name: 'AFK_COMPACT_MODEL',
    description: 'Override the model used by the /compact summarizer. Falls back to a cheap default (haiku-class).',
    type: 'string',
    required: false,
    example: 'claude-haiku-4-5',
    category: 'model',
  },
  {
    name: 'AFK_DEFAULT_SUBAGENT_MODEL',
    description: 'Override the default model used when a subagent is dispatched without an explicit model.',
    type: 'string',
    required: false,
    example: 'sonnet',
    category: 'model',
  },
  {
    name: 'AFK_DIAGNOSE_BASELINE',
    description: 'Kill switch for /diagnose reproducer baseline execution. When set to \'0\', the /diagnose skill skips executing the detected reproducer command for a ground-truth baseline; default enabled (runs). Set to \'0\' to disable.',
    type: 'boolean',
    required: false,
    default: '1',
    example: '0',
    category: 'debug',
  },
  {
    name: 'AFK_DISABLE_PROMPT_CACHE',
    description: 'Disable Anthropic prompt caching when set to 1/true/yes/on. Unset = caching enabled.',
    type: 'boolean',
    required: false,
    default: '0',
    example: '1',
    category: 'model',
  },
  {
    name: 'AFK_EFFORT',
    description: 'Effort hint guiding adaptive-thinking depth, forwarded as Anthropic output_config.effort (model-gated; ignored where unsupported). Accepts low | medium | high | xhigh | max.',
    type: 'string',
    required: false,
    example: 'medium',
    category: 'model',
  },
  {
    name: 'AFK_MAX_BUDGET_USD',
    description: 'Per-turn USD budget ceiling. Aborts the turn when projected spend would exceed this.',
    type: 'number',
    required: false,
    default: '5.00',
    example: '10.00',
    category: 'model',
  },
  {
    name: 'AFK_MAX_OUTPUT_TOKENS',
    description: 'Cap on output tokens per turn. Falls back to provider default when unset.',
    type: 'number',
    required: false,
    example: '8192',
    category: 'model',
  },
  {
    name: 'AFK_MAX_TOKENS',
    description: 'Cap on total tokens per turn (input + output). Default 4096.',
    type: 'number',
    required: false,
    default: '4096',
    example: '8192',
    category: 'model',
  },
  {
    name: 'AFK_MODEL',
    description: 'Default model for agent turns. Accepts slot names (small, medium, large), legacy aliases (opus, sonnet, haiku), the fixed-id fable alias (Claude Fable 5), or full model IDs.',
    type: 'string',
    required: false,
    default: 'sonnet',
    example: 'claude-opus-4-5',
    category: 'model',
  },
  {
    name: 'AFK_MODEL_LARGE',
    description: 'Bind the "large" capability tier (most capable) to a model id/alias. Overrides afk.config.json models.large.',
    type: 'string',
    required: false,
    example: 'claude-opus-4-8',
    category: 'model',
  },
  {
    name: 'AFK_MODEL_LARGE_API_KEY',
    description: 'Per-slot API key for the "large" tier (Stage 2). Overrides global credentials for this tier only.',
    type: 'string',
    required: false,
    category: 'model',
    secret: true,
  },
  {
    name: 'AFK_MODEL_LARGE_BASE_URL',
    description: 'Per-slot endpoint base URL for the "large" tier (Stage 2). Anthropic Messages base or OpenAI-compatible base per the tier provider.',
    type: 'string',
    required: false,
    example: 'http://localhost:8080/v1',
    category: 'model',
  },
  {
    name: 'AFK_MODEL_MEDIUM',
    description: 'Bind the "medium" capability tier (general-use) to a model id/alias. Overrides afk.config.json models.medium.',
    type: 'string',
    required: false,
    example: 'claude-sonnet-4-6',
    category: 'model',
  },
  {
    name: 'AFK_MODEL_MEDIUM_API_KEY',
    description: 'Per-slot API key for the "medium" tier (Stage 2). Overrides global credentials for this tier only.',
    type: 'string',
    required: false,
    category: 'model',
    secret: true,
  },
  {
    name: 'AFK_MODEL_MEDIUM_BASE_URL',
    description: 'Per-slot endpoint base URL for the "medium" tier (Stage 2). Anthropic Messages base or OpenAI-compatible base per the tier provider.',
    type: 'string',
    required: false,
    example: 'http://localhost:8080/v1',
    category: 'model',
  },
  {
    name: 'AFK_MODEL_SMALL',
    description: 'Bind the "small" capability tier (cheap/fast) to a model id/alias. Overrides afk.config.json models.small.',
    type: 'string',
    required: false,
    example: 'gpt-4o-mini',
    category: 'model',
  },
  {
    name: 'AFK_MODEL_SMALL_API_KEY',
    description: 'Per-slot API key for the "small" tier (Stage 2). Overrides global credentials for this tier only.',
    type: 'string',
    required: false,
    category: 'model',
    secret: true,
  },
  {
    name: 'AFK_MODEL_SMALL_BASE_URL',
    description: 'Per-slot endpoint base URL for the "small" tier (Stage 2). Anthropic Messages base or OpenAI-compatible base per the tier provider.',
    type: 'string',
    required: false,
    example: 'http://localhost:8080/v1',
    category: 'model',
  },
  {
    name: 'AFK_PROMPT_CACHE_TTL',
    description: 'TTL for Anthropic prompt-cache blocks. Accepts 5m or 1h.',
    type: 'string',
    required: false,
    default: '1h',
    example: '1h',
    category: 'model',
  },
  {
    name: 'AFK_SUGGEST_ENABLED',
    description: 'Enable the LLM-backed ghost-text suggestion tier in the interactive REPL. Set to 1/true/yes/on to activate. Off by default.',
    type: 'boolean',
    required: false,
    category: 'model',
  },
  {
    name: 'AFK_SUGGEST_GHOST',
    description: 'Enable REPL ghost-text inline suggestions (Tier-1 history/dropdown + optional Tier-2 LLM). 1 = on (default), 0 = off. Set 0/false/off/no to disable all ghost text. Tier-2 LLM is separately gated by AFK_SUGGEST_ENABLED.',
    type: 'boolean',
    required: false,
    default: '1',
    example: '0',
    category: 'model',
  },
  {
    name: 'AFK_SUGGEST_MODEL',
    description: 'Override the small model used for REPL ghost-text suggestions. Falls back to AFK_COMPACT_MODEL or haiku-class for anthropic, or the session model for other providers.',
    type: 'string',
    required: false,
    category: 'model',
  },
  {
    name: 'AFK_TASK_BUDGET',
    description: 'Per-task token budget ceiling. Aborts when cumulative usage would exceed it.',
    type: 'number',
    required: false,
    default: '100000',
    example: '200000',
    category: 'model',
  },
  {
    name: 'AFK_TEMPERATURE',
    description: 'Numeric temperature override for model sampling. Provider default if unset.',
    type: 'number',
    required: false,
    example: '0.7',
    category: 'model',
  },
  {
    name: 'AFK_THINKING',
    description: 'Extended-thinking mode. Accepts adaptive | disabled | enabled:<N> | enabled:max. Defaults to the model-appropriate mode when unset (adaptive on current models).',
    type: 'string',
    required: false,
    default: 'adaptive',
    example: 'adaptive',
    category: 'model',
  },
  {
    name: 'AFK_TIMEOUT_MS',
    description: 'Per-turn timeout in milliseconds. Provider/SDK default if unset.',
    type: 'number',
    required: false,
    example: '120000',
    category: 'model',
  },
  {
    name: 'CLAUDE_MODEL',
    description: 'Legacy alias for AFK_MODEL — supported for back-compat with pre-AFK_* deployments.',
    type: 'string',
    required: false,
    example: 'sonnet',
    category: 'model',
  },

  // ── System prompt ─────────────────────────────────────────────────────────
  {
    name: 'AFK_SYSTEM_PROMPT',
    description: 'Raw operator-overlay prompt. Highest-priority overlay (over afk.config.json and AFK.md). Appended on top of the framework base (prompts/system-prompt.md) under an "# Operator configuration" header — it augments, never replaces, the base.',
    type: 'string',
    required: false,
    example: 'You are a helpful agent.',
    category: 'model',
  },
  {
    name: 'AFK_DUMP_PROMPT',
    description: 'Write the resolved system prompt to a file at startup. Accepts a path or 1 for default location.',
    type: 'string',
    required: false,
    example: '/tmp/afk-prompt.txt',
    category: 'debug',
  },

  // ── Auth / external APIs ──────────────────────────────────────────────────
  {
    name: 'ANTHROPIC_API_KEY',
    description: 'Anthropic API key. Tier-1 credential — overrides keychain OAuth and CLAUDE_CODE_OAUTH_TOKEN.',
    type: 'string',
    required: false,
    category: 'auth',
    secret: true,
  },
  {
    name: 'CLAUDE_CODE_OAUTH_TOKEN',
    description: 'Claude Code OAuth token. Tier-2 credential — used when ANTHROPIC_API_KEY is unset; falls back to keychain.',
    type: 'string',
    required: false,
    category: 'auth',
    secret: true,
  },
  {
    name: 'OPENAI_API_KEY',
    description: 'OpenAI API key for the openai-compatible provider (gpt-*, o1*, o3*, o4* models).',
    type: 'string',
    required: false,
    category: 'auth',
    secret: true,
  },
  {
    name: 'CODEX_API_KEY',
    description: 'Fallback OpenAI API key for the openai-compatible provider, read after OPENAI_API_KEY. Legacy name from the removed @openai/codex-sdk integration — prefer OPENAI_API_KEY.',
    type: 'string',
    required: false,
    category: 'auth',
    secret: true,
  },
  {
    name: 'AFK_LOCAL_API_KEY',
    description: 'Placeholder API key for local Anthropic-compatible servers (vllm-mlx, etc.). Set when AFK_LOCAL_BASE_URL is configured.',
    type: 'string',
    required: false,
    default: 'local',
    example: 'local',
    category: 'auth',
    secret: true,
  },
  {
    name: 'AFK_LOCAL_BASE_URL',
    description: 'Base URL for a self-hosted Anthropic-compatible server. When set, routes traffic away from api.anthropic.com.',
    type: 'string',
    required: false,
    example: 'http://127.0.0.1:8080',
    category: 'model',
  },
  {
    name: 'AFK_OPENAI_BASE_URL',
    description: 'Base URL override for the OpenAI-compatible provider. Used for local shims (mlx_lm.server, Ollama, vLLM, LM Studio). The OpenAI SDK appends `/chat/completions` itself — a value ending in `/chat/completions` will be stripped at config-load time with a one-shot warning.',
    type: 'string',
    required: false,
    example: 'http://127.0.0.1:8000/v1',
    category: 'model',
  },
  {
    name: 'AFK_OPENAI_USE_RESPONSES',
    description: 'Opt the OpenAI-compatible provider into the OpenAI Responses API instead of Chat Completions for API-key sessions. Truthy values: 1, true, yes, on. The ChatGPT-subscription OAuth path uses Responses automatically regardless of this flag.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'model',
  },
  {
    name: 'AFK_OPENAI_CHATGPT_OAUTH',
    description: 'Opt into using ChatGPT-subscription OAuth credentials from ~/.codex/auth.json (auth_mode: chatgpt) as OpenAI provider auth. Off by default. READ-ONLY: AFK never refreshes these tokens — re-run `codex` when the access token expires. Routes requests over the Responses API to the private ChatGPT backend (chatgpt.com/backend-api).',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'model',
  },
  {
    name: 'AFK_PROVIDER',
    description: 'Force provider selection (anthropic | anthropic-direct | openai | openai-compatible | openai-codex). Overrides the model-name heuristic. Same surface as the --provider CLI flag; CLI flag wins when both are set.',
    type: 'string',
    required: false,
    example: 'openai-compatible',
    category: 'model',
  },
  {
    name: 'EXA_API_KEY',
    description: 'Exa (exa.ai) search API key, enabling web_scrape search mode. Free tier (20k requests/month) available at https://exa.ai. When unset, search mode returns an actionable error; markdown and raw modes are unaffected.',
    type: 'string',
    required: false,
    category: 'auth',
    secret: true,
  },

  // ── Telegram ──────────────────────────────────────────────────────────────
  {
    name: 'TELEGRAM_BOT_TOKEN',
    description: 'Telegram bot token from @BotFather. Required to run the Telegram bot surface.',
    type: 'string',
    required: false, // Required only when running the bot; not for `afk chat`.
    category: 'telegram',
    secret: true,
  },
  {
    name: 'AFK_TELEGRAM_BOT_TOKEN',
    description: 'Alternative env var name for the Telegram bot token, accepted by the setup wizard.',
    type: 'string',
    required: false,
    category: 'telegram',
    secret: true,
  },
  {
    name: 'AFK_TELEGRAM_ALLOWED_CHAT_IDS',
    description: 'Comma-separated list of Telegram chat IDs allowed to interact with the bot. Required when the bot is running.',
    type: 'string',
    required: false,
    example: '123456789,987654321',
    category: 'telegram',
  },
  {
    name: 'AFK_TELEGRAM_PRIMARY_CHAT_ID',
    description: 'Default chat ID for outbound notifications (primary-mode routing). When unset, notifications go to the first private/DM chat in AFK_TELEGRAM_ALLOWED_CHAT_IDS. The afk.config.json telegram.notify block takes precedence.',
    type: 'string',
    required: false,
    example: '123456789',
    category: 'telegram',
  },
  {
    name: 'AFK_TELEGRAM_NOTIFY_MODE',
    description: 'Outbound notification fan-out: primary (default — one chat), broadcast (every allowed chat), or custom (afk.config.json telegram.notify.targets). The afk.config.json telegram.notify.mode takes precedence.',
    type: 'string',
    required: false,
    example: 'broadcast',
    category: 'telegram',
  },
  {
    name: 'TELEGRAM_DATA_DIR',
    description: 'Override the directory where Telegram bot state is stored. Defaults to ~/.afk/state/telegram/.',
    type: 'string',
    required: false,
    category: 'telegram',
  },
  {
    name: 'TELEGRAM_VERBOSE',
    description: 'Set to 1 to log per-message details from the Telegram bot — chat IDs, message text, latency.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'telegram',
  },
  {
    name: 'AFK_TELEGRAM_TRACE',
    description: 'Set to 1 to dump raw bridge traffic between the agent and the Telegram bot — debugging only.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'debug',
  },
  {
    name: 'AFK_TELEGRAM_CWD',
    description: 'Override the working directory used by the Telegram bot when spawning agent sessions.',
    type: 'string',
    required: false,
    category: 'telegram',
  },

  // ── Paths / state ─────────────────────────────────────────────────────────
  {
    name: 'AFK_HOME',
    description: 'Override the AFK home directory. Default: ~/.afk/.',
    type: 'string',
    required: false,
    default: '~/.afk',
    example: '/opt/afk',
    category: 'paths',
  },
  {
    name: 'AFK_STATE_DIR',
    description: 'Override the entire AFK state tier (sessions/, todos/, transcripts/, memory/, daemon/, etc.), not just one subdirectory. Must be an absolute path (not /). Default: $AFK_HOME/state/.',
    type: 'string',
    required: false,
    category: 'paths',
  },
  {
    name: 'AFK_FRAMEWORK_DIR',
    description: 'Override the AFK agent-framework directory used for telemetry and briefs. Default: $AFK_HOME/agent-framework/.',
    type: 'string',
    required: false,
    category: 'paths',
  },
  {
    name: 'HOME',
    description: 'Standard Unix home directory. Used as the fallback when AFK_HOME is unset.',
    type: 'string',
    required: false,
    category: 'process',
  },
  {
    name: 'PATH',
    description: 'System PATH. Read for executable resolution (git, gh, etc.) in tool handlers.',
    type: 'string',
    required: false,
    category: 'process',
  },

  // ── Daemon ────────────────────────────────────────────────────────────────
  {
    name: 'AFK_DAEMON_CWD',
    description: 'Working directory used by the daemon process for spawned agent sessions.',
    type: 'string',
    required: false,
    category: 'daemon',
  },
  {
    name: 'AFK_DAEMON_TASK',
    description: 'Default task description for the daemon. Falls back to afk.config.json daemon.task.',
    type: 'string',
    required: false,
    category: 'daemon',
  },
  {
    name: 'AFK_DAEMON_TASK_ID',
    description: 'Task identifier the daemon uses to scope its state directory and telemetry.',
    type: 'string',
    required: false,
    category: 'daemon',
  },
  {
    name: 'AFK_DAEMON_HOST',
    description: 'Bind address for the daemon control HTTP surface. Defaults to 127.0.0.1 (loopback only). The control surface is unauthenticated, so bind a non-loopback address such as 0.0.0.0 only on a trusted or firewalled network. Overridden by the --host flag.',
    type: 'string',
    required: false,
    category: 'daemon',
  },
  {
    name: 'AFK_SESSIONSTART_COOLDOWN_MS',
    description: 'Cooldown in milliseconds between SessionStart trigger fires in the daemon. Prevents thundering-herd on rapid restarts.',
    type: 'number',
    required: false,
    category: 'daemon',
  },

  // ── Worktree management ───────────────────────────────────────────────────
  {
    name: 'AFK_WORKTREE_AUTONAME',
    description: 'Auto-rename worktree branches based on the first user message in interactive mode. 1 = on (default), 0 = off.',
    type: 'boolean',
    required: false,
    default: '1',
    example: '0',
    category: 'worktree',
  },
  {
    name: 'AFK_WORKTREE_BRANCH_PREFIX',
    description: 'Branch-name prefix for AFK-managed worktrees. Default afk/. Set to empty string to drop the prefix.',
    type: 'string',
    required: false,
    default: 'afk/',
    example: 'wt/',
    category: 'worktree',
  },
  {
    name: 'AFK_WORKTREE_BASE',
    description: 'Override the base git ref for worktrees created with --worktree. By default AFK bases worktrees on the remote\'s default branch (e.g. origin/main), fetched fresh. Set this to pin a different ref, or to HEAD to base on the local checkout. Overridden per-session by --worktree-base.',
    type: 'string',
    required: false,
    example: 'origin/main',
    category: 'worktree',
  },
  {
    name: 'AFK_WORKTREE_BOOT_PRUNE',
    description: 'When set, the daemon prunes stale worktrees at boot in addition to the cron-driven sweep.',
    type: 'boolean',
    required: false,
    category: 'worktree',
  },
  {
    name: 'AFK_WORKTREE_PRUNE_DISABLE',
    description: 'Disable the worktree prune job entirely. Useful for long-running tests.',
    type: 'boolean',
    required: false,
    category: 'worktree',
  },
  {
    name: 'AFK_WORKTREE_MAX_AGE_CLEAN',
    description: 'Maximum age (in days) before a clean worktree is auto-pruned. Default 14.',
    type: 'number',
    required: false,
    default: '14',
    category: 'worktree',
  },
  {
    name: 'AFK_WORKTREE_MAX_AGE_DIRTY',
    description: 'Maximum age (in days) before a dirty worktree is auto-pruned. Default 30.',
    type: 'number',
    required: false,
    default: '30',
    category: 'worktree',
  },
  {
    name: 'AFK_WORKTREE_SWEEP_ROOT',
    description: 'Override the root directory under which AFK worktrees are tracked for pruning.',
    type: 'string',
    required: false,
    category: 'worktree',
  },


  // ── MCP ───────────────────────────────────────────────────────────────────
  {
    name: 'AFK_ALLOW_PROJECT_MCP',
    description: 'Allow loading MCP configuration from <cwd>/.mcp.json. Disabled by default — opt-in to mitigate config-injection risks.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'mcp',
  },

  // ── Routing / behavior ────────────────────────────────────────────────────
  {
    name: 'AFK_AUTO_ROUTING',
    description: 'Auto-route bare slash inputs to matching skills. Applies to interactive, chat, telegram, and daemon surfaces.',
    type: 'boolean',
    required: false,
    example: 'true',
    category: 'routing',
  },
  {
    name: 'AFK_INTERNAL',
    description: 'Tier gate. Set to exactly `1` to unlock — only the literal string "1" unlocks (other truthy values like "true"/"yes" leave the tier locked). When unlocked, skills tagged `audience: \'internal\'` (e.g. /audit-fit, harvest/distill plugins) become visible at end-user surfaces (slash-command list, --help, tab-complete, system-prompt skill manifest). Default unset = public tier — internal skills are hidden. Not an access-control boundary; it gates surfacing, not the underlying registry.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'routing',
  },
  {
    name: 'AFK_SHELL_PASSTHROUGH',
    description:
      'Enable the interactive REPL `!cmd` / `!&cmd` shell-passthrough feature. On by default. Set to 0, false, off, or no (case-insensitive) to disable, so inputs beginning with ! are sent to the model as literal text instead of being executed as shell commands. Equivalent to the --no-shell-passthrough flag.',
    type: 'boolean',
    required: false,
    default: '1',
    example: '0',
    category: 'misc',
  },

  // ── UI / output ───────────────────────────────────────────────────────────
  {
    name: 'AFK_BANNER_PLAIN',
    description: 'Suppress the ANSI-colored banner at REPL startup. Useful for non-TTY captures and CI logs.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'misc',
  },
  {
    name: 'AFK_SPINNER_TIPS',
    description: 'Show rotating tips in the loading spinner during long calls. 1 = on, 0 = off.',
    type: 'boolean',
    required: false,
    category: 'misc',
  },
  {
    name: 'AFK_SHOW_DIFFS',
    description: 'Show inline diffs in the tool-lane output for edit/write tool calls. 1 = on, 0 = off.',
    type: 'boolean',
    required: false,
    category: 'misc',
  },
  {
    name: 'AFK_SKILL_STREAM_VERBOSE',
    description: 'Verbose streaming output when a skill is dispatched. Logs sub-agent setup, intermediate events, and final result.',
    type: 'boolean',
    required: false,
    category: 'debug',
  },
  {
    name: 'FORCE_COLOR',
    description: 'Standard Node convention. Force-enable ANSI color output even when stdout is not a TTY.',
    type: 'string',
    required: false,
    example: '1',
    category: 'process',
  },
  {
    name: 'NO_COLOR',
    description: 'Standard convention (https://no-color.org). When set to any non-empty value, disables ANSI color output.',
    type: 'string',
    required: false,
    example: '1',
    category: 'process',
  },

  // ── Debug / diagnostics ───────────────────────────────────────────────────
  {
    name: 'AFK_DEBUG',
    description: 'Enable verbose debug logging across the codebase. Accepts 1 to enable.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'debug',
  },
  {
    name: 'AFK_DEBUG_CLIPBOARD',
    description: 'Debug bracketed-paste and image-paste handling in the interactive REPL.',
    type: 'boolean',
    required: false,
    category: 'debug',
  },
  {
    name: 'AFK_DEBUG_COMPOSITOR',
    description: 'Gate compositor phase-boundary traces to stderr; any truthy value enables.',
    type: 'boolean',
    required: false,
    category: 'debug',
  },
  {
    name: 'AFK_TRACE_DISABLED',
    description: 'Disable the agent trace subsystem entirely. Set to 1 to skip trace file writes.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'debug',
  },
  {
    name: 'AFK_SESSION_LEDGER_DISABLED',
    description:
      'Disable the per-session durable event ledger (state/sessions/<id>/events.jsonl). ' +
      'Set to 1 to skip ledger writes; live cross-surface watching (e.g. the Telegram ' +
      '/watch command) will report no activity for sessions started while disabled.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'debug',
  },
  {
    name: 'DEBUG',
    description: 'Standard Node `debug`-package convention. When set to 1, enables verbose logging in several modules alongside AFK_DEBUG.',
    type: 'string',
    required: false,
    category: 'debug',
  },
  {
    name: 'AGENT_AFK_ASCII',
    description:
      'Force the interactive REPL tool-lane renderer to ASCII-only glyphs instead of the default Unicode box-drawing set. Accepts 1/true/yes (case-insensitive). Useful for terminals whose font lacks ┃├╰├ glyphs.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'debug',
  },

  // ── Process / runtime conventions ────────────────────────────────────────
  {
    name: 'AGENT_SURFACE',
    description: 'Internal surface marker propagated to subprocesses. Identifies which AFK surface (cli, telegram, daemon) spawned the process.',
    type: 'string',
    required: false,
    example: 'cli',
    category: 'process',
  },
  {
    name: 'CI',
    description: 'Standard CI-detection convention. Auto-set by GitHub Actions, CircleCI, etc. Used to switch off TTY-only UX.',
    type: 'string',
    required: false,
    example: 'true',
    category: 'process',
  },
  {
    name: 'NODE_ENV',
    description: 'Standard Node environment marker. test | development | production. Used by routing-telemetry.ts to suppress test-time writes.',
    type: 'string',
    required: false,
    example: 'production',
    category: 'process',
  },
  {
    name: 'VITEST',
    description: 'Set automatically by Vitest. Used at runtime to short-circuit code paths that should not fire in tests.',
    type: 'string',
    required: false,
    category: 'process',
  },
  {
    name: 'NO_UPDATE_NOTIFIER',
    description: 'Disable the update-available notifier on CLI startup. Standard convention shared with many Node CLIs.',
    type: 'boolean',
    required: false,
    category: 'process',
  },

  // ── Browser-control tools ────────────────────────────────────────────────
  {
    name: 'AFK_BROWSER_HEADLESS',
    description:
      'Override the default headless mode for native browser-control tools. ' +
      '`1`/`true` forces headless; `0`/`false` forces headed. When unset the default ' +
      'is headless for daemon and subagent surfaces and headed for repl/interactive — ' +
      'so an operator can watch the agent work in REPL mode.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'browser',
  },
  {
    name: 'AFK_BROWSER_ALLOWED_DOMAINS',
    description:
      'Comma-separated allowlist of URL host globs. When set, browser_open and any ' +
      'navigation that targets a host outside the list returns status: blocked_by_policy. ' +
      'Unset means no allowlist (permissive). Patterns use simple `*` glob ' +
      'matching against the URL host. Combines with AFK_BROWSER_BLOCKED_DOMAINS — block wins.',
    type: 'string',
    required: false,
    example: 'github.com,*.atlassian.net',
    category: 'browser',
  },
  {
    name: 'AFK_BROWSER_BLOCKED_DOMAINS',
    description:
      'Comma-separated blocklist of URL host globs. Browser navigation that matches any ' +
      'entry returns status: blocked_by_policy regardless of the allowlist.',
    type: 'string',
    required: false,
    example: '*.ads.example.com',
    category: 'browser',
  },
  {
    name: 'AFK_BROWSER_DOM_SNAPSHOTS',
    description:
      'Phase 2 opt-in: when set to 1, every browser_act writes a gzipped DOM snapshot ' +
      'sidecar under ~/.afk/state/witness/<sid>/browser/dom-snapshots/. Off by default ' +
      'because snapshots are large; useful for post-mortem analysis of failed actions.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'browser',
  },
  {
    name: 'AFK_BROWSER_BACKEND',
    description:
      'Select the browser provider backend. Phase 1 supports only `playwright`. ' +
      'Reserved for future `cdp` / `mcp` adapters. Unset defaults to `playwright`.',
    type: 'string',
    required: false,
    example: 'playwright',
    category: 'browser',
  },
  {
    name: 'AFK_BROWSER_CONFIG',
    description:
      'Absolute path to an alternate browser config file. Overrides the default ' +
      '~/.afk/config/browser.json lookup. Useful for per-project overrides in CI.',
    type: 'string',
    required: false,
    example: '/path/to/browser.json',
    category: 'browser',
  },

  // ── Filesystem ────────────────────────────────────────────────────────────
  {
    name: 'AFK_WRITE_DENYLIST',
    description: 'Comma-separated list of additional path globs that the write_file tool refuses to write to.',
    type: 'string',
    required: false,
    example: '**/.env,**/secrets/**',
    category: 'misc',
  },
  {
    name: 'AFK_WRITE_DIFF',
    description: 'Show a diff preview before each write_file tool call. Defaults provider-controlled when unset.',
    type: 'boolean',
    required: false,
    category: 'misc',
  },

  // ── CLI / capture-mode ────────────────────────────────────────────────────
  {
    name: 'AFK_DEMO_CLEAN',
    description: 'Explicit opt-in to capture-mode. When set to 1, suppresses high-frequency repaint drivers (spinner ticker, live thinking-preview) so recorded artifacts contain each state once instead of once per timer tick.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'misc',
  },
  {
    name: 'SCRIPT',
    description: 'Set by script(1) on BSD/macOS/Linux to the typescript filename while a terminal session is being recorded. Presence of a non-empty value triggers capture-mode.',
    type: 'string',
    required: false,
    example: '/tmp/typescript',
    category: 'process',
  },
  {
    name: 'ASCIINEMA_REC',
    description: 'Set to 1 by asciinema rec while a session is being recorded. Triggers capture-mode.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'process',
  },

  // ── Session identity ─────────────────────────────────────────────────────
  {
    name: 'AFK_SESSION_ID',
    description:
      'Override the browser session ID used by the native browser-control tools. ' +
      'Defaults to \'default\' for single-session use. Subagents inherit the ' +
      'parent\'s session by default. Set this when running multiple concurrent ' +
      'AFK processes that should each manage an isolated browser context.',
    type: 'string',
    required: false,
    default: 'default',
    example: 'session-abc123',
    category: 'browser',
  },

  // ── CLI / shell integration ───────────────────────────────────────────────
  {
    name: 'SHELL',
    description: 'Standard POSIX env var pointing to the user\'s login shell binary. Used by shell-init and worktree commands to auto-detect the correct shell syntax for emitted wrapper code.',
    type: 'string',
    required: false,
    example: '/bin/zsh',
    category: 'process',
  },
  {
    name: 'PAGER',
    description: 'Standard POSIX env var naming the user\'s preferred pager (with optional flags). Used by /transcript to render the full session in a scrollable viewer; falls back to `less -R` when unset.',
    type: 'string',
    required: false,
    example: 'less -R',
    category: 'process',
  },
  {
    name: 'AFK_DIFF_LINES',
    description: 'Maximum number of diff lines shown in the inline diff render during write_file tool calls. Set to 0 for no cap. Non-integer values are silently ignored and the default applies.',
    type: 'number',
    required: false,
    example: '50',
    category: 'misc',
  },
  {
    name: 'AFK_SHELL_WRAPPER',
    description: 'Set to 1 or true by the optional afk shell wrapper function (installed via `afk shell-init`). Signals that the parent shell has the wrapper active so the post-exit cd can fire.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'process',
  },
  {
    name: 'AFK_USER_CARD_MAX_ROWS',
    description: 'Maximum number of visual rows emitted by renderUserCard before collapsing the remainder into a dim "…(N lines collapsed)" summary row. Defaults to 24. Non-integer or non-positive values are silently ignored and the default applies.',
    type: 'number',
    required: false,
    example: '24',
    category: 'misc',
  },
];

/**
 * Single read-point for every env var the runtime touches. Getter on every
 * property — lazy, no caching, sees live `process.env` mutations.
 *
 * Migration: every `process.env['X']` outside `src/config/env.ts` should be
 * `env.X`. CI enforces via `pnpm audit:env:check`.
 *
 * The shape of `env` mirrors `ENV_REGISTRY` 1:1 (verified by
 * `env-registry.test.ts`). When adding a new var: add a getter here, add a
 * registry entry above.
 */
export const env = {
  // Model / agent runtime
  get AFK_COMPACT_KEEP_LAST_TURNS(): string | undefined { return process.env['AFK_COMPACT_KEEP_LAST_TURNS']; },
  get AFK_COMPACT_MODEL(): string | undefined { return process.env['AFK_COMPACT_MODEL']; },
  get AFK_DEFAULT_SUBAGENT_MODEL(): string | undefined { return process.env['AFK_DEFAULT_SUBAGENT_MODEL']; },
  get AFK_DIAGNOSE_BASELINE(): string | undefined { return process.env['AFK_DIAGNOSE_BASELINE']; },
  get AFK_DISABLE_PROMPT_CACHE(): string | undefined { return process.env['AFK_DISABLE_PROMPT_CACHE']; },
  get AFK_EFFORT(): string | undefined { return process.env['AFK_EFFORT']; },
  get AFK_MAX_BUDGET_USD(): string | undefined { return process.env['AFK_MAX_BUDGET_USD']; },
  get AFK_MAX_OUTPUT_TOKENS(): string | undefined { return process.env['AFK_MAX_OUTPUT_TOKENS']; },
  get AFK_MAX_TOKENS(): string | undefined { return process.env['AFK_MAX_TOKENS']; },
  get AFK_MODEL(): string | undefined { return process.env['AFK_MODEL']; },
  get AFK_MODEL_LARGE(): string | undefined { return process.env['AFK_MODEL_LARGE']; },
  get AFK_MODEL_LARGE_API_KEY(): string | undefined { return process.env['AFK_MODEL_LARGE_API_KEY']; },
  get AFK_MODEL_LARGE_BASE_URL(): string | undefined { return process.env['AFK_MODEL_LARGE_BASE_URL']; },
  get AFK_MODEL_MEDIUM(): string | undefined { return process.env['AFK_MODEL_MEDIUM']; },
  get AFK_MODEL_MEDIUM_API_KEY(): string | undefined { return process.env['AFK_MODEL_MEDIUM_API_KEY']; },
  get AFK_MODEL_MEDIUM_BASE_URL(): string | undefined { return process.env['AFK_MODEL_MEDIUM_BASE_URL']; },
  get AFK_MODEL_SMALL(): string | undefined { return process.env['AFK_MODEL_SMALL']; },
  get AFK_MODEL_SMALL_API_KEY(): string | undefined { return process.env['AFK_MODEL_SMALL_API_KEY']; },
  get AFK_MODEL_SMALL_BASE_URL(): string | undefined { return process.env['AFK_MODEL_SMALL_BASE_URL']; },
  get AFK_PROMPT_CACHE_TTL(): string | undefined { return process.env['AFK_PROMPT_CACHE_TTL']; },
  get AFK_SUGGEST_ENABLED(): string | undefined { return process.env['AFK_SUGGEST_ENABLED']; },
  get AFK_SUGGEST_GHOST(): string | undefined { return process.env['AFK_SUGGEST_GHOST']; },
  get AFK_SUGGEST_MODEL(): string | undefined { return process.env['AFK_SUGGEST_MODEL']; },
  get AFK_TASK_BUDGET(): string | undefined { return process.env['AFK_TASK_BUDGET']; },
  get AFK_TEMPERATURE(): string | undefined { return process.env['AFK_TEMPERATURE']; },
  get AFK_THINKING(): string | undefined { return process.env['AFK_THINKING']; },
  get AFK_TIMEOUT_MS(): string | undefined { return process.env['AFK_TIMEOUT_MS']; },
  get CLAUDE_MODEL(): string | undefined { return process.env['CLAUDE_MODEL']; },

  // System prompt
  get AFK_SYSTEM_PROMPT(): string | undefined { return process.env['AFK_SYSTEM_PROMPT']; },
  get AFK_DUMP_PROMPT(): string | undefined { return process.env['AFK_DUMP_PROMPT']; },

  // Auth
  get ANTHROPIC_API_KEY(): string | undefined { return process.env['ANTHROPIC_API_KEY']; },
  get CLAUDE_CODE_OAUTH_TOKEN(): string | undefined { return process.env['CLAUDE_CODE_OAUTH_TOKEN']; },
  get OPENAI_API_KEY(): string | undefined { return process.env['OPENAI_API_KEY']; },
  get CODEX_API_KEY(): string | undefined { return process.env['CODEX_API_KEY']; },
  get AFK_LOCAL_API_KEY(): string | undefined { return process.env['AFK_LOCAL_API_KEY']; },
  get AFK_LOCAL_BASE_URL(): string | undefined { return process.env['AFK_LOCAL_BASE_URL']; },
  get AFK_OPENAI_BASE_URL(): string | undefined { return process.env['AFK_OPENAI_BASE_URL']; },
  get AFK_OPENAI_USE_RESPONSES(): string | undefined { return process.env['AFK_OPENAI_USE_RESPONSES']; },
  get AFK_OPENAI_CHATGPT_OAUTH(): string | undefined { return process.env['AFK_OPENAI_CHATGPT_OAUTH']; },
  get AFK_PROVIDER(): string | undefined { return process.env['AFK_PROVIDER']; },
  get EXA_API_KEY(): string | undefined { return process.env['EXA_API_KEY']; },

  // Telegram
  get TELEGRAM_BOT_TOKEN(): string | undefined { return process.env['TELEGRAM_BOT_TOKEN']; },
  get AFK_TELEGRAM_BOT_TOKEN(): string | undefined { return process.env['AFK_TELEGRAM_BOT_TOKEN']; },
  get AFK_TELEGRAM_ALLOWED_CHAT_IDS(): string | undefined { return process.env['AFK_TELEGRAM_ALLOWED_CHAT_IDS']; },
  get AFK_TELEGRAM_PRIMARY_CHAT_ID(): string | undefined { return process.env['AFK_TELEGRAM_PRIMARY_CHAT_ID']; },
  get AFK_TELEGRAM_NOTIFY_MODE(): string | undefined { return process.env['AFK_TELEGRAM_NOTIFY_MODE']; },
  get TELEGRAM_DATA_DIR(): string | undefined { return process.env['TELEGRAM_DATA_DIR']; },
  get TELEGRAM_VERBOSE(): string | undefined { return process.env['TELEGRAM_VERBOSE']; },
  get AFK_TELEGRAM_TRACE(): string | undefined { return process.env['AFK_TELEGRAM_TRACE']; },
  get AFK_TELEGRAM_CWD(): string | undefined { return process.env['AFK_TELEGRAM_CWD']; },

  // Paths
  get AFK_HOME(): string | undefined { return process.env['AFK_HOME']; },
  get AFK_STATE_DIR(): string | undefined { return process.env['AFK_STATE_DIR']; },
  get AFK_FRAMEWORK_DIR(): string | undefined { return process.env['AFK_FRAMEWORK_DIR']; },

  get HOME(): string | undefined { return process.env['HOME']; },
  get PATH(): string | undefined { return process.env['PATH']; },

  // Daemon
  get AFK_DAEMON_CWD(): string | undefined { return process.env['AFK_DAEMON_CWD']; },
  get AFK_DAEMON_TASK(): string | undefined { return process.env['AFK_DAEMON_TASK']; },
  get AFK_DAEMON_TASK_ID(): string | undefined { return process.env['AFK_DAEMON_TASK_ID']; },
  get AFK_DAEMON_HOST(): string | undefined { return process.env['AFK_DAEMON_HOST']; },
  get AFK_SESSIONSTART_COOLDOWN_MS(): string | undefined { return process.env['AFK_SESSIONSTART_COOLDOWN_MS']; },

  // Worktree
  get AFK_WORKTREE_AUTONAME(): string | undefined { return process.env['AFK_WORKTREE_AUTONAME']; },
  get AFK_WORKTREE_BRANCH_PREFIX(): string | undefined { return process.env['AFK_WORKTREE_BRANCH_PREFIX']; },
  get AFK_WORKTREE_BASE(): string | undefined { return process.env['AFK_WORKTREE_BASE']; },
  get AFK_WORKTREE_BOOT_PRUNE(): string | undefined { return process.env['AFK_WORKTREE_BOOT_PRUNE']; },
  get AFK_WORKTREE_PRUNE_DISABLE(): string | undefined { return process.env['AFK_WORKTREE_PRUNE_DISABLE']; },
  get AFK_WORKTREE_MAX_AGE_CLEAN(): string | undefined { return process.env['AFK_WORKTREE_MAX_AGE_CLEAN']; },
  get AFK_WORKTREE_MAX_AGE_DIRTY(): string | undefined { return process.env['AFK_WORKTREE_MAX_AGE_DIRTY']; },
  get AFK_WORKTREE_SWEEP_ROOT(): string | undefined { return process.env['AFK_WORKTREE_SWEEP_ROOT']; },


  // MCP
  get AFK_ALLOW_PROJECT_MCP(): string | undefined { return process.env['AFK_ALLOW_PROJECT_MCP']; },

  // Routing
  get AFK_AUTO_ROUTING(): string | undefined { return process.env['AFK_AUTO_ROUTING']; },
  get AFK_INTERNAL(): string | undefined { return process.env['AFK_INTERNAL']; },
  get AFK_SHELL_PASSTHROUGH(): string | undefined { return process.env['AFK_SHELL_PASSTHROUGH']; },

  // UI / output
  get AFK_BANNER_PLAIN(): string | undefined { return process.env['AFK_BANNER_PLAIN']; },
  get AFK_SPINNER_TIPS(): string | undefined { return process.env['AFK_SPINNER_TIPS']; },
  get AFK_SHOW_DIFFS(): string | undefined { return process.env['AFK_SHOW_DIFFS']; },
  get AFK_SKILL_STREAM_VERBOSE(): string | undefined { return process.env['AFK_SKILL_STREAM_VERBOSE']; },
  get FORCE_COLOR(): string | undefined { return process.env['FORCE_COLOR']; },
  get NO_COLOR(): string | undefined { return process.env['NO_COLOR']; },

  // Debug
  get AFK_DEBUG(): string | undefined { return process.env['AFK_DEBUG']; },
  get AFK_DEBUG_CLIPBOARD(): string | undefined { return process.env['AFK_DEBUG_CLIPBOARD']; },
  get AFK_DEBUG_COMPOSITOR(): string | undefined { return process.env['AFK_DEBUG_COMPOSITOR']; },
  get AFK_TRACE_DISABLED(): string | undefined { return process.env['AFK_TRACE_DISABLED']; },
  get AFK_SESSION_LEDGER_DISABLED(): string | undefined { return process.env['AFK_SESSION_LEDGER_DISABLED']; },
  get DEBUG(): string | undefined { return process.env['DEBUG']; },
  get AGENT_AFK_ASCII(): string | undefined { return process.env['AGENT_AFK_ASCII']; },

  // Process / runtime
  get AGENT_SURFACE(): string | undefined { return process.env['AGENT_SURFACE']; },
  get CI(): string | undefined { return process.env['CI']; },
  get NODE_ENV(): string | undefined { return process.env['NODE_ENV']; },
  get VITEST(): string | undefined { return process.env['VITEST']; },
  get NO_UPDATE_NOTIFIER(): string | undefined { return process.env['NO_UPDATE_NOTIFIER']; },

  // Session identity
  get AFK_SESSION_ID(): string | undefined { return process.env['AFK_SESSION_ID']; },

  // Browser-control tools
  get AFK_BROWSER_HEADLESS(): string | undefined { return process.env['AFK_BROWSER_HEADLESS']; },
  get AFK_BROWSER_ALLOWED_DOMAINS(): string | undefined { return process.env['AFK_BROWSER_ALLOWED_DOMAINS']; },
  get AFK_BROWSER_BLOCKED_DOMAINS(): string | undefined { return process.env['AFK_BROWSER_BLOCKED_DOMAINS']; },
  get AFK_BROWSER_DOM_SNAPSHOTS(): string | undefined { return process.env['AFK_BROWSER_DOM_SNAPSHOTS']; },
  get AFK_BROWSER_BACKEND(): string | undefined { return process.env['AFK_BROWSER_BACKEND']; },
  get AFK_BROWSER_CONFIG(): string | undefined { return process.env['AFK_BROWSER_CONFIG']; },

  // Filesystem
  get AFK_WRITE_DENYLIST(): string | undefined { return process.env['AFK_WRITE_DENYLIST']; },
  get AFK_WRITE_DIFF(): string | undefined { return process.env['AFK_WRITE_DIFF']; },

  // CLI / capture-mode
  get AFK_DEMO_CLEAN(): string | undefined { return process.env['AFK_DEMO_CLEAN']; },
  get SCRIPT(): string | undefined { return process.env['SCRIPT']; },
  get ASCIINEMA_REC(): string | undefined { return process.env['ASCIINEMA_REC']; },

  // CLI / shell integration
  get SHELL(): string | undefined { return process.env['SHELL']; },
  get PAGER(): string | undefined { return process.env['PAGER']; },
  get AFK_DIFF_LINES(): string | undefined { return process.env['AFK_DIFF_LINES']; },
  get AFK_SHELL_WRAPPER(): string | undefined { return process.env['AFK_SHELL_WRAPPER']; },
  get AFK_USER_CARD_MAX_ROWS(): string | undefined { return process.env['AFK_USER_CARD_MAX_ROWS']; },
} as const; // `as const` narrows getter return types — it does NOT call Object.freeze; the object is mutable at runtime.

// ── Secret hardening ────────────────────────────────────────────────────────
// Credential-bearing getters (auth keys, OAuth tokens, bot tokens) are
// made non-enumerable so accidental serialization paths do NOT surface their
// values: `JSON.stringify(env)`, `console.log(env)`, `Object.keys(env)`,
// `for...in env`, and `util.inspect(env)` all skip them. Direct access
// (`env.ANTHROPIC_API_KEY`) is unaffected — this only blocks the
// accidental-leak path, not deliberate use.
//
// External constraint: ECMA-262 property descriptor semantics — `enumerable`
// gates iteration but NOT existence; the property still resolves on direct
// read. `Object.defineProperty` preserves the existing getter when we copy
// the descriptor.
(function applySecretHardening(): void {
  for (const entry of ENV_REGISTRY) {
    if (!entry.secret) continue;
    const descriptor = Object.getOwnPropertyDescriptor(env, entry.name);
    if (!descriptor) continue; // env-registry parity test will catch the miss
    Object.defineProperty(env, entry.name, { ...descriptor, enumerable: false });
  }
})();

/**
 * Union of every key on the `env` object. Useful for typed variable-name
 * parameters, e.g. `function readEnv(name: EnvVarName)`.
 *
 * NOTE: This alias alone does NOT enforce that every getter has a matching
 * `ENV_REGISTRY` entry — `keyof typeof env` is a structural alias with no
 * direct relationship to the registry array. The authoritative parity gate is
 * the runtime check in `src/config/env.test.ts`. The bidirectional type
 * assertions below provide an early, compile-time squiggle when the two fall
 * out of sync.
 */
export type EnvVarName = keyof typeof env;

// Bidirectional compile-time parity check.
// If any key exists in `env` but not in ENV_REGISTRY (or vice-versa),
// `tsc --noEmit` will emit: "Type 'never' is not assignable to type 'true'".
type _RegistryNames = (typeof ENV_REGISTRY)[number]['name'];
type _EnvKeys = keyof typeof env;
type _CheckEnvCoversRegistry = _RegistryNames extends _EnvKeys ? true : never;
type _CheckRegistryCoversEnv = _EnvKeys extends _RegistryNames ? true : never;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare const _parityEnv: _CheckEnvCoversRegistry;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
declare const _parityRegistry: _CheckRegistryCoversEnv;

/**
 * Look up a registry entry by name. Returns undefined if the var is unknown.
 * Used by `/doctor` for the required-var check.
 */
export function getEnvVarMeta(name: string): EnvVarMeta | undefined {
  return ENV_REGISTRY.find((e) => e.name === name);
}

/**
 * Return the list of vars where `required: true` and the current process has
 * no value set. Consumed by `/doctor` and surface-specific bootstrap code.
 *
 * `requiredFor` lets callers scope the check — e.g., the Telegram surface
 * passes `'telegram'` and gets only TELEGRAM_BOT_TOKEN + AFK_TELEGRAM_ALLOWED_CHAT_IDS.
 */
export function getMissingRequiredEnvVars(category?: EnvVarCategory): EnvVarMeta[] {
  return ENV_REGISTRY.filter((e) => {
    if (!e.required) return false;
    if (category !== undefined && e.category !== category) return false;
    return process.env[e.name] === undefined || process.env[e.name] === '';
  });
}
