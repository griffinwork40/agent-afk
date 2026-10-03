/**
 * Atomic file-write utilities shared across agent-afk.
 *
 * Both a synchronous (`atomicWriteFile`) and an asynchronous
 * (`atomicWriteFileAsync`) variant are exported so callers with different
 * concurrency models can share the same implementation.
 *
 * # Why atomic writes
 *
 * `writeFileSync` / `writeFile` truncate the destination before writing.  A
 * crash or SIGKILL between the truncate and the final byte leaves a corrupt
 * (often zero-length) file.  For config files, lease records, and any data
 * where partial content is worse than stale content, the safe pattern is:
 *
 *   1. Write to a sibling temp file in the same directory.
 *   2. `rename(tmp, dest)` — atomic on POSIX and NTFS on the same filesystem.
 *
 * The temp file and the destination share a directory by construction so the
 * rename is always same-filesystem.
 *
 * # Temp file naming
 *
 * Names use `crypto.randomBytes(6)` (48 bits of entropy).  This avoids two
 * failure modes:
 *   - `Date.now()` alone: concurrent writes within the same millisecond share
 *     a temp name and the later write silently discards the earlier one.
 *   - `process.pid + Date.now()`: safe within a process, but not across forked
 *     children with the same PID (rare but possible) or across machines sharing
 *     a network filesystem.
 *
 * # Cleanup
 *
 * The temp file is cleaned up in a `finally` block using best-effort
 * semantics — the unlink error is suppressed because the rename may already
 * have succeeded and the target path no longer exists, or another process may
 * have removed it concurrently.  The original error from the write/rename is
 * always re-thrown.
 *
 * @module utils/atomic-write
 */

import { mkdirSync, writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { mkdir, writeFile, rename, rm } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AtomicWriteOptions {
  /**
   * POSIX file-creation mode bits applied to the temp file before rename.
   * Defaults to `0o600` (owner read/write only) so secrets are not briefly
   * world-readable while the temp file exists.
   */
  mode?: number;
  /**
   * Character encoding for string content.  Defaults to `'utf-8'`.
   */
  encoding?: BufferEncoding;
  /**
   * When true, create the destination's parent directory (and any missing
   * ancestors) before writing.  Defaults to `true`.
   */
  mkdirp?: boolean;
  /**
   * When true, open the temp file with `O_EXCL` (`flag: 'wx'`) so a
   * pre-existing temp path (e.g. from a prior interrupted write) causes an
   * immediate `EEXIST` error rather than silently overwriting it.
   *
   * The random temp-name already makes collisions vanishingly rare, but callers
   * where a stale tmp surviving a crash represents a security concern (e.g. a
   * service unit file that embeds credentials) can opt in explicitly.
   *
   * Defaults to `false`.
   */
  secure?: boolean;
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/**
 * Generate a collision-resistant temp file path adjacent to `dest`.
 *
 * Invariant: the temp path is in the same directory as `dest` so the
 * subsequent rename is always same-filesystem and therefore atomic.
 */
function makeTmpPath(dest: string): string {
  const dir = dirname(dest);
  const hex = randomBytes(6).toString('hex');
  return join(dir, `.tmp-${hex}`);
}

/**
 * Transient error codes emitted by Windows when a concurrent rename targets
 * the same destination file.  On POSIX, `rename(2)` is guaranteed atomic and
 * these codes never appear; on POSIX these codes signal permanent conditions
 * (unwritable directory, mount boundary) and must NOT be retried.
 *
 * - `EPERM`  (-4048): most common; destination briefly locked by the winner.
 * - `EACCES` (-4092): alternative Windows access-denied code.
 * - `EBUSY`  (-4082): file in use by another process during the rename window.
 */
const WIN_RENAME_TRANSIENT = new Set(['EPERM', 'EACCES', 'EBUSY']);

/**
 * Attempt `rename(tmp, dest)`, retrying up to `maxRetries` times on transient
 * Windows errors (EPERM / EACCES / EBUSY).  Each retry waits an exponentially
 * increasing delay (10 ms, 20 ms, 40 ms …) so callers converge quickly.
 *
 * Contract: the retry path is ONLY activated on Windows (`_platform === 'win32'`).
 * On POSIX, EPERM/EACCES/EBUSY indicate permanent error conditions and are
 * re-thrown immediately without retry.
 *
 * @param _platform  - Injected platform string; defaults to `process.platform`.
 *                     Pass a literal string in tests to exercise both branches
 *                     portably without skipping by host platform (repo rule R4).
 * @param _renameFn  - Injectable rename implementation.  Defaults to the real
 *                     `fs/promises.rename`.  Tests pass a simple mock function
 *                     so they never need to spy on a non-configurable ES module
 *                     export.
 */
export async function renameWithRetry(
  tmp: string,
  dest: string,
  maxRetries = 5,
  _platform: string = process.platform,
  _renameFn: (from: string, to: string) => Promise<void> = rename,
): Promise<void> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      await _renameFn(tmp, dest);
      return;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Invariant: only retry transient Windows rename races; on POSIX these
      // codes are permanent and must propagate immediately.
      if (_platform !== 'win32' || !WIN_RENAME_TRANSIENT.has(code ?? '')) throw err;
      lastErr = err;
      // Skip the sleep on the final attempt — we are about to throw anyway.
      if (attempt < maxRetries) await sleep(10 * 2 ** attempt);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Synchronous variant
// ---------------------------------------------------------------------------

/**
 * Write `content` to `dest` atomically: write to a sibling temp file, then
 * `rename` it over the target.  The rename is atomic on POSIX and NTFS within
 * a single filesystem — a crash mid-write never leaves a half-written file.
 *
 * @param dest    - Absolute path of the destination file.
 * @param content - String (or Buffer) to write.
 * @param opts    - Optional mode, encoding, and mkdirp flag.
 */
export function atomicWriteFile(
  dest: string,
  content: string | Buffer,
  opts: AtomicWriteOptions | number = {},
): void {
  // Support legacy positional `mode` param (envFile.ts compatibility).
  const resolvedOpts: AtomicWriteOptions =
    typeof opts === 'number' ? { mode: opts } : opts;

  const mode = resolvedOpts.mode ?? 0o600;
  const encoding = resolvedOpts.encoding ?? 'utf-8';
  const mkdirp = resolvedOpts.mkdirp ?? true;
  const flag = resolvedOpts.secure ? 'wx' : 'w';

  if (mkdirp) {
    mkdirSync(dirname(dest), { recursive: true });
  }

  const tmp = makeTmpPath(dest);
  try {
    writeFileSync(tmp, content, { mode, encoding, flag });
    renameSync(tmp, dest);
  } catch (err) {
    // Best-effort cleanup — suppress unlink errors.
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Asynchronous variant
// ---------------------------------------------------------------------------

/**
 * Async version of {@link atomicWriteFile}.  Write `content` to `dest`
 * atomically via a sibling temp file and `rename`.
 *
 * @param dest    - Absolute path of the destination file.
 * @param content - String (or Buffer) to write.
 * @param opts    - Optional mode, encoding, and mkdirp flag.
 */
export async function atomicWriteFileAsync(
  dest: string,
  content: string | Buffer,
  opts: AtomicWriteOptions = {},
): Promise<void> {
  const mode = opts.mode ?? 0o600;
  const encoding = opts.encoding ?? 'utf-8';
  const mkdirp = opts.mkdirp ?? true;
  const flag = opts.secure ? 'wx' : 'w';

  if (mkdirp) {
    await mkdir(dirname(dest), { recursive: true });
  }

  const tmp = makeTmpPath(dest);
  try {
    await writeFile(tmp, content, { mode, encoding, flag });
    await renameWithRetry(tmp, dest);
  } catch (err) {
    // Best-effort cleanup — suppress unlink errors.
    try { await rm(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}
