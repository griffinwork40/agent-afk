/**
 * Handlers for peer-messaging tools: list_sessions and send_to_session.
 *
 * Both handlers are top-level only. They read the `sessionId` from the
 * handler context (set by the dispatcher from the session's own id) to:
 *   - Exclude self from list_sessions results.
 *   - Identify the sender for send_to_session.
 *   - Read the sender's own presence file to get the `name` field.
 *
 * callerSessionId comes from `context.sessionId` — the same field used by
 * `sendMessageToAgent` for ownership checks.
 *
 * @module agent/tools/handlers/peer
 */

import type { ToolResult } from '../types.js';
import type { ToolHandlerContext } from '../types.js';
import { readLivePresenceFiles, readPresenceFiles } from '../../awareness/presence.js';
import { sendToSession, describeTargetState } from '../../peer/send.js';
import { countPending } from '../../peer/inbox-store.js';
import { findDeliveredEnvelope } from '../../peer/inbox-store.js';
import { emitPeerMessage } from '../../trace/emit.js';

// ---------------------------------------------------------------------------
// list_sessions
// ---------------------------------------------------------------------------

export async function listSessionsHandler(
  _input: unknown,
  _signal: AbortSignal | undefined,
  context?: ToolHandlerContext,
): Promise<ToolResult> {
  const selfId = context?.sessionId;

  const records = await readLivePresenceFiles();
  const peers = records.filter((r) => r.sessionId !== selfId);

  const results = await Promise.all(
    peers.map(async (r) => {
      const pending = await countPending(r.sessionId).catch(() => 0);
      return {
        sessionId: r.sessionId,
        name: r.name,
        surface: r.surface,
        cwd: r.cwd,
        branch: r.workspace?.branch ?? null,
        turnState: describeTargetState(r),
        acceptsMessages: r.peerInbox === true,
        turnStateSince: r.turnStateSince,
        heartbeatAgeMs: r.heartbeatAgeMs,
        pendingMessages: pending,
        blocked: r.blockedSince !== undefined,
      };
    }),
  );

  return { content: JSON.stringify(results, null, 2) };
}

// ---------------------------------------------------------------------------
// send_to_session
// ---------------------------------------------------------------------------

export async function sendToSessionHandler(
  input: unknown,
  _signal: AbortSignal | undefined,
  context?: ToolHandlerContext,
): Promise<ToolResult> {
  if (!input || typeof input !== 'object') {
    return { content: 'Invalid input: expected object.', isError: true };
  }
  const obj = input as Record<string, unknown>;
  const to = typeof obj['to'] === 'string' ? obj['to'].trim() : '';
  const message = typeof obj['message'] === 'string' ? obj['message'] : '';
  const replyTo = typeof obj['reply_to'] === 'string' ? obj['reply_to'].trim() : undefined;

  if (!to) return { content: 'send_to_session requires a non-empty "to" field.', isError: true };
  if (!message) return { content: 'send_to_session requires a non-empty "message" field.', isError: true };

  const callerSessionId = context?.sessionId;
  if (callerSessionId === undefined) {
    return { content: 'send_to_session is unavailable: this session has no id yet.', isError: true };
  }
  const traceWriter = context?.traceWriter;

  // Read caller's own presence file to get name (best-effort).
  let callerName: string | undefined;
  try {
    const allRecords = await readPresenceFiles();
    const self = allRecords.find((r) => r.sessionId === callerSessionId);
    callerName = self?.name;
  } catch {
    // Best-effort — proceed without a name.
  }

  // Determine hop count: if reply_to is provided, look up the source envelope
  // hop in our delivered/ dir and add 1; otherwise default to 0.
  let hop = 0;
  if (replyTo !== undefined) {
    try {
      const originalEnv = await findDeliveredEnvelope(callerSessionId, replyTo);
      if (originalEnv !== null) {
        hop = originalEnv.hop + 1;
      }
    } catch {
      // Best-effort — use hop 0.
    }
  }

  const result = await sendToSession({
    from: { id: callerSessionId, ...(callerName !== undefined ? { name: callerName } : {}) },
    to,
    message,
    replyTo,
    hop,
  });

  const bodyBytes = Buffer.byteLength(message, 'utf8');

  if (result.status === 'refused') {
    await emitPeerMessage(traceWriter, {
      action: 'refused',
      messageId: result.messageId,
      peer: result.resolvedTo ?? to,
      bytes: bodyBytes,
      reason: result.reason,
    });
    return {
      content: JSON.stringify({
        status: 'refused',
        reason: result.reason,
        detail: result.detail,
        resolvedTo: result.resolvedTo,
      }),
      isError: true,
    };
  }

  await emitPeerMessage(traceWriter, {
    action: 'sent',
    messageId: result.messageId,
    peer: result.resolvedTo ?? to,
    bytes: bodyBytes,
  });

  return {
    content: JSON.stringify({
      status: 'queued',
      messageId: result.messageId,
      resolvedTo: result.resolvedTo,
      targetState: result.targetState,
    }),
  };
}
