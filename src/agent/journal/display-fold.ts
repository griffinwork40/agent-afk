/**
 * Display fold: reconstruct the HUMAN-VISIBLE conversation history from a
 * session's raw journal records, for on-screen replay on `--resume` / `/fork`
 * (docs/message-journal.md, "Display fold").
 *
 * Invariant: the model fold (`foldJournal`) and the display fold answer
 * different questions and must never be conflated. The model fold is "what
 * does the model see now" — compaction REPLACES history with a summary. The
 * display fold is "what did the human see" — compaction must NOT erase what
 * scrolled past. Both read the same records; only the truncate semantics
 * differ:
 *
 *   - SOFT truncates (reason `compact` | `resync` | `repair` |
 *     `provider_switch`, and the implicit overwrite of an append at
 *     `index < length`) drop messages from the live model array but KEEP their
 *     display rows. The messages JournalSync re-appends right after (the
 *     compaction kept-tail, microcompacted messages with placeholders, a
 *     provider-switch conversion) are matched back to those rows by
 *     fingerprint instead of being shown twice, and the ORIGINAL row wins, so
 *     a microcompaction placeholder never replaces real tool output.
 *   - HARD truncates (reason `rewind`) drop the display rows too: the user
 *     rewound, so those turns are gone from the conversation. `clear` drops
 *     everything, because `/clear` starts the conversation over.
 *   - The compaction preamble (summary user message + canned assistant ack)
 *     is model-only and never displayed.
 *
 * Matching window: re-appends follow their truncate immediately. When an
 * append matches nothing in the pending set it creates a new row, but the
 * pending set remains alive so a later re-append (e.g. a tool-result that
 * arrives after an unmatched orphan repair message) can still match back.
 * Candidates are consumed newest-first (`pop()`) so a compaction kept-tail
 * always reuses the most-recent occurrence when the same fingerprint appears
 * more than once in the pending window. A later, genuinely new message with
 * an identical fingerprint always gets its own row once the pending entries
 * for that fingerprint are exhausted.
 *
 * Fork chains: `forkJournal` writes only the parent's CURRENT fold, which after
 * a compaction no longer contains the early history. The display fold follows
 * `meta.forkedFrom` into the parent, replays the parent's records up to the
 * fork instant (the fork meta's `ts`, disambiguated within the same
 * millisecond by `forkedFrom.length`; see `cutAtFork`. Record timestamps are
 * stamped at enqueue and `/fork` flushes the parent queue before forking),
 * then soft-truncates to 0 and
 * replays the fork's own records, whose re-appended fold matches back onto the
 * parent's rows.
 *
 * @module agent/journal/display-fold
 */

import { COMPACT_ACK_TEXT, COMPACT_SUMMARY_HEADER } from '../providers/shared/compaction.js';
import { readJournalRecords } from './reader.js';
import { nextLength } from './records.js';
import type { JournalBlock, JournalMessage, JournalRecord, JournalTruncateReason } from './types.js';

/** Upper bound on `forkedFrom` hops; also a cycle guard for hand-edited journals. */
const MAX_FORK_DEPTH = 16;

const HARD_TRUNCATE_REASONS: ReadonlySet<JournalTruncateReason> = new Set<JournalTruncateReason>(['rewind']);

function blockKey(b: JournalBlock): string | null {
  switch (b.type) {
    case 'text':
      return `t:${b.text}`;
    case 'text_ref':
      return `t:${b.ref.path}`;
    case 'tool_use':
      return `u:${b.id}`;
    case 'tool_result':
      // Keyed by id only: a microcompacted re-append (placeholder content)
      // must match the original result it replaced.
      return `r:${b.toolUseId}`;
    case 'thinking':
    case 'redacted_thinking':
      // Dropped by provider switches; must not break the match.
      return null;
    default:
      return b.type;
  }
}

/** Identity of a message for re-append matching. Exported for tests. */
export function messageFingerprint(m: JournalMessage): string {
  const keys = Array.isArray(m.content) ? m.content.map(blockKey).filter((k): k is string => k !== null) : [];
  return `${m.role}|${keys.join('\u0000')}`;
}

function firstText(m: JournalMessage): string {
  const b = Array.isArray(m.content) ? m.content.find((c) => c.type === 'text') : undefined;
  return b && b.type === 'text' ? b.text : '';
}

/** True for the model-only compaction preamble (summary + canned ack). */
export function isCompactionPreamble(m: JournalMessage): boolean {
  if (m.role === 'user') return firstText(m).startsWith(COMPACT_SUMMARY_HEADER);
  return m.role === 'assistant' && firstText(m).trim() === COMPACT_ACK_TEXT;
}

/**
 * Stateful fold. `rows` holds displayed messages (null = removed by a hard
 * truncate); `live[i]` maps model-array index i to its row (-1 = not
 * displayed, e.g. the compaction preamble). `pendingWindowCap` tracks the
 * highest model index that was displaced into the pending map; appends
 * arriving beyond that boundary are definitively past the re-append window.
 */
class DisplayFoldState {
  private rows: Array<JournalMessage | null> = [];
  private live: number[] = [];
  private pending = new Map<string, number[]>();
  // Invariant: pendingWindowCap is the highest model-array index (== live index)
  // of any message currently in the pending map. -1 when pending is empty.
  // Used to distinguish an orphan insertion (index <= cap, no match) from a
  // genuinely new message (index > cap, no match); only the latter clears the map.
  private pendingWindowCap = -1;

  softTruncate(length: number): void {
    if (this.live.length > length) {
      // A new displacement window begins: stale pending entries from a prior
      // soft-truncate (e.g. a compaction preamble phase) must not bleed into
      // this window's match set.  Reset first, then populate from the newly
      // displaced rows only.
      this.pending.clear();
      this.pendingWindowCap = this.live.length - 1;
      for (const row of this.live.slice(length)) {
        const msg = row >= 0 ? this.rows[row] : null;
        if (!msg) continue;
        const fp = messageFingerprint(msg);
        const list = this.pending.get(fp) ?? [];
        list.push(row);
        this.pending.set(fp, list);
      }
    }
    this.live.length = Math.min(this.live.length, length);
  }

  private hardTruncate(length: number): void {
    for (const row of this.live.slice(length)) if (row >= 0) this.rows[row] = null;
    this.live.length = Math.min(this.live.length, length);
    this.pending.clear();
    this.pendingWindowCap = -1;
  }

  private clear(): void {
    this.rows = [];
    this.live = [];
    this.pending.clear();
    this.pendingWindowCap = -1;
  }

  private append(index: number, message: JournalMessage): void {
    if (index < this.live.length) this.softTruncate(index);
    if (isCompactionPreamble(message)) {
      this.live.push(-1);
      return;
    }
    const fp = messageFingerprint(message);
    const matches = this.pending.get(fp);
    // Pop (newest) rather than shift (oldest): softTruncate pushes rows in
    // live-array order (oldest first), so the last entry is the most-recent
    // occurrence — correct for a compaction kept-tail match.
    const matched = matches?.pop();
    if (matched !== undefined) {
      if (matches && matches.length === 0) this.pending.delete(fp);
      if (this.pending.size === 0) this.pendingWindowCap = -1;
      this.live.push(matched);
      return;
    }
    // Miss: if the current model index is still within the re-append window
    // (i.e., an orphan message was inserted before the tail is fully re-synced),
    // keep the pending map alive so subsequent re-appends can still match back.
    // Only clear when we are definitively past the window boundary.
    if (index > this.pendingWindowCap) {
      this.pending.clear();
      this.pendingWindowCap = -1;
    }
    this.rows.push(message);
    this.live.push(this.rows.length - 1);
  }

  apply(rec: JournalRecord): void {
    if (rec.kind === 'append') {
      this.append(rec.index, rec.message);
    } else if (rec.kind === 'truncate') {
      if (rec.reason === 'clear') this.clear();
      else if (rec.reason !== undefined && HARD_TRUNCATE_REASONS.has(rec.reason)) this.hardTruncate(rec.length);
      else this.softTruncate(rec.length);
    }
  }

  messages(): JournalMessage[] {
    return this.rows.filter((m): m is JournalMessage => m !== null);
  }
}

/**
 * Pure display fold over ordered record segments (oldest ancestor first).
 * Each segment after the first starts with an implicit soft truncate to 0: a
 * fork journal re-appends the parent's fold from index 0.
 */
export function foldForDisplay(segments: readonly (readonly JournalRecord[])[]): JournalMessage[] {
  const state = new DisplayFoldState();
  segments.forEach((records, i) => {
    if (i > 0) state.softTruncate(0);
    for (const rec of records) state.apply(rec);
  });
  return state.messages();
}

type ReadRecords = (sessionId: string) => JournalRecord[];

function forkMeta(records: readonly JournalRecord[]): Extract<JournalRecord, { kind: 'meta' }> | undefined {
  const first = records.find((r) => r.kind === 'meta');
  return first?.kind === 'meta' && first.forkedFrom ? first : undefined;
}

/** Where a child forked from its parent: the fork meta's instant and fold length. */
interface ForkCut {
  ts: number;
  length: number;
}

/**
 * The parent records that existed at the fork. Records strictly before the
 * fork instant are in. Records in the SAME millisecond are ambiguous (a fast
 * parent can append right after forking), so those count only while the
 * parent's model length still equals the length the fork copied; a same-ms
 * append past that length is post-fork. Exported for tests.
 */
export function cutAtFork(records: readonly JournalRecord[], cut: ForkCut): JournalRecord[] {
  let len = 0;
  let end = 0;
  records.forEach((r, i) => {
    if (r.ts > cut.ts) return;
    len = nextLength(len, r);
    if (r.ts < cut.ts || len === cut.length) end = i + 1;
  });
  return records.slice(0, end);
}

/**
 * Resolve the record segments for `sessionId`, oldest ancestor first. A
 * missing or unreadable ancestor just ends the chain (the fork's own fold is
 * still a complete, if shorter, history).
 */
export function displaySegments(sessionId: string, read: ReadRecords = (id) => readJournalRecords(id)): JournalRecord[][] {
  const segments: JournalRecord[][] = [];
  const seen = new Set<string>();
  let id: string | undefined = sessionId;
  let cut: ForkCut | undefined;
  while (id !== undefined && !seen.has(id) && segments.length < MAX_FORK_DEPTH) {
    seen.add(id);
    const all = read(id);
    const records = cut ? cutAtFork(all, cut) : all;
    if (records.length === 0) break;
    segments.unshift(records);
    const meta = forkMeta(records);
    id = meta?.forkedFrom?.sessionId;
    cut = meta?.forkedFrom ? { ts: meta.ts, length: meta.forkedFrom.length } : undefined;
  }
  return segments;
}

/**
 * Human-visible messages for a session (NOT hydrated: callers hydrate only
 * the window they render). Empty when the session has no journal.
 */
export function loadDisplayMessages(sessionId: string): JournalMessage[] {
  return foldForDisplay(displaySegments(sessionId));
}
