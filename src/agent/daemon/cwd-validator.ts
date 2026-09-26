/**
 * Shared validator and runtime guard for per-task working directory paths.
 *
 * Used by schedule-store, tool handlers, web routes, CLI, and the scheduler
 * so validation logic stays in one place and never diverges.
 *
 * @module agent/daemon/cwd-validator
 */

import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { statSync } from 'node:fs';

/**
 * Expand a leading `~/` or a bare `~` to the real home directory, then
 * resolve the result to an absolute path anchored at `process.cwd()` for
 * relative inputs. Home expansion mirrors shell semantics.
 */
export function expandCwd(rawCwd: string): string {
  const home = homedir();
  let expanded = rawCwd;
  if (expanded === '~') {
    expanded = home;
  } else if (expanded.startsWith('~/')) {
    expanded = home + expanded.slice(1);
  }
  return resolve(expanded);
}

/**
 * Validate and normalise a raw `cwd` string supplied by an operator.
 *
 * Steps:
 *  1. Expand `~/` to `$HOME`.
 *  2. Resolve to absolute.
 *  3. Assert the path exists AND is a directory.
 *
 * Returns `{ ok: true; resolved: string }` on success or
 * `{ ok: false; error: string }` on failure — never throws.
 *
 * The resolved (absolute) path is what gets persisted to schedules.json,
 * so tilde entries stored in an older file are transparently normalised
 * when any surface touches them.
 */
export function validateScheduleCwd(
  rawCwd: string,
): { ok: true; resolved: string } | { ok: false; error: string } {
  const resolved = expandCwd(rawCwd);
  let stat: ReturnType<typeof statSync>;
  try {
    stat = statSync(resolved);
  } catch {
    return {
      ok: false,
      error: `cwd path does not exist: ${resolved}`,
    };
  }
  if (!stat.isDirectory()) {
    return {
      ok: false,
      error: `cwd path is not a directory: ${resolved}`,
    };
  }
  return { ok: true, resolved };
}

/**
 * Runtime check: verify a task's pinned cwd still exists and is a directory.
 * Returns an error string when the directory is missing, undefined when healthy.
 *
 * Call at the top of runOnce (before session spawn) so a vanished directory
 * produces a telemetry 'error' record rather than a grep/glob timeout in $HOME.
 * Never silently falls back to process.cwd().
 */
export function checkTaskCwdAtRuntime(cwd: string): string | undefined {
  try {
    const s = statSync(cwd);
    if (!s.isDirectory()) {
      return `per-task cwd is not a directory: ${cwd}`;
    }
    return undefined;
  } catch {
    return `per-task cwd does not exist: ${cwd}`;
  }
}
