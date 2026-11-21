import { join } from 'path';

import { getSessionLedgerDir, getAfkStateDir, isSafeLedgerSessionId } from './paths.js';

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

/**
 * Path for the ACP-id → AFK-journal-id mapping file.
 *
 * Lives at `$AFK_STATE_DIR/acp/session-map.json`, a single JSON object
 * `{ [acpId: string]: string | { afkId?: string; cwd?: string } }` written
 * atomically via atomicWriteFileAsync. It is written only when a provider
 * reports a journal id other than the ACP id. A string entry is the afkId; the
 * object shape was written by an earlier build, whose `cwd` is read only as a
 * fallback for sessions without a per-session record
 * ({@link getAcpSessionRecordPath}). Host-local only; not a credential or
 * portable export.
 */
export function getAcpSessionMapPath(): string {
  return join(getAfkStateDir(), 'acp', 'session-map.json');
}

/**
 * Per-session ACP record: `$AFK_STATE_DIR/acp/sessions/<acpId>.json`, holding
 * `{ "cwd": "<canonical session directory>" }`. One file per ACP session id, so
 * two `afk acp` processes never write the same file.
 *
 * @throws if `acpId` fails {@link isSafeLedgerSessionId} (the ledger id guard).
 */
export function getAcpSessionRecordPath(acpId: string): string {
  if (!isSafeLedgerSessionId(acpId)) {
    throw new Error(`Invalid ACP session id for record path: ${JSON.stringify(acpId)}`);
  }
  return join(getAfkStateDir(), 'acp', 'sessions', `${acpId}.json`);
}
