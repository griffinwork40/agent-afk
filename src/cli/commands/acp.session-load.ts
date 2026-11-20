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
 * replayHistory: emit the display history to the peer.
 *   - Delegates to emitReplayUpdates in acp.replay.ts.
 *   - Throws on peer write failure (caller owns error mapping).
 *
 * @module cli/commands/acp.session-load
 */

import { journalExists } from '../../agent/journal/reader.js';
import type { McpServerConfig } from '../../agent/mcp/types.js';
import type { AcpClientPeer, LoadSessionRequest, McpServerStdio } from './acp.wire.js';
import type { AcpSessionHandle, AcpSessionOptions } from './acp.session.js';
import { buildAcpSession, closeAcpSession } from './acp.session.js';
import { resolveAcpId } from './acp.session-map.js';
import { emitReplayUpdates } from './acp.replay.js';

/** Convert wire McpServerStdio[] to AFK's name-keyed McpServerConfig map. */
export function convertMcpServers(
  servers: readonly McpServerStdio[],
): Record<string, McpServerConfig> {
  const result: Record<string, McpServerConfig> = {};
  for (const s of servers) {
    const envRecord: Record<string, string> = {};
    for (const e of s.env) envRecord[e.name] = e.value;
    result[s.name] = {
      type: 'stdio',
      command: s.command,
      args: s.args,
      env: envRecord,
    };
  }
  return result;
}

/**
 * Restore only. A1 calls replayHistory before replying to load, never for resume.
 *
 * Error semantics (caller maps to wire codes):
 *   - Throws `AcpNotFoundError`  when id is unknown or journal is missing.
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

  // Build the session with resume=afkId so the provider seeds resumeMessages
  // from the journal, and sessionId=acpId so the wire id stays stable.
  let handle: AcpSessionHandle | undefined;
  try {
    handle = await buildAcpSession({
      ...opts,
      cwd,
      resume: afkId,
      sessionId: acpId,
      mcpServers: convertMcpServers(mcpServers),
    });
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
 * A1 calls this explicitly for load (not resume). Throws on peer write failure;
 * caller must release the live session and return internal error to the client.
 */
export async function replayHistory(sessionId: string, peer: AcpClientPeer): Promise<void> {
  const afkId = resolveAcpId(sessionId);
  await emitReplayUpdates(sessionId, afkId, peer);
}

/** Sentinel error type so callers can distinguish not-found from internal. */
export class AcpNotFoundError extends Error {
  override name = 'AcpNotFoundError';
}
