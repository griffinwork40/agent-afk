/**
 * Preserve a session's event ledger before a web reset replaces it.
 *
 * Invariant: `events.jsonl` is the only durable record of tool-call arguments
 * (the witness trace keeps only byte counts), so a web `/clear` or `/rewind`
 * must never overwrite it in place. The current file is renamed to an archive
 * sibling first; the caller then renames its fresh projection into
 * `events.jsonl`, so tailers still see a new inode and detect the generation.
 */

import { existsSync, renameSync } from 'node:fs';
import { getSessionLedgerPath } from '../paths.js';
import { getSessionLedgerArchivePath } from '../paths.journal.js';

/** Returns the archive path, or undefined when there was no ledger yet. */
export function archiveSessionLedger(sessionId: string, now: Date = new Date()): string | undefined {
  const path = getSessionLedgerPath(sessionId);
  if (!existsSync(path)) return undefined;
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  let archive = getSessionLedgerArchivePath(sessionId, stamp);
  // Two resets inside one millisecond must not overwrite the first archive.
  for (let n = 1; existsSync(archive); n += 1) {
    archive = getSessionLedgerArchivePath(sessionId, `${stamp}-${n}`);
  }
  renameSync(path, archive);
  return archive;
}
