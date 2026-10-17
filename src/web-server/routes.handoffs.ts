/**
 * Daemon handoff listing route for the `afk web` surface.
 *
 * Contract: this handler is dispatched from `server.ts` after bearer-token
 * and Origin checks have already passed. Read-only: no POST/answer route
 * (deliberately deferred — see issue #1416; answering requires a CSRF +
 * responder-identity design that belongs in a separate PR).
 *
 * Response shape:
 *   { handoffs: [{ taskId, sessionId, createdAt, status, question: { message, type, choices } }] }
 *
 * Excluded fields: `originalCommand` (may carry secrets), `route`,
 * `telegramMessageId`, `answer`, `answerSource`, `answeredAt`,
 * `responderIdentity`, `elicitId`.
 */

import type { ServerResponse } from 'node:http';
import { listPendingHandoffs } from '../agent/daemon/handoff-store.js';
import { getHandoffsDir } from '../paths.js';
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

/** Injectable context for the handoff route — enables a tmp dir in tests. */
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

// ---------------------------------------------------------------------------
// Route handler
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
