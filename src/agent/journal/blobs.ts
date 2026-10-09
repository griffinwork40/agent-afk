/**
 * Content-addressed blob store for spilled journal payloads:
 * `sessions/<sessionId>/blobs/<sha256>.<ext>` (docs/message-journal.md).
 *
 * Invariant: `BlobRef.path` is RELATIVE to `getSessionsDir()` and always uses
 * `/` separators, so a forked journal can point at its parent's blobs and the
 * file is portable across platforms. Readers resolve it against the sessions
 * root and REFUSE anything that escapes it (a journal line is untrusted input:
 * `../../..` must never read an arbitrary file into a resumed conversation).
 *
 * Invariant: writes are exclusive-create. The bytes go to a temp file that is
 * then hard-linked to the final name; `link` fails with EEXIST when the blob
 * already exists, which is the dedup path (same name = same sha256 = same
 * bytes). A pre-existing blob whose size does not match (a torn write from a
 * crashed process) is replaced by rename. The final name therefore only ever
 * holds complete content.
 *
 * @module agent/journal/blobs
 */

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

import { getSessionBlobsDir, getSessionsDir } from '../../paths.js';
import type { BlobRef } from './types.js';
import { isErrnoCode } from '../../utils/errors.js';

/** A payload waiting to be written before the record that references it. */
export interface PendingBlob {
  ref: BlobRef;
  data: Buffer;
  /** Absolute destination path. */
  absPath: string;
}

const EXT_BY_MEDIA_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'application/pdf': 'pdf',
  'text/plain': 'txt',
  'application/json': 'json',
};

/** File extension for a media type; unknown types fall back to a sanitized subtype or `bin`. */
export function extForMediaType(mediaType: string): string {
  const mt = mediaType.toLowerCase().split(';')[0]!.trim();
  const known = EXT_BY_MEDIA_TYPE[mt];
  if (known) return known;
  const sub = mt.split('/')[1] ?? '';
  const clean = sub.replace(/[^a-z0-9]/g, '').slice(0, 16);
  return clean || 'bin';
}

/** Build the ref + destination for a payload in `sessionId`'s blob store. */
export function makePendingBlob(sessionId: string, sha256: string, data: Buffer, mediaType: string): PendingBlob {
  const absPath = join(getSessionBlobsDir(sessionId), `${sha256}.${extForMediaType(mediaType)}`);
  const relPath = relative(getSessionsDir(), absPath).split(sep).join('/');
  return { ref: { path: relPath, bytes: data.length, sha256, mediaType }, data, absPath };
}

/** Absolute path for a ref, or null when it is malformed or escapes the sessions root. */
export function resolveBlobPath(ref: BlobRef): string | null {
  if (!ref || typeof ref.path !== 'string' || ref.path.length === 0 || isAbsolute(ref.path)) return null;
  const root = resolve(getSessionsDir());
  const abs = resolve(root, ref.path);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  return abs;
}

/** Read a blob's bytes. `null` when missing, unreadable, unsafe, or the wrong size. */
export function readBlob(ref: BlobRef): Buffer | null {
  const abs = resolveBlobPath(ref);
  if (!abs) return null;
  try {
    const data = fs.readFileSync(abs);
    if (typeof ref.bytes === 'number' && data.length !== ref.bytes) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * Writes pending blobs, deduplicating IN-FLIGHT payloads within this process.
 * One store is shared by a session's top-level journal and all of its
 * subagent journals.
 *
 * Invariant: a settled write is NOT cached. Completed dedup is the on-disk
 * `stat` in {@link writeBlobExclusive}, so a blob whose directory was removed
 * after it was written (a sweep in another process, a manual `rm`) is written
 * again by the next record that references it rather than being assumed present.
 */
export class BlobStore {
  private readonly inFlight = new Map<string, Promise<void>>();

  /** Write (or reuse) a blob. Rejects on I/O failure; the caller decides the fallback. */
  write(blob: PendingBlob): Promise<void> {
    const existing = this.inFlight.get(blob.absPath);
    if (existing) return existing;
    const p = writeBlobExclusive(blob);
    this.inFlight.set(blob.absPath, p);
    const settle = (): void => {
      if (this.inFlight.get(blob.absPath) === p) this.inFlight.delete(blob.absPath);
    };
    p.then(settle, settle);
    return p;
  }
}

async function writeBlobExclusive(blob: PendingBlob): Promise<void> {
  const dir = join(blob.absPath, '..');
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  try {
    const st = await fsp.stat(blob.absPath);
    if (st.size === blob.data.length) return; // dedup: content-addressed name
  } catch {
    // absent: write below
  }
  const tmp = `${blob.absPath}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  try {
    await fsp.writeFile(tmp, blob.data, { mode: 0o600, flag: 'wx' });
  } catch (err) {
    if (!isErrnoCode(err, 'ENOENT')) throw err;
    // The dir was removed between mkdir and write: recreate it and retry once.
    await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
    await fsp.writeFile(tmp, blob.data, { mode: 0o600, flag: 'wx' });
  }
  try {
    await fsp.link(tmp, blob.absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') {
      // Filesystems without hard links (EPERM/ENOTSUP on some FUSE/FAT
      // mounts): fall back to rename. Same-hash races then just overwrite
      // identical bytes.
      if (code === 'EPERM' || code === 'ENOTSUP' || code === 'EXDEV' || code === 'ENOSYS') {
        await fsp.rename(tmp, blob.absPath);
        return;
      }
      throw err;
    }
    const st = await fsp.stat(blob.absPath);
    if (st.size !== blob.data.length) await fsp.rename(tmp, blob.absPath); // replace a torn blob
  } finally {
    await fsp.unlink(tmp).catch(() => undefined);
  }
}
