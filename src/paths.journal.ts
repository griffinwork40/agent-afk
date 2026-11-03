import { join } from 'path';

import { getSessionLedgerDir } from './paths.js';

/**
 * Message-journal paths (docs/message-journal.md). Everything lives inside the
 * per-session directory the ledger already owns:
 *
 *   sessions/<sessionId>/
 *     journal.jsonl                 top-level conversation journal
 *     subagents/<subagentId>.jsonl  one journal per forked child
 *     blobs/<sha256>.<ext>          spilled large text + binary payloads
 *
 * All helpers throw on an unsafe session id (via `getSessionLedgerDir`).
 */

const SUBAGENT_ID_SAFE = /^[a-zA-Z0-9._-]+$/;

export function getSessionJournalPath(sessionId: string): string {
  return join(getSessionLedgerDir(sessionId), 'journal.jsonl');
}

export function getSubagentJournalsDir(sessionId: string): string {
  return join(getSessionLedgerDir(sessionId), 'subagents');
}

/** @throws if `subagentId` contains path-unsafe characters. */
export function getSubagentJournalPath(sessionId: string, subagentId: string): string {
  if (!SUBAGENT_ID_SAFE.test(subagentId) || subagentId === '.' || subagentId === '..') {
    throw new Error(`Invalid subagent id for journal path: ${JSON.stringify(subagentId)}`);
  }
  return join(getSubagentJournalsDir(sessionId), `${subagentId}.jsonl`);
}

/** Content-addressed blob store for spilled payloads. */
export function getSessionBlobsDir(sessionId: string): string {
  return join(getSessionLedgerDir(sessionId), 'blobs');
}

/**
 * Archive slot for a session ledger that a web `/clear` or `/rewind` replaced:
 * `sessions/<sessionId>/events.reset-<stamp>.jsonl`. Readers open
 * `events.jsonl` by exact name, so archives are never mistaken for the live
 * ledger; they exist so a reset never destroys the durable tool-call record.
 */
/** Canonical identity sidecar for O(1) metadata lookups (#4429). */
export function getSessionMetaPath(sessionId: string): string {
  return join(getSessionLedgerDir(sessionId), 'session-meta.json');
}

export function getSessionLedgerArchivePath(sessionId: string, stamp: string): string {
  if (!SUBAGENT_ID_SAFE.test(stamp)) {
    throw new Error(`Invalid ledger archive stamp: ${JSON.stringify(stamp)}`);
  }
  return join(getSessionLedgerDir(sessionId), `events.reset-${stamp}.jsonl`);
}
