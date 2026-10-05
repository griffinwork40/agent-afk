/**
 * Atomic, abort-safe commit step for the `write_file` tool.
 *
 * Contract: on the temp+rename path, after `commitFileWrite` returns or throws,
 * the target holds either its complete previous content (or is still absent)
 * or the complete new content. Never a truncated mix. The in-place fallback
 * (below) is not atomic: it is never started after an abort, but a failure
 * partway through it (e.g. ENOSPC) can leave the target modified. Only a
 * {@link WriteAbortedUntouchedError} proves the target was not touched.
 * A plain `writeFile(path, content, { signal })` truncates the target first,
 * so a user interrupt (ESC soft-stop), subagent cancel, or crash mid-write
 * used to leave a partial or zero-byte file.
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
 * Thrown by {@link commitFileWrite} when the signal aborted and the target is
 * PROVABLY untouched: the abort was observed before any in-place write began,
 * or the failure came from the temp+rename path (rename is its last step, so
 * any throw there leaves the target as it was). Callers report "not modified"
 * only for this error, never for a bare `signal.aborted`: an in-place
 * `writeFile` that fails partway (e.g. ENOSPC after truncation) while an abort
 * lands concurrently may have changed the target. `signal.reason` can be any
 * value, so this marker, not `err.name === 'AbortError'`, is the contract.
 */
export class WriteAbortedUntouchedError extends Error {
  constructor(readonly target: string, options?: { cause?: unknown }) {
    super(`Aborted; ${target} was not modified`, options);
    this.name = 'WriteAbortedUntouchedError';
  }
}

/**
 * Write `content` to `filePath` atomically, honoring `signal` up to the rename
 * commit point. Creates parent directories as needed.
 *
 * `validateTarget` runs on the resolved write target whenever it differs from
 * `filePath` (a symlink, possibly dangling), BEFORE any mkdir, temp file, or
 * write. The caller's containment/denylist checks only saw the link's own
 * path; this re-check stops a contained link from steering the write (and its
 * `mkdirp`) outside the granted roots. Its throw propagates unwrapped, even if
 * the signal has aborted, so a rejection is never reported as an abort.
 *
 * @throws {WriteAbortedUntouchedError} aborted with the target untouched.
 */
export async function commitFileWrite(
  filePath: string,
  content: string,
  signal: AbortSignal,
  validateTarget?: (target: string) => void,
): Promise<void> {
  const target = await untouchedOnAbort(filePath, signal, () => resolveWriteTarget(filePath));
  if (validateTarget && target !== filePath) validateTarget(target);
  const route = await untouchedOnAbort(filePath, signal, () => commitAtomicOrDefer(target, content, signal));
  if (route === 'in-place') await writeInPlace(target, filePath, content, signal);
}

/** Run a step that cannot touch the target; an abort-time failure becomes the marker. */
async function untouchedOnAbort<T>(filePath: string, signal: AbortSignal, step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (err) {
    if (signal.aborted) throw new WriteAbortedUntouchedError(filePath, { cause: err });
    throw err;
  }
}

/**
 * Commit via temp+rename, or return `'in-place'` when the historical in-place
 * write must run instead. Never modifies `target` on a throw.
 */
async function commitAtomicOrDefer(
  target: string,
  content: string,
  signal: AbortSignal,
): Promise<'done' | 'in-place'> {
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
  if (exactMode && !(await isWritable(target))) return 'in-place';

  try {
    // `secure`: open the temp with O_EXCL so a pre-planted symlink at the temp
    // name is refused instead of followed.
    await atomicWriteFileAsync(target, content, {
      mode, exactMode, signal, encoding: 'utf-8', mkdirp: true, secure: true,
    });
    return 'done';
  } catch (err) {
    const code = errCode(err);
    if (signal.aborted || !FALLBACK_CODES.has(code ?? '')) throw err;
    return 'in-place';
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
 * Historical in-place write. Not atomic and not abortable midway (aborting a
 * truncating write is the very corruption this module prevents). An abort seen
 * BEFORE it starts throws {@link WriteAbortedUntouchedError}. Once `writeFile`
 * starts, its errors propagate raw even if the signal has since aborted: a
 * failure partway (e.g. ENOSPC after truncation) may have modified the target,
 * so it must not be reported as "not modified".
 */
async function writeInPlace(target: string, filePath: string, content: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new WriteAbortedUntouchedError(filePath, { cause: signal.reason });
  await writeFile(target, content);
}
