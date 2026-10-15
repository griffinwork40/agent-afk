/**
 * Per-file retention for peer-inbox `delivered/` receipts.
 *
 * ## Why
 * `sweepPeerInboxes` in `inbox-store.ts` only removes whole session inbox
 * directories (after 7 days of inactivity for dead sessions). Inside a
 * long-lived receiver, `delivered/` grows without bound, slowing every
 * `readdir` that `checkSendGuards` and `findDeliveredEnvelope` issue.
 *
 * ## Retention threshold
 * The longest window any reader needs is the wake-budget window (1 hour,
 * `PEER_WAKE_BUDGET_WINDOW_MS`) plus the dedup window (60 s). This gives
 * `findDeliveredEnvelope` enough room to look up a receipt when resolving
 * `reply_to` hop counts on a freshly-replied envelope. The threshold is
 * derived from the guard-layer constants rather than hardcoded separately.
 *
 * ## Safety invariant (receipt-as-claim-authority)
 * A delivered receipt is NEVER removed while its pending source file still
 * exists. A pending source with no receipt can still be claimed; destroying
 * the receipt first would allow re-delivery of the same envelope.
 *
 * ## Throttle
 * Callers (the notifier tick) pass a `lastRanMs` cursor and a
 * `minIntervalMs` threshold. The function returns early when not enough
 * time has elapsed, so scanning on every poll tick is safe.
 *
 * @module agent/peer/inbox-retention
 */

import { readdir, stat, unlink } from 'fs/promises';
import { join } from 'path';
import { getPeerInboxDir } from '../../paths.js';
import { PEER_WAKE_BUDGET_WINDOW_MS } from './guards.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Minimum time between retention sweeps per-session. The notifier polls on
 * every tick (default every 1s); throttling keeps the sweep cheap.
 */
export const DELIVERED_RETENTION_INTERVAL_MS = 5 * 60_000; // 5 minutes

/**
 * Maximum age of an unacked delivered receipt before it is treated as a
 * leaked orphan and pruned anyway. A receipt without an ack marker is normally
 * crash residue that `recoverUnackedDelivered` reclaims on restart. If the
 * receipt was somehow never recovered after 24 hours it is almost certainly
 * abandoned (session never restarted or the ack was silently lost after a
 * full restart cycle). 24 h >> the restart window for any realistic session.
 */
export const UNACKED_RETENTION_MAX_AGE_MS = 24 * 60 * 60_000; // 24 hours

/**
 * Age threshold after which a delivered receipt may be pruned.
 *
 * = wake-budget window (longest window any reader needs) + dedup window (60 s
 * of margin for `findDeliveredEnvelope` reply-lookup on fresh replies) + an
 * extra 60 s safety margin.
 *
 * Derived from `PEER_WAKE_BUDGET_WINDOW_MS` (guards.ts) and the dedup
 * constant to avoid a separate magic number.
 */
export const DELIVERED_RECEIPT_MAX_AGE_MS =
  PEER_WAKE_BUDGET_WINDOW_MS + // 1 hour — wake-budget window
  60_000 + // dedup-window margin
  60_000; // extra safety margin

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Options for `pruneDeliveredReceipts`. */
export interface PruneDeliveredReceiptsOpts {
  /** The session whose `delivered/` directory is swept. */
  sessionId: string;
  /**
   * Wall-clock time of the most recent successful sweep for this session.
   * Pass `0` to force a run on the first call. Updated by the caller.
   */
  lastRanMs: number;
  /**
   * Minimum ms between sweeps. Defaults to `DELIVERED_RETENTION_INTERVAL_MS`.
   * Pass a smaller value in tests.
   */
  minIntervalMs?: number;
  /** Injected clock for testing. Defaults to `Date.now`. */
  now?: () => number;
}

/** Result from `pruneDeliveredReceipts`. */
export interface PruneResult {
  /** Whether a sweep was actually performed (false when throttled). */
  ran: boolean;
  /** Wall-clock time of the sweep, or `lastRanMs` when skipped. */
  nowMs: number;
  /** Number of receipt files removed. */
  pruned: number;
  /** Number of files skipped because a pending source still existed. */
  skippedHasPending: number;
  /** Number of files skipped because they were too fresh to prune. */
  skippedFresh: number;
  /**
   * Number of files skipped because they have no ack marker yet (crash
   * residue awaiting `recoverUnackedDelivered`) and are younger than
   * `UNACKED_RETENTION_MAX_AGE_MS`.
   */
  skippedUnacked: number;
}

/**
 * Prune stale delivered receipts for a single session.
 *
 * - Reads `delivered/`, `delivered/acked/`, and `pending/` for the session.
 * - Removes receipt files older than `DELIVERED_RECEIPT_MAX_AGE_MS`.
 * - Skips any receipt whose corresponding pending source still exists
 *   (receipt-as-claim-authority invariant).
 * - Skips any receipt that has no ack marker in `delivered/acked/` and is
 *   younger than `UNACKED_RETENTION_MAX_AGE_MS` — these are crash residue
 *   that `recoverUnackedDelivered` reclaims on restart. After 24 h they are
 *   treated as leaked orphans and pruned to prevent unbounded growth.
 * - Is a no-op when the throttle interval has not elapsed.
 * - Never throws — all errors are caught so the caller (notifier tick) is
 *   never interrupted.
 */
export async function pruneDeliveredReceipts(
  opts: PruneDeliveredReceiptsOpts,
): Promise<PruneResult> {
  const {
    sessionId,
    lastRanMs,
    minIntervalMs = DELIVERED_RETENTION_INTERVAL_MS,
    now: getNow = Date.now,
  } = opts;

  const nowMs = getNow();

  // Throttle: skip when the interval has not elapsed.
  if (nowMs - lastRanMs < minIntervalMs) {
    return { ran: false, nowMs: lastRanMs, pruned: 0, skippedHasPending: 0, skippedFresh: 0, skippedUnacked: 0 };
  }

  const result: PruneResult = { ran: true, nowMs, pruned: 0, skippedHasPending: 0, skippedFresh: 0, skippedUnacked: 0 };

  try {
    const base = getPeerInboxDir(sessionId);
    const deliveredDir = join(base, 'delivered');
    const ackedDir = join(deliveredDir, 'acked');
    const pendingDir = join(base, 'pending');

    // Read pending filenames once — used to guard the claim-authority invariant.
    let pendingFiles: Set<string>;
    try {
      pendingFiles = new Set(await readdir(pendingDir));
    } catch {
      pendingFiles = new Set();
    }

    // Read acked filenames once — unacked receipts may be crash residue awaiting
    // recoverUnackedDelivered on the next restart; protect them from early pruning.
    let ackedFiles: Set<string>;
    try {
      ackedFiles = new Set(await readdir(ackedDir));
    } catch {
      ackedFiles = new Set();
    }

    let deliveredFiles: string[];
    try {
      deliveredFiles = await readdir(deliveredDir);
    } catch {
      return result; // delivered/ doesn't exist yet — nothing to prune
    }

    const cutoff = nowMs - DELIVERED_RECEIPT_MAX_AGE_MS;
    const unackedCutoff = nowMs - UNACKED_RETENTION_MAX_AGE_MS;

    for (const file of deliveredFiles) {
      if (file.startsWith('.tmp-') || file === 'acked') continue;

      // Safety invariant: never prune a receipt while its pending source exists.
      if (pendingFiles.has(file)) {
        result.skippedHasPending++;
        continue;
      }

      // Check mtime to decide whether the file is old enough to prune.
      let mtime: number;
      try {
        const info = await stat(join(deliveredDir, file));
        mtime = info.mtimeMs;
      } catch {
        continue; // file disappeared between readdir and stat — skip
      }

      if (mtime >= cutoff) {
        result.skippedFresh++;
        continue;
      }

      // Crash-recovery guard: if there is no ack marker and the file is younger
      // than UNACKED_RETENTION_MAX_AGE_MS, retain it so recoverUnackedDelivered
      // can reclaim it on the next restart. After 24 h assume it's an orphan.
      if (!ackedFiles.has(file) && mtime >= unackedCutoff) {
        result.skippedUnacked++;
        continue;
      }

      // File is old enough and has no surviving pending source — remove it.
      try {
        await unlink(join(deliveredDir, file));
        result.pruned++;
      } catch {
        // ENOENT: concurrent sweep already removed it. Any other error: skip silently.
      }
    }
  } catch {
    // Best-effort — never interfere with the notifier tick.
  }

  return result;
}
