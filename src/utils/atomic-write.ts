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
import { mkdir, writeFile, rename, rm, chmod } from 'node:fs/promises';
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
  /**
   * Async variant only. Aborts the write: forwarded to the temp-file
   * `writeFile`, and re-checked immediately before the `rename` commit point,
   * so an abort at any moment leaves `dest` untouched (old content or absent)
   * and the temp file removed. The abort reason is re-thrown.
   */
  signal?: AbortSignal;
  /**
   * Async variant only. When true, `chmod` the temp file to exactly `mode`
   * before the rename. The `mode` given to file creation is masked by the
   * process umask, so callers preserving an existing file's permission bits
   * (e.g. an editor-style overwrite of a 0o775 script) need this to land the
   * original mode verbatim. Defaults to `false`.
   */
  exactMode?: boolean;
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
    await writeFile(tmp, content, { mode, encoding, flag, ...(opts.signal ? { signal: opts.signal } : {}) });
    if (opts.exactMode) await chmod(tmp, mode);
    // Commit point: an abort that landed after the temp write must not rename.
    opts.signal?.throwIfAborted();
    await rename(tmp, dest);
  } catch (err) {
    // Best-effort cleanup — suppress unlink errors.
    try { await rm(tmp, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}
