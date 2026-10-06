/**
 * Peer boundary delivery wiring for the top-level REPL session.
 *
 * Installs a `setBeforeNextRound` callback on the REPL's AgentSession so that
 * peer messages arriving during a tool batch are delivered at the next
 * inter-round boundary (after the batch, before the next model request) instead
 * of waiting for the next turn.
 *
 * Peer messages ONLY. A human queued-user-message (typed + Enter while a turn
 * runs) is never injected here: it stays in the compositor queue and runs as
 * its own turn at end of turn, which the yield-to-user contract
 * (`agent/tools/user-yield.ts`) relies on. It still takes priority: while one
 * is pending, peers are held back so the user's turn runs first.
 *
 * Barriers preventing peer injection:
 *   - Any human queued-user-message is present in the compositor → peer waits.
 *     The check uses `hasPendingSubmission()` (not just `peekQueuedText()`) so
 *     attachment-bearing payloads — where `peekQueuedText` returns undefined —
 *     still block peer injection correctly.
 *   - The REPL input buffer is non-empty (half-typed) → not an inter-round
 *     concern; the boundary callback doesn't touch readline state.
 *   - Attachments or slash-commands in the compositor queue → same barrier;
 *     peer remains in the PeerInboxNotifier buffer.
 *   - Admission queue byte or count ceiling reached mid-batch → only admitted
 *     envelopes are consumed from the notifier buffer; rejected envelopes stay
 *     in FIFO order for the next boundary turn or next-turn fallback. Each
 *     envelope is attempted individually (not as a merged batch) so a single
 *     large envelope never causes loss of smaller following envelopes.
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
import { renderPeerMessageBlock } from '../../../agent/peer/envelope.js';
import type { InteractiveCtx } from './shared.js';
import type { InputSurface } from '../../input/input-surface.js';
import { prependTurnInjections, type InjectionSource } from './loop-iteration.injections.js';

/**
 * Minimal compositor surface: a read-only probe of the human queue.
 *
 * Contract: deliberately has no peek/reserve/drop members, so the boundary
 * cannot consume the human queue (see the module doc for why).
 */
export interface BoundaryCompositor {
  /**
   * True when ANY human payload is pending (text, attachment, slash command, or
   * shell passthrough), i.e. exactly when the boundary should block peer
   * injection and defer to the human turn.
   */
  hasPendingSubmission(): boolean;
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
  /** Explicit active-turn barrier, including a human already removed from FIFO. */
  isQueuedHumanTurn?: () => boolean;
}

/**
 * Build and install the inter-round boundary callback on the current session.
 *
 * The callback, when invoked by the provider loop (Anthropic or OpenAI) at each
 * tool-round boundary:
 *   1. Checks `isQueuedHumanTurn()` (a human already dequeued from FIFO and
 *      currently running as the turn) OR `hasPendingSubmission()` (any human
 *      payload still waiting: text, attachment, slash command, or shell
 *      passthrough — including attachment-bearing payloads that
 *      `peekQueuedText` returns undefined for). If either is true the
 *      human-priority barrier is active: peer injection is skipped entirely
 *      this boundary. Peer messages stay in the notifier buffer.
 *   2. If no human barrier: admits peer messages one envelope at a time using
 *      `peekEnvelopes()` + `consumeEnvelopes()` — each envelope is attempted
 *      individually with its stable source id. Only admitted envelopes are
 *      consumed from the notifier buffer; rejected envelopes stay in FIFO order
 *      for the next boundary or next-turn drain. No peer message is ever
 *      silently discarded: rejection always means "retry later", not data loss.
 *   3. Takes an AdmissionQueue snapshot and returns the drained text, or
 *      `undefined` if nothing is ready to deliver.
 *
 * The human queue is never read or modified here. Peer entries are
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
    // Invariant: the boundary NEVER consumes the human queue. A message the
    // user typed + Entered mid-turn is delivered at END OF TURN by the
    // compositor's `→ idle` drain, as its own turn. The yield-to-user contract
    // (`agent/tools/user-yield.ts`) depends on this: a yielding tool such as
    // wait_for tells the model "end your turn so the message is delivered
    // first", which is only true if nothing pulls the message in mid-turn.
    // History: #2810 drained human text here too, so a queued message landed
    // after ANY tool round (bash, compose, ...) and the yield notice lied.
    //
    // hasPendingSubmission() is true for ANY human payload: text, attachment,
    // image, slash command. peekQueuedText() alone returns undefined for image-
    // bearing payloads, so it would wrongly let peers past the barrier.
    const humanPending = opts.isQueuedHumanTurn?.() === true || (compositor?.hasPendingSubmission() ?? false);
    // Human barrier active → skip peers entirely this boundary. They stay in
    // the notifier buffer so the user's queued turn runs first; the next-turn
    // drain (or a later boundary) delivers them.
    if (!humanPending) {
      // ── 2. No human barrier: admit peer messages one envelope at a time ──
      // Peek the buffered envelopes without consuming them, then attempt to
      // admit each individually into the admission queue using the envelope's
      // stable source id. Only consume (remove from notifier buffer) the
      // envelopes that were actually admitted — rejected envelopes remain in
      // the buffer for the next boundary turn or next-turn fallback, so no
      // peer messages are ever silently discarded on a byte or count ceiling.
      //
      // Five 64 KiB messages must each be admitted across successive turns:
      // the per-envelope loop + retain-on-reject guarantee ensures every
      // message is eventually injected once capacity exists, never dropped.
      if (peerNotifier.hasPendingInjections()) {
        const pending = peerNotifier.peekEnvelopes();
        let admitCount = 0;
        for (const { envelope } of pending) {
          // Render the envelope to its presentation block so the byte
          // accounting in the admission queue reflects what the model sees.
          const rendered = renderPeerMessageBlock(envelope);
          const admitted = admissionQueue.submitPeer(envelope.from.id, rendered.trimEnd());
          if (!admitted) {
            // Queue full or byte/sender ceiling reached. Stop trying further
            // envelopes — they stay in the notifier buffer in FIFO order and
            // will be re-attempted at the next boundary or next-turn drain.
            break;
          }
          admitCount++;
        }
        // Consume only the admitted prefix; rejected tail stays in the buffer.
        if (admitCount > 0) {
          peerNotifier.consumeEnvelopes(admitCount);
        }
      }
    }

    // ── 3. Snapshot and drain ───────────────────────────────────────────────
    // Under the human barrier nothing is injected, even a peer straggler: the
    // user's queued turn must run first (next-turn fallback picks it up).
    if (humanPending || !admissionQueue.pending) return undefined;
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
 * Only peer stragglers reach here: the boundary never admits human entries.
 */
export function drainAdmissionQueueFallback(text: string, q: AdmissionQueue): string {
  if (!q.pending) return text;
  const snap = q.snapshot();
  const extra = q.drain(snap);
  return extra.length > 0 ? extra + '\n\n' + text : text;
}

/**
 * Peer-deferral injection block extracted from `runInputLoop`.
 *
 * Computes the `deferPeers` flag from the explicit parameters (human-turn
 * barrier via `queuedHumanTurn` OR a pending compositor submission), then:
 *   - Calls `prependTurnInjections` with shell, bg, and — when not deferring —
 *     peer sources.
 *   - When not deferring, drains any peers already in the admission queue that
 *     the boundary callback did not consume (turns with no tool rounds).
 *
 * Returns the updated `runText`. All parameters are passed explicitly — no
 * closure over enclosing loop locals — so this function is trivially testable
 * and adds zero lines to `runInputLoop`.
 *
 * `processJobNotifier` is optional — supplied when the background-process job
 * notifier is present (i.e. the `run_in_background` feature is active). When
 * provided it is injected between `bgResultNotifier` and the peer notifier,
 * matching the same position it occupies in the full sources array.
 */
export function applyDeferPeers(
  runText: string,
  queuedHumanTurn: boolean,
  surface: Pick<InputSurface, 'getCompositor'>,
  shellPassthrough: InjectionSource,
  bgResultNotifier: InjectionSource,
  peerNotifier: InjectionSource,
  admissionQueue: AdmissionQueue,
  processJobNotifier?: InjectionSource,
): string {
  const deferPeers = queuedHumanTurn || (surface.getCompositor()?.hasPendingSubmission() ?? false);
  const extraSources: InjectionSource[] = processJobNotifier ? [processJobNotifier] : [];
  let out = prependTurnInjections(runText, [shellPassthrough, bgResultNotifier, ...extraSources, ...(!deferPeers ? [peerNotifier] : [])]);
  if (!deferPeers) out = drainAdmissionQueueFallback(out, admissionQueue);
  return out;
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
  isQueuedHumanTurn: () => boolean,
): { admissionQueue: AdmissionQueue; reinstall: () => void } {
  const admissionQueue = new AdmissionQueue();
  const opts: PeerBoundaryOpts = {
    getSession: () => ctx.session.current as BoundarySession | undefined,
    getCompositor: () => surface.getCompositor() as BoundaryCompositor | null,
    peerNotifier,
    admissionQueue,
    isQueuedHumanTurn,
  };
  let dispose = installPeerBoundary(opts);
  const reinstall = () => { dispose = reinstallPeerBoundary(opts, dispose); };
  return { admissionQueue, reinstall };
}
