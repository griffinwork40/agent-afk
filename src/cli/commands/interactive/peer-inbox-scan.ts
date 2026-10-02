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
 * @module cli/commands/interactive/peer-inbox-scan
 */

import {
  listPending,
  peekPending,
  claimPending,
  holdPending,
} from '../../../agent/peer/inbox-store.js';
import type { PeerInboundMode } from '../../../agent/peer/inbound-mode.js';
import type { WakeBudget } from '../../../agent/peer/guards.js';
import type { PeerEnvelope } from '../../../agent/peer/envelope.js';

export type HeldReason = 'inbound-hold' | 'wake-budget';

export interface PeerScanResult {
  claimed: PeerEnvelope[];
  held: Array<{ envelope: PeerEnvelope; reason: HeldReason }>;
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
    const peeked = await peekPending(args.sessionId, file);
    if (peeked === null) return; // vanished (another claimer) or unparseable
    let reason: HeldReason | undefined;
    if (args.mode === 'hold') reason = 'inbound-hold';
    else if (!args.wakeBudget.tryConsume(peeked.from.id)) reason = 'wake-budget';
    if (reason !== undefined) {
      if (await holdPending(args.sessionId, file)) result.held.push({ envelope: peeked, reason });
      return;
    }
    const claimed = await claimPending(args.sessionId, file);
    if (claimed !== null) result.claimed.push(claimed);
  } catch {
    // Best-effort per file: one bad entry must not stall the rest of the inbox.
  }
}
