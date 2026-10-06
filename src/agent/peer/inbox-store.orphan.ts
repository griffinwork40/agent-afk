/**
 * Orphan detection and corrupt-receipt cleanup for the peer inbox.
 *
 * An orphan is a `pending/<file>` entry whose `delivered/<file>` receipt
 * already exists — produced when a process dies after `link/copyFile` but
 * before the pending source `unlink`. The two functions here together handle
 * the full orphan lifecycle:
 *
 *   1. {@link checkOrphanPending} — detect an orphan and classify its receipt.
 *   2. {@link clearDeliveredReceipt} — remove a corrupt receipt so a future
 *      `claimPending` (after `/inbox accept`) can create a fresh one without
 *      hitting EEXIST.
 *
 * Extracted from `inbox-store.ts` to keep that file within the 350-code-line
 * ceiling.  Re-exported from `inbox-store.ts` for backward compatibility;
 * callers should continue to import from `inbox-store.js`.
 *
 * @module agent/peer/inbox-store.orphan
 */

import { readFile, unlink } from 'fs/promises';
import { join } from 'path';
import { getPeerInboxDir } from '../../paths.js';
import { parseEnvelope } from './envelope.js';

/**
 * Check whether `file` in `pending/` is an orphan from a prior crash.
 *
 * An orphan is a pending entry whose delivered receipt already exists —
 * produced when a process dies after `link/copyFile` but before `unlink`.
 *
 * Returns:
 *   - `'valid'`   — receipt exists AND parses as a valid envelope; the pending
 *                   source was removed (callers must NOT spend wake budget).
 *   - `'corrupt'` — receipt exists but is unparseable (partial copy on crash);
 *                   pending source is left untouched (content must never be
 *                   destroyed on a bad receipt).
 *   - `'none'`    — no receipt; not an orphan, process normally.
 *
 * Never throws.
 */
export async function checkOrphanPending(
  sessionId: string,
  file: string,
): Promise<'valid' | 'corrupt' | 'none'> {
  const base = getPeerInboxDir(sessionId);
  const dst = join(base, 'delivered', file);
  let raw: string;
  try {
    raw = await readFile(dst, 'utf8');
  } catch {
    return 'none'; // receipt absent — not an orphan
  }
  // Receipt exists. Try to parse it.
  const env = parseEnvelope(raw);
  if (env === null) return 'corrupt'; // do NOT delete pending — bad receipt
  // Valid receipt: remove the orphaned pending source, ignore failures.
  await unlink(join(base, 'pending', file)).catch(() => undefined);
  return 'valid';
}

/**
 * Unlink a corrupt delivered receipt so a future `claimPending` (after
 * `/inbox accept`) can create a fresh receipt via `link/copyFile` without
 * hitting EEXIST.
 *
 * Called from `peer-inbox-scan.ts` in the `orphan === 'corrupt'` branch,
 * BEFORE moving the pending file to `held/`. This breaks the accept loop:
 * without this unlink, `releaseHeld` → `claimPending` fails with EEXIST
 * forever because the stale corrupt receipt is still on disk.
 *
 * Ignores ENOENT — idempotent when the receipt is already absent.
 * Never throws.
 */
export async function clearDeliveredReceipt(sessionId: string, file: string): Promise<void> {
  const path = join(getPeerInboxDir(sessionId), 'delivered', file);
  await unlink(path).catch((err: unknown) => {
    const e = err as NodeJS.ErrnoException;
    if (e.code !== 'ENOENT') throw err;
  });
}
