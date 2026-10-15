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
