/**
 * Session-level typed bounded admission queue for peer boundary delivery.
 *
 * Aggregates two kinds of inputs at the REPL's inter-round boundary:
 *  - `human`  — text the user queued (typed + Enter) while a turn was in flight.
 *               Always wins: human entries sort before peer entries regardless of
 *               arrival order.
 *  - `peer`   — text arriving from another session's peer inbox.
 *
 * Both kinds are FIFO per source (monotone seq within each kind). Human entries
 * act as a barrier: when any human entry is present, no peer entry is admitted
 * until the human queue is empty. This prevents peer messages from bypassing
 * a user who typed an input mid-turn.
 *
 * Admission limits (constructor options):
 *  - `maxCount`  — total entry cap (default 50)
 *  - `maxBytes`  — total body byte cap (default 256 KiB)
 *  - `maxPerSender` — per peer-sender cap (default 10; human is a single sender)
 *
 * Thread / async safety: all methods are synchronous. Callers must not share
 * an instance across concurrent async paths without external serialization.
 *
 * @module agent/peer/admission-queue
 */

/** Discriminated-union entry for the queue. */
export type AdmissionEntry =
  | { readonly kind: 'human'; readonly seq: number; readonly text: string; readonly bytes: number }
  | { readonly kind: 'peer'; readonly seq: number; readonly text: string; readonly bytes: number; readonly senderId: string };

/** Bounds for a snapshot taken at a specific receiver sequence number. */
export interface AdmissionSnapshot {
  /** Entries selected by the snapshot, in delivery order. */
  readonly entries: readonly AdmissionEntry[];
  /** The seq cutoff used to take this snapshot (exclusive upper bound). */
  readonly cutoff: number;
}

export interface AdmissionQueueOptions {
  /** Maximum total entries in the queue (default 50). */
  maxCount?: number;
  /** Maximum total byte footprint (default 256 * 1024). */
  maxBytes?: number;
  /** Maximum entries per peer sender id (default 10; does not apply to 'human'). */
  maxPerSender?: number;
}

const DEFAULT_MAX_COUNT = 50;
const DEFAULT_MAX_BYTES = 256 * 1024;
const DEFAULT_MAX_PER_SENDER = 10;

export class AdmissionQueue {
  private readonly entries: AdmissionEntry[] = [];
  private readonly maxCount: number;
  private readonly maxBytes: number;
  private readonly maxPerSender: number;
  private totalBytes = 0;
  private seq = 0;

  constructor(opts: AdmissionQueueOptions = {}) {
    this.maxCount = opts.maxCount ?? DEFAULT_MAX_COUNT;
    this.maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
    this.maxPerSender = opts.maxPerSender ?? DEFAULT_MAX_PER_SENDER;
  }

  /** Total number of entries currently in the queue. */
  get size(): number { return this.entries.length; }

  /** True when there are any entries. */
  get pending(): boolean { return this.entries.length > 0; }

  /**
   * True when the queue has reached its `maxCount` ceiling and will reject the
   * next `submitPeer` regardless of byte size. Callers that hold the peer text
   * in their own buffer (e.g. `PeerInboxNotifier`) can check `full` before
   * calling `drainInjections()` so they only drain what will actually be admitted
   * — leaving the remainder in their buffer for the next boundary turn or
   * next-turn fallback instead of silently discarding it.
   */
  get full(): boolean { return this.entries.length >= this.maxCount; }

  /**
   * Submit a human queued-user-message.
   * Returns true if admitted, false if the queue is full.
   */
  submitHuman(text: string): boolean {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (!this.canAdmit(bytes)) return false;
    this.totalBytes += bytes;
    this.entries.push({ kind: 'human', seq: this.seq++, text, bytes });
    return true;
  }

  /**
   * Submit a peer message from `senderId`.
   * Returns true if admitted, false if the queue is full or per-sender cap hit.
   */
  submitPeer(senderId: string, text: string): boolean {
    const bytes = Buffer.byteLength(text, 'utf8');
    if (!this.canAdmit(bytes)) return false;
    const senderCount = this.entries.filter(
      (e) => e.kind === 'peer' && e.senderId === senderId,
    ).length;
    if (senderCount >= this.maxPerSender) return false;
    this.totalBytes += bytes;
    this.entries.push({ kind: 'peer', seq: this.seq++, text, bytes, senderId });
    return true;
  }

  /**
   * Take an atomic snapshot of entries admissible at this moment, respecting
   * the human-first barrier: if any human entry is present, only human entries
   * are included. Entries in the snapshot are stable (not yet removed) until
   * `drain()` is called with the same snapshot.
   *
   * The `cutoff` is the next seq that would be issued — used by callers to
   * verify that late arrivals after the snapshot are not included.
   *
   * Implementation note: the sort is applied unconditionally (even when all
   * entries are of the same kind and already in seq order) because seq values
   * are strictly monotone and the queue is append-only — in practice the sort
   * is a no-op on sorted input (O(n) for TimSort), so the cost is bounded.
   * An optimised path would skip the sort when `hasHuman=false` (all-peer,
   * already FIFO), but correctness takes priority over micro-optimisation here.
   */
  snapshot(): AdmissionSnapshot {
    const hasHuman = this.entries.some((e) => e.kind === 'human');
    const selected = hasHuman
      ? this.entries.filter((e) => e.kind === 'human')
      : [...this.entries];
    // Stable sort: human < peer, FIFO within kind (seq is monotone).
    selected.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'human' ? -1 : 1;
      return a.seq - b.seq;
    });
    return { entries: selected, cutoff: this.seq };
  }

  /**
   * Remove the entries that were in `snapshot` from the queue and return
   * their joined text (empty string if no entries).
   *
   * Only removes entries whose seq is still present — idempotent on double drain.
   *
   * Implementation note: the loop iterates in reverse and splices individual
   * entries by index (`O(n²)` in the worst case). For the configured maximum
   * of `maxCount = 50` entries this is bounded and harmless; the splice avoids
   * a full array copy by mutating in place, which keeps constant-factor cost
   * lower than a filter+reassign approach for this queue size.
   */
  drain(snap: AdmissionSnapshot): string {
    if (snap.entries.length === 0) return '';
    const seqs = new Set(snap.entries.map((e) => e.seq));
    let i = this.entries.length;
    while (i-- > 0) {
      const e = this.entries[i]!;
      if (seqs.has(e.seq)) {
        this.totalBytes -= e.bytes;
        this.entries.splice(i, 1);
      }
    }
    return snap.entries.map((e) => e.text).join('\n\n');
  }

  /**
   * Clear all entries. Used when the session is rekeyed (resume/swap): the old
   * queue contents belong to the outgoing session's conversation.
   */
  clear(): void {
    this.entries.splice(0);
    this.totalBytes = 0;
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private canAdmit(bytes: number): boolean {
    return this.entries.length < this.maxCount && this.totalBytes + bytes <= this.maxBytes;
  }
}
