/**
 * One pass over a session's peer inbox `pending/` directory: decide, per
 * envelope, whether to leave it, hold it, or claim it for injection.
 *
 * Contract: pure decision + filesystem moves, no timers and no REPL state.
 * The caller ({@link PeerInboxNotifier}) owns the injection buffer and the
 * wake hook; this function only reports what it claimed and held.
 *
 * Invariant: the wake budget is checked BEFORE claiming. An over-budget
 * envelope is moved to `held/` and never enters the injection buffer. Merely
 * withholding the wake is not enough: the REPL re-runs `tryAutoResume` every
 * time its prompt becomes receptive (`onAwaitingInput`), so any buffered
 * envelope would wake the session anyway and the budget would be a no-op.
 *
 * Invariant: orphan detection precedes ALL budget and hold decisions.
 * A pending file with a valid delivered receipt is a crash residue: it is
 * removed silently without spending a wake-budget slot and without creating a
 * held/ entry. A corrupt receipt leaves the pending file intact.
 *
 * Invariant: an unparseable pending file is moved to `held/` with reason
 * `'corrupt'` on first encounter, stopping the infinite re-read loop. Content
 * is preserved; no wake-budget slot is spent.
 *
 * Invariant: a wake-budget slot is spent ONLY when claimPending returns a
 * non-null envelope. A null return (lost race or vanished source) or a thrown
 * claim triggers an immediate refund via `wakeBudget.refund()`.
 *
 * @module cli/commands/interactive/peer-inbox-scan
 */

import {
  listPending,
  peekPending,
  claimPending,
  holdPending,
  checkOrphanPending,
} from '../../../agent/peer/inbox-store.js';
import type { PeerInboundMode } from '../../../agent/peer/inbound-mode.js';
import type { WakeBudget } from '../../../agent/peer/guards.js';
import type { PeerEnvelope } from '../../../agent/peer/envelope.js';

export type HeldReason = 'inbound-hold' | 'wake-budget' | 'corrupt';

/**
 * A held entry with a successfully parsed envelope (`reason` is `'inbound-hold'`
 * or `'wake-budget'`).
 */
export interface HeldEntryOk {
  envelope: PeerEnvelope;
  reason: Exclude<HeldReason, 'corrupt'>;
}

/**
 * A held entry for an envelope that could not be parsed. The file has been
 * moved to `held/` to stop it from re-appearing on every poll, but no
 * structured envelope is available.
 */
export interface HeldEntryCorrupt {
  envelope?: never;
  reason: 'corrupt';
  /** Filename that was moved to `held/`. */
  file: string;
}

export type HeldEntry = HeldEntryOk | HeldEntryCorrupt;

export interface PeerScanResult {
  claimed: PeerEnvelope[];
  held: HeldEntry[];
}

export interface PeerScanArgs {
  sessionId: string;
  mode: PeerInboundMode;
  wakeBudget: WakeBudget;
  /** Max envelopes to claim this pass (buffer headroom). Remaining stay pending. */
  capacity: number;
}

/** Scan `pending/` once. Never throws for per-file failures. */
export async function scanPeerInbox(args: PeerScanArgs): Promise<PeerScanResult> {
  const result: PeerScanResult = { claimed: [], held: [] };
  if (args.mode === 'off') return result;
  const files = await listPending(args.sessionId);
  for (const file of files) {
    if (args.mode === 'accept' && result.claimed.length >= args.capacity) break;
    await processPendingFile(args, file, result);
  }
  return result;
}

async function processPendingFile(
  args: PeerScanArgs,
  file: string,
  result: PeerScanResult,
): Promise<void> {
  try {
    // Orphan check: if a delivered receipt already exists, this pending file
    // is crash residue.
    //   'valid'  — receipt parsed; pending source removed; skip silently.
    //   'corrupt' — receipt exists but is unparseable (e.g. partial copy on
    //               crash); pending source is intact. Move it to held/ so it
    //               stops re-appearing on every poll (content preserved).
    //   'none'   — not an orphan; process normally.
    const orphan = await checkOrphanPending(args.sessionId, file);
    if (orphan === 'valid') return;
    if (orphan === 'corrupt') {
      const moved = await holdPending(args.sessionId, file);
      if (moved) result.held.push({ reason: 'corrupt', file });
      return;
    }

    const peeked = await peekPending(args.sessionId, file);
    if (peeked === 'vanished') return; // silently gone — another claimer won or the file was removed
    if (peeked === 'unparseable') {
      // Move to held/ so it does not re-appear on every poll. Content is
      // preserved; the operator can inspect or drop it via /inbox.
      const moved = await holdPending(args.sessionId, file);
      if (moved) result.held.push({ reason: 'corrupt', file });
      return;
    }
    let reason: Exclude<HeldReason, 'corrupt'> | undefined;
    if (args.mode === 'hold') reason = 'inbound-hold';
    else if (!args.wakeBudget.tryConsume(peeked.from.id)) reason = 'wake-budget';
    if (reason !== undefined) {
      if (await holdPending(args.sessionId, file)) result.held.push({ envelope: peeked, reason });
      return;
    }
    // Invariant: refund on BOTH a null claim (lost race / vanished source) and
    // a thrown claim; otherwise a persistently failing file re-spends a slot
    // on every poll and starves the sender's budget.
    let claimed: PeerEnvelope | null = null;
    try {
      claimed = await claimPending(args.sessionId, file);
    } finally {
      if (claimed === null) args.wakeBudget.refund(peeked.from.id);
    }
    if (claimed !== null) result.claimed.push(claimed);
  } catch {
    // Best-effort per file: one bad entry must not stall the rest of the inbox.
  }
}
