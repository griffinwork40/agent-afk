/**
 * POST /api/sessions/:id/resume: resume a stored (read-only) session as a
 * new owned live session, without needing a live "carrier" session.
 *
 * Contract: `:id` names the PAST session (id or name, as `/resume <id>`
 * accepts). Responses: 201 `{ session: { id } }` with the NEW live session id,
 * 404 `unknown_session` when no saved session matches, 409
 * `session_live_elsewhere` when another process holds it, 501 when this server
 * has no session owner, 500 `resume_failed` on a start failure. Sits behind
 * the same bearer + Origin checks as every other mutating route (enforced by
 * the server's request guard before routing).
 */

import type { ServerResponse } from 'node:http';
import { requireValidSessionId, sendJson, type RouteContext } from './routes.js';

export async function handleResumeSession(
  ctx: RouteContext,
  res: ServerResponse,
  pastSessionId: string,
): Promise<void> {
  if (!requireValidSessionId(res, pastSessionId)) return;
  if (!ctx.resumeSession) {
    sendJson(res, 501, {
      error: 'sessions_not_supported',
      message: 'this server is attach-only and cannot resume sessions.',
    });
    return;
  }
  try {
    const resumed = await ctx.resumeSession(pastSessionId);
    if (resumed.kind === 'not-found') {
      sendJson(res, 404, {
        error: 'unknown_session',
        message: `No saved session: ${pastSessionId}`,
      });
      return;
    }
    if (resumed.kind === 'live-elsewhere') {
      sendJson(res, 409, {
        error: 'session_live_elsewhere',
        message: 'This session is running in another process. Continue it there, or end it first.',
      });
      return;
    }
    sendJson(res, 201, { session: { id: resumed.id } });
  } catch (error) {
    // Log the full error server-side; never reflect internal details to the client.
    console.error('[resume] failed:', error);
    sendJson(res, 500, {
      error: 'resume_failed',
      message: 'Failed to resume session.',
    });
  }
}
