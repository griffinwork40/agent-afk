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
    description: 'Colon-separated list of additional absolute paths the read_file/grep/glob/list_directory tools refuse to read, and that the bash-restriction hook refuses to let a shell command reference on interactive surfaces (REPL, Telegram) — on headless surfaces (afk chat, daemon) bash fails open regardless of this list. A leading ~/ is expanded (~user/ is not — spell those absolutely). Built-in credential entries (~/.ssh, ~/.aws, ~/.afk/config, …) always apply on top and cannot be removed. One built-in exception exists: ~/.afk/config/mcp.json (the MCP registry) IS readable — paths listed here outrank that carve-out, so set this to ~/.afk/config/mcp.json if your registry holds inline secrets rather than ${VAR} placeholders.',
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
] as const satisfies readonly EnvVarMeta[];
