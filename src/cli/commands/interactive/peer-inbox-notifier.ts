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
 *   - Crash window: an envelope claimed (renamed into `delivered/`) but not yet
 *     drained into a turn is lost from the conversation if the process dies.
 *     The file stays in `delivered/` for forensics.
 *   - Scans are serialized; overlapping triggers coalesce into one rescan.
 *
 * @module cli/commands/interactive/peer-inbox-notifier
 */

import { watch, mkdir } from 'fs/promises';
import { join } from 'path';
import { getPeerInboxDir } from '../../../paths.js';
import { listHeld, releaseHeld, claimPending } from '../../../agent/peer/inbox-store.js';
import { resolvePeerInboundMode, type PeerInboundMode } from '../../../agent/peer/inbound-mode.js';
import { createWakeBudget, type WakeBudget } from '../../../agent/peer/guards.js';
import { renderPeerMessageBlock, type PeerEnvelope } from '../../../agent/peer/envelope.js';
import { emitPeerMessage } from '../../../agent/trace/emit.js';
import type { TraceSink } from '../../../agent/trace/index.js';
import { palette } from '../../palette.js';
import { env } from '../../../config/env.js';
import { scanPeerInbox, type HeldReason } from './peer-inbox-scan.js';
import type { InteractiveCtx } from './shared.js';
import {
  resolveTmuxLabel,
  setPresenceName,
  setPresenceNameIfUnset,
  setPresencePeerInbox,
} from '../../../agent/awareness/presence.peer.js';

/** Max envelopes buffered between drains; extras stay in `pending/`. */
const MAX_PENDING_INJECTIONS = 50;

export interface PeerInboxNotifierOpts {
  /** Current session id; undefined until the first turn mints it. */
  getSessionId: () => string | undefined;
  /** Human-visible line in the REPL scrollback. */
  writeLine: (text: string) => void;
  /** Inbound mode getter (default: `AFK_PEER_INBOUND`). */
  mode?: () => PeerInboundMode;
  traceWriter?: TraceSink;
  now?: () => number;
  /** Poll interval override (ms). Falls back to `AFK_PEER_POLL_MS`, then 1000. */
  pollMs?: number;
}

function resolvePollMs(override: number | undefined): number {
  if (override !== undefined && override > 0) return override;
  const n = parseInt(env.AFK_PEER_POLL_MS ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : 1000;
}

function senderLabel(e: PeerEnvelope): string {
  const short = e.from.id.slice(0, 8);
  return e.from.name !== undefined ? `${e.from.name} (${short})` : short;
}

function sizeLabel(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${bytes} B`;
}

export class PeerInboxNotifier {
  /** Wake hook; wired to the REPL's `tryAutoResume`. */
  onInjectable: (() => void) | null = null;

  private readonly buffer: PeerEnvelope[] = [];
  private readonly wakeBudget: WakeBudget;
  private readonly pollMs: number;
  private readonly getMode: () => PeerInboundMode;
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

  constructor(private readonly opts: PeerInboxNotifierOpts) {
    this.wakeBudget = createWakeBudget(opts.now !== undefined ? { now: opts.now } : {});
    this.pollMs = resolvePollMs(opts.pollMs);
    this.getMode = opts.mode ?? resolvePeerInboundMode;
  }

  hasPendingInjections(): boolean {
    return this.buffer.length > 0;
  }

  /** Render and clear the buffer (one block per envelope). '' when empty. */
  drainInjections(): string {
    if (this.buffer.length === 0) return '';
    const envelopes = this.buffer.splice(0);
    return envelopes.map((e) => renderPeerMessageBlock(e)).join('\n') + '\n\n';
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
   */
  async forceAccept(messageIds: ReadonlySet<string> | 'all'): Promise<number> {
    const sessionId = this.opts.getSessionId();
    if (sessionId === undefined) return 0;
    const wasEmpty = this.buffer.length === 0;
    let injected = 0;
    for (const { file, envelope } of await listHeld(sessionId)) {
      if (messageIds !== 'all' && !messageIds.has(envelope.messageId)) continue;
      if (!(await releaseHeld(sessionId, file))) continue;
      const claimed = await claimPending(sessionId, file).catch(() => null);
      if (claimed === null) continue;
      this.accept(claimed);
      injected++;
    }
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
    try {
      do {
        this.rescan = false;
        await this.scanOnce(sessionId);
      } while (this.rescan);
    } catch {
      // Best-effort: the REPL must never crash on inbox I/O.
    } finally {
      this.scanning = false;
    }
  }

  private async scanOnce(sessionId: string): Promise<void> {
    if (this.disposed) return;
    const wasEmpty = this.buffer.length === 0;
    const { claimed, held } = await scanPeerInbox({
      sessionId,
      mode: this.getMode(),
      wakeBudget: this.wakeBudget,
      capacity: MAX_PENDING_INJECTIONS - this.buffer.length,
    });
    for (const h of held) this.noteHeld(h.envelope, h.reason);
    for (const e of claimed) this.accept(e);
    if (wasEmpty && claimed.length > 0) this.fireInjectable();
  }

  private accept(e: PeerEnvelope): void {
    const bytes = Buffer.byteLength(e.body, 'utf8');
    this.buffer.push(e);
    this.opts.writeLine(palette.dim(`↘ peer message from ${senderLabel(e)} · ${sizeLabel(bytes)}`));
    void emitPeerMessage(this.opts.traceWriter, { action: 'delivered', messageId: e.messageId, peer: e.from.id, bytes });
  }

  private noteHeld(e: PeerEnvelope, reason: HeldReason): void {
    const bytes = Buffer.byteLength(e.body, 'utf8');
    const why = reason === 'wake-budget' ? 'wake budget reached' : 'AFK_PEER_INBOUND=hold';
    this.opts.writeLine(palette.dim(`↘ peer message from ${senderLabel(e)} held (${why}) · /inbox to review`));
    void emitPeerMessage(this.opts.traceWriter, { action: 'held', messageId: e.messageId, peer: e.from.id, bytes, reason });
  }

  private fireInjectable(): void {
    try { this.onInjectable?.(); } catch { /* best-effort */ }
  }

  private async tick(): Promise<void> {
    if (this.disposed) return;
    const sessionId = this.opts.getSessionId();
    if (sessionId !== undefined && sessionId !== this.watchedId) await this.startWatching(sessionId);
    await this.scan();
  }

  private stopWatcher(): void {
    try { this.watchAc?.abort(); } catch { /* best-effort */ }
    this.watchAc = undefined;
    this.watchedId = undefined;
  }

  /** Mark presence as a reader and apply the `/name` or tmux label. Best-effort. */
  private async advertise(sessionId: string): Promise<void> {
    await setPresencePeerInbox(sessionId, true);
    if (this.desiredName !== undefined) return setPresenceName(sessionId, this.desiredName);
    const label = await resolveTmuxLabel();
    if (label !== undefined) await setPresenceNameIfUnset(sessionId, label);
  }

  private async startWatching(sessionId: string): Promise<void> {
    this.stopWatcher();
    this.watchedId = sessionId;
    const base = getPeerInboxDir(sessionId);
    try {
      for (const sub of ['pending', 'delivered', 'held']) {
        await mkdir(join(base, sub), { recursive: true, mode: 0o700 });
      }
    } catch {
      return; // the poll keeps retrying scans; nothing to watch yet
    }
    if (this.disposed || this.watchedId !== sessionId) return; // disposed or re-keyed mid-setup
    void this.advertise(sessionId);
    const ac = new AbortController();
    this.watchAc = ac;
    void (async () => {
      try {
        for await (const _event of watch(join(base, 'pending'), { signal: ac.signal })) void this.scan();
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
    ...(ctx.traceWriter !== undefined ? { traceWriter: ctx.traceWriter } : {}),
  });
}
