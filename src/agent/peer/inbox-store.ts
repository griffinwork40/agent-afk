/**
 * Contract: filesystem mailbox operations for peer messaging.
 *
 * Each session's inbox lives at:
 *   `$AFK_STATE_DIR/inbox/<sessionId>/{pending,delivered,held}/`
 *
 * Write protocol (tmp + rename): messages are written as `.tmp-<id>` then
 * atomically renamed to `<ts-sortable>-<messageId>.json`. This guarantees
 * that a reader never sees a partially-written message.
 *
 * Claim protocol (exclusive receipt): first try link `pending/F` to
 * `delivered/F`; on filesystems without hard-link support (exFAT/FAT, SMB,
 * some FUSE), fall back to `copyFile(COPYFILE_EXCL)` for the same exclusive-
 * create semantics. EEXIST and ENOENT return null. After a successful receipt
 * creation, unlink the pending source. A crash after receipt creation leaves a
 * delivered receipt that prevents orphaned pending sources from being claimed
 * again.
 *
 * Orphan detection: before spending wake budget or holding, callers should
 * call `checkOrphanPending`. If a valid delivered receipt already exists for
 * a pending file, the pending file is an orphan (crash residue) and should be
 * removed without consuming budget.
 *
 * Injection-ack protocol (crash recovery): after a claimed envelope is
 * successfully injected into a model turn, the receiver writes an ack marker
 * to `delivered/acked/<file>` containing the owning sessionId. On restart,
 * `recoverUnackedDelivered` scans `delivered/` for receipts that have no
 * corresponding ack marker and moves them back to `pending/` so they are
 * re-delivered. Recovery is scoped to the owning sessionId: receipts whose
 * envelope `to` field does not match the calling sessionId are never reclaimed
 * into an unrelated session. At-least-once delivery: a crash between ack-write
 * and turn-injection may replay an already-injected message; callers should
 * deduplicate by `messageId` when this matters.
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
  link,
  copyFile,
  constants as fsConstants,
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
    mkdir(join(base, 'delivered', 'acked'), { recursive: true, mode: 0o700 }),
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
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Validate that `file` is a bare filename — no path separators or `..`
 * traversal components.
 *
 * Parity with the `sessionId` guard in `paths.peer.ts:37`. Although `readdir`
 * on POSIX never yields entries containing `/`, and held/ files are written by
 * this module's own code (so they are trusted), defense-in-depth symmetry
 * matters: callers accept `file` values from the inbox UI and from test code,
 * so an accidental traversal is worth blocking explicitly.
 *
 * Rejects `/` and `\` (Windows path separator), the bare `..` component, and
 * any embedded `..` segment.
 *
 * @throws {Error} when `file` contains a path separator or traversal sequence.
 */
function assertBareFilename(file: string): void {
  if (
    file.includes('/') ||
    file.includes('\\') ||
    file === '..' ||
    file.includes('..')
  ) {
    throw new Error(`Invalid file parameter for inbox operation: "${file}"`);
  }
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

// Contract: error codes where hard links are structurally unsupported.
// EPERM covers Linux/macOS no-hardlink-across-fs; ENOTSUP, EOPNOTSUPP, ENOSYS
// cover exFAT/FAT/FUSE/SMB. EXDEV covers cross-device link attempts.
// EACCES is intentionally excluded — permission errors should propagate.
const HARDLINK_UNSUPPORTED_CODES = new Set([
  'EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV',
]);

/**
 * Create an exclusive delivered receipt, then remove the pending name.
 * Returns the claimed envelope, or null when another claimer won (EEXIST)
 * or the source disappeared (ENOENT).
 *
 * Receipt creation uses `link()` for atomic exclusive-create on POSIX
 * filesystems. When hardlinks are not supported (exFAT/FAT, SMB, FUSE),
 * falls back to `copyFile(COPYFILE_EXCL)` which provides the same
 * exclusive-create guarantee. Both approaches ensure exactly one claimer
 * wins; the fallback requires that the pending and delivered directories
 * are on the same volume (they always are — both are under the same
 * `$AFK_STATE_DIR/inbox/<id>/` tree).
 */
export async function claimPending(
  sessionId: string,
  file: string,
): Promise<PeerEnvelope | null> {
  const base = getPeerInboxDir(sessionId);
  const src = join(base, 'pending', file);
  const dst = join(base, 'delivered', file);
  try {
    await link(src, dst);
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EEXIST' || e.code === 'ENOENT') return null;
    if (!HARDLINK_UNSUPPORTED_CODES.has(e.code ?? '')) throw err;
    // Fallback: copyFile with exclusive-create flag.
    try {
      await copyFile(src, dst, fsConstants.COPYFILE_EXCL);
    } catch (copyErr: unknown) {
      const ce = copyErr as NodeJS.ErrnoException;
      if (ce.code === 'EEXIST' || ce.code === 'ENOENT') return null;
      throw copyErr;
    }
  }
  // Keep the receipt even if cleanup fails; it is the claim authority.
  await unlink(src).catch(() => undefined);
  try {
    return parseEnvelope(await readFile(dst, 'utf8'));
  } catch {
    return null; // corrupt/unreadable receipt is still claimed
  }
}

// Orphan detection and corrupt-receipt cleanup live in the sibling module
// inbox-store.orphan.ts; re-exported here for backward compatibility.
export { checkOrphanPending, clearDeliveredReceipt } from './inbox-store.orphan.js';

/**
 * Read a pending envelope WITHOUT claiming it, so a receiver can decide
 * (sender identity, wake budget) before committing to claim or hold.
 *
 * Returns:
 *   - A {@link PeerEnvelope} when the file is readable and parses cleanly.
 *   - `'vanished'`    — the file is gone (ENOENT); safe to silently skip.
 *   - `'unparseable'` — the file exists but does not parse (corrupt bytes or
 *                       an unsupported schema version); caller should move it
 *                       to `held/` so it stops re-appearing on every poll.
 *
 * Never throws.
 */
export async function peekPending(
  sessionId: string,
  file: string,
): Promise<PeerEnvelope | 'vanished' | 'unparseable'> {
  assertBareFilename(file);
  let raw: string;
  try {
    raw = await readFile(join(getPeerInboxDir(sessionId), 'pending', file), 'utf8');
  } catch (err: unknown) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'ENOENT') return 'vanished';
    // Other read errors (EACCES, EIO, …): treat as unparseable — content may
    // be partially intact; move to held/ rather than leaving it looping.
    return 'unparseable';
  }
  const env = parseEnvelope(raw);
  return env !== null ? env : 'unparseable';
}

/**
 * Move a pending envelope to `held/` (inbound-mode=hold path).
 * Returns `true` on success, `false` when the file is gone (ENOENT).
 */
export async function holdPending(sessionId: string, file: string): Promise<boolean> {
  assertBareFilename(file);
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
 * A successfully parsed held entry.
 * @see listHeld
 */
export interface HeldEntryOk {
  file: string;
  envelope: PeerEnvelope;
  /** Discriminant: always absent on a parseable entry. */
  corrupt?: never;
}

/**
 * A held entry whose content cannot be parsed (corrupt bytes or unsupported
 * schema version). Content is preserved in `held/`; only the structured
 * envelope is unavailable.
 * @see listHeld
 */
export interface HeldEntryCorrupt {
  file: string;
  /** Discriminant: true when the envelope cannot be parsed. */
  corrupt: true;
  envelope?: never;
}

/** Discriminated union for a single entry returned by {@link listHeld}. */
export type HeldEntry = HeldEntryOk | HeldEntryCorrupt;

/**
 * List held envelopes for a session, sorted chronologically.
 *
 * Returns one {@link HeldEntry} per file in `held/`:
 *   - `{ file, envelope }` when the file is readable and parses cleanly.
 *   - `{ file, corrupt: true }` when the file exists but cannot be parsed
 *     (corrupt bytes, unsupported schema version, or partial write). Content
 *     is preserved; the caller may {@link dropHeld} the entry by `file`.
 */
export async function listHeld(sessionId: string): Promise<HeldEntry[]> {
  const dir = join(getPeerInboxDir(sessionId), 'held');
  let files: string[];
  try {
    files = (await readdir(dir)).filter((f) => !f.startsWith('.tmp-')).sort();
  } catch {
    return [];
  }
  const results: HeldEntry[] = [];
  for (const file of files) {
    try {
      const raw = await readFile(join(dir, file), 'utf8');
      const env = parseEnvelope(raw);
      if (env) {
        results.push({ file, envelope: env });
      } else {
        results.push({ file, corrupt: true });
      }
    } catch {
      // Unreadable (EACCES, EIO, …): still surface it as corrupt so the
      // operator can see and drop it via /inbox.
      results.push({ file, corrupt: true });
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
  assertBareFilename(file);
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
 * claimed (linked into `delivered/`) but not yet injected into any model
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
    if (file === 'acked' || !file.endsWith(`-${messageId}.json`)) continue;
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

// ---------------------------------------------------------------------------
// Injection-ack protocol (crash recovery)
// ---------------------------------------------------------------------------

/**
 * Write a durable injection-ack marker after a claimed envelope has been
 * successfully injected into a model turn.
 *
 * The marker is stored at `delivered/acked/<file>` with the owning sessionId
 * as its content. This allows `recoverUnackedDelivered` on restart to
 * distinguish injected messages from claimed-but-crashed ones.
 *
 * Never throws. Failures are silently swallowed so a write error during
 * injection does not interrupt the model turn.
 */
export async function writeInjectionAck(sessionId: string, file: string): Promise<void> {
  try {
    const base = getPeerInboxDir(sessionId);
    const ackedDir = join(base, 'delivered', 'acked');
    await mkdir(ackedDir, { recursive: true, mode: 0o700 });
    await atomicWriteFileAsync(join(ackedDir, file), sessionId, {
      mode: 0o600,
      mkdirp: false,
    });
  } catch {
    // Best-effort: a missing ack will be recovered on next restart.
  }
}

/**
 * Recover claimed-but-uninjected envelopes for `sessionId` on process restart.
 *
 * Scans `delivered/` for receipt files that have no corresponding ack marker
 * in `delivered/acked/`. For each such file, verifies that the envelope's
 * `to` field matches `sessionId` (cross-session safety), then moves it back
 * to `pending/` so it will be re-delivered on the next receiver poll.
 *
 * Returns the filenames of envelopes that were successfully reclaimed.
 *
 * Contract:
 *   - Only reclaims envelopes whose `to` field equals `sessionId`; never
 *     touches envelopes belonging to another session.
 *   - Idempotent: a receipt already back in `pending/` is silently skipped.
 *   - At-least-once: if a crash happened between ack-write and turn
 *     injection, the ack may already exist and the envelope is NOT reclaimed,
 *     so the duplicate is the caller's responsibility to deduplicate by
 *     `messageId`.
 *   - Never throws; partial progress is preserved.
 */
export async function recoverUnackedDelivered(sessionId: string): Promise<string[]> {
  const base = getPeerInboxDir(sessionId);
  const deliveredDir = join(base, 'delivered');
  const ackedDir = join(base, 'delivered', 'acked');
  const pendingDir = join(base, 'pending');
  const recovered: string[] = [];

  let deliveredFiles: string[];
  try {
    deliveredFiles = await readdir(deliveredDir);
  } catch {
    return []; // No delivered/ dir — nothing to recover.
  }

  // Build the ack set once.
  let ackedFiles: Set<string>;
  try {
    ackedFiles = new Set(await readdir(ackedDir));
  } catch {
    ackedFiles = new Set();
  }

  for (const file of deliveredFiles) {
    if (file.startsWith('.tmp-') || file === 'acked') continue;
    // Skip receipts that have an ack marker — already injected.
    if (ackedFiles.has(file)) continue;

    // Parse the receipt to verify it belongs to this session.
    let env: PeerEnvelope | null = null;
    try {
      const raw = await readFile(join(deliveredDir, file), 'utf8');
      env = parseEnvelope(raw);
    } catch {
      // Unreadable receipt — skip; do not reclaim corrupt data.
      continue;
    }
    if (env === null || env.to !== sessionId) continue;

    // Ensure pending/ exists, then move receipt back.
    try {
      await mkdir(pendingDir, { recursive: true, mode: 0o700 });
      // Before rename: if pending/<file> already exists, the process crashed
      // between link and unlink during claim, leaving both copies. The pending
      // copy is already queued for redelivery — just remove the duplicate
      // delivered receipt instead of overwriting the pending entry.
      try {
        await stat(join(pendingDir, file));
        // pending copy exists — remove the delivered duplicate
        await unlink(join(deliveredDir, file)).catch(() => {});
        recovered.push(file);
        continue;
      } catch {
        // pending doesn't exist — proceed with rename
      }
      await rename(join(deliveredDir, file), join(pendingDir, file));
      recovered.push(file);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      // ENOENT: already gone (concurrent restart or prior recovery); skip.
      if (e.code !== 'ENOENT') {
        // Any other error: leave the file in place, do not corrupt state.
      }
    }
  }

  return recovered;
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
