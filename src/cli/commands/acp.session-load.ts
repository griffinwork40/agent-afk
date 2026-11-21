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
 * cwd: a session records its canonical cwd at session/new. Load or resume of
 * a session that is not live requires that same directory (compared on
 * canonical paths) and throws AcpInvalidParams otherwise, the same kind the
 * live-session reopen check uses. An entry written before cwd was stored is
 * accepted once and its cwd is backfilled, so later loads are checked.
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
import { journalExists } from '../../agent/journal/reader.js';
import type { AcpClientPeer, LoadSessionRequest } from './acp.wire.js';
import { AcpInvalidParams, convertMcpServers } from './acp.params.js';
import type { AcpSessionHandle, AcpSessionOptions } from './acp.session.js';
import { buildAcpSession, closeAcpSession } from './acp.session.js';
import { acpSessionMapSettled, readAcpCwd, recordAcpCwd, resolveAcpId } from './acp.session-map.js';
import { emitReplayUpdates } from './acp.replay.js';

/**
 * Restore only. A1 calls replayHistory before replying to load, never for resume.
 *
 * Error semantics (caller maps to wire codes):
 *   - Throws `AcpNotFoundError`  when id is unknown or journal is missing.
 *   - Throws `AcpInvalidParams`  when the stored canonical cwd differs.
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
  if (!journalExists(afkId)) {
    throw new AcpNotFoundError(`Unknown session: ${acpId}`);
  }
  await acpSessionMapSettled(); // a cwd recorded by session/new in this process is on disk
  const storedCwd = readAcpCwd(acpId);
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
    // Legacy entry (no stored cwd): accept, then backfill so later loads are checked.
    if (storedCwd === undefined) await recordAcpCwd(acpId, canonicalDir(cwd)).catch(() => undefined);
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
