/**
 * Filesystem, rate-limit, web-egress, CLI/capture-mode, session-identity,
 * and CLI/shell-integration env vars. A contiguous slice of `ENV_REGISTRY`.
 *
 * Extracted from `env.ts` to keep that file within the 350-code-line ceiling.
 * `env.ts` spreads this tuple into `ENV_REGISTRY` at the appropriate position.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.misc
 */

import type { EnvVarMeta } from './env.js';

export const MISC_ENV_REGISTRY = [
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
    name: 'AFK_READ_DENYLIST',
    description: 'Colon-separated list of additional absolute paths the read_file/grep/glob/list_directory tools refuse to read, and that the bash-restriction hook refuses to let a shell command reference on interactive surfaces (REPL, Telegram) — on headless surfaces (afk chat, daemon) bash fails open regardless of this list. A leading ~/ is expanded (~user/ is not — spell those absolutely). Built-in credential entries (~/.ssh, ~/.aws, ~/.afk/config, …) always apply on top and cannot be removed. Built-in READ-only exceptions: ~/.afk/config/mcp.json (the MCP registry), ~/.afk/config/schedules.json, ~/.ssh/config, ~/.ssh/known_hosts, and SSH public keys (direct *.pub children of ~/.ssh, symlink-resolved). Paths listed here outrank every exception — e.g. set this to ~/.afk/config/mcp.json if your registry holds inline secrets rather than ${VAR} placeholders, or to ~/.ssh to re-deny all of ~/.ssh. Bash honors the exceptions only for provably read-only commands (cat/grep/head/… pipelines with no redirection); writes stay blocked on every surface.',
    type: 'string',
    required: false,
    example: '/Users/me/project/.env:/Users/me/secrets',
    category: 'misc',
  },
  {
    name: 'AFK_WRITE_DIFF',
    description: 'Show a diff preview before each write_file tool call. Defaults provider-controlled when unset.',
    type: 'boolean',
    required: false,
    category: 'misc',
  },

  // ── Rate-limit admission control ──────────────────────────────────────────
  {
    name: 'AFK_RATE_LIMIT_ADMISSION_DISABLED',
    description: 'Bypass the process-wide rate-limit admission gate (issue #941). Set to 1 to skip pre-request capacity checks. Default 0 (gate active). OAuth subscription accounts already pass through automatically when no per-minute headers are returned.',
    type: 'boolean',
    required: false,
    default: '0',
    example: '1',
    category: 'model',
  },
  {
    name: 'AFK_USAGE_LEDGER_DISABLED',
    description: 'Set to 1 to stop publishing/reading the cross-process usage ledger (namespace `usage` in state/kv/kv.db). Usage surfaces (`afk usage`, get_runtime_state, fan-out notice, daemon budget gate) then see only this process\'s in-memory quota cache. Default 0 (ledger active).',
    type: 'boolean',
    required: false,
    default: '0',
    example: '1',
    category: 'model',
  },
  {
    name: 'AFK_RATE_LIMIT_STAGGER_MAX_MS',
    description: 'Jitter ceiling (ms) for the rate-limit admission bucket: each waiter at a window boundary wakes at reset + random(0..ceiling) to avoid re-storming the API. Default 500. Set to 0 in tests for deterministic timing.',
    type: 'number',
    required: false,
    default: '500',
    example: '0',
    category: 'model',
  },

  // ── Web egress ────────────────────────────────────────────────────────────
  {
    name: 'AFK_WEB_ALLOW_PRIVATE_HOSTS',
    description:
      'Opt out of the web_scrape SSRF egress guard. When unset (default) the guard is ACTIVE: ' +
      'the markdown, raw, and headless-render paths refuse loopback (127/8, ::1), link-local ' +
      '(169.254/16 — including the 169.254.169.254 cloud instance-metadata endpoint), RFC1918 ' +
      '(10/8, 172.16/12, 192.168/16), carrier-grade NAT (100.64/10), IPv6 unique-local (fc00::/7), ' +
      '0.0.0.0/8, and the IPv4-mapped/compatible IPv6 forms of all of those. Hostnames are ' +
      'resolved and the RESOLVED addresses are classified (DNS-rebinding guard), and the check is ' +
      're-applied on every redirect hop. Set to 1/true to allow private-host access — needed only ' +
      'to scrape a local dev server. Enabling it restores a model-reachable SSRF path (issue #575).',
    type: 'boolean',
    required: false,
    example: '1',
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
    name: 'VISUAL',
    description: 'Standard POSIX env var naming the user\'s preferred full-screen editor (with optional flags). Consulted FIRST by the /editor slash command (and its key chord) to compose a long prompt externally; takes precedence over EDITOR. No fallback editor is assumed — if neither VISUAL nor EDITOR is set, /editor prints a hint instead of guessing.',
    type: 'string',
    required: false,
    example: 'nvim',
    category: 'process',
  },
  {
    name: 'EDITOR',
    description: 'Standard POSIX env var naming the user\'s preferred editor (with optional flags). Consulted by the /editor slash command AFTER VISUAL, as the standard fallback. No default editor is assumed when both are unset — /editor prints a hint telling the user to set one.',
    type: 'string',
    required: false,
    example: 'vim',
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
  {
    name: 'AFK_LEASE_TTL_MS',
    description:
      'Lease TTL in milliseconds for durable task execution (issue #1411). ' +
      'A leased task whose lease expires before it completes is recovered and re-enqueued ' +
      '(or dead-lettered if maxAttempts is exhausted). Default: 600000 (10 minutes).',
    type: 'number',
    required: false,
    example: '600000',
    category: 'misc',
  },
  {
    name: 'AFK_STOP_HOOK_MAX_CONTINUATIONS',
    description:
      'Maximum number of same-turn continuation rounds a blocking Stop hook may trigger ' +
      'before the turn ends normally (issue #2714). Each continuation re-enters the model ' +
      'loop with the block reason as a framework user message, giving the agent another ' +
      'chance to address the hook. 0 disables continuation entirely (the turn ends on ' +
      'first block). Default: 2.',
    type: 'number',
    required: false,
    default: '2',
    example: '3',
    category: 'misc',
  },
  {
    name: 'AFK_PREEXISTING_LEDGER_DISABLE',
    description:
      'Set to 1 to disable the pre-existing-defect SessionEnd hook. ' +
      'When set, the hook will not scan session turns or append records to ' +
      '~/.afk/agent-framework/preexisting-ledger.jsonl. ' +
      'Useful in test environments or when the ledger is not desired.',
    type: 'boolean',
    required: false,
    example: '1',
    category: 'debug',
  },
  {
    name: 'AFK_SDK_SURFACE_WARN',
    description:
      'Controls the one-time warning emitted when an SDK session ' +
      '(AgentSession / query() / queryText()) discovers skills but has no ' +
      'skillExecutor wired, meaning the model cannot invoke them. ' +
      'Set to 0 to silence the warning (useful when the reduced surface is intentional).',
    type: 'string',
    required: false,
    example: '0',
    category: 'misc',
  },
  {
    name: 'AFK_READONLY_GIT_TOOL',
    description:
      'Opt-in (#3754). When set to 1/true/yes/on, read-only child agents (read-only ' +
      'skills such as ground-state, named agents with `bash: read-only` such as ' +
      'git-investigator, and compose nodes running such agents) lose the generic `bash` ' +
      'tool and get the structured `git_read` tool instead (status, log, diff, show, ' +
      'grep, tag/branch listing, blame, ls-files; argv-only, fixed option allowlist). ' +
      'Top-level sessions (no tool allowlist) also see `git_read` while set. ' +
      'Default: off (read-only children keep classifier-gated bash).',
    type: 'boolean',
    required: false,
    default: '0',
    example: '1',
    category: 'misc',
  },
  {
    name: 'AFK_REMOTE_DEPTH',
    description:
      'Set to 1 by the remote_agent tool on every afk run it launches on another host over SSH ' +
      '(inlined into the remote command, since sshd drops forwarded env by default). When set to ' +
      'a non-empty value other than 0, remote_agent refuses to dispatch, so a remote agent can ' +
      'never fan out to further hosts. Not meant to be set by hand.',
    type: 'string',
    required: false,
    example: '1',
    category: 'misc',
  },
  {
    name: 'AFK_STEER_MODE',
    description:
      'Controls when a typed-ahead REPL message is delivered to the model during a multi-round ' +
      'turn. "boundary" (opt-in): drain the compositor queue at every tool-round boundary, so a ' +
      'correction typed during tool execution reaches the model on the NEXT tool round rather than ' +
      'waiting for the whole turn to end. "turn-end" (default): existing behaviour — the message ' +
      'is delivered as its own turn once the current turn finishes. The "boundary" mode is gated ' +
      'behind this env var during soak (issue #3897). Note: the user-yield contract ' +
      '(wait_for / exit_plan_mode) relies on "turn-end" semantics; those tools tell the model ' +
      '"end your turn so the message is delivered first", which is only accurate in "turn-end" ' +
      'mode. In "boundary" mode the message arrives mid-turn and the yield notice is redundant ' +
      'but harmless — the tool still returns early, the model still sees the message.',
    type: 'string',
    required: false,
    default: 'turn-end',
    example: 'boundary',
    category: 'misc',
  },

  // ── Observability / OTLP export ───────────────────────────────────────────
  {
    name: 'AFK_OTLP_ENDPOINT',
    description:
      'OTLP/HTTP endpoint URL for live trace export (e.g. http://localhost:4318/v1/traces). ' +
      'When set, `afk trace export-otlp` POSTs the converted OTLP/JSON payload to this ' +
      'endpoint after converting the witness trace. A dead or unreachable endpoint never ' +
      'blocks or fails the command — the error is printed to stderr and the command still ' +
      'exits 0. Equivalent to passing `--endpoint <url>` on the command line; the flag ' +
      'takes precedence when both are provided.',
    type: 'string',
    required: false,
    example: 'http://localhost:4318/v1/traces',
    category: 'misc',
  },
  {
    name: 'AFK_OTLP_HEADERS',
    description:
      'Comma-separated list of `Key=Value` HTTP headers appended to every OTLP/HTTP push ' +
      'request made by `afk trace export-otlp` when `AFK_OTLP_ENDPOINT` or `--endpoint` ' +
      'is set. Typical use: bearer tokens and tenant identifiers required by managed ' +
      'collectors (e.g. Grafana Cloud, Honeycomb). Values that contain a literal comma must ' +
      'be percent-encoded (%2C). Example: `Authorization=Bearer <tok>,X-Org=acme`.',
    type: 'string',
    required: false,
    example: 'Authorization=Bearer tok123,X-Org=acme',
    category: 'misc',
  },
] as const satisfies readonly EnvVarMeta[];
