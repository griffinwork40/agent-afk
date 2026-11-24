/**
 * ACP session load and resume helpers.
 *
 * loadAcpSession: restore a persisted session by ACP wire id.
 *   - Resolves the ACP id to the AFK journal id via the session map.
 *   - Verifies the journal exists before constructing anything.
 *   - On failure, releases any partially created resources.
 *   - Replay is NOT performed here; A1 calls replayHistory explicitly after
 *     load, never for resume (see profile §10 last paragraph).
 *
 * cwd: session/new writes the canonical cwd to a per-session record
 * (acp.session-record.ts) before replying. Load or resume of a session that is
 * not live requires that same directory (compared on canonical paths) and
 * throws AcpInvalidParams otherwise, the same kind the live-session reopen
 * check uses. A record that exists but cannot be read fails the load
 * (internal). A session without a record predates the check: it is accepted,
 * and its record is written synchronously before the handle is returned; if
 * that write fails the session is closed and the load fails.
 *
 * MCP: the wire array is converted by acp.params convertMcpServers, the one
 * validating converter (duplicate names throw AcpInvalidParams).
 *
 * replayHistory: emit the display history to the peer.
 *   - Delegates to emitReplayUpdates in acp.replay.ts.
 *   - Throws on peer write failure (caller owns error mapping).
 *
 * @module cli/commands/acp.session-load
 */

import { realpathSync } from 'node:fs';
import path from 'node:path';
import { checkJournalExists } from '../../agent/journal/reader.js';
import type { AcpClientPeer, LoadSessionRequest } from './acp.wire.js';
import { AcpInvalidParams, convertMcpServers } from './acp.params.js';
import type { AcpSessionHandle, AcpSessionOptions } from './acp.session.js';
import { buildAcpSession, closeAcpSession } from './acp.session.js';
import { resolveAcpId } from './acp.session-map.js';
import { pruneAcpSessionRecord, readAcpSessionRecord, writeAcpSessionRecord } from './acp.session-record.js';
import { emitReplayUpdates } from './acp.replay.js';

/**
 * Restore only. A1 calls replayHistory before replying to load, never for resume.
 *
 * Error semantics (caller maps to wire codes):
 *   - Throws `AcpNotFoundError`  when id is unknown or journal is missing.
 *   - Throws `AcpInvalidParams`  when the stored canonical cwd differs.
 *   - Throws generic Error when the session record is unreadable or cannot be written.
 *   - Throws generic Error for internal failures (session construction, etc.).
 *   - On any throw after partial construction, resources are released.
 */
export async function loadAcpSession(
  params: LoadSessionRequest,
  opts: AcpSessionOptions,
): Promise<AcpSessionHandle> {
  const { sessionId: acpId, cwd, mcpServers } = params;

  // Resolve ACP id → AFK journal id (identity when no mapping exists).
  const afkId = resolveAcpId(acpId);

  // Fail fast: verify the journal exists before allocating anything.
  // Prune the stale record only on a true ENOENT; transient errors (EACCES,
  // EIO, …) must not permanently delete the record of a live session.
  const journalState = checkJournalExists(afkId);
  if (journalState !== 'exists') {
    if (journalState === 'enoent') pruneAcpSessionRecord(acpId);
    throw new AcpNotFoundError(`Unknown session: ${acpId}`);
  }
  // Throws (internal) on an unreadable or malformed record: never treated as "no record".
  const record = readAcpSessionRecord(acpId);
  const storedCwd = record?.cwd;
  if (storedCwd !== undefined && canonicalDir(storedCwd) !== canonicalDir(cwd)) {
    throw new AcpInvalidParams('session restored with a different cwd');
  }

  // Build the session with resume=afkId so the provider seeds resumeMessages
  // from the journal, and sessionId=acpId so the wire id stays stable.
  const converted = convertMcpServers(mcpServers);
  let handle: AcpSessionHandle | undefined;
  try {
    handle = await buildAcpSession({
      ...opts,
      cwd,
      resume: afkId,
      sessionId: acpId,
      mcpServers: converted,
    });
    // No record: the session predates the check. Write its record before
    // returning so later loads are checked; a failed write fails the load.
    if (storedCwd === undefined) writeAcpSessionRecord(acpId, { cwd: canonicalDir(cwd) });
    return handle;
  } catch (err) {
    if (handle !== undefined) {
      await closeAcpSession(handle).catch(() => { /* best-effort cleanup */ });
    }
    throw err;
  }
}

/**
 * Resolve the opaque ACP id to its journal, emit display history in order.
 *
 * A1 calls this explicitly for load (not resume), passing the restored cwd
 * so relative tool locations resolve as they would for a live call. Throws on peer write failure;
 * caller must release the live session and return internal error to the client.
 */
export async function replayHistory(sessionId: string, peer: AcpClientPeer, cwd?: string): Promise<void> {
  const afkId = resolveAcpId(sessionId);
  await emitReplayUpdates(sessionId, afkId, peer, cwd);
}

/** Canonical spelling of a directory; falls back to a resolved path if it no longer exists. */
function canonicalDir(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** Sentinel error type so callers can distinguish not-found from internal. */
export class AcpNotFoundError extends Error {
  override name = 'AcpNotFoundError';
}
