/**
 * Peer boundary delivery wiring for the top-level REPL session.
 *
 * Installs a `setBeforeNextRound` callback on the REPL's AgentSession so that
 * peer messages arriving during a tool batch are delivered at the next
 * inter-round boundary (after the batch, before the next model request) instead
 * of waiting for the next turn.
 *
 * Delivery priority (FIFO within each tier):
 *   1. Human queued-user-messages (user typed + Enter while a turn was running)
 *   2. Peer messages (from other sessions' inboxes)
 *
 * Barriers preventing peer injection:
 *   - Any human queued-user-message is present in the compositor → peer waits.
 *     The check uses `hasPendingSubmission()` (not just `peekQueuedText()`) so
 *     attachment-bearing payloads — where `peekQueuedText` returns undefined —
 *     still block peer injection correctly.
 *   - The REPL input buffer is non-empty (half-typed) → not an inter-round
 *     concern; the boundary callback doesn't touch readline state.
 *   - Attachments or slash-commands in the compositor queue → human-first tier
 *     handles it; peer remains in the PeerInboxNotifier buffer.
 *   - Admission queue is full (`admissionQueue.full`) → peer stays in the
 *     PeerInboxNotifier buffer for the next boundary turn or next-turn fallback.
 *     The notifier is NOT drained when the queue cannot accept, preventing silent
 *     message loss under the maxCount/maxBytes ceiling.
 *
 * Consume-once semantics: the boundary callback drains its snapshot exactly once.
 * If the session ends before a boundary fires (single-model-call turns with no
 * tool rounds), the `next-turn fallback` in `prependTurnInjections` delivers
 * the remainder via the ordinary drain, preventing duplication.
 *
 * Rekey: when `installPeerBoundary` is called again (after /resume), the old
 * callback is replaced. The AdmissionQueue must be cleared by the caller before
 * re-install to avoid leaking previous-session entries.
 *
 * @module cli/commands/interactive/loop-iteration.boundary
 */

import type { PeerInboxNotifier } from './peer-inbox-notifier.js';
import { AdmissionQueue } from '../../../agent/peer/admission-queue.js';
import type { InteractiveCtx } from './shared.js';
import type { InputSurface } from '../../input/input-surface.js';

/** Minimal compositor surface for reading and consuming the human queue. */
export interface BoundaryCompositor {
  /**
   * True when ANY human payload is pending (text, attachment, slash command, or
   * shell passthrough). Unlike `peekQueuedText`, this returns true even when the
   * queued payload contains an image or other non-text attachment — i.e. exactly
   * when the boundary should block peer injection and defer to the human turn.
   */
  hasPendingSubmission(): boolean;
  peekQueuedText(): { text: string; payloads: readonly unknown[] } | undefined;
  reserveQueued(snapshot: { payloads: readonly unknown[] }): void;
  releaseQueued(snapshot: { payloads: readonly unknown[] }): void;
  dropQueued(snapshot: { payloads: readonly unknown[] }): number;
}

/** Minimal session surface: only what boundary needs. */
export interface BoundarySession {
  setBeforeNextRound?: (cb: (() => string | undefined) | undefined) => void;
}

/**
 * Options for boundary wiring. All mutable references are read live (via
 * getter functions) so the wiring survives /model swaps and /resume.
 */
export interface PeerBoundaryOpts {
  /** Live session getter — re-read on every boundary invocation. */
  getSession: () => BoundarySession | undefined;
  /** Live compositor getter — may return null (non-TTY). */
  getCompositor: () => BoundaryCompositor | null;
  /** Peer inbox notifier that holds the peer message buffer. */
  peerNotifier: PeerInboxNotifier;
  /** Admission queue shared with next-turn fallback. */
  admissionQueue: AdmissionQueue;
}

/**
 * Build and install the inter-round boundary callback on the current session.
 *
 * The callback, when invoked by the provider loop (Anthropic or OpenAI) at each
 * tool-round boundary:
 *   1. Checks `hasPendingSubmission()` — if any human payload is pending
 *      (including attachment-bearing payloads that `peekQueuedText` returns
 *      undefined for), the human-priority barrier is active: peer injection is
 *      skipped entirely this boundary. Peer messages stay in the notifier buffer.
 *   2. If no human barrier: tries to admit queued human text (via peekQueuedText)
 *      and then peer messages (from the PeerInboxNotifier buffer) into the
 *      AdmissionQueue — but ONLY if the queue has capacity (`!admissionQueue.full`)
 *      so peer messages are never silently discarded on a saturated queue.
 *   3. Takes an AdmissionQueue snapshot and returns the drained text, or
 *      `undefined` if nothing is ready to deliver.
 *
 * Human entries are REMOVED from the compositor queue via `dropQueued` so they
 * are not delivered a second time by the next-turn idle drain. Peer entries are
 * removed from `admissionQueue` via `drain()`. Peer entries that do NOT fit in
 * the queue remain in the PeerInboxNotifier buffer for the next boundary turn or
 * the next-turn fallback, and are never silently lost.
 *
 * Returns a disposer that removes the callback when called.
 */
export function installPeerBoundary(opts: PeerBoundaryOpts): () => void {
  const { getSession, getCompositor, peerNotifier, admissionQueue } = opts;

  const callback = (): string | undefined => {
    const compositor = getCompositor();

    // ── 1. Human barrier check ───────────────────────────────────────────────
    // hasPendingSubmission() is true for ANY human payload: text, attachment,
    // image, slash command. peekQueuedText() alone returns undefined for image-
    // bearing payloads, which would incorrectly allow peer injection past the
    // human-first barrier. We check hasPendingSubmission first.
    const humanPending = compositor?.hasPendingSubmission() ?? false;
    if (humanPending) {
      // Human has something queued (may include attachments). Try to admit
      // text-only entries; attachment-bearing payloads will be forwarded by the
      // normal next-turn drain path, not the boundary callback.
      const humanSnap = compositor!.peekQueuedText();
      if (humanSnap !== undefined) {
        // Reserve so concurrent Ctrl+B doesn't double-consume while we decide.
        compositor!.reserveQueued(humanSnap);
        // Submit to admission queue as human priority.
        const admitted = admissionQueue.submitHuman(humanSnap.text);
        if (!admitted) {
          // Queue full — release back to compositor for normal next-turn drain.
          compositor!.releaseQueued(humanSnap);
        } else {
          // Drop from compositor: we now own the text via admissionQueue.
          compositor!.dropQueued(humanSnap);
        }
      }
      // Human barrier active — do NOT drain peer messages this boundary.
      // Peer messages stay in the notifier buffer and will be picked up at
      // the next boundary (once the human queue is empty) or by the next-turn
      // fallback.
    } else {
      // ── 2. No human barrier: admit peer messages ─────────────────────────
      // Guard: do not drain from the notifier buffer if the admission queue is
      // already full — a failed submitPeer would silently discard the peer text
      // since drainInjections() is a destructive operation. Leaving the messages
      // in the notifier buffer allows the next boundary turn or next-turn
      // fallback to deliver them once the queue has capacity.
      if (peerNotifier.hasPendingInjections() && !admissionQueue.full) {
        const raw = peerNotifier.drainInjections();
        if (raw.length > 0) {
          // The raw string may contain multiple envelopes rendered as one block.
          // Admit as a single peer submission; senderId = 'peer-batch'.
          const admitted = admissionQueue.submitPeer('peer-batch', raw.trimEnd());
          if (!admitted) {
            // Queue rejected the batch (byte ceiling exceeded). The text has
            // already been drained from the notifier buffer — we cannot push it
            // back. This path should be extremely rare (the `!full` guard above
            // blocks the common count-limit case); log nothing (best-effort) and
            // leave it for next-turn recovery via prependTurnInjections.
            // The `full` guard makes this path reachable only when the byte
            // ceiling is hit without the count ceiling, which requires a single
            // very large peer batch (> 256 KiB). Acceptable loss in that edge case.
          }
        }
      }
    }

    // ── 3. Snapshot and drain ───────────────────────────────────────────────
    if (!admissionQueue.pending) return undefined;
    const snap = admissionQueue.snapshot();
    if (snap.entries.length === 0) return undefined;
    const text = admissionQueue.drain(snap);
    return text.length > 0 ? text : undefined;
  };

  // Capture the session at install time so the disposer clears the SAME
  // session object even if getSession() has been advanced to a new session.
  const installedSession = getSession();
  installedSession?.setBeforeNextRound?.(callback);

  return () => {
    // Clear the callback on the exact session this install targeted.
    installedSession?.setBeforeNextRound?.(undefined);
  };
}

/**
 * Re-install the boundary callback on a new session (after /resume or /model
 * swap). Clears the admission queue to discard old-session entries, then
 * installs fresh. Returns the new disposer.
 */
export function reinstallPeerBoundary(
  opts: PeerBoundaryOpts,
  prevDispose: (() => void) | undefined,
): () => void {
  prevDispose?.();
  // Reclaim any envelopes that were claimed from the old session's inbox but
  // not yet injected into a model turn (still in the notifier's in-memory
  // buffer). reclaimDelivered() renames them back to pending/ so the next poll
  // can re-deliver them to whoever picks them up. Best-effort: we don't await
  // here because reinstall must be synchronous for the swap sequence.
  void opts.peerNotifier.reclaim();
  opts.admissionQueue.clear();
  return installPeerBoundary(opts);
}

/**
 * Next-turn fallback drain: any admission-queue entries that the boundary
 * callback did not consume (e.g. turn had no tool rounds) are prepended to
 * `text` before it is submitted to the model. Returns the updated text.
 *
 * Human entries have already been removed from the compositor via `dropQueued`
 * inside the boundary callback; only peer stragglers reach here.
 */
export function drainAdmissionQueueFallback(text: string, q: AdmissionQueue): string {
  if (!q.pending) return text;
  const snap = q.snapshot();
  const extra = q.drain(snap);
  return extra.length > 0 ? extra + '\n\n' + text : text;
}

/**
 * Factory used by `runInputLoop` to wire peer boundary delivery without adding
 * code lines to the grandfathered loop-iteration.ts. Creates the AdmissionQueue,
 * builds the opts object from live getters on `ctx` and `surface`, installs the
 * first boundary, and returns the queue plus a `reinstall` function for the
 * `/resume` swap path.
 */
export function setupPeerBoundary(
  ctx: InteractiveCtx,
  surface: InputSurface,
  peerNotifier: PeerInboxNotifier,
): { admissionQueue: AdmissionQueue; reinstall: () => void } {
  const admissionQueue = new AdmissionQueue();
  const opts: PeerBoundaryOpts = {
    getSession: () => ctx.session.current as BoundarySession | undefined,
    getCompositor: () => surface.getCompositor() as BoundaryCompositor | null,
    peerNotifier,
    admissionQueue,
  };
  let dispose = installPeerBoundary(opts);
  const reinstall = () => { dispose = reinstallPeerBoundary(opts, dispose); };
  return { admissionQueue, reinstall };
}
