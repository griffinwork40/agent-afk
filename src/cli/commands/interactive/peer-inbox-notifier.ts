/**
 * REPL-side receiver for cross-session peer messages.
 *
 * Watches this session's peer inbox (`$AFK_STATE_DIR/inbox/<id>/pending/`)
 * with `fs.watch` plus an unref'd poll (the poll is the safety net: macOS
 * FSEvents coalesces and Linux inotify mis-reports renames). Each scan
 * (see `peer-inbox-scan.ts`) claims accepted envelopes into an in-memory FIFO
 * buffer and moves held ones to `held/`. The surface mirrors
 * `BgResultNotifier` (`hasPendingInjections` / `drainInjections` /
 * `onInjectable`) so the REPL's existing `tryAutoResume` wake path serves
 * both: an idle prompt with an empty input buffer wakes, a busy session gets
 * the message prepended to its next turn, and nothing ever interrupts a
 * running turn or clobbers half-typed input.
 *
 * Contract:
 *   - The inbox is keyed on `getSessionId()` — the same id the presence file
 *     advertises (`provider-query-build.ts` invariant). It is undefined until
 *     the first turn mints it, and changes on `/resume`; the poll re-keys the
 *     watcher whenever the id changes.
 *   - Body text is never written to the trace; only ids and byte counts.
 *   - Crash window: an envelope claimed (linked into `delivered/`) but not yet
 *     drained into a turn is lost from the conversation if the process dies.
 *     The file stays in `delivered/` for forensics.
 *   - Scans are serialized; overlapping triggers coalesce into one rescan.
 *
 * @module cli/commands/interactive/peer-inbox-notifier
 */

import { watch, mkdir } from 'fs/promises';
import { join } from 'path';
import { getPeerInboxDir } from '../../../paths.js';
import { listHeld, releaseHeld, claimPending, reclaimDelivered, envelopeFilename, writeInjectionAck, recoverUnackedDelivered } from '../../../agent/peer/inbox-store.js';
import { resolvePeerInboundMode, type PeerInboundMode } from '../../../agent/peer/inbound-mode.js';
import { createWakeBudget, type WakeBudget } from '../../../agent/peer/guards.js';
import { renderPeerMessageBlock, type PeerEnvelope } from '../../../agent/peer/envelope.js';
import { emitPeerMessage } from '../../../agent/trace/emit.js';
import type { TraceSink } from '../../../agent/trace/index.js';
import { palette } from '../../palette.js';
import { getTerminalWidth } from '../../terminal-size.js';
import { capToMeasure, contentMargin } from '../../render/measure.js';
import { formatPeerArrival, safePeerSender } from './peer-arrival-format.js';
import { env } from '../../../config/env.js';
import { scanPeerInbox, type HeldReason } from './peer-inbox-scan.js';
import type { InteractiveCtx } from './shared.js';
import {
  resolveTmuxLabel,
  setPresenceName,
  setPresenceNameIfUnset,
  setPresencePeerInbox,
} from '../../../agent/awareness/presence.peer.js';
import { pruneDeliveredReceipts } from '../../../agent/peer/inbox-retention.js';

/** Max envelopes buffered between drains; extras stay in `pending/`. */
const MAX_PENDING_INJECTIONS = 50;

export interface PeerInboxNotifierOpts {
  /** Current session id; undefined until the first turn mints it. */
  getSessionId: () => string | undefined;
  /** Human-visible line in the REPL scrollback. */
  writeLine: (text: string) => void;
  /** Inbound mode getter (default: `AFK_PEER_INBOUND`). */
  mode?: () => PeerInboundMode;
  /**
   * Live getter for the trace writer. Called on every emit so a mid-session
   * resume (which swaps the trace writer) is automatically reflected.
   * When not provided, tracing is disabled.
   */
  getTraceWriter?: () => TraceSink | undefined;
  now?: () => number;
  /** Poll interval override (ms). Falls back to `AFK_PEER_POLL_MS`, then 1000. */
  pollMs?: number;
}

function resolvePollMs(override: number | undefined): number {
  if (override !== undefined && override > 0) return override;
  const n = parseInt(env.AFK_PEER_POLL_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 1000;
}

/** Buffered claimed envelope with enough context to reclaim it on dispose/resume. */
interface BufferedClaim {
  envelope: PeerEnvelope;
  /** Session-id whose delivered/ directory holds the claimed file. */
  sessionId: string;
}

export class PeerInboxNotifier {
  /** Wake hook; wired to the REPL's `tryAutoResume`. */
  onInjectable: (() => void) | null = null;

  private readonly buffer: BufferedClaim[] = [];
  private wakeBudget: WakeBudget;
  private readonly pollMs: number;
  private readonly getMode: () => PeerInboundMode;
  private readonly resolveTraceWriter: () => TraceSink | undefined;
  private scanning = false;
  private rescan = false;
  private watchedId: string | undefined;
  private watchAc: AbortController | undefined;
  private pollHandle: ReturnType<typeof setInterval> | undefined;
  /**
   * Set by dispose(). Every async continuation (tick, scan, watcher setup)
   * re-checks it after its awaits: an in-flight tick that resumed after
   * dispose() would otherwise resurrect an orphaned watcher that keeps
   * claiming messages into a buffer nothing drains.
   */
  private disposed = false;
  /** Operator `/name` choice; survives until the presence file exists. */
  private desiredName: string | undefined;
  /**
   * Generation counter incremented on each `onSwapped()` reset. Every async
   * scan captures the generation at start and discards its results if the
   * counter has advanced by the time it completes (A→B→A resume race).
   */
  private generation = 0;
  /** Timestamp of the last delivered/ retention sweep. 0 = not yet run. */
  private lastRetentionRunMs = 0;

  constructor(private readonly opts: PeerInboxNotifierOpts) {
    this.wakeBudget = createWakeBudget(opts.now !== undefined ? { now: opts.now } : {});
    this.pollMs = resolvePollMs(opts.pollMs);
    this.getMode = opts.mode ?? resolvePeerInboundMode;
    this.resolveTraceWriter = opts.getTraceWriter ?? (() => undefined);
  }

  /**
   * Invariant: reset per-session state synchronously at the resume-swap commit point
   * (call from `onSwapped` in bootstrap.ts before the drain cycle runs).
   *
   * - Clears the injection buffer so outgoing-session messages cannot leak
   *   into the resumed session's first turn.
   * - Resets the wake budget so resumed-session senders start from a clean
   *   credit pool.
   * - Advances the generation counter so any async scan that is still in
   *   flight (forceAccept, watcher-triggered scan, rescan loop) sees a stale
   *   generation and discards its results instead of injecting them.
   * - Stops the current watcher (watchedId is cleared) so the next tick
   *   re-establishes a watcher for the new session's inbox directory.
   */
  resetForNewSession(): void {
    // Reclaim buffered-but-uninjected envelopes back to pending/ so the next
    // poll can re-deliver them. Best-effort; fire-and-forget.
    void this.reclaim();
    this.generation++;
    this.wakeBudget = createWakeBudget(this.opts.now !== undefined ? { now: this.opts.now } : {});
    this.stopWatcher(); // clears watchedId → next tick re-keys to new sessionId
  }

  hasPendingInjections(): boolean {
    return this.buffer.length > 0;
  }

  /**
   * Peek at the buffered envelopes without consuming them. Returns a readonly
   * snapshot of the current buffer in FIFO order. Use with `consumeEnvelopes`
   * to implement transactional admit-then-consume semantics: peek all entries,
   * call `submitPeer` on each in the admission queue, then consume only those
   * that were accepted — so rejected entries remain in the buffer for the next
   * boundary turn instead of being silently discarded.
   */
  peekEnvelopes(): readonly BufferedClaim[] {
    return this.buffer;
  }

  /**
   * Consume (remove and emit 'injected' trace events for) the first `count`
   * envelopes from the buffer. Callers must only consume envelopes that were
   * successfully admitted to the downstream queue — unconsumed tail entries
   * remain in the buffer for the next boundary turn or next-turn fallback.
   *
   * Returns the rendered text of the consumed envelopes joined by '\n'.
   *
   * Generation-guard note: `consumeEnvelopes` does NOT check `isCurrent()`.
   * This is intentional. The REPL boundary callback that calls
   * `peekEnvelopes()` + `consumeEnvelopes()` is synchronous — the session
   * generation cannot advance between the peek and the consume (there is no
   * await). A generation mismatch therefore cannot occur on this path:
   * `resetForNewSession()` is only called from the resume-swap commit point,
   * which is serialized against the callback by the REPL event loop.
   * The async paths (`scan`, `forceAccept`) do check `isCurrent()` after
   * every await because a swap CAN fire while those are in flight.
   */
  consumeEnvelopes(count: number): string {
    if (count <= 0 || this.buffer.length === 0) return '';
    const toConsume = this.buffer.splice(0, count);
    const text = toConsume.map(({ envelope }) => renderPeerMessageBlock(envelope)).join('\n') + '\n\n';
    for (const { envelope, sessionId } of toConsume) {
      const bytes = Buffer.byteLength(envelope.body, 'utf8');
      void emitPeerMessage(this.resolveTraceWriter(), { action: 'injected', messageId: envelope.messageId, peer: envelope.from.id, bytes });
      // Write injection-ack marker so recoverUnackedDelivered on restart will
      // not re-queue this envelope. Fire-and-forget: never throws.
      void writeInjectionAck(sessionId, envelopeFilename(envelope));
    }
    return text;
  }

  /**
   * Render and clear the buffer (one block per envelope). Returns '' when
   * empty. Each drained envelope emits an `'injected'` trace event — distinct
   * from `'claimed'` (which fires at claim time) so the trace accurately
   * reflects what the model actually saw.
   *
   * Prefer `peekEnvelopes()` + `consumeEnvelopes()` for admission-gated paths
   * where some envelopes may be rejected by a downstream queue. This method
   * is a convenience wrapper for callers that always consume all pending entries
   * (e.g. the next-turn fallback `prependTurnInjections` path).
   */
  drainInjections(): string {
    return this.consumeEnvelopes(this.buffer.length);
  }

  /**
   * Reclaim all currently buffered (claimed-but-not-yet-injected) envelopes
   * back to `pending/` in their originating session's inbox. Call this before
   * clearing the buffer on a session swap (`/resume`) so the new session can
   * re-claim them on its next scan. Best-effort: individual rename failures
   * are swallowed so a partial reclaim doesn't block the swap.
   *
   * Returns the number of envelopes successfully reclaimed.
   *
   * Generation-guard note: `reclaim` does NOT check `isCurrent()` and does
   * not use `this.generation`. It is called exclusively from
   * `resetForNewSession()`, which holds a lock on the swap sequence: at the
   * call site, `this.generation` has already been incremented and the buffer
   * has been spliced out atomically (in JavaScript's single-threaded sense).
   * Any concurrently in-flight `scan` or `forceAccept` that returns after
   * this point will find a stale generation and discard its results — so
   * reclaim owns the spliced claims exclusively and needs no generation check.
   */
  async reclaim(): Promise<number> {
    if (this.buffer.length === 0) return 0;
    const claims = this.buffer.splice(0);
    let reclaimed = 0;
    for (const { envelope, sessionId } of claims) {
      const file = envelopeFilename(envelope);
      try {
        const ok = await reclaimDelivered(sessionId, file);
        const bytes = Buffer.byteLength(envelope.body, 'utf8');
        void emitPeerMessage(this.resolveTraceWriter(), {
          action: ok ? 'reclaimed' : 'dropped',
          messageId: envelope.messageId,
          peer: envelope.from.id,
          bytes,
        });
        if (ok) reclaimed++;
      } catch {
        // Best-effort: never crash the swap sequence.
      }
    }
    return reclaimed;
  }

  /** Begin watching + polling. Idempotent. */
  start(): void {
    if (this.pollHandle !== undefined) return;
    this.disposed = false;
    this.pollHandle = setInterval(() => void this.tick(), this.pollMs);
    this.pollHandle.unref?.();
    void this.tick();
  }

  /** Stop watcher and poll. Idempotent. */
  dispose(): void {
    this.disposed = true;
    if (this.pollHandle !== undefined) clearInterval(this.pollHandle);
    this.pollHandle = undefined;
    this.stopWatcher();
  }

  /**
   * Operator override (`/inbox accept`): move the named held envelopes back
   * through pending into the buffer, bypassing the wake budget. Returns how
   * many were injected.
   *
   * Generation-checked: if a resume swap fires while the async listHeld +
   * releaseHeld + claimPending chain is in flight, results from the outgoing
   * session are discarded (generation mismatch) rather than injected into the
   * resumed session's first turn.
   */
  async forceAccept(messageIds: ReadonlySet<string> | 'all'): Promise<number> {
    const sessionId = this.opts.getSessionId();
    if (sessionId === undefined || this.disposed) return 0;
    const gen = this.generation;
    const wasEmpty = this.buffer.length === 0;
    let injected = 0;
    for (const held of await listHeld(sessionId)) {
      if (!this.isCurrent(sessionId, gen)) return 0; // swap fired mid-flight; discard
      // Corrupt entries cannot be accepted (no parseable envelope); skip.
      if (held.corrupt) continue;
      const { file, envelope } = held;
      if (messageIds !== 'all' && !messageIds.has(envelope.messageId)) continue;
      const released = await releaseHeld(sessionId, file);
      if (!this.isCurrent(sessionId, gen)) return 0; // swap fired between release and claim
      if (!released) continue;
      const claimed = await claimPending(sessionId, file).catch(() => null);
      if (!this.isCurrent(sessionId, gen)) return 0; // swap fired after claim; discard
      if (claimed === null) continue;
      this.accept(claimed, sessionId);
      injected++;
    }
    if (!this.isCurrent(sessionId, gen)) return 0;
    if (wasEmpty && injected > 0) this.fireInjectable();
    return injected;
  }

  /**
   * `/name`: record the operator's label and apply it now if the presence file
   * exists, else on first watch (presence is only written once a turn starts).
   */
  async setName(name: string | undefined): Promise<void> {
    this.desiredName = name;
    const sessionId = this.opts.getSessionId();
    if (sessionId !== undefined) await setPresenceName(sessionId, name);
  }

  /** Run one scan now (tests and the poll tick). Serialized. */
  async scan(): Promise<void> {
    const sessionId = this.opts.getSessionId();
    if (sessionId === undefined || this.disposed) return;
    if (this.scanning) { this.rescan = true; return; }
    this.scanning = true;
    const gen = this.generation;
    try {
      do {
        this.rescan = false;
        // Re-read sessionId each iteration: a swap may have changed it.
        const currentId = this.opts.getSessionId();
        if (currentId === undefined || !this.isCurrent(sessionId, gen)) break;
        await this.scanOnce(currentId, gen);
      } while (this.rescan);
    } catch {
      // Best-effort: the REPL must never crash on inbox I/O.
    } finally {
      this.scanning = false;
    }
  }

  private isCurrent(sessionId: string, gen: number): boolean {
    return !this.disposed && this.generation === gen && this.opts.getSessionId() === sessionId;
  }

  private async scanOnce(sessionId: string, gen: number): Promise<void> {
    if (!this.isCurrent(sessionId, gen)) return;
    const wasEmpty = this.buffer.length === 0;
    const { claimed, held } = await scanPeerInbox({
      sessionId,
      mode: this.getMode(),
      wakeBudget: this.wakeBudget,
      capacity: MAX_PENDING_INJECTIONS - this.buffer.length,
    });
    // Drop results if a swap fired while the async scan was in flight.
    if (!this.isCurrent(sessionId, gen)) return;
    for (const h of held) {
      if (h.reason === 'corrupt') {
        this.noteCorrupt(h.file);
      } else {
        this.noteHeld(h.envelope, h.reason);
      }
    }
    for (const e of claimed) this.accept(e, sessionId);
    if (wasEmpty && claimed.length > 0) this.fireInjectable();
  }

  private accept(e: PeerEnvelope, sessionId?: string): void {
    const sid = sessionId ?? '';
    const bytes = Buffer.byteLength(e.body, 'utf8');
    this.buffer.push({ envelope: e, sessionId: sid });
    // Display sanitization/truncation never touches the serialized envelope.
    const cols = getTerminalWidth();
    this.opts.writeLine(formatPeerArrival(e, capToMeasure(cols - contentMargin(cols).length)));
    // Emit 'claimed': the envelope has been moved to delivered/ on disk. The
    // 'injected' event fires separately in consumeEnvelopes() when the text
    // actually reaches a model turn. These are distinct: a crash between claim
    // and inject leaves 'claimed' with no matching 'injected'; a reclaim on
    // resume emits 'reclaimed'. resolveTraceWriter() reads live.
    void emitPeerMessage(this.resolveTraceWriter(), { action: 'claimed', messageId: e.messageId, peer: e.from.id, bytes });
  }

  private noteHeld(e: PeerEnvelope, reason: Exclude<HeldReason, 'corrupt'>): void {
    const bytes = Buffer.byteLength(e.body, 'utf8');
    const why = reason === 'wake-budget' ? 'wake budget reached' : 'AFK_PEER_INBOUND=hold';
    const sizeHint = bytes >= 1024 ? ` · ${(bytes / 1024).toFixed(1)} kB` : '';
    this.opts.writeLine(palette.dim(`↘ peer message from ${safePeerSender(e.from)} held (${why})${sizeHint} · /inbox to review`));
    // resolveTraceWriter() reads live so mid-session resume is reflected.
    void emitPeerMessage(this.resolveTraceWriter(), { action: 'held', messageId: e.messageId, peer: e.from.id, bytes, reason });
  }

  /** Notify the operator when an unparseable or corrupt pending file is quarantined. */
  private noteCorrupt(file: string): void {
    // Strip control characters from the filename for safe terminal display.
    // eslint-disable-next-line no-control-regex
    const safeFile = file.replace(/[\x00-\x1f\x7f-\x9f]/g, '');
    this.opts.writeLine(
      palette.dim(`↘ peer message held (corrupt/unsupported format: ${safeFile}) · /inbox drop to remove`),
    );
    // Invariant: messageId and peer are unavailable here — the file is
    // unparseable, so no structured envelope exists. peer is set to 'unknown'
    // and bytes to 0 rather than omitting the trace event entirely, so the
    // operator can see the quarantine in the trace even without a sender id.
    void emitPeerMessage(this.resolveTraceWriter(), {
      action: 'held',
      peer: 'unknown',
      bytes: 0,
      reason: 'corrupt',
      file: safeFile,
    });
  }

  private fireInjectable(): void {
    try { this.onInjectable?.(); } catch { /* best-effort */ }
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    const sessionId = this.opts.getSessionId();
    if (sessionId !== undefined && sessionId !== this.watchedId) await this.startWatching(sessionId);
    await this.scan();
    if (this.disposed || sessionId === undefined) return;
    // Throttled retention sweep: prune stale delivered/ receipts. Best-effort;
    // pruneDeliveredReceipts never throws. Update the cursor only when the
    // sweep actually ran (result.ran = true) so the interval stays accurate.
    const retention = await pruneDeliveredReceipts({
      sessionId,
      lastRanMs: this.lastRetentionRunMs,
      now: this.opts.now,
    });
    if (retention.ran) this.lastRetentionRunMs = retention.nowMs;
  }

  private stopWatcher(): void {
    try { this.watchAc?.abort(); } catch { /* best-effort */ }
    this.watchAc = undefined;
    this.watchedId = undefined;
  }

  /** Mark presence as a reader and apply the `/name` or tmux label. Best-effort. */
  private async advertise(sessionId: string, gen: number): Promise<void> {
    if (!this.isCurrent(sessionId, gen)) return;
    await setPresencePeerInbox(sessionId, true);
    if (!this.isCurrent(sessionId, gen)) return;
    if (this.desiredName !== undefined) return setPresenceName(sessionId, this.desiredName);
    const label = await resolveTmuxLabel();
    if (this.isCurrent(sessionId, gen) && label !== undefined) await setPresenceNameIfUnset(sessionId, label);
  }

  private async startWatching(sessionId: string): Promise<void> {
    this.stopWatcher();
    this.watchedId = sessionId;
    const startGen = this.generation;
    const base = getPeerInboxDir(sessionId);
    try {
      for (const sub of ['pending', 'delivered', 'held']) {
        await mkdir(join(base, sub), { recursive: true, mode: 0o700 });
      }
    } catch {
      return; // the poll keeps retrying scans; nothing to watch yet
    }
    // Guard: disposed, re-keyed, OR a swap fired between the awaited mkdir and now.
    if (this.disposed || this.watchedId !== sessionId || !this.isCurrent(sessionId, startGen)) return;
    void this.advertise(sessionId, startGen);
    // Recover any envelopes claimed before a prior crash that were never acked.
    // Fire-and-forget: best-effort, never throws. Recovery moves them back to
    // pending/ so the next scan picks them up for re-delivery.
    void recoverUnackedDelivered(sessionId).then((recovered) => {
      if (recovered.length > 0 && this.isCurrent(sessionId, startGen)) {
        this.opts.writeLine(`↩ recovered ${recovered.length} unacked peer message(s) from prior crash`);
      }
    });
    const ac = new AbortController();
    this.watchAc = ac;
    const watchGen = this.generation;
    void (async () => {
      try {
        for await (const _event of watch(join(base, 'pending'), { signal: ac.signal })) {
          // Ignore watcher events from a prior session's generation.
          if (this.isCurrent(sessionId, watchGen)) void this.scan();
        }
      } catch {
        // AbortError on dispose/re-key, or a dead watcher: the poll is the safety net.
      }
    })();
  }
}

/** Factory kept for call-site symmetry with the other footer subsystems. */
export function createPeerInboxNotifier(opts: PeerInboxNotifierOpts): PeerInboxNotifier {
  return new PeerInboxNotifier(opts);
}

/**
 * The REPL's notifier: keyed on `ctx.stats.sessionId` (the presence id; see
 * module Contract), rendering through the REPL renderer and tracing to the
 * session's witness writer when one is attached.
 */
export function createReplPeerNotifier(ctx: InteractiveCtx): PeerInboxNotifier {
  return new PeerInboxNotifier({
    getSessionId: () => ctx.stats.sessionId,
    writeLine: (text) => ctx.replRenderer.writeLine(text),
    getTraceWriter: () => ctx.traceWriter,
  });
}
