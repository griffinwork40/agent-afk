/**
 * Daemon, web UI, worktree management, routing/behavior, and bash-preview
 * env vars. A contiguous slice of `ENV_REGISTRY`.
 *
 * Extracted from `env.ts` to keep that file within the 350-code-line ceiling.
 * `env.ts` spreads this tuple into `ENV_REGISTRY` at the appropriate position.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.daemon
 */

import type { EnvVarMeta } from './env.js';

export const DAEMON_ENV_REGISTRY = [
  // ── Daemon ────────────────────────────────────────────────────────────────
  {
    name: 'AFK_DAEMON_BUDGET_GATE_DISABLED',
    description: 'Set to 1 to disable the subscription-usage budget gate for daemon/cron agent tasks. When unset (default) the daemon checks Claude subscription utilization before starting each agent task and skips the run if any window is at or above AFK_DAEMON_BUDGET_SKIP_PCT. Shell and builtin tasks are never gated regardless of this setting.',
    type: 'boolean',
    required: false,
    default: '0',
    example: '1',
    category: 'daemon',
  },
  {
    name: 'AFK_DAEMON_BUDGET_SKIP_PCT',
    description: 'Subscription-usage skip threshold (0–100 integer) for the daemon budget gate. When any Claude subscription window\'s utilization is at or above this percentage, scheduled agent tasks are skipped with a Telegram notice. Default 90 (90%). Set to 100 to disable the gate entirely (no usage fetch is made and every task passes). Requires AFK_DAEMON_BUDGET_GATE_DISABLED=0 (default).',
    type: 'number',
    required: false,
    default: '90',
    example: '80',
    category: 'daemon',
  },
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
  {
    name: 'AFK_DAEMON_SHELL_TIMEOUT_MS',
    description: 'Wall-clock timeout in milliseconds for executor:shell scheduled tasks. Defaults to 2700000 (45 minutes), matching the agent executor budget (AFK_SUBAGENT_TIMEOUT_MS). The child process is killed on timeout; the telemetry errorMessage will read "daemon shell timeout after NNNs" to distinguish a daemon-imposed kill from a process or network failure.',
    type: 'number',
    required: false,
    category: 'daemon',
  },
  {
    name: 'AFK_TOOL_HEALTH_DISABLE',
    description:
      'Disable the tool-health daemon builtin entirely. Set to "1" to skip registration.',
    type: 'boolean',
    required: false,
    category: 'daemon',
  },

  // ── Web UI (`afk web`) ────────────────────────────────────────────────────
  {
    name: 'AFK_WEB_PORT',
    description: 'Port for the `afk web` browser surface. Defaults to 4141; falls back to an ephemeral port when taken. Overridden by --port.',
    type: 'number',
    required: false,
    example: '4141',
    category: 'daemon',
  },
  {
    name: 'AFK_WEB_HOST',
    description: 'Bind address for the `afk web` browser surface. Defaults to 127.0.0.1. Unlike the daemon control surface, a non-loopback bind is REFUSED unless AFK_WEB_TOKEN (or --token) is also set, because this surface can submit prompts and approve tool use. Overridden by --host.',
    type: 'string',
    required: false,
    example: '127.0.0.1',
    category: 'daemon',
  },
  {
    name: 'AFK_WEB_TOKEN',
    description: 'Bearer token for the `afk web` surface. When unset, a random per-run token is minted and printed in the startup URL. Setting this explicitly is also what permits a non-loopback bind.',
    type: 'string',
    required: false,
    category: 'daemon',
    secret: true,
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
    name: 'AFK_WORKTREE_ON_EXIT',
    description: 'Clean-worktree quit policy for interactive --worktree sessions: ask, keep, or remove.',
    type: 'string',
    required: false,
    example: 'ask',
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

  // ── Routing / behavior ────────────────────────────────────────────────────
  {
    name: 'AFK_AUTO_ROUTING',
    description: 'Auto-route bare slash inputs to matching skills. Applies to interactive, chat, and telegram surfaces.',
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
  {
    name: 'AFK_BG_AUTO_DELIVER',
    description:
      'Auto-deliver background subagent results into the model context on the next user turn (interactive REPL). On by default. Set to 0, false, off, or no (case-insensitive) to disable, restoring the manual /bgsub:join retrieval flow.',
    type: 'boolean',
    required: false,
    default: '1',
    example: '0',
    category: 'misc',
  },

  // ── Bash preview ─────────────────────────────────────────────────────────
  {
    name: 'AFK_BASH_PREVIEW_HEAD_LINES',
    description:
      'Number of leading non-empty lines shown in the bash output head block of the TUI outcome ' +
      'preview. 0 (default) disables the head block entirely. Accepted range 0–200; ' +
      'non-integer, negative, or out-of-range input falls back to the default. ' +
      'When head + tail >= total non-empty lines, all lines are shown without a hidden-line notice. ' +
      'Keep preview preferences separate from model-context caps (AFK_BASH_PREVIEW_TAIL_LINES).',
    type: 'number',
    required: false,
    default: '0',
    example: '3',
    category: 'misc',
  },
  {
    name: 'AFK_BASH_PREVIEW_TAIL_LINES',
    description:
      'Number of trailing non-empty lines shown in the bash output tail block of the TUI outcome ' +
      'preview. Default 7 (compact tail-first preview). Accepted range 0–200; ' +
      'non-integer, negative, or out-of-range input falls back to the default. ' +
      'When head + tail >= total non-empty lines, all lines are shown without a hidden-line notice. ' +
      'Keep preview preferences separate from model-context caps (AFK_BASH_PREVIEW_HEAD_LINES).',
    type: 'number',
    required: false,
    default: '7',
    example: '10',
    category: 'misc',
  },
] as const satisfies readonly EnvVarMeta[];
