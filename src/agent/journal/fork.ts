/**
 * `/fork` support: seed a new session's journal from a source journal's
 * current fold (docs/message-journal.md).
 *
 * Invariant: the new file is written whole to a temp file and hard-linked into
 * place, so a reader (or the new session's writer resolving its resume
 * length) never sees a half-written fork. An existing destination journal is
 * never overwritten: that would silently destroy a live session's record. The
 * no-clobber check IS the `link` (EEXIST -> false), not a prior `existsSync`,
 * so a destination created concurrently can never be replaced.
 *
 * @module agent/journal/fork
 */

import * as fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';

import { getSessionJournalPath, isSafeLedgerSessionId } from '../../paths.js';
import { loadJournalFold } from './reader.js';
import { JOURNAL_VERSION, type JournalRecord } from './types.js';
import { isMessageJournalDisabled } from './noop.js';

/**
 * Create `sessions/<newSessionId>/journal.jsonl` holding the source journal's
 * current folded conversation: a `meta` record with
 * `forkedFrom: { sessionId, length }`, a `mark('fork')`, then one `append` per
 * message. Blob refs are copied as-is (they are sessions-root-relative, so they
 * keep pointing at the source's blobs; no bytes are duplicated).
 *
 * @returns true when a journal was written; false when the source has no
 *   journal (caller falls back to the sidecar-only fork) or on any I/O error.
 *   Also false when journaling is disabled, either id is unsafe, the ids are
 *   equal, or the destination already has a journal.
 */
export function forkJournal(sourceSessionId: string, newSessionId: string): boolean {
  if (isMessageJournalDisabled()) return false;
  if (!isSafeLedgerSessionId(sourceSessionId) || !isSafeLedgerSessionId(newSessionId)) return false;
  if (sourceSessionId === newSessionId) return false;
  const fold = loadJournalFold(sourceSessionId);
  if (!fold) return false;
  let tmp: string | undefined;
  try {
    const dst = getSessionJournalPath(newSessionId);
    if (fs.existsSync(dst)) return false; // cheap early-out; the link below is authoritative
    const ts = Date.now();
    const src = fold.meta;
    const records: JournalRecord[] = [
      {
        v: JOURNAL_VERSION,
        ts,
        kind: 'meta',
        sessionId: newSessionId,
        writerId: randomUUID(),
        ...(src?.provider !== undefined ? { provider: src.provider } : {}),
        ...(src?.model !== undefined ? { model: src.model } : {}),
        ...(src?.cwd !== undefined ? { cwd: src.cwd } : {}),
        forkedFrom: { sessionId: sourceSessionId, length: fold.messages.length },
      },
      { v: JOURNAL_VERSION, ts, kind: 'mark', label: 'fork', detail: { from: sourceSessionId } },
      ...fold.messages.map((message, index): JournalRecord => ({ v: JOURNAL_VERSION, ts, kind: 'append', index, message })),
    ];
    fs.mkdirSync(dirname(dst), { recursive: true, mode: 0o700 });
    tmp = `${dst}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
    fs.writeFileSync(tmp, records.map((r) => JSON.stringify(r) + '\n').join(''), { mode: 0o600, flag: 'wx' });
    fs.linkSync(tmp, dst); // throws EEXIST instead of clobbering a racing writer
    return true;
  } catch {
    return false;
  } finally {
    if (tmp !== undefined) {
      try {
        fs.unlinkSync(tmp); // success: drops the temp name; failure: cleanup
      } catch {
        // best-effort cleanup
      }
    }
  }
}
