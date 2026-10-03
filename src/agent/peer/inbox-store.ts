/**
 * Filesystem mailbox operations for peer messaging.
 *
 * Each session's inbox lives at:
 *   `$AFK_STATE_DIR/inbox/<sessionId>/{pending,delivered,held}/`
 *
 * Write protocol (tmp + rename): messages are written as `.tmp-<id>` then
 * atomically renamed to `<ts-sortable>-<messageId>.json`. This guarantees
 * that a reader never sees a partially-written message.
 *
 * Claim protocol (rename-wins): exactly one claimer wins the
 * `pending/ → delivered/` rename. A concurrent claim that loses gets ENOENT
 * from the rename and returns null — the caller treats null as "someone else
 * delivered it".
 *
 * File modes:
 *   - Directories: 0o700 (only the owning user can list/enter)
 *   - Files: 0o600 (only the owning user can read/write)
 *
 * @module agent/peer/inbox-store
 */

import { atomicWriteFileAsync } from '../../utils/atomic-write.js';
import {
  mkdir,
  rename,
  readdir,
  readFile,
  unlink,
  stat,
} from 'fs/promises';
import { join } from 'path';
import { getPeerInboxDir } from '../../paths.js';
import { parseEnvelope, type PeerEnvelope } from './envelope.js';
import type { PeerRefusal } from './guards.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result returned by `sendToSession` (and the lower-level write path). */
export interface SendResult {
  status: 'queued' | 'refused';
  messageId?: string;
  reason?: PeerRefusal;
  detail?: string;
}

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

/**
 * Ensure the three subdirectories exist for a session's inbox.
 * Uses `recursive: true` so the call is idempotent.
 * Mode 0o700: only the owning user should be able to list or enter.
 */
async function ensureInboxDirs(sessionId: string): Promise<void> {
  const base = getPeerInboxDir(sessionId);
  await Promise.all([
    mkdir(join(base, 'pending'), { recursive: true, mode: 0o700 }),
    mkdir(join(base, 'delivered'), { recursive: true, mode: 0o700 }),
    mkdir(join(base, 'held'), { recursive: true, mode: 0o700 }),
  ]);
}

/**
 * Build a timestamp-sortable filename prefix from an ISO date string.
 * Replaces colons and dots (which are not universally safe in filenames) with
 * dashes: `2026-10-02T12-30-45-123Z`.
 */
function sortableTs(isoString: string): string {
  return isoString.replace(/[:.]/g, '-');
}

/**
 * Reconstruct the canonical filename for an envelope. Matches the format used
 * by {@link writeEnvelope}: `<ts-sortable>-<messageId>.json`.
 *
 * Useful when a caller holds a {@link PeerEnvelope} and needs to locate its
 * file in `pending/`, `delivered/`, or `held/` without having stored the
 * filename separately.
 */
export function envelopeFilename(env: Pick<PeerEnvelope, 'ts' | 'messageId'>): string {
  return `${sortableTs(env.ts)}-${env.messageId}.json`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Write a {@link PeerEnvelope} into the target session's `pending/`
 * subdirectory using the tmp-then-rename protocol.
 *
 * The filename format is `<ts-sortable>-<messageId>.json`, which sorts
 * chronologically in readdir output (no explicit sort needed beyond lexical).
 */
export async function writeEnvelope(env: PeerEnvelope): Promise<void> {
  await ensureInboxDirs(env.to);
  const base = getPeerInboxDir(env.to);
  const pendingDir = join(base, 'pending');
  const filename = `${sortableTs(env.ts)}-${env.messageId}.json`;
  // INV-023: tmp+rename via the shared helper. Its `.tmp-*` sibling is what
  // listPending() skips, so a reader never sees a half-written envelope.
  await atomicWriteFileAsync(join(pendingDir, filename), JSON.stringify(env), {
    mode: 0o600,
    mkdirp: false,
  });
}

/**
 * List pending envelope filenames for a session, sorted lexically (which is
 * also chronological given the `<ts-sortable>-<messageId>.json` format).
 * Excludes `.tmp-*` partial writes.
 */
export async function listPending(sessionId: string): Promise<string[]> {
  const dir = join(getPeerInboxDir(sessionId), 'pending');
  try {
    const files = await readdir(dir);
    return files.filter((f) => !f.startsWith('.tmp-')).sort();
  } catch {
    return [];
  }
}

/**
 * Atomically claim a pending envelope by renaming it to `delivered/`.
 *
 * Returns the parsed envelope on success; `null` when the rename fails
 * with ENOENT (another claimer won the race). Any other error is propagated.
 */
export async function claimPending(
  sessionId: string,
  file: string,
): Promise<PeerEnvelope | null> {
  const base = getPeerInboxDir(sessionId);
  const src = join(base, 'pending', file);
  const dst = join(base, 'delivered', file);
  try {
    await rename(src, dst);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return null;
    throw err;
  }
  try {
    const raw = await readFile(dst, 'utf8');
    return parseEnvelope(raw);
  } catch {
    // If the read fails after a successful rename we still "won" the claim;
    // return null to indicate a corrupt/unreadable message.
    return null;
  }
}

/**
 * Read a pending envelope WITHOUT claiming it, so a receiver can decide
 * (sender identity, wake budget) before committing to claim or hold.
 * Returns `null` when the file is gone or unparseable. Never throws.
 */
export async function peekPending(
  sessionId: string,
  file: string,
): Promise<PeerEnvelope | null> {
  try {
    const raw = await readFile(join(getPeerInboxDir(sessionId), 'pending', file), 'utf8');
    return parseEnvelope(raw);
  } catch {
    return null;
  }
}

/**
 * Move a pending envelope to `held/` (inbound-mode=hold path).
 * Returns `true` on success, `false` when the file is gone (ENOENT).
 */
export async function holdPending(sessionId: string, file: string): Promise<boolean> {
  const base = getPeerInboxDir(sessionId);
  const src = join(base, 'pending', file);
  const dst = join(base, 'held', file);
  try {
    await mkdir(join(base, 'held'), { recursive: true, mode: 0o700 });
    await rename(src, dst);
    return true;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * List held envelopes for a session, sorted chronologically.
 * Returns an array of `{ file, envelope }` pairs; unparseable entries are
 * skipped silently.
 */
export async function listHeld(
  sessionId: string,
): Promise<Array<{ file: string; envelope: PeerEnvelope }>> {
  const dir = join(getPeerInboxDir(sessionId), 'held');
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => !f.startsWith('.tmp-')).sort();
  } catch {
    return [];
  }
  const results: Array<{ file: string; envelope: PeerEnvelope }> = [];
  for (const file of files) {
    try {
      const raw = await readFile(join(dir, file), 'utf8');
      const env = parseEnvelope(raw);
      if (env) results.push({ file, envelope: env });
    } catch {
      // Skip unreadable files silently.
    }
  }
  return results;
}

/**
 * Move a held envelope back to `pending/` so it will be delivered on the
 * next receiver poll. Returns `true` on success, `false` when not found.
 */
export async function releaseHeld(sessionId: string, file: string): Promise<boolean> {
  const base = getPeerInboxDir(sessionId);
  const src = join(base, 'held', file);
  const dst = join(base, 'pending', file);
  try {
    await mkdir(join(base, 'pending'), { recursive: true, mode: 0o700 });
    await rename(src, dst);
    return true;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Permanently delete a held envelope. Returns `true` on success, `false`
 * when not found (already delivered or deleted by a concurrent caller).
 */
export async function dropHeld(sessionId: string, file: string): Promise<boolean> {
  const path = join(getPeerInboxDir(sessionId), 'held', file);
  try {
    await unlink(path);
    return true;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Count pending (undelivered) envelopes for a session. Returns 0 when the
 * inbox directory is absent or unreadable.
 */
export async function countPending(sessionId: string): Promise<number> {
  const files = await listPending(sessionId);
  return files.length;
}

/**
 * Move a delivered envelope back to `pending/` so it can be re-delivered by
 * the next receiver poll. This is the reclaim path for envelopes that were
 * claimed (renamed into `delivered/`) but not yet injected into any model
 * turn — for example, when the session is swapped out via `/resume` before
 * the buffered envelope could be drained.
 *
 * The filename is preserved exactly (same `<ts-sortable>-<messageId>.json`)
 * so lexical ordering and dedup checks remain consistent.
 *
 * Returns `true` on success; `false` when the file is not found in
 * `delivered/` (already consumed or double-reclaimed).
 */
export async function reclaimDelivered(sessionId: string, file: string): Promise<boolean> {
  const base = getPeerInboxDir(sessionId);
  const src = join(base, 'delivered', file);
  const dst = join(base, 'pending', file);
  try {
    await mkdir(join(base, 'pending'), { recursive: true, mode: 0o700 });
    await rename(src, dst);
    return true;
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return false;
    throw err;
  }
}

/**
 * Scan `delivered/` for an envelope whose `messageId` field matches the
 * given id. Returns the envelope if found, or null. Used by `send.ts` to
 * look up a replied-to envelope's hop count for the `hop+1` calculation.
 */
export async function findDeliveredEnvelope(
  sessionId: string,
  messageId: string,
): Promise<PeerEnvelope | null> {
  const dir = join(getPeerInboxDir(sessionId), 'delivered');
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return null;
  }
  for (const file of files) {
    if (!file.includes(messageId)) continue;
    try {
      const raw = await readFile(join(dir, file), 'utf8');
      const env = parseEnvelope(raw);
      if (env && env.messageId === messageId) return env;
    } catch {
      // Skip unreadable files.
    }
  }
  return null;
}

/**
 * Sweep peer inbox directories that belong to sessions which are no longer
 * live. A directory is removed when:
 *   1. Its session id is NOT in `liveSessionIds`.
 *   2. The newest file within it is older than `maxAgeMs` (default 7 days).
 *
 * Returns the number of directories removed. Never throws — all errors are
 * caught and swallowed so the sweep cannot interfere with session startup.
 */
export async function sweepPeerInboxes(opts: {
  liveSessionIds: ReadonlySet<string>;
  maxAgeMs?: number;
  now?: () => number;
}): Promise<number> {
  const { liveSessionIds, maxAgeMs = 7 * 24 * 60 * 60_000, now: getNow = Date.now } = opts;
  // Import getPeerInboxRoot lazily to avoid a dependency cycle during tests.
  const { getPeerInboxRoot } = await import('../../paths.js');
  const root = getPeerInboxRoot();
  let removed = 0;

  let sessionDirs: string[];
  try {
    sessionDirs = await readdir(root);
  } catch {
    return 0;
  }

  const nowMs = getNow();
  for (const sessionId of sessionDirs) {
    if (liveSessionIds.has(sessionId)) continue;
    const base = join(root, sessionId);
    try {
      // Find the newest mtime across all files in all subdirs.
      let newestMs = 0;
      const subdirs = ['pending', 'delivered', 'held'];
      for (const sub of subdirs) {
        let subFiles: string[];
        try {
          subFiles = await readdir(join(base, sub));
        } catch {
          continue;
        }
        for (const file of subFiles) {
          try {
            const info = await stat(join(base, sub, file));
            if (info.mtimeMs > newestMs) newestMs = info.mtimeMs;
          } catch {
            // Ignore stat errors.
          }
        }
      }
      // Also check the base directory itself.
      try {
        const baseInfo = await stat(base);
        if (baseInfo.mtimeMs > newestMs) newestMs = baseInfo.mtimeMs;
      } catch {
        // Ignore.
      }

      if (nowMs - newestMs >= maxAgeMs) {
        const { rm } = await import('fs/promises');
        await rm(base, { recursive: true, force: true });
        removed++;
      }
    } catch {
      // Skip directories we can't process.
    }
  }
  return removed;
}
