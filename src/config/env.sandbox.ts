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
      'Opt-in OS-level sandbox for every bash tool invocation. ' +
      'Accepted values:\n' +
      '  workspace-write  – allow reads everywhere; writes confined to the ' +
      'session cwd/worktree and the OS temp dir. ' +
      'Credential paths from the write-denylist floor are always denied. ' +
      'Network is unrestricted by default.\n' +
      '  read-only        – deny all writes (implies workspace-write plus ' +
      'no-write-anywhere). Use for fully read-only recon subagents.\n' +
      '  off              – disable the sandbox even if a parent session ' +
      'enabled it (inheriting contexts only).\n' +
      'Platform support: macOS uses sandbox-exec (deprecated API, still ' +
      'functional as of macOS 15). Linux uses bwrap (bubblewrap) when on PATH, ' +
      'Landlock otherwise. ' +
      'Windows: this variable is accepted but the sandbox is a no-op with a ' +
      'warning — bash runs unsandboxed on Windows regardless of this setting. ' +
      'When explicitly set but the sandbox mechanism is unavailable (bwrap not ' +
      'found, Landlock kernel too old), the spawn is REFUSED rather than ' +
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
