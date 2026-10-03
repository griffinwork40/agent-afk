/**
 * Atomic, abort-safe commit step for the `write_file` tool.
 *
 * Contract: after `commitFileWrite` returns or throws, the target holds either
 * its complete previous content (or is still absent) or the complete new
 * content. Never a truncated mix. A plain `writeFile(path, content, { signal })`
 * truncates the target first, so a user interrupt (ESC soft-stop), subagent
 * cancel, or crash mid-write used to leave a partial or zero-byte file.
 *
 * Invariant: an atomic temp+rename must not change what an in-place overwrite
 * would have changed, beyond atomicity. Three properties are preserved:
 *   1. Symlinks: the write goes through to the link's final target. Renaming
 *      over the link path itself would silently replace the symlink with a
 *      regular file.
 *   2. Permission bits: an existing file keeps its exact mode (`exactMode`,
 *      not umask-masked). A new file gets 0o666 masked by the umask, the same
 *      as `writeFile`.
 *   3. Writability, both directions: a file the user cannot write (e.g. 0o444)
 *      still fails, with the same error as before, instead of being replaced
 *      by a rename (which needs only directory permission). And when the
 *      directory refuses a sibling temp file (EACCES/EPERM, or EBUSY on
 *      Windows) but the file itself is writable, fall back to the historical
 *      in-place write so no previously-working write starts failing.
 * Known, accepted difference: rename gives the file a new inode, so hard links
 * to the old file keep the old content, and ownership becomes the writing user.
 *
 * Temp creation, cleanup, and the rename itself live in `utils/atomic-write.ts`
 * (INV-023: no inline atomic-write implementations).
 *
 * @module agent/tools/handlers/write-file.atomic
 */

import { access, constants, lstat, readlink, realpath, stat, writeFile } from 'fs/promises';
import { dirname, resolve } from 'path';
import { atomicWriteFileAsync } from '../../../utils/atomic-write.js';

/** Symlink hops followed for a dangling link before giving up (matches ELOOP). */
const MAX_LINK_HOPS = 40;

/** Read the `code` off a Node fs error, if any. */
function errCode(err: unknown): string | undefined {
  return err instanceof Error && 'code' in err ? String((err as NodeJS.ErrnoException).code) : undefined;
}

/**
 * Resolve the path the bytes should land on: the final target of any symlink
 * chain, or `filePath` itself for a regular or not-yet-existing file.
 */
export async function resolveWriteTarget(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch (err) {
    if (errCode(err) !== 'ENOENT') throw err;
  }
  // ENOENT: either a brand-new file or a DANGLING symlink. `writeFile` would
  // create the link's target, so follow the chain by hand to keep that.
  let current = filePath;
  for (let hop = 0; hop < MAX_LINK_HOPS; hop++) {
    let isLink: boolean;
    try {
      isLink = (await lstat(current)).isSymbolicLink();
    } catch (err) {
      if (errCode(err) === 'ENOENT') return current;
      throw err;
    }
    if (!isLink) return current;
    current = resolve(dirname(current), await readlink(current));
  }
  return current;
}

/**
 * Write `content` to `filePath` atomically, honoring `signal` up to the rename
 * commit point. Creates parent directories as needed.
 */
export async function commitFileWrite(
  filePath: string,
  content: string,
  signal: AbortSignal,
): Promise<void> {
  const target = await resolveWriteTarget(filePath);

  let mode = 0o666;
  let exactMode = false;
  try {
    mode = (await stat(target)).mode & 0o7777;
    exactMode = true;
  } catch (err) {
    if (errCode(err) !== 'ENOENT') throw err;
  }

  // A rename needs only DIRECTORY write permission, so it would silently replace
  // a read-only file that an in-place write refuses. Route an existing file we
  // cannot write through the in-place path so it fails exactly as before.
  if (exactMode && !(await isWritable(target))) return writeInPlace(target, content, signal);

  try {
    await atomicWriteFileAsync(target, content, { mode, exactMode, signal, encoding: 'utf-8', mkdirp: true });
  } catch (err) {
    const code = errCode(err);
    if (signal.aborted || !FALLBACK_CODES.has(code ?? '')) throw err;
    await writeInPlace(target, content, signal);
  }
}

/** Errors from the temp+rename path that the historical in-place write may survive. */
const FALLBACK_CODES = new Set(['EACCES', 'EPERM', 'EBUSY']);

/** True when the current user may write `target` (honors mode bits / Windows read-only). */
async function isWritable(target: string): Promise<boolean> {
  try {
    await access(target, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Historical in-place write. Not atomic, so it is never aborted midway (that is
 * the truncation this module exists to prevent): either it never starts, or it
 * runs to completion. Keeps "aborted => target unmodified" true.
 */
async function writeInPlace(target: string, content: string, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await writeFile(target, content);
}
