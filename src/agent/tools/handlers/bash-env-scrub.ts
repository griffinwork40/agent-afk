/**
 * Scrubs episode-revealing vars from the env handed to bash child processes.
 *
 * AFK_WHATIF_EPISODE must be kept in the parent Node process (the gate reads
 * it from `env.AFK_WHATIF_EPISODE`) but must NOT be visible to shell commands
 * the agent runs with the `bash` tool — otherwise `bash env` reveals the
 * experiment (issue #2425).
 *
 * Usage: wherever bash.ts builds a child env from process.env, wrap it with
 * `scrubBashEnv(env)` before passing to spawn.
 *
 * @module agent/tools/handlers/bash-env-scrub
 */

import { resolveSpawnTmpEnv } from '../../session/session-tmpdir.js';

/** Env vars stripped from every shell child process the agent spawns. */
const BASH_ENV_SCRUB: readonly string[] = ['AFK_WHATIF_EPISODE', 'AFK_WHATIF_TOOL_LOG'];

/**
 * Return a copy of `env` with episode-revealing variables removed.
 * When `env` is undefined, inherit process.env and scrub it.
 */
export function scrubBashEnv(
  env: Record<string, string | undefined> | undefined,
): Record<string, string | undefined> {
  const base: Record<string, string | undefined> =
    env !== undefined ? { ...env } : { ...process.env };
  for (const key of BASH_ENV_SCRUB) {
    delete base[key];
  }
  return base;
}

/**
 * The env for a shell/test child: `process.env` overlaid with the per-session
 * `contextEnv` (e.g. `PLUGIN_ROOT`, the session's private `TMPDIR`/`TMP`/
 * `TEMP`), then scrubbed. The session temp dir is created lazily here; when it
 * cannot be, its keys are dropped and the child inherits the process temp dir.
 */
export function buildChildEnv(
  contextEnv: Record<string, string> | undefined,
): Record<string, string | undefined> {
  const sessionEnv = resolveSpawnTmpEnv(contextEnv);
  return scrubBashEnv(sessionEnv !== undefined ? { ...process.env, ...sessionEnv } : undefined);
}
