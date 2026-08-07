/**
 * Request routing for the `afk web` surface.
 *
 * Contract: every handler here receives an already-authenticated request —
 * `server.ts` enforces the bearer token and Origin check before dispatching.
 * Handlers must still enforce the OWNERSHIP boundary themselves, because that
 * is a per-session property rather than a per-request one.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { readLedger, tailLedger } from '../agent/session-ledger.js';
import { jsonDateReplacer } from '../cli/json-date-replacer.js';
import { listWebSessions } from './session-source.js';
import { formatSseFrame } from './sse-protocol.js';
import type { WebElicitationBridge } from './elicitation-web.js';

/** Heartbeat cadence; keeps intermediaries from idling out a quiet stream. */
const HEARTBEAT_MS = 15_000;

export interface RouteContext {
  /** Session ids created inside THIS process — the only ones we can drive. */
  owned: Set<string>;
  bridge: WebElicitationBridge;
  /** Submit a prompt to an owned session. */
  submitPrompt: (sessionId: string, text: string) => Promise<void>;
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body, jsonDateReplacer);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    // This API is token-authenticated and loopback-bound; never let a browser
    // or intermediary cache a transcript to disk.
    'cache-control': 'no-store',
  });
  res.end(payload);
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
 * Invariant: SSE resume is replay-then-tail, and the replay source is the
 * session LEDGER, which is a lossy projection rather than a transcript
 * (assistant text capped, tool inputs truncated, and successful tool output
 * never persisted at all). The `replay: true` marker on replayed frames is what
 * lets the browser render "result not available after refresh" instead of
 * presenting an empty string as though it were the real output. Dropping that
 * flag would silently turn a known gap into a confident lie.
 */
export async function handleStream(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
): Promise<void> {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-store',
    connection: 'keep-alive',
    // Defeats proxy buffering, which otherwise holds frames until a buffer
    // fills and makes a live stream look hung.
    'x-accel-buffering': 'no',
  });

  const lastEventId = header(req, 'last-event-id');
  let seq = Number.parseInt(lastEventId ?? '0', 10);
  if (!Number.isFinite(seq) || seq < 0) seq = 0;
  const resumeFrom = seq;

  let closed = false;
  const heartbeat = setInterval(() => {
    if (!closed) res.write(': ping\n\n');
  }, HEARTBEAT_MS);

  const finish = (): void => {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    res.end();
  };
  req.on('close', finish);

  try {
    // Phase 1 — replay everything the client has not seen.
    let index = 0;
    for await (const record of readLedger(sessionId)) {
      index += 1;
      if (index <= resumeFrom) continue;
      if (closed) return;
      res.write(formatSseFrame({ id: String(index), data: { record, replay: true } }));
    }

    // Phase 2 — tail live.
    for await (const record of tailLedger(sessionId)) {
      if (closed) return;
      index += 1;
      res.write(formatSseFrame({ id: String(index), data: { record, replay: false } }));
    }
  } catch (err) {
    if (!closed) {
      res.write(
        formatSseFrame({
          data: { error: err instanceof Error ? err.message : String(err) },
        }),
      );
    }
  } finally {
    finish();
  }
}

export async function handlePrompt(
  ctx: RouteContext,
  res: ServerResponse,
  sessionId: string,
  body: unknown,
): Promise<void> {
  if (!requireOwned(ctx, res, sessionId)) return;
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
  if (!requireOwned(ctx, res, sessionId)) return;
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
