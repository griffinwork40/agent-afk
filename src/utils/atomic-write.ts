/**
 * Atomic file write utility: write a sibling temp file, then `rename` it over
 * the target. `rename(2)` is atomic on a single filesystem (POSIX + NTFS), so
 * a crash mid-write can never leave a half-written target file.
 *
 * Invariant: the temp file must reside in the same directory as the target so
 * that the rename is intra-filesystem. All temp paths are derived from the
 * target's directory to guarantee this.
 *
 * # Options
 *
 * - `mode` (default `0o600`) — file permission bits for the temp file. Carried
 *   through to the final file by the rename, so the target is never
 *   world-readable even transiently.
 * - `secure` (default `false`) — when `true`, open the temp file with
 *   `O_EXCL` (`flag: 'wx'`). Prevents the write from silently overwriting a
 *   leftover temp file from a previous failed run. Useful when the caller
 *   manages rollback externally (e.g. systemd install.ts).
 * - `encoding` (default `'utf-8'`) — character encoding for the content string.
 * - `mkdirp` (default `true`) — create parent directories if they do not exist.
 *
 * # Error handling
 *
 * Both sync and async forms throw on failure. On failure, a best-effort
 * cleanup removes the temp file (unlink errors are silently swallowed — the
 * temp file leaving behind is cosmetic, not a correctness concern).
 *
 * # Async vs sync
 *
 * `atomicWriteFile` — synchronous; safe for module-init paths and CLI commands
 * where blocking I/O is acceptable.
 *
 * `atomicWriteFileAsync` — async; suitable for hot paths in long-running daemons
 * where blocking the event loop is undesirable.
 *
 * @module utils/atomic-write
 */

import {
  existsSync,
  mkdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'fs';
import { rename, unlink, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { randomBytes } from 'crypto';

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------

export interface AtomicWriteOptions {
  /**
   * File permission bits for the written file.
   * Applies to the temp file before rename; the final file inherits the same
   * bits via the rename so it is never transiently more permissive.
   * @default 0o600
   */
  mode?: number;
  /**
   * When `true`, open the temp file with `O_EXCL` (`flag: 'wx'`).
   * Use this when the caller requires that the temp file must NOT already
   * exist (e.g. install scripts where a leftover `.tmp` should be an error,
   * not silently overwritten).
   * @default false
   */
  secure?: boolean;
  /**
   * Character encoding for the content string.
   * @default 'utf-8'
   */
  encoding?: BufferEncoding;
  /**
   * When `true`, create parent directories with `{ recursive: true }` before
   * writing. When `false`, assumes the directory already exists.
   * @default true
   */
  mkdirp?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Generate a collision-resistant temp file path in the same directory as
 * `targetPath`. Uses `pid + randomBytes` so concurrent writes from different
 * processes or simultaneous calls within the same process each get a distinct
 * name.
 */
function makeTempPath(targetPath: string): string {
  const nonce = randomBytes(4).toString('hex');
  return join(dirname(targetPath), `.${nonce}-${process.pid}.tmp`);
}

/**
 * Resolve option defaults, returning a fully-specified options object.
 */
function resolveOpts(opts: AtomicWriteOptions | undefined): Required<AtomicWriteOptions> {
  return {
    mode: opts?.mode ?? 0o600,
    secure: opts?.secure ?? false,
    encoding: opts?.encoding ?? 'utf-8',
    mkdirp: opts?.mkdirp ?? true,
  };
}

// ---------------------------------------------------------------------------
// Synchronous API
// ---------------------------------------------------------------------------

/**
 * Atomically write `content` to `filePath` (synchronous).
 *
 * 1. Optionally create parent directories (`mkdirp: true`, default).
 * 2. Write `content` to a temp file in the same directory.
 * 3. `renameSync` the temp over the target.
 * 4. On any failure, attempt to clean up the temp file, then re-throw.
 *
 * @param filePath - Absolute or relative path to write.
 * @param content  - String content to write.
 * @param opts     - See {@link AtomicWriteOptions}.
 */
export function atomicWriteFile(
  filePath: string,
  content: string,
  opts?: AtomicWriteOptions,
): void {
  const { mode, secure, encoding, mkdirp } = resolveOpts(opts);
  if (mkdirp) {
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const tmp = makeTempPath(filePath);
  try {
    writeFileSync(tmp, content, {
      encoding,
      mode,
      ...(secure ? { flag: 'wx' } : {}),
    });
    renameSync(tmp, filePath);
  } catch (err) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      /* ignore — temp file cleanup is best-effort */
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Asynchronous API
// ---------------------------------------------------------------------------

/**
 * Atomically write `content` to `filePath` (asynchronous).
 *
 * Identical contract to `atomicWriteFile` but uses `fs/promises` throughout.
 * Prefer this on long-lived daemon paths where blocking the event loop matters.
 *
 * @param filePath - Absolute or relative path to write.
 * @param content  - String content to write.
 * @param opts     - See {@link AtomicWriteOptions}.
 */
export async function atomicWriteFileAsync(
  filePath: string,
  content: string,
  opts?: AtomicWriteOptions,
): Promise<void> {
  const { mode, secure, encoding, mkdirp } = resolveOpts(opts);
  if (mkdirp) {
    // mkdirSync is fine here; directory creation is a one-time cheap op and
    // fs/promises has no mkdirAsync with recursive that is materially faster.
    mkdirSync(dirname(filePath), { recursive: true });
  }
  const tmp = makeTempPath(filePath);
  try {
    await writeFile(tmp, content, {
      encoding,
      mode,
      ...(secure ? { flag: 'wx' } : {}),
    });
    await rename(tmp, filePath);
  } catch (err) {
    try {
      await unlink(tmp);
    } catch {
      /* ignore — temp file cleanup is best-effort */
    }
    throw err;
  }
}
