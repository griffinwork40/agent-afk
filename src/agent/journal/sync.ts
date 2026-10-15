/**
 * JournalSync: turns a provider's in-memory message array into journal
 * `append` / `truncate` records by diffing against the last synced snapshot.
 *
 * Why a differ instead of hooking every mutation site: the Anthropic provider
 * alone mutates its array at ~10 sites (push, compaction splice, rewind,
 * orphan repair, abort synthesis, ...), and new sites keep appearing. Diffing
 * at a few commit points (before each model request, before tool dispatch,
 * at turn end) captures all of them, including ones that do not exist yet,
 * with no per-site wiring.
 *
 * Invariant: comparison is by object REFERENCE. Pushed messages keep their
 * identity; compaction/rewind/repair produce a divergent prefix, which is
 * emitted as `truncate(k)` + re-append of everything after the divergence.
 * An in-place mutation of an already-synced message object (e.g. the
 * wind-down note appended into the last user message's content array) is
 * NOT detected; that is an accepted, documented gap (docs/message-journal.md).
 * A caller that KNOWS it edited synced messages in place (microcompaction)
 * calls {@link JournalSync.invalidateFrom} so the next sync re-appends them.
 *
 * Invariant (spans, #2464): when the adapter implements `adopt`, a run of
 * natives built from the same journal messages maps back to those ORIGINAL
 * messages as a unit. `starts[i]` is the provider index where the span
 * holding native `i` begins (`i` itself when not adopted). A divergence or
 * invalidation that lands inside a span backs off to its start, so the span
 * is re-mapped whole and tool_use/tool_result pairing cannot be split.
 *
 * @module agent/journal/sync
 */

import type {
  JournalAdapter,
  JournalMessage,
  JournalTruncateReason,
  MessageJournal,
} from './types.js';

export interface SyncOptions {
  /** Advisory reason attached to a truncate, when the caller knows it. */
  reason?: JournalTruncateReason;
}

export class JournalSync<T> {
  /** Provider message refs at the last sync. */
  private committed: T[] = [];
  /** lenAfter[i] = journal length after provider messages [0..i]. */
  private lenAfter: number[] = [];
  /** starts[i] = provider index where the adopted span holding message i begins. */
  private starts: number[] = [];
  private seeded = false;

  constructor(
    private readonly journal: MessageJournal | undefined,
    private readonly adapter: JournalAdapter<T>,
  ) {}

  /** True when a journal is wired; lets callers skip work when it is not. */
  get enabled(): boolean {
    return this.journal !== undefined;
  }

  /**
   * Declare the provider's starting array: `[]` for a fresh runtime, the
   * seeded messages on resume. When the journal's folded length does not
   * match the mapped seed, the journal is resynced so the folded array equals
   * exactly what this runtime will send. Calling `sync` without `seed` seeds
   * with `[]` first.
   *
   * Invariant: the leading ADOPTED entries are the journal messages the seed
   * was built from (the resumed fold, or the router's handover snapshot of
   * this same journal), so a resync keeps them and rewrites only from the
   * first non-adopted entry, e.g. the synthetic tool results a crash-resume
   * repair adds. A seed that adopts nothing resyncs from 0, as before.
   */
  seed(messages: readonly T[]): void {
    const journal = this.journal;
    if (!journal) return;
    this.seeded = true;
    const mapped = this.mapAll(messages, 0, 0);
    if (journal.length !== mapped.entries.length) {
      const keep = Math.min(mapped.adoptedPrefix, journal.length);
      if (journal.length !== keep) journal.truncate(keep, 'resync');
      mapped.entries.slice(keep).forEach((m, i) => journal.append(keep + i, m));
    }
    this.committed = [...messages];
    this.lenAfter = mapped.lenAfter;
    this.starts = mapped.starts;
  }

  /** Diff `messages` against the last snapshot and emit the delta. */
  sync(messages: readonly T[], opts: SyncOptions = {}): void {
    const journal = this.journal;
    if (!journal) return;
    if (!this.seeded) this.seed([]);

    let k = 0;
    while (k < this.committed.length && k < messages.length && messages[k] === this.committed[k]) k++;
    if (k < this.starts.length) k = this.starts[k]!;
    const baseLen = k === 0 ? 0 : this.lenAfter[k - 1]!;
    // Truncate when the prefix diverged/shrank, or when someone else moved
    // the journal (e.g. a sibling runtime after /clear) out from under us.
    if (journal.length !== baseLen) journal.truncate(baseLen, opts.reason ?? 'resync');

    const tail = this.mapAll(messages.slice(k), baseLen, k);
    tail.entries.forEach((m, i) => journal.append(baseLen + i, m));
    this.committed = [...messages];
    this.lenAfter = [...this.lenAfter.slice(0, k), ...tail.lenAfter];
    this.starts = [...this.starts.slice(0, k), ...tail.starts];
  }

  /**
   * Forget the committed snapshot from provider index `index` on, so the next
   * {@link sync} emits `truncate` + re-append from there. For callers that
   * mutated already-synced message objects IN PLACE (microcompaction), which
   * the by-reference diff cannot see. Out-of-range indices are clamped; a
   * no-op before the first seed/sync. An index inside an adopted span backs
   * off to the span's start (see the module Invariant).
   */
  invalidateFrom(index: number): void {
    let at = Math.max(0, Math.min(Number.isFinite(index) ? Math.floor(index) : 0, this.committed.length));
    if (at < this.starts.length) at = this.starts[at]!;
    this.committed.length = at;
    this.lenAfter.length = at;
    this.starts.length = at;
  }

  /**
   * The last-synced conversation in journal form (the committed native
   * messages mapped through the adapter; adopted spans yield their original
   * journal messages, so the handover keeps what the native form cannot
   * carry). Callers wanting the CURRENT array `sync` first. Empty when no
   * journal is wired or nothing was synced.
   */
  snapshot(): JournalMessage[] {
    return this.mapAll(this.committed, 0, 0).entries;
  }

  /**
   * Map natives to journal messages. `offset` is the provider index of
   * `messages[0]` (for `starts`); `adoptedPrefix` counts the leading entries
   * that came from adopted spans with nothing fresh before them.
   */
  private mapAll(messages: readonly T[], startLen: number, offset: number): MappedTail {
    const out: MappedTail = { entries: [], lenAfter: [], starts: [], adoptedPrefix: 0 };
    let len = startLen;
    let leading = true;
    for (let i = 0; i < messages.length;) {
      const hit = this.adapter.adopt?.(messages, i);
      if (hit && hit.count > 0) {
        out.entries.push(...hit.entries);
        len += hit.entries.length;
        if (leading) out.adoptedPrefix += hit.entries.length;
        for (let c = 0; c < hit.count; c++) { out.lenAfter.push(len); out.starts.push(offset + i); }
        i += hit.count;
        continue;
      }
      const j = this.adapter.toJournal(messages[i]!);
      if (j) {
        out.entries.push(j);
        len++;
        leading = false;
      }
      out.lenAfter.push(len);
      out.starts.push(offset + i);
      i++;
    }
    return out;
  }
}

interface MappedTail {
  entries: JournalMessage[];
  lenAfter: number[];
  starts: number[];
  adoptedPrefix: number;
}
