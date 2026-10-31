/**
 * Bash sandbox env vars — opt-in OS-level process isolation.
 *
 * A contiguous slice of `ENV_REGISTRY`. Extracted as a sub-module so
 * `env.ts` stays within the 350-code-line ceiling.
 *
 * Contract: this file declares data only. It must never read `process.env`
 * (the single read-point stays `env.ts`, enforced by `pnpm audit:env:check`),
 * and it imports `EnvVarMeta` as a type only so there is no runtime cycle.
 *
 * @module config/env.sandbox
 */

import type { EnvVarMeta } from './env.js';

export const SANDBOX_ENV_REGISTRY = [
  // ── OS-level bash sandbox (issue #3845) ──────────────────────────────────
  {
    name: 'AFK_BASH_SANDBOX',
    description:
      'Opt-in OS-level filesystem write sandbox for foreground bash invocations. ' +
      'Accepted values:\n' +
      '  workspace-write  – allow reads everywhere; writes confined to the ' +
      'effective cwd/worktree and actual child TMPDIR (TMP/TEMP fallback). ' +
      'The complete write-denylist floor (including relocated AFK paths and ' +
      'custom entries) remains protected; Linux refuses grants overlapping ' +
      'protected paths in either direction, including symlink aliases and absent leaves. ' +
      'Network is unrestricted by default.\n' +
      '  read-only        – deny regular-file writes everywhere; narrow standard ' +
      'device IO remains available for process/git functionality.\n' +
      '  off              – disable the sandbox even if a parent session ' +
      'enabled it (inheriting contexts only).\n' +
      'Platform support: macOS uses sandbox-exec (deprecated API, still ' +
      'functional as of macOS 15). Linux requires bwrap (bubblewrap); there is ' +
      'no Landlock fallback. Windows and unsupported platforms refuse the spawn. ' +
      'Background bash spawning is not covered yet; do not use this setting ' +
      'as a sandbox for run_in_background commands. Reads and network access ' +
      'are not restricted. This is not a VM boundary: pre-existing hardlinks, ' +
      'bind-mount aliases and concurrent host topology changes are not covered. ' +
      'When explicitly set but the sandbox mechanism is unavailable, the ' +
      'spawn is REFUSED rather than ' +
      'silently running unsandboxed (fail-closed). ' +
      'Unset (default): sandbox disabled; existing string-based path guards ' +
      'remain active. Do not set this to make security claims before measuring ' +
      'real-world soak data — the string guards remain the primary line for ' +
      'accidental-access prevention.',
    type: 'string',
    required: false,
    example: 'workspace-write',
    category: 'misc',
  },
] as const satisfies readonly EnvVarMeta[];
