/**
 * Daemon handoff routes for the `afk web` surface.
 *
 * Contract: every handler here is dispatched from `server.ts` after bearer-token
 * and Origin checks have already passed. The Origin check (enforced in dispatch()
 * for every non-GET) is the CSRF gate — no cross-origin page can POST without a
 * matching Origin header. The bearer token cannot ride a cookie (the doc key in
 * the cookie is NOT the bearer token, per auth.ts), so the bearer-on-Authorization
 * + Origin pair is sufficient CSRF protection for this surface.
 *
 * GET /api/handoffs
 *   Response: { handoffs: [{ taskId, sessionId, createdAt, status, question }] }
 *
 * POST /api/handoffs/:taskId/answer
 *   Body:     { answer: unknown }
 *   Response: 200 { ok: true }  — this caller won the first-writer CAS
 *             409 { error: 'no_longer_active' }  — already answered/expired
 *             400 { error: 'bad_request' }        — missing or malformed body
 *             404 { error: 'not_found' }          — no record for taskId
 *
 * Excluded from GET response: `originalCommand` (may carry secrets), `route`,
 * `telegramMessageId`, `answer`, `answerSource`, `answeredAt`,
 * `responderIdentity`, `elicitId`.
 *
 * Responder identity on POST: `"web:<remoteIp>"` — the string form documented
 * on HandoffRecord.responderIdentity for the web surface.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { listPendingHandoffs, readHandoff } from '../agent/daemon/handoff-store.js';
import { answerHandoff, MAX_ANSWER_BYTES } from '../agent/daemon/handoff-wiring.js';
import { getHandoffsDir } from '../paths.js';
import { isRecord } from '../utils/type-guards.js';
import { sendJson } from './routes.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Slim projection of HandoffRecord safe to expose over the API. */
export interface HandoffSummary {
  taskId: string;
  sessionId: string;
  createdAt: string;
  status: 'pending';
  question: {
    message: string | undefined;
    type: string | undefined;
    choices: unknown[] | undefined;
  };
}

/** Injectable context for the handoff routes — enables a tmp dir in tests. */
export interface HandoffRouteContext {
  /** Override the handoffs directory (defaults to `getHandoffsDir()`). */
  handoffsDir?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Project a full HandoffRecord to the safe API shape.
 *
 * Only fields explicitly listed here are included — new fields added to
 * HandoffRecord remain absent from the response until deliberately added here.
 */
function toSummary(record: Awaited<ReturnType<typeof listPendingHandoffs>>[number]): HandoffSummary {
  // A parseable record can still carry `question: null` (or a non-object);
  // treat it as empty rather than letting one bad file 500 the list (#1416).
  const raw: unknown = record.question;
  const q: Record<string, unknown> = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {};
  return {
    taskId: record.taskId,
    sessionId: record.sessionId,
    createdAt: record.createdAt,
    status: 'pending',
    question: {
      message: typeof q['message'] === 'string' ? q['message'] : undefined,
      type: typeof q['type'] === 'string' ? q['type'] : undefined,
      choices: Array.isArray(q['choices']) ? (q['choices'] as unknown[]) : undefined,
    },
  };
}

/**
 * Derive the responder identity string for the web surface.
 * Format: `"web:<remoteIp>"` — matches the documented convention in
 * HandoffRecord.responderIdentity. Falls back to `"web:unknown"` when
 * Node does not expose the socket address (e.g. mocked in tests).
 */
function webIdentity(req: IncomingMessage): string {
  const ip = req.socket?.remoteAddress ?? 'unknown';
  return `web:${ip}`;
}

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

/**
 * `GET /api/handoffs` — list all pending daemon handoffs.
 *
 * Returns only records with status === 'pending'; answered, expired, and
 * cancelled records are silently excluded. Skips unreadable or malformed
 * files (delegated to `listPendingHandoffs`).
 *
 * @param res  - The HTTP response to write.
 * @param hctx - Optional route context; callers may inject a tmp handoffsDir
 *               for tests without touching the live state directory.
 */
export async function handleListHandoffs(
  res: ServerResponse,
  hctx: HandoffRouteContext = {},
): Promise<void> {
  const dir = hctx.handoffsDir ?? getHandoffsDir();
  const records = await listPendingHandoffs(dir);
  const handoffs = records.map(toSummary);
  sendJson(res, 200, { handoffs });
}

/**
 * `POST /api/handoffs/:taskId/answer` — answer a pending daemon handoff.
 *
 * Security: bearer token + Origin validation are enforced by `dispatch()` in
 * `server.ts` before this handler is reached. Origin validation is the CSRF
 * gate: the bearer token is never in a cookie (auth.ts), so any cross-origin
 * POST cannot supply a valid Authorization header, and a present Origin must
 * match an allowed loopback origin (originAllowed in auth.ts).
 *
 * First-writer-wins: `answerHandoff` uses an O_EXCL lock so simultaneous
 * answers from Telegram and the web surface race correctly — only one wins,
 * and the loser receives a 409.
 *
 * @param req    - The incoming HTTP request (used to read the remote IP).
 * @param res    - The HTTP response to write.
 * @param taskId - The daemon task ID extracted from the URL path.
 * @param body   - Parsed request body (expected: `{ answer: unknown }`).
 * @param hctx   - Optional route context; callers may inject a tmp handoffsDir.
 */
export async function handleAnswerHandoff(
  req: IncomingMessage,
  res: ServerResponse,
  taskId: string,
  body: unknown,
  hctx: HandoffRouteContext = {},
): Promise<void> {
  if (!isRecord(body) || !('answer' in body)) {
    sendJson(res, 400, {
      error: 'bad_request',
      message: 'body must be { answer: <value> }',
    });
    return;
  }

  const dir = hctx.handoffsDir ?? getHandoffsDir();

  // Verify the record exists and is still pending before attempting to answer.
  // Gives a clean 404 (not found) or 409 (already answered/expired) rather than
  // the generic error thrown by answerHandoff, and avoids a confusing 409 for
  // records that exist but are no longer actionable.
  const existing = await readHandoff(taskId, dir);
  if (existing === null) {
    sendJson(res, 404, {
      error: 'not_found',
      message: `no handoff record found for task ${taskId}`,
    });
    return;
  }
  if (existing.status !== 'pending') {
    sendJson(res, 409, {
      error: 'no_longer_active',
      message: `handoff for task ${taskId} is no longer active (already answered or expired)`,
    });
    return;
  }

  const answer = body['answer'];

  // Validate answer size before attempting the CAS write — answers over
  // MAX_ANSWER_BYTES would throw inside answerHandoff, surfacing as a 500.
  const serialized = JSON.stringify(answer);
  if (Buffer.byteLength(serialized, 'utf-8') > MAX_ANSWER_BYTES) {
    sendJson(res, 400, {
      error: 'bad_request',
      message: `answer exceeds maximum size of ${MAX_ANSWER_BYTES} bytes`,
    });
    return;
  }

  const identity = webIdentity(req);

  // Invariant: readHandoff above is a pre-check for a clean 404, but the
  // record can be answered, expired, or deleted between that read and the
  // CAS write below. answerHandoff returns false when the CAS lock is lost,
  // but throws when the record no longer exists. Catch that race and map it
  // to 409 rather than letting it propagate as a 500.
  let won: boolean;
  try {
    won = await answerHandoff(taskId, answer, 'web', dir, identity);
  } catch (err) {
    // Only swallow the well-known race: the record was deleted between the
    // pre-check read above and the CAS write inside answerHandoff. Any other
    // error (disk I/O, permission failure, etc.) is a genuine 500 and must
    // not be silently mapped to "no longer active".
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('handoff-store: no record found')) {
      sendJson(res, 409, {
        error: 'no_longer_active',
        message: `handoff for task ${taskId} is no longer active (already answered or expired)`,
      });
      return;
    }
    throw err;
  }

  if (!won) {
    sendJson(res, 409, {
      error: 'no_longer_active',
      message: `handoff for task ${taskId} is no longer active (already answered or expired)`,
    });
    return;
  }

  sendJson(res, 200, { ok: true });
}
