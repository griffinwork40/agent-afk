/**
 * Spawn-cwd error enrichment.
 *
 * Node's `spawn()`/`execFile()` with a non-existent `cwd` rejects with an
 * ENOENT that names the BINARY, not the missing directory — e.g.
 * `spawn git ENOENT` / `spawn /bin/sh ENOENT` (err = { code: 'ENOENT',
 * syscall: 'spawn git', path: 'git' }). To an agent (or human) this
 * masquerades as "the binary is missing", triggering pointless retries,
 * when the real cause is usually a deleted working directory (e.g. a git
 * worktree reaped mid-session).
 *
 * This module translates that failure AFTER it happens: `statSync(cwd)` runs
 * only on the error path, so there is no TOCTOU window, no happy-path cost,
 * and no pre-spawn contract change. Callers wire it into their existing
 * catch / `'error'`-event sites.
 *
 * @module utils/spawn-cwd-error
 */

import { statSync } from 'node:fs';

/** Structural shape of a Node spawn ENOENT error (subset we inspect). */
interface SpawnErrorLike {
  code?: unknown;
  syscall?: unknown;
  message?: unknown;
}

/**
 * True when `err` is a spawn-phase ENOENT — the error Node emits both for a
 * genuinely missing binary AND for a missing `cwd` (indistinguishable by the
 * error object alone; disambiguated by {@link cwdIsMissing}).
 */
export function isSpawnEnoent(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const e = err as SpawnErrorLike;
  return (
    e.code === 'ENOENT' &&
    typeof e.syscall === 'string' &&
    e.syscall.startsWith('spawn')
  );
}

/**
 * True when `cwd` is defined and does not exist (or is unreachable) on disk
 * at the moment of the check. Runs `statSync` — call only on error paths.
 */
export function cwdIsMissing(cwd: string | undefined): boolean {
  if (cwd === undefined) return false;
  try {
    statSync(cwd);
    return false;
  } catch {
    return true;
  }
}

/**
 * Return an enriched, actionable message when `err` is a spawn ENOENT whose
 * real cause is a dead working directory; otherwise return the original
 * error message unchanged.
 *
 * Contract: pure translation — never throws, never mutates `err`, and only
 * touches the filesystem (statSync) when the error already matched the
 * spawn-ENOENT shape.
 */
export function describeSpawnCwdError(err: unknown, cwd: string | undefined): string {
  const original =
    err instanceof Error
      ? err.message
      : typeof (err as SpawnErrorLike)?.message === 'string'
        ? String((err as SpawnErrorLike).message)
        : String(err);

  if (isSpawnEnoent(err) && cwdIsMissing(cwd)) {
    return `working directory does not exist: ${cwd} (deleted worktree?) — underlying: ${original}`;
  }
  return original;
}
