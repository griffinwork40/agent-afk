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
 *   - The REPL input buffer is non-empty (half-typed) → not an inter-round
 *     concern; the boundary callback doesn't touch readline state.
 *   - Attachments or slash-commands in the compositor queue → human-first tier
 *     handles it; peer remains in the PeerInboxNotifier buffer.
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
 *   1. Peeks any human queued-user-message from the compositor (priority tier).
 *   2. Drains peer messages from the PeerInboxNotifier buffer into the
 *      AdmissionQueue (peer tier).
 *   3. Takes an AdmissionQueue snapshot (human wins if any present).
 *   4. Returns the drained text, or `undefined` if nothing to deliver.
 *
 * Human entries are REMOVED from the compositor queue via `dropQueued` so they
 * are not delivered a second time by the next-turn idle drain. Peer entries are
 * removed from `admissionQueue` via `drain()`.
 *
 * Returns a disposer that removes the callback when called.
 */
export function installPeerBoundary(opts: PeerBoundaryOpts): () => void {
  const { getSession, getCompositor, peerNotifier, admissionQueue } = opts;

  const callback = (): string | undefined => {
    const compositor = getCompositor();

    // ── 1. Peek human queued-user-message ───────────────────────────────────
    const humanSnap = compositor?.peekQueuedText();
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

    // ── 2. Drain peer buffer into admission queue ───────────────────────────
    // drainInjections() returns formatted peer blocks; we need raw text.
    // Directly consume the notifier's buffer if non-empty.
    if (peerNotifier.hasPendingInjections()) {
      const raw = peerNotifier.drainInjections();
      if (raw.length > 0) {
        // The raw string may contain multiple envelopes; admit as a single peer
        // submission. senderId = 'peer-batch' (already rendered, no per-sender id).
        admissionQueue.submitPeer('peer-batch', raw.trimEnd());
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
