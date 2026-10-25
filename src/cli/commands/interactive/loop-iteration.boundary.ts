/**
 * Peer boundary delivery wiring for the top-level REPL session.
 *
 * Installs a `setBeforeNextRound` callback on the REPL's AgentSession so that
 * peer messages arriving during a tool batch are delivered at the next
 * inter-round boundary (after the batch, before the next model request) instead
 * of waiting for the next turn.
 *
 * When `AFK_STEER_MODE=boundary`, typed-ahead REPL messages are also drained at
 * every tool-round boundary (Part of #3897). The default (`turn-end`) preserves
 * the existing behaviour where a queued message runs as its own turn.
 *
 * Settled background-process envelopes (`<background-process-result>`) ride
 * the same boundary. Invariant: an envelope for a job that settles mid-turn
 * must reach the model INSIDE that turn when a later tool round exists;
 * otherwise it sits in the notifier until the turn ends and the auto-resume
 * wake starts a whole extra turn just to re-report an outcome the model
 * usually already learned (via wait_for, a log tail, ...). Delivery is a
 * positive fact, so no heuristic about "did the model see it" is needed: a
 * job still pending at turn end was by definition not delivered, and the
 * wake is correct. Process envelopes are metadata only (see
 * process-job-notifier.ts) and bounded by its MAX_PENDING, so they bypass the
 * peer AdmissionQueue byte accounting, but they obey the same human barrier.
 *
 * Peer messages and process envelopes ONLY by default. When `AFK_STEER_MODE=boundary`
 * a human queued-user-message is also drained here (Part of #3897). In the default
 * `turn-end` mode the message stays in the compositor queue and runs as its own turn,
 * which the yield-to-user contract (`agent/tools/user-yield.ts`) relies on. It still
 * takes priority: while one is pending (in `turn-end` mode), peers are held back so
 * the user's turn runs first.
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
import { env } from '../../../config/env.js';
import type { TraceSink } from '../../../agent/trace/index.js';

/**
 * Minimal compositor surface used by the peer boundary.
 *
 * `hasPendingSubmission` is always required. `peekQueuedText` and `dropQueued`
 * are optional extensions used only when `AFK_STEER_MODE=boundary` is set
 * (Part of #3897); their absence is safe — the feature simply stays off.
 */
export interface BoundaryCompositor {
  /**
   * True when ANY human payload is pending (text, attachment, slash command, or
   * shell passthrough), i.e. exactly when the boundary should block peer
   * injection and defer to the human turn.
   */
  hasPendingSubmission(): boolean;
  /**
   * Snapshot the queued text-only messages without consuming them.
   * Returns `undefined` when nothing is queued, when queued payloads contain
   * attachments (which can't ride a text-only boundary carrier), or when the
   * joined text is blank. Only used when `AFK_STEER_MODE=boundary`.
   */
  peekQueuedText?(): { readonly text: string; readonly preview: string; readonly payloads: readonly unknown[] } | undefined;
  /**
   * Drop exactly the payloads captured in a prior `peekQueuedText` snapshot,
   * after their text has been delivered. Only used when `AFK_STEER_MODE=boundary`.
   */
  dropQueued?(snapshot: { readonly text: string; readonly preview: string; readonly payloads: readonly unknown[] }): number;
}

/** Minimal session surface: only what boundary needs. */
export interface BoundarySession {
  setBeforeNextRound?: (cb: (() => string | undefined) | undefined) => void;
}

/**
 * Steering mode resolved from `AFK_STEER_MODE`. Defaults to `turn-end`.
 * Only `boundary` enables mid-turn human-queue drain (Part of #3897).
 */
export type SteerMode = 'boundary' | 'turn-end';

/** Read and validate `AFK_STEER_MODE` from the environment. */
export function resolveSteerMode(): SteerMode {
  return env.AFK_STEER_MODE === 'boundary' ? 'boundary' : 'turn-end';
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
  /**
   * Settled background-process envelopes, drained at each boundary (behind
   * the human barrier). Absent when the session has no process registry.
   */
  processJobNotifier?: InjectionSource;
  /**
   * Steering mode for this boundary. When `boundary`, the callback also drains
   * the human compositor queue at each tool-round boundary (Part of #3897).
   * Defaults to `turn-end` (existing behaviour preserved).
   */
  steerMode?: SteerMode;
  /**
   * Trace sink — reserved for future boundary-specific witness events.
   * The `queued_user_message` event is emitted by the provider loop (inter-round)
   * when it consumes the steering text, not here (avoids duplicate trace rows).
   */
  traceWriter?: TraceSink;
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

    // ── 1. Human barrier / steering-mode check ──────────────────────────────
    // In default `turn-end` mode the boundary NEVER consumes the human queue.
    // A message typed + Entered mid-turn is delivered at END OF TURN by the
    // compositor's `→ idle` drain, as its own turn. The yield-to-user contract
    // (`agent/tools/user-yield.ts`) depends on this: a yielding tool such as
    // wait_for tells the model "end your turn so the message is delivered
    // first", which is only true if nothing pulls the message in mid-turn.
    //
    // In `boundary` mode (AFK_STEER_MODE=boundary, Part of #3897) the human
    // message IS drained here, ahead of peer messages.  Attachment-bearing
    // payloads still fall through to their normal turn — peekQueuedText()
    // returns undefined for them, so they are never silently dropped.
    //
    // hasPendingSubmission() is true for ANY human payload: text, attachment,
    // image, slash command. peekQueuedText() alone returns undefined for image-
    // bearing payloads, so it would wrongly let peers past the barrier.
    const humanPending = opts.isQueuedHumanTurn?.() === true || (compositor?.hasPendingSubmission() ?? false);

    // ── 1a. Boundary-mode human drain (AFK_STEER_MODE=boundary) ─────────────
    // Invariant: only text-only queued messages are drained here. Attachment-
    // bearing payloads (peekQueuedText → undefined) are left for the normal
    // idle drain so images remain intact. Double-delivery is prevented by
    // dropQueued — once the text is handed to the provider loop the payloads
    // are removed from the compositor queue before the next → idle transition.
    if (opts.steerMode === 'boundary' && humanPending && compositor !== null && compositor !== undefined) {
      const snapshot = compositor.peekQueuedText?.();
      if (snapshot !== undefined) {
        // Invariant: command-shaped submissions (slash commands `/…` and shell
        // passthroughs `!…`) must NOT be drained mid-turn. They require the
        // normal REPL dispatch path (loop-iteration.ts:204-212) which handles
        // slash resolution, shell execution, and plugin forwarding. Draining
        // them here would send raw command text to the model, bypassing
        // dispatch and potentially disclosing local shell commands/secrets.
        const trimmed = snapshot.text.trimStart();
        if (trimmed.startsWith('/') || trimmed.startsWith('!')) {
          // Leave the queue intact for the normal turn-end path.
          // Fall through to the peer-delivery section below; the human barrier
          // (humanPending=true) will block peers as usual.
        } else {
          // Drop BEFORE returning so the compositor's → idle transition does not
          // re-deliver the same text as a separate turn.
          compositor.dropQueued?.(snapshot);
          // Note: the `queued_user_message` trace event is emitted by the provider
          // loop (anthropic-direct/loop/inter-round.ts, openai-compatible/query/
          // turn-driver.ts) when it consumes the steeringText — not here. This
          // avoids duplicate witness rows.
          //
          // Return immediately: the human message IS the content for this boundary.
          // Peers are deferred; they will be delivered at the next boundary or the
          // next-turn fallback, maintaining the invariant that the user's message
          // is always seen before peer content.
          return snapshot.text;
        }
      }
      // No text-only snapshot (attachment-bearing or blank), or command-shaped
      // text that must go through REPL dispatch → fall through to the normal
      // peer-delivery path below; the human payload stays queued.
    }

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
      // Skip rendering entirely when the queue is already at maxCount — no
      // envelope can be admitted regardless of byte size, so there is no
      // point paying the renderPeerMessageBlock cost for each one.
      if (peerNotifier.hasPendingInjections() && !admissionQueue.full) {
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
    // Under the human barrier nothing is injected, even a peer straggler or a
    // process envelope: the user's queued turn must run first (the next-turn
    // fallback in applyDeferPeers drains both).
    if (humanPending) return undefined;
    // Early-exit when neither source has anything ready: avoids allocating the
    // parts array on every tool-round boundary for the common idle case.
    if (!opts.processJobNotifier?.hasPendingInjections() && !admissionQueue.pending) {
      return undefined;
    }
    // Process envelopes first, matching the next-turn prepend order
    // (process results precede peer messages).
    const parts: string[] = [];
    const processText = opts.processJobNotifier?.drainInjections().trimEnd() ?? '';
    if (processText.length > 0) parts.push(processText);
    if (admissionQueue.pending) {
      const snap = admissionQueue.snapshot();
      if (snap.entries.length > 0) {
        const peerText = admissionQueue.drain(snap);
        if (peerText.length > 0) parts.push(peerText);
      }
    }
    return parts.length > 0 ? parts.join('\n\n') : undefined;
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
 *
 * Reads `AFK_STEER_MODE` once at call time and threads it into `PeerBoundaryOpts`
 * so the callback drains the human queue mid-turn when `boundary` mode is active
 * (Part of #3897).
 */
export function setupPeerBoundary(
  ctx: InteractiveCtx,
  surface: InputSurface,
  peerNotifier: PeerInboxNotifier,
  isQueuedHumanTurn: () => boolean,
  processJobNotifier?: InjectionSource,
): { admissionQueue: AdmissionQueue; reinstall: () => void } {
  const admissionQueue = new AdmissionQueue();
  const steerMode = resolveSteerMode();
  // One-time warning: boundary mode requires peekQueuedText/dropQueued on the
  // compositor. If the compositor lacks them the feature silently stays off,
  // which is correct but surprising — surface it once so the operator knows.
  if (steerMode === 'boundary') {
    const comp = surface.getCompositor() as BoundaryCompositor | null;
    if (comp) {
      const missing: string[] = [];
      if (!comp.peekQueuedText) missing.push('peekQueuedText');
      if (!comp.dropQueued) missing.push('dropQueued');
      if (missing.length > 0) {
        process.stderr.write(
          '[afk] warning: AFK_STEER_MODE=boundary is set but the compositor does not expose ' +
          `${missing.join(', ')} — mid-turn human-queue drain will be inactive.\n`,
        );
      }
    }
  }
  const opts: PeerBoundaryOpts = {
    getSession: () => ctx.session.current as BoundarySession | undefined,
    getCompositor: () => surface.getCompositor() as BoundaryCompositor | null,
    peerNotifier,
    admissionQueue,
    isQueuedHumanTurn,
    processJobNotifier,
    steerMode,
    traceWriter: ctx.traceWriter,
  };
  let dispose = installPeerBoundary(opts);
  const reinstall = () => { dispose = reinstallPeerBoundary(opts, dispose); };
  return { admissionQueue, reinstall };
}
