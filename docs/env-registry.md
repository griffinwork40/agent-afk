# Environment Variable Registry

Generated from `src/config/env.ts`. Do not edit by hand — run `pnpm scan:env` after changing the registry source.

**118 vars** across 12 categories. Every `process.env[...]` read in `src/` outside `src/config/env.ts` is a CI failure (enforced by `pnpm audit:env:check`).

To add a var: edit `src/config/env.ts` (add a getter on `env` + an entry in `ENV_REGISTRY`), then run `pnpm scan:env`.

## Model

| Name | Type | Required | Default | Example | Description |
|------|------|----------|---------|---------|-------------|
| `AFK_COMPACT_KEEP_LAST_TURNS` | number |  |  | `6` | Number of recent turns the compactor keeps verbatim during /compact. Default tuned in compact-handler.ts. |
| `AFK_COMPACT_MODEL` | string |  |  | `claude-haiku-4-5` | Override the model used by the /compact summarizer. Falls back to a cheap default (haiku-class). |
| `AFK_DEFAULT_SUBAGENT_MODEL` | string |  |  | `sonnet` | Override the default model used when a subagent is dispatched without an explicit model. |
| `AFK_DISABLE_PROMPT_CACHE` | boolean |  | `0` | `1` | Disable Anthropic prompt caching when set to 1/true/yes/on. Unset = caching enabled. |
| `AFK_EFFORT` | string |  |  | `medium` | Effort hint guiding adaptive-thinking depth, forwarded as Anthropic output_config.effort (model-gated; ignored where unsupported). Accepts low \| medium \| high \| xhigh \| max. |
| `AFK_LOCAL_BASE_URL` | string |  |  | `http://127.0.0.1:8080` | Base URL for a self-hosted Anthropic-compatible server. When set, routes traffic away from api.anthropic.com. |
| `AFK_MAX_BUDGET_USD` | number |  | `5.00` | `10.00` | Cumulative USD budget ceiling for the session. Aborts the turn when the running cost crosses this. |
| `AFK_MAX_OUTPUT_TOKENS` | number |  |  | `8192` | Cap on output tokens per turn. Falls back to provider default when unset. |
| `AFK_MAX_TOKENS` | number |  | `4096` | `8192` | Cap on total tokens per turn (input + output). Default 4096. |
| `AFK_MODEL` | string |  | `sonnet` | `claude-opus-4-5` | Default model for agent turns. Accepts slot names (local, small, medium, large), legacy aliases (opus, sonnet, haiku), the fixed-id fable alias (Claude Fable 5), or full model IDs. |
| `AFK_MODEL_LARGE` | string |  |  | `claude-opus-4-8` | Bind the "large" capability tier (most capable) to a model id/alias. Overrides afk.config.json models.large. |
| `AFK_MODEL_LARGE_API_KEY` | string |  |  |  | Per-slot API key for the "large" tier (Stage 2). Overrides global credentials for this tier only. |
| `AFK_MODEL_LARGE_BASE_URL` | string |  |  | `http://localhost:8080/v1` | Per-slot endpoint base URL for the "large" tier (Stage 2). Anthropic Messages base or OpenAI-compatible base per the tier provider. |
| `AFK_MODEL_LOCAL` | string |  |  | `llama3.2:3b` | Bind the "local" capability tier (cheapest/fastest, user-configured) to a model id. Overrides afk.config.json models.local. Point at a local Ollama, LM Studio, or any OpenAI-compatible shim. |
| `AFK_MODEL_LOCAL_API_KEY` | string |  |  |  | Per-slot API key for the "local" tier. Overrides global credentials for this tier only. |
| `AFK_MODEL_LOCAL_BASE_URL` | string |  |  | `http://localhost:11434/v1` | Per-slot endpoint base URL for the "local" tier. Anthropic Messages base or OpenAI-compatible base per the tier provider. |
| `AFK_MODEL_MEDIUM` | string |  |  | `claude-sonnet-5` | Bind the "medium" capability tier (general-use) to a model id/alias. Overrides afk.config.json models.medium. |
| `AFK_MODEL_MEDIUM_API_KEY` | string |  |  |  | Per-slot API key for the "medium" tier (Stage 2). Overrides global credentials for this tier only. |
| `AFK_MODEL_MEDIUM_BASE_URL` | string |  |  | `http://localhost:8080/v1` | Per-slot endpoint base URL for the "medium" tier (Stage 2). Anthropic Messages base or OpenAI-compatible base per the tier provider. |
| `AFK_MODEL_SMALL` | string |  |  | `gpt-4o-mini` | Bind the "small" capability tier (cheap/fast) to a model id/alias. Overrides afk.config.json models.small. |
| `AFK_MODEL_SMALL_API_KEY` | string |  |  |  | Per-slot API key for the "small" tier (Stage 2). Overrides global credentials for this tier only. |
| `AFK_MODEL_SMALL_BASE_URL` | string |  |  | `http://localhost:8080/v1` | Per-slot endpoint base URL for the "small" tier (Stage 2). Anthropic Messages base or OpenAI-compatible base per the tier provider. |
| `AFK_OPENAI_BASE_URL` | string |  |  | `http://127.0.0.1:8000/v1` | Base URL override for the OpenAI-compatible provider. Used for local shims (mlx_lm.server, Ollama, vLLM, LM Studio). The OpenAI SDK appends `/chat/completions` itself — a value ending in `/chat/completions` will be stripped at config-load time with a one-shot warning. |
| `AFK_OPENAI_CHATGPT_OAUTH` | boolean |  |  | `1` | Opt into using ChatGPT-subscription OAuth credentials from ~/.codex/auth.json (auth_mode: chatgpt) as OpenAI provider auth. Off by default. READ-ONLY: AFK never refreshes these tokens — re-run `codex` when the access token expires. Routes requests over the Responses API to the private ChatGPT backend (chatgpt.com/backend-api). |
| `AFK_OPENAI_USE_RESPONSES` | boolean |  |  | `1` | Opt the OpenAI-compatible provider into the OpenAI Responses API instead of Chat Completions for API-key sessions. Truthy values: 1, true, yes, on. The ChatGPT-subscription OAuth path uses Responses automatically regardless of this flag. |
| `AFK_PROMPT_CACHE_TTL` | string |  | `1h` | `1h` | TTL for Anthropic prompt-cache blocks. Accepts 5m or 1h. |
| `AFK_PROVIDER` | string |  |  | `openai-compatible` | Force provider selection (anthropic \| anthropic-direct \| openai \| openai-compatible \| openai-codex). Overrides the model-name heuristic. Same surface as the --provider CLI flag; CLI flag wins when both are set. |
| `AFK_SUGGEST_ENABLED` | boolean |  |  |  | Enable the LLM-backed ghost-text suggestion tier in the interactive REPL. Set to 1/true/yes/on to activate. Off by default. |
| `AFK_SUGGEST_GHOST` | boolean |  | `1` | `0` | Enable REPL ghost-text inline suggestions (Tier-1 history/dropdown + optional Tier-2 LLM). 1 = on (default), 0 = off. Set 0/false/off/no to disable all ghost text. Tier-2 LLM is separately gated by AFK_SUGGEST_ENABLED. |
| `AFK_SUGGEST_MODEL` | string |  |  |  | Override the small model used for REPL ghost-text suggestions. Falls back to AFK_COMPACT_MODEL or haiku-class for anthropic, or the session model for other providers. |
| `AFK_SYSTEM_PROMPT` | string |  |  | `You are a helpful agent.` | Raw operator-overlay prompt. Highest-priority overlay (over afk.config.json and AFK.md). Appended on top of the framework base (prompts/system-prompt.md) under an "# Operator configuration" header — it augments, never replaces, the base. |
| `AFK_TASK_BUDGET` | number |  | `100000` | `200000` | Per-task token budget ceiling. Aborts when cumulative usage would exceed it. |
| `AFK_TEMPERATURE` | number |  |  | `0.7` | Numeric temperature override for model sampling. Provider default if unset. |
| `AFK_THINKING` | string |  | `adaptive` | `adaptive` | Extended-thinking mode. Accepts adaptive \| disabled \| enabled:<N> \| enabled:max. Defaults to the model-appropriate mode when unset (adaptive on current models). |
| `AFK_TIMEOUT_MS` | number |  |  | `120000` | Per-turn timeout in milliseconds. Provider/SDK default if unset. |
| `AFK_VISION_MODELS` | string |  |  | `qwen2.5-vl,!gpt-4o-mini` | Comma-separated override for image (vision) capability detection on the openai-compatible provider. Each token force-enables a model id by exact or substring match (e.g. "qwen2.5-vl" matches a local VL id); prefix a token with "!" to force-disable. Use to send images to a local vision-language model AFK does not recognise by name, or to blacklist a mis-detected id. Built-in detection already covers gpt-4o/4.1/5.x, o1/o3/o4-mini, Claude, and common VL families. |
| `CLAUDE_MODEL` | string |  |  | `sonnet` | Legacy alias for AFK_MODEL — supported for back-compat with pre-AFK_* deployments. |

## Auth

| Name | Type | Required | Default | Example | Description |
|------|------|----------|---------|---------|-------------|
| `AFK_LOCAL_API_KEY` | string |  | `local` | `local` | Placeholder API key for local Anthropic-compatible servers (vllm-mlx, etc.). Set when AFK_LOCAL_BASE_URL is configured. |
| `ANTHROPIC_API_KEY` | string |  |  |  | Anthropic API key. Tier-1 credential — overrides keychain OAuth and CLAUDE_CODE_OAUTH_TOKEN. |
| `CLAUDE_CODE_OAUTH_TOKEN` | string |  |  |  | Claude Code OAuth token. Tier-2 credential — used when ANTHROPIC_API_KEY is unset; falls back to keychain. |
| `CODEX_API_KEY` | string |  |  |  | Fallback OpenAI API key for the openai-compatible provider, read after OPENAI_API_KEY. Legacy name from the removed @openai/codex-sdk integration — prefer OPENAI_API_KEY. |
| `EXA_API_KEY` | string |  |  |  | Exa (exa.ai) search API key, enabling web_scrape search mode. Free tier (20k requests/month) available at https://exa.ai. When unset, search mode returns an actionable error; markdown and raw modes are unaffected. |
| `OPENAI_API_KEY` | string |  |  |  | OpenAI API key for the openai-compatible provider (gpt-*, o1*, o3*, o4* models). |

## Telegram

| Name | Type | Required | Default | Example | Description |
|------|------|----------|---------|---------|-------------|
| `AFK_TELEGRAM_ALLOWED_CHAT_IDS` | string |  |  | `123456789,987654321` | Comma-separated list of Telegram chat IDs allowed to interact with the bot. Required when the bot is running. |
| `AFK_TELEGRAM_BOT_TOKEN` | string |  |  |  | Alternative env var name for the Telegram bot token, accepted by the setup wizard. |
| `AFK_TELEGRAM_CWD` | string |  |  |  | Override the working directory used by the Telegram bot when spawning agent sessions. |
| `AFK_TELEGRAM_NOTIFY_MODE` | string |  |  | `broadcast` | Outbound notification fan-out: primary (default — one chat), broadcast (every allowed chat), or custom (afk.config.json telegram.notify.targets). The afk.config.json telegram.notify.mode takes precedence. |
| `AFK_TELEGRAM_PRIMARY_CHAT_ID` | string |  |  | `123456789` | Default chat ID for outbound notifications (primary-mode routing). When unset, notifications go to the first private/DM chat in AFK_TELEGRAM_ALLOWED_CHAT_IDS. The afk.config.json telegram.notify block takes precedence. |
| `TELEGRAM_BOT_TOKEN` | string |  |  |  | Telegram bot token from @BotFather. Required to run the Telegram bot surface. |
| `TELEGRAM_DATA_DIR` | string |  |  |  | Override the directory where Telegram bot state is stored. Defaults to ~/.afk/state/telegram/. |
| `TELEGRAM_VERBOSE` | boolean |  |  | `1` | Set to 1 to log per-message details from the Telegram bot — chat IDs, message text, latency. |

## Paths

| Name | Type | Required | Default | Example | Description |
|------|------|----------|---------|---------|-------------|
| `AFK_FRAMEWORK_DIR` | string |  |  |  | Override the AFK agent-framework directory used for telemetry and briefs. Default: $AFK_HOME/agent-framework/. |
| `AFK_HOME` | string |  | `~/.afk` | `/opt/afk` | Override the AFK home directory. Default: ~/.afk/. |
| `AFK_STATE_DIR` | string |  |  |  | Override the entire AFK state tier (sessions/, todos/, transcripts/, memory/, daemon/, etc.), not just one subdirectory. Must be an absolute path (not /). Default: $AFK_HOME/state/. |

## Daemon

| Name | Type | Required | Default | Example | Description |
|------|------|----------|---------|---------|-------------|
| `AFK_DAEMON_CWD` | string |  |  |  | Working directory used by the daemon process for spawned agent sessions. |
| `AFK_DAEMON_HOST` | string |  |  |  | Bind address for the daemon control HTTP surface. Defaults to 127.0.0.1 (loopback only). The control surface is unauthenticated, so bind a non-loopback address such as 0.0.0.0 only on a trusted or firewalled network. Overridden by the --host flag. |
| `AFK_DAEMON_TASK` | string |  |  |  | Default task description for the daemon. Falls back to afk.config.json daemon.task. |
| `AFK_DAEMON_TASK_ID` | string |  |  |  | Task identifier the daemon uses to scope its state directory and telemetry. |
| `AFK_SESSIONSTART_COOLDOWN_MS` | number |  |  |  | Cooldown in milliseconds between SessionStart trigger fires in the daemon. Prevents thundering-herd on rapid restarts. |

## Worktree

| Name | Type | Required | Default | Example | Description |
|------|------|----------|---------|---------|-------------|
| `AFK_WORKTREE_AUTONAME` | boolean |  | `1` | `0` | Auto-rename worktree branches based on the first user message in interactive mode. 1 = on (default), 0 = off. |
| `AFK_WORKTREE_BASE` | string |  |  | `origin/main` | Override the base git ref for worktrees created with --worktree. By default AFK bases worktrees on the remote's default branch (e.g. origin/main), fetched fresh. Set this to pin a different ref, or to HEAD to base on the local checkout. Overridden per-session by --worktree-base. |
| `AFK_WORKTREE_BOOT_PRUNE` | boolean |  |  |  | When set, the daemon prunes stale worktrees at boot in addition to the cron-driven sweep. |
| `AFK_WORKTREE_BRANCH_PREFIX` | string |  | `afk/` | `wt/` | Branch-name prefix for AFK-managed worktrees. Default afk/. Set to empty string to drop the prefix. |
| `AFK_WORKTREE_MAX_AGE_CLEAN` | number |  | `14` |  | Maximum age (in days) before a clean worktree is auto-pruned. Default 14. |
| `AFK_WORKTREE_MAX_AGE_DIRTY` | number |  | `30` |  | Maximum age (in days) before a dirty worktree is auto-pruned. Default 30. |
| `AFK_WORKTREE_PRUNE_DISABLE` | boolean |  |  |  | Disable the worktree prune job entirely. Useful for long-running tests. |
| `AFK_WORKTREE_SWEEP_ROOT` | string |  |  |  | Override the root directory under which AFK worktrees are tracked for pruning. |

## Mcp

| Name | Type | Required | Default | Example | Description |
|------|------|----------|---------|---------|-------------|
| `AFK_ALLOW_PROJECT_MCP` | boolean |  |  | `0` | Controls auto-loading of MCP configuration from <cwd>/.mcp.json. Auto-loaded by default — set to 0 to disable (mitigates config-injection risk in shared/CI environments). |

## Routing

| Name | Type | Required | Default | Example | Description |
|------|------|----------|---------|---------|-------------|
| `AFK_AUTO_ROUTING` | boolean |  |  | `true` | Auto-route bare slash inputs to matching skills. Applies to interactive, chat, telegram, and daemon surfaces. |
| `AFK_INTERNAL` | boolean |  |  | `1` | Tier gate. Set to exactly `1` to unlock — only the literal string "1" unlocks (other truthy values like "true"/"yes" leave the tier locked). When unlocked, skills tagged `audience: 'internal'` (e.g. /audit-fit, harvest/distill plugins) become visible at end-user surfaces (slash-command list, --help, tab-complete, system-prompt skill manifest). Default unset = public tier — internal skills are hidden. Not an access-control boundary; it gates surfacing, not the underlying registry. |

## Browser

| Name | Type | Required | Default | Example | Description |
|------|------|----------|---------|---------|-------------|
| `AFK_BROWSER_ALLOWED_DOMAINS` | string |  |  | `github.com,*.atlassian.net` | Comma-separated allowlist of URL host globs. When set, browser_open and any navigation that targets a host outside the list returns status: blocked_by_policy. Unset means no allowlist (permissive). Patterns use simple `*` glob matching against the URL host. Combines with AFK_BROWSER_BLOCKED_DOMAINS — block wins. |
| `AFK_BROWSER_BACKEND` | string |  |  | `playwright` | Select the browser provider backend. Phase 1 supports only `playwright`. Reserved for future `cdp` / `mcp` adapters. Unset defaults to `playwright`. |
| `AFK_BROWSER_BLOCKED_DOMAINS` | string |  |  | `*.ads.example.com` | Comma-separated blocklist of URL host globs. Browser navigation that matches any entry returns status: blocked_by_policy regardless of the allowlist. |
| `AFK_BROWSER_CONFIG` | string |  |  | `/path/to/browser.json` | Absolute path to an alternate browser config file. Overrides the default ~/.afk/config/browser.json lookup. Useful for per-project overrides in CI. |
| `AFK_BROWSER_DEFAULT_PROFILE` | string |  |  | `work` | Name of the persistent session-vault profile the agent reuses for browser sessions. The context restores its login from (and saves it back to) ~/.afk/state/browser/<profile>/storageState.json, so a human runs `afk browser login --profile <name>` once and the agent reuses that authenticated session across unattended runs. Unset defaults to `default` (a fresh, empty profile — identical to pre-vault behavior). Allowed charset: [A-Za-z0-9_-], max 128 chars. |
| `AFK_BROWSER_DOM_SNAPSHOTS` | boolean |  |  | `1` | Phase 2 opt-in: when set to 1, every browser_act writes a gzipped DOM snapshot sidecar under ~/.afk/state/witness/<sid>/browser/dom-snapshots/. Off by default because snapshots are large; useful for post-mortem analysis of failed actions. |
| `AFK_BROWSER_HEADLESS` | boolean |  |  | `1` | Override the default headless mode for native browser-control tools. `1`/`true` forces headless; `0`/`false` forces headed. When unset the default is headless for daemon and subagent surfaces and headed for repl/interactive — so an operator can watch the agent work in REPL mode. |
| `AFK_SESSION_ID` | string |  | `default` | `session-abc123` | Override the browser session ID used by the native browser-control tools. Defaults to 'default' for single-session use. Subagents inherit the parent's session by default. Set this when running multiple concurrent AFK processes that should each manage an isolated browser context. |

## Debug

| Name | Type | Required | Default | Example | Description |
|------|------|----------|---------|---------|-------------|
| `AFK_DEBUG` | boolean |  |  | `1` | Enable verbose debug logging across the codebase. Accepts 1 to enable. |
| `AFK_DEBUG_CLIPBOARD` | boolean |  |  |  | Debug bracketed-paste and image-paste handling in the interactive REPL. |
| `AFK_DEBUG_COMPOSITOR` | boolean |  |  |  | Gate compositor phase-boundary traces to stderr; any truthy value enables. |
| `AFK_DIAGNOSE_BASELINE` | boolean |  | `1` | `0` | Kill switch for /diagnose reproducer baseline execution. When set to '0', the /diagnose skill skips executing the detected reproducer command for a ground-truth baseline; default enabled (runs). Set to '0' to disable. |
| `AFK_DUMP_PROMPT` | string |  |  | `/tmp/afk-prompt.txt` | Write the resolved system prompt to a file at startup. Accepts a path or 1 for default location. |
| `AFK_RUN_RECEIPT_DISABLED` | boolean |  |  | `1` | Disable the post-session run receipt (state/receipts/<label>.json and .md). Set to 1 to skip receipt writes; the underlying witness trace is unaffected. Receipts are also implicitly off when AFK_TRACE_DISABLED=1 (no trace to summarize). |
| `AFK_SESSION_LEDGER_DISABLED` | boolean |  |  | `1` | Disable the per-session durable event ledger (state/sessions/<id>/events.jsonl). Set to 1 to skip ledger writes; live cross-surface watching (e.g. the Telegram /watch command) will report no activity for sessions started while disabled. |
| `AFK_SKILL_STREAM_VERBOSE` | boolean |  |  |  | Verbose streaming output when a skill is dispatched. Logs sub-agent setup, intermediate events, and final result. |
| `AFK_TELEGRAM_TRACE` | boolean |  |  | `1` | Set to 1 to dump raw bridge traffic between the agent and the Telegram bot — debugging only. |
| `AFK_TRACE_DISABLED` | boolean |  |  | `1` | Disable the agent trace subsystem entirely. Set to 1 to skip trace file writes. |
| `AGENT_AFK_ASCII` | boolean |  |  | `1` | Force the interactive REPL tool-lane renderer to ASCII-only glyphs instead of the default Unicode box-drawing set. Accepts 1/true/yes (case-insensitive). Useful for terminals whose font lacks ┃├╰├ glyphs. |
| `DEBUG` | string |  |  |  | Standard Node `debug`-package convention. When set to 1, enables verbose logging in several modules alongside AFK_DEBUG. |

## Process

| Name | Type | Required | Default | Example | Description |
|------|------|----------|---------|---------|-------------|
| `AFK_DISABLE_BASH_INTERPRETER_GUARD` | boolean |  | `0` | `1` | Skip ONLY the bash interpreter-eval denylist (python -c, node -e, sh -c, ...) when set to 1, leaving the rest of path-approval intact. Applies on interactive surfaces (REPL/Telegram), where the denylist is active but your workflow legitimately runs interpreter one-liners. The restricted-root substring check is unaffected. Default: denylist active on interactive surfaces; headless already fails open (opt in with AFK_FORCE_BASH_INTERPRETER_GUARD=1). To disable all of path-approval + bash restriction instead, use AFK_DISABLE_PATH_APPROVAL=1. |
| `AFK_DISABLE_PATH_APPROVAL` | boolean |  | `0` | `1` | Skip the path-approval + bash-restriction hooks entirely when set to 1. Use for headless flows that need wide-open file access (CI scripts, batch jobs). Default: hooks enabled. Note: on headless surfaces (afk chat, daemon) no grant manager is wired, so the interpreter denylist (python -c, node -e, sh -c, ...) fails OPEN by default — opt headless flows into it with AFK_FORCE_BASH_INTERPRETER_GUARD=1, or set this var to 1 to disable all of path-approval. |
| `AFK_FORCE_BASH_INTERPRETER_GUARD` | boolean |  | `0` | `1` | Apply the bash interpreter-eval denylist (python -c, node -e, sh -c, ...) even on headless surfaces (afk chat, daemon) where no grant manager is wired. By default the denylist fires only on interactive surfaces (REPL/Telegram), failing open on headless so legitimate automation is not hard-blocked with no recourse. Set to 1 to opt headless flows back into the guard. Overridden by AFK_DISABLE_BASH_INTERPRETER_GUARD=1. Default: off (headless fails open). |
| `AFK_SHELL_WRAPPER` | boolean |  |  | `1` | Set to 1 or true by the optional afk shell wrapper function (installed via `afk shell-init`). Signals that the parent shell has the wrapper active so the post-exit cd can fire. |
| `AGENT_SURFACE` | string |  |  | `cli` | Internal surface marker propagated to subprocesses. Identifies which AFK surface (cli, telegram, daemon) spawned the process. |
| `ASCIINEMA_REC` | boolean |  |  | `1` | Set to 1 by asciinema rec while a session is being recorded. Triggers capture-mode. |
| `CI` | string |  |  | `true` | Standard CI-detection convention. Auto-set by GitHub Actions, CircleCI, etc. Used to switch off TTY-only UX. |
| `FORCE_COLOR` | string |  |  | `1` | Standard Node convention. Force-enable ANSI color output even when stdout is not a TTY. |
| `HOME` | string |  |  |  | Standard Unix home directory. Used as the fallback when AFK_HOME is unset. |
| `NO_COLOR` | string |  |  | `1` | Standard convention (https://no-color.org). When set to any non-empty value, disables ANSI color output. |
| `NO_UPDATE_NOTIFIER` | boolean |  |  |  | Disable the update-available notifier on CLI startup. Standard convention shared with many Node CLIs. |
| `NODE_ENV` | string |  |  | `production` | Standard Node environment marker. test \| development \| production. Used by routing-telemetry.ts to suppress test-time writes. |
| `PAGER` | string |  |  | `less -R` | Standard POSIX env var naming the user's preferred pager (with optional flags). Used by /transcript to render the full session in a scrollable viewer; falls back to `less -R` when unset. |
| `PATH` | string |  |  |  | System PATH. Read for executable resolution (git, gh, etc.) in tool handlers. |
| `SCRIPT` | string |  |  | `/tmp/typescript` | Set by script(1) on BSD/macOS/Linux to the typescript filename while a terminal session is being recorded. Presence of a non-empty value triggers capture-mode. |
| `SHELL` | string |  |  | `/bin/zsh` | Standard POSIX env var pointing to the user's login shell binary. Used by shell-init and worktree commands to auto-detect the correct shell syntax for emitted wrapper code. |
| `VITEST` | string |  |  |  | Set automatically by Vitest. Used at runtime to short-circuit code paths that should not fire in tests. |

## Misc

| Name | Type | Required | Default | Example | Description |
|------|------|----------|---------|---------|-------------|
| `AFK_BANNER_PLAIN` | boolean |  |  | `1` | Suppress the ANSI-colored banner at REPL startup. Useful for non-TTY captures and CI logs. |
| `AFK_DEMO_CLEAN` | boolean |  |  | `1` | Explicit opt-in to capture-mode. When set to 1, suppresses high-frequency repaint drivers (spinner ticker, live thinking-preview) so recorded artifacts contain each state once instead of once per timer tick. |
| `AFK_DIFF_LINES` | number |  |  | `50` | Maximum number of diff lines shown in the inline diff render during write_file tool calls. Set to 0 for no cap. Non-integer values are silently ignored and the default applies. |
| `AFK_GOBLIN_SPINNER` | boolean |  |  | `0` | Goblin-themed working spinner (olive frames + goblin verbs) while the agent runs tools. 1 = on (default), 0 = classic dim spinner. |
| `AFK_MEMORY_EVIDENCE_GATE` | boolean |  |  | `1` | Opt-in (set to 1) evidence gate for durable memory writes. When enabled, a codebase fact (memory_update category "convention") stored without an `evidence` citation is recalled as [unverified], and memory_search results carry a verification verdict. User preferences and agent reflections are never gated. Default off — memory behaves identically to legacy when unset. |
| `AFK_SHELL_PASSTHROUGH` | boolean |  | `1` | `0` | Enable the interactive REPL `!cmd` / `!&cmd` shell-passthrough feature. On by default. Set to 0, false, off, or no (case-insensitive) to disable, so inputs beginning with ! are sent to the model as literal text instead of being executed as shell commands. Equivalent to the --no-shell-passthrough flag. |
| `AFK_SHOW_DIFFS` | boolean |  |  |  | Show inline diffs in the tool-lane output for edit/write tool calls. 1 = on, 0 = off. |
| `AFK_SPINNER_TIPS` | boolean |  |  |  | Show rotating tips in the loading spinner during long calls. 1 = on, 0 = off. |
| `AFK_USER_CARD_MAX_ROWS` | number |  |  | `24` | Maximum number of visual rows emitted by renderUserCard before collapsing the remainder into a dim "…(N lines collapsed)" summary row. Defaults to 24. Non-integer or non-positive values are silently ignored and the default applies. |
| `AFK_WRITE_DENYLIST` | string |  |  | `**/.env,**/secrets/**` | Comma-separated list of additional path globs that the write_file tool refuses to write to. |
| `AFK_WRITE_DIFF` | boolean |  |  |  | Show a diff preview before each write_file tool call. Defaults provider-controlled when unset. |
