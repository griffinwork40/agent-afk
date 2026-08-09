/**
 * Request routing for the `afk web` surface.
 *
 * Contract: every handler here receives an already-authenticated request —
 * `server.ts` enforces the bearer token and Origin check before dispatching.
 * Handlers must still enforce the OWNERSHIP boundary themselves, because that
 * is a per-session property rather than a per-request one.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { isSafeLedgerSessionId } from '../paths.js';
import { jsonDateReplacer } from '../cli/json-date-replacer.js';
import { listWebSessions } from './session-source.js';
import { SECURITY_HEADERS } from './static-assets.js';
import type { WebElicitationBridge } from './elicitation-web.js';
import type { CreateSessionRequest, OwnedSessionInfo } from './session-owner.js';

export { SECURITY_HEADERS };

export interface RouteContext {
  /** Session ids created inside THIS process — the only ones we can drive. */
  owned: Set<string>;
  bridge: WebElicitationBridge;
  /** Submit a prompt to an owned session. */
  submitPrompt: (sessionId: string, text: string) => Promise<void>;
  /**
   * Whether an owned session already has a turn in flight — the backpressure
   * predicate `handlePrompt` gates on. Always present: `server.ts` defaults it
   * to "never busy" when neither an explicit option nor an owner supplies one,
   * so attach-only mode (no owner at all) is unaffected.
   */
  isBusy: (sessionId: string) => boolean;
  /**
   * Start a new session in this process. Absent when the server was started
   * without an owner, in which case the surface is attach-only.
   */
  createSession?: (request: CreateSessionRequest) => Promise<OwnedSessionInfo>;
  /** Soft-interrupt an in-flight turn on an owned session. */
  interrupt?: (sessionId: string) => Promise<void>;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, jsonDateReplacer);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // This API is token-authenticated and loopback-bound; never let a browser
    // or intermediary cache a transcript to disk.
    'cache-control': 'no-store',
  });
  res.end(payload);
}

/**
 * Invariant: an id that fails `isSafeLedgerSessionId` must be REJECTED, not
 * passed through. Every ledger reader treats an unsafe id as "no such session"
 * and silently yields nothing, so a traversal-shaped or malformed id opened a
 * 200 event-stream that never emitted a frame — indistinguishable, from the
 * browser's side, from a live session that happens to be quiet.
 */
export function requireValidSessionId(res: ServerResponse, id: string): boolean {
  if (isSafeLedgerSessionId(id)) return true;
  sendJson(res, 400, {
    error: 'bad_session_id',
    message: 'session id must be 1-128 chars of [A-Za-z0-9_-]',
  });
  return false;
}

/**
 * Invariant: a session this process does not own cannot be driven from here.
 * Its elicitation handler lives in another OS process (the elicitation router
 * is a single-slot, process-wide singleton), so a prompt or approval addressed
 * to it would silently never resolve. Reject loudly with 409 instead.
 */
function requireOwned(ctx: RouteContext, res: ServerResponse, id: string): boolean {
  if (ctx.owned.has(id)) return true;
  sendJson(res, 409, {
    error: 'session_not_owned',
    message:
      `session ${id} is attached read-only (it runs in another process). ` +
      `Prompts and approvals can only be sent to sessions started by this server.`,
  });
  return false;
}

export async function handleListSessions(ctx: RouteContext, res: ServerResponse): Promise<void> {
  const sessions = await listWebSessions(ctx.owned);
  sendJson(res, 200, { sessions });
}

/**
 * Invariant: backpressure is checked AFTER ownership, never before. An
 * unowned session always 409s as `session_not_owned` regardless of busy
 * state — that error names the actual reason (no driver reaches it at all),
 * where a busy check first would misreport a foreign session as "busy".
 */
export async function handlePrompt(
  ctx: RouteContext,
  res: ServerResponse,
  sessionId: string,
  body: unknown,
): Promise<void> {
  if (!requireValidSessionId(res, sessionId)) return;
  if (!requireOwned(ctx, res, sessionId)) return;
  if (ctx.isBusy(sessionId)) {
    sendJson(res, 409, {
      error: 'session_busy',
      message: `session ${sessionId} already has a turn in flight. Wait for it to finish, or interrupt it, before sending another prompt.`,
    });
    return;
  }
  const text = readStringField(body, 'text');
  if (text === undefined) {
    sendJson(res, 400, { error: 'bad_request', message: 'body must be { text: string }' });
    return;
  }
  await ctx.submitPrompt(sessionId, text);
  sendJson(res, 202, { ok: true });
}

export function handleApprove(
  ctx: RouteContext,
  res: ServerResponse,
  sessionId: string,
  body: unknown,
): void {
  if (!requireValidSessionId(res, sessionId)) return;
  if (!requireOwned(ctx, res, sessionId)) return;
  approveByRequestId(ctx, res, body);
}

/**
 * `POST /api/approve` — answer a pending elicitation by request id alone.
 *
 * Contract: deliberately session-agnostic, and that is not a weakening. The
 * elicitation record does not always carry a sessionId (the router supplies it
 * as an optional extra), and the per-session route resolved by requestId
 * regardless — the id constrained nothing. Meanwhile requiring it broke the
 * real case: a user viewing a read-only session could never answer a prompt,
 * because the frontend fell back to the ACTIVE session id and got a permanent
 * 409. Identity is still established — bearer token and Origin are checked in
 * `dispatch` before this runs, and the bridge only holds elicitations raised by
 * sessions this process owns.
 */
export function handleApproveByRequestId(
  ctx: RouteContext,
  res: ServerResponse,
  body: unknown,
): void {
  approveByRequestId(ctx, res, body);
}

function approveByRequestId(ctx: RouteContext, res: ServerResponse, body: unknown): void {
  const requestId = readStringField(body, 'requestId');
  if (requestId === undefined) {
    sendJson(res, 400, { error: 'bad_request', message: 'body must include requestId' });
    return;
  }
  const response = isRecord(body) ? body['response'] : undefined;
  const resolved = ctx.bridge.resolve(requestId, response);
  if (!resolved) {
    sendJson(res, 404, {
      error: 'unknown_request',
      message: `no pending elicitation with id ${requestId}`,
    });
    return;
  }
  sendJson(res, 200, { ok: true });
}

export function header(req: IncomingMessage, name: string): string | undefined {
  const raw = req.headers[name];
  return Array.isArray(raw) ? raw[0] : raw;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null;
}

function readStringField(body: unknown, field: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * `POST /api/sessions` — start a session this process can drive.
 *
 * Contract: 501 when the server was started without an owner. That is the
 * attach-only configuration, and it is a capability gap rather than a client
 * error — reporting 400 or 404 would suggest the request was malformed.
 */
export async function handleCreateSession(
  ctx: RouteContext,
  res: ServerResponse,
  body: unknown,
): Promise<void> {
  if (!ctx.createSession) {
    sendJson(res, 501, {
      error: 'sessions_not_supported',
      message:
        'this server is attach-only and cannot start sessions. ' +
        'Run `afk web` (which wires a session owner) rather than embedding startWebServer without one.',
    });
    return;
  }

  const request: CreateSessionRequest = {};
  const cwd = readStringField(body, 'cwd');
  const model = readStringField(body, 'model');
  if (cwd !== undefined) request.cwd = cwd;
  if (model !== undefined) request.model = model;

  try {
    const info = await ctx.createSession(request);
    sendJson(res, 201, { session: info });
  } catch (error) {
    sendJson(res, 500, {
      error: 'session_start_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * `POST /api/sessions/:id/interrupt` — soft-stop an in-flight turn.
 *
 * Contract: interrupt is idempotent from the browser's point of view. Stopping
 * an idle session is a no-op that still reports 200, because the alternative is
 * a race — a turn can finish between the browser rendering Stop and the click
 * arriving, and surfacing that as an error would be noise, not information.
 */
export async function handleInterrupt(
  ctx: RouteContext,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  if (!requireValidSessionId(res, sessionId)) return;
  if (!requireOwned(ctx, res, sessionId)) return;
  if (!ctx.interrupt) {
    sendJson(res, 501, { error: 'interrupt_not_supported', message: 'no interrupt handler wired' });
    return;
  }
  try {
    await ctx.interrupt(sessionId);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    sendJson(res, 500, {
      error: 'interrupt_failed',
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
