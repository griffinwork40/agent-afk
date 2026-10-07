/**
 * Message-journal writer entry point (docs/message-journal.md).
 *
 * `createMessageJournal` wires a {@link JournalFileWriter} for the top-level
 * journal and hands out one more per `forSubagent(id)`, all sharing the
 * session's lazy id accessor, meta, blob store, and once-only error reporter.
 * The per-file mechanics (buffering, resume length, spill, ordering) live in
 * journal-file.ts.
 *
 * Contract (types.ts `MessageJournal`): every method is fire-and-forget and
 * never throws; `flush()` resolves when every queued write of THIS journal is
 * on disk; `close()` flushes and stops accepting writes, idempotent. Closing
 * the parent does not close subagent journals (each child owns its own).
 *
 * @module agent/journal/writer
 */

import { createOnceReporter } from './append-queue.js';
import { BlobStore } from './blobs.js';
import { JournalFileWriter, type JournalSessionShared } from './journal-file.js';
import { isMessageJournalDisabled, NOOP_JOURNAL } from './noop.js';
import type { JournalMarkLabel, JournalMessage, JournalTruncateReason, MessageJournal } from './types.js';

export { isMessageJournalDisabled } from './noop.js';

export interface CreateMessageJournalOptions {
  /**
   * Lazy session-id accessor. The id may be unknown at construction (it can
   * be assigned after the first turn); records are buffered in memory until
   * it resolves, then flushed in order.
   */
  getSessionId: () => string | undefined;
  /** Metadata stamped on the journal's `meta` record. */
  meta?: { provider?: string; model?: string; cwd?: string };
}

class FileJournal implements MessageJournal {
  private readonly children = new Map<string, FileJournal>();

  constructor(
    private readonly shared: JournalSessionShared,
    private readonly file: JournalFileWriter,
  ) {}

  get length(): number {
    try {
      return this.file.length;
    } catch {
      return 0;
    }
  }

  get path(): string | undefined {
    try { return this.file.path; } catch { return undefined; }
  }

  append(index: number, message: JournalMessage): void {
    this.file.record({ kind: 'append', index, message });
  }

  truncate(length: number, reason?: JournalTruncateReason): void {
    this.file.record({ kind: 'truncate', length, ...(reason !== undefined ? { reason } : {}) });
  }

  mark(label: JournalMarkLabel, detail?: Record<string, unknown>): void {
    this.file.record({ kind: 'mark', label, ...(detail !== undefined ? { detail } : {}) });
  }

  /**
   * One journal per subagent id per session writer: a repeat call with the
   * same id returns the same (open) instance so two writers never interleave
   * one file from a single process.
   */
  forSubagent(subagentId: string): MessageJournal {
    const existing = this.children.get(subagentId);
    if (existing && !existing.file.isClosed) return existing;
    const child = new FileJournal(this.shared, new JournalFileWriter(this.shared, subagentId));
    this.children.set(subagentId, child);
    return child;
  }

  flush(): Promise<void> {
    return this.file.flush().catch(() => undefined);
  }

  close(): Promise<void> {
    return this.file.close().catch(() => undefined);
  }
}

/**
 * Build the session's journal. Returns a no-op journal (length 0, every
 * method a no-op) when `AFK_MESSAGE_JOURNAL_DISABLED=1`.
 *
 * Contract: `length` reflects the ON-DISK fold of an existing journal file the
 * first time it is read after the session id resolves (so a resumed session
 * appends at the right index), then tracks writes in memory.
 */
export function createMessageJournal(opts: CreateMessageJournalOptions): MessageJournal {
  if (isMessageJournalDisabled()) return NOOP_JOURNAL;
  const shared: JournalSessionShared = {
    getSessionId: opts.getSessionId,
    meta: { ...(opts.meta ?? {}) },
    blobs: new BlobStore(),
    report: createOnceReporter('message-journal'),
  };
  return new FileJournal(shared, new JournalFileWriter(shared));
}
