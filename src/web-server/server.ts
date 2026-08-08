/**
 * `afk web` — local-first HTTP + SSE server for browsing live agent sessions.
 *
 * Invariant: the security posture here is deliberately STRICTER than
 * `src/agent/daemon.ts`. The daemon serves an unauthenticated JSON control
 * plane and documents that as accepted risk. This surface can submit prompts
 * and approve tool use, so it authenticates every /api/* call with a bearer
 * token, validates Origin on mutating requests, and refuses to bind a
 * non-loopback interface without an explicitly supplied token.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize } from 'node:path';
import { getWebUiAssetsDir } from '../paths.js';
import {
  bearerFromHeader,
  checkBind,
  mintToken,
  originAllowed,
  tokenFromQuery,
  tokensMatch,
} from './auth.js';
import { WebElicitationBridge } from './elicitation-web.js';
import type { CreateSessionRequest, SessionOwner } from './session-owner.js';
import {
  handleApprove,
  handleCreateSession,
  handleInterrupt,
  handleListSessions,
  handlePrompt,
  handleStream,
  header,
  sendJson,
  type RouteContext,
} from './routes.js';

export const DEFAULT_WEB_PORT = 4141;
export const DEFAULT_WEB_HOST = '127.0.0.1';

/** Cap on a request body; prompts are text, so this is generous. */
const MAX_BODY_BYTES = 1_000_000;

export interface WebServerOptions {
  port?: number;
  host?: string;
  /** Explicit token (flag/env). When absent one is minted. */
  token?: string;
  /** Session ids this process owns. Shared by reference with the caller. */
  owned?: Set<string>;
  submitPrompt?: (sessionId: string, text: string) => Promise<void>;
  /**
   * Supplies the drivable-session capability. When present it provides `owned`,
   * `submitPrompt`, session creation, and interrupt in one object.
   *
   * Contract: the explicit `owned`/`submitPrompt` options still win when both
   * are given, so tests can inject fakes without constructing a real owner.
   * When NO owner is supplied the surface is attach-only — every session is
   * read-only and `POST /api/sessions` reports 501 rather than pretending.
   */
  owner?: SessionOwner;
}

export interface WebServerHandle {
  port: number;
  host: string;
  token: string;
  url: string;
  bridge: WebElicitationBridge;
  stop: () => Promise<void>;
}

export async function startWebServer(options: WebServerOptions = {}): Promise<WebServerHandle> {
  const host = options.host ?? DEFAULT_WEB_HOST;
  const tokenExplicit = typeof options.token === 'string' && options.token.length > 0;
  const bind = checkBind(host, tokenExplicit);
  if (!bind.ok) throw new Error(bind.reason ?? 'refusing to bind');

  const token = tokenExplicit ? (options.token as string) : mintToken();
  const owned = options.owned ?? options.owner?.owned ?? new Set<string>();
  const bridge = new WebElicitationBridge();
  bridge.install();

  /** Abort controllers for in-flight SSE streams, so shutdown can end them. */
  const streams = new Set<AbortController>();

  const ctx: RouteContext = {
    owned,
    bridge,
    submitPrompt:
      options.submitPrompt ??
      (options.owner
        ? (id, text) => options.owner!.submitPrompt(id, text)
        : async () => {
            throw new Error('no prompt handler wired');
          }),
    ...(options.owner
      ? {
          createSession: (req: CreateSessionRequest) => options.owner!.create(req),
          interrupt: (id: string) => options.owner!.interrupt(id),
        }
      : {}),
  };

  const server = createServer((req, res) => {
    void dispatch(req, res, ctx, token, host, actualPort(server), streams).catch((err: unknown) => {
      if (res.headersSent) {
        res.end();
        return;
      }
      sendJson(res, 500, {
        error: 'internal',
        message: err instanceof Error ? err.message : String(err),
      });
    });
  });

  const port = await listen(server, options.port ?? DEFAULT_WEB_PORT, host);
  const displayHost = host === '0.0.0.0' ? '127.0.0.1' : host;

  return {
    port,
    host,
    token,
    url: `http://${displayHost}:${port}/?token=${token}`,
    bridge,
    stop: async () => {
      bridge.uninstall();
      // Invariant: abort live SSE streams BEFORE awaiting `server.close()`.
      // `close()` stops accepting new connections but waits for existing ones
      // to end, and an event-stream response never ends on its own — it tails
      // the ledger and heartbeats indefinitely. So with any browser attached,
      // the SIGINT/SIGTERM path's `stop().then(() => process.exit(0))` never
      // resolved, and the `stopping` guard swallowed every subsequent signal:
      // the process could only be killed with SIGKILL. Aborting each stream's
      // controller ends its response, which lets `close()` complete promptly.
      for (const controller of [...streams]) controller.abort();
      streams.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/**
 * Bind, falling back to an ephemeral port when the requested one is taken.
 * A hard failure here would be a poor experience for a convenience surface —
 * but the fallback is reported through the returned port, never silently.
 */
function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const onError = (err: NodeJS.ErrnoException): void => {
      if (err.code === 'EADDRINUSE' && port !== 0) {
        server.removeListener('error', onError);
        server.listen(0, host, () => resolve(actualPort(server)));
        return;
      }
      reject(err);
    };
    server.once('error', onError);
    server.listen(port, host, () => {
      server.removeListener('error', onError);
      resolve(actualPort(server));
    });
  });
}

function actualPort(server: Server): number {
  const addr = server.address();
  return typeof addr === 'object' && addr !== null ? addr.port : 0;
}

async function dispatch(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: RouteContext,
  token: string,
  host: string,
  port: number,
  streams: Set<AbortController>,
): Promise<void> {
  const rawUrl = req.url ?? '/';
  const path = rawUrl.split('?')[0] ?? '/';
  const method = req.method ?? 'GET';

  if (!path.startsWith('/api/')) {
    await serveStatic(req, res, path, rawUrl, token);
    return;
  }

  // ---- auth: bearer required on every API route -------------------------
  if (!tokensMatch(token, bearerFromHeader(header(req, 'authorization')))) {
    sendJson(res, 401, { error: 'unauthorized', message: 'missing or invalid bearer token' });
    return;
  }

  // ---- CSRF: validate Origin on mutating requests ------------------------
  // A loopback bind does not prevent a page in the user's browser from POSTing
  // to localhost, so this check is load-bearing, not decorative.
  if (method !== 'GET' && !originAllowed(header(req, 'origin'), host, port)) {
    sendJson(res, 403, { error: 'bad_origin', message: 'Origin not allowed' });
    return;
  }

  if (path === '/api/sessions' && method === 'GET') {
    await handleListSessions(ctx, res);
    return;
  }

  const streamMatch = /^\/api\/sessions\/([^/]+)\/stream$/.exec(path);
  if (streamMatch?.[1] && method === 'GET') {
    await handleStream(req, res, decodeURIComponent(streamMatch[1]), streams);
    return;
  }

  const promptMatch = /^\/api\/sessions\/([^/]+)\/prompt$/.exec(path);
  if (promptMatch?.[1] && method === 'POST') {
    await handlePrompt(ctx, res, decodeURIComponent(promptMatch[1]), await readBody(req));
    return;
  }

  if (path === '/api/sessions' && method === 'POST') {
    await handleCreateSession(ctx, res, await readBody(req));
    return;
  }

  const interruptMatch = /^\/api\/sessions\/([^/]+)\/interrupt$/.exec(path);
  if (interruptMatch?.[1] && method === 'POST') {
    await handleInterrupt(ctx, res, decodeURIComponent(interruptMatch[1]));
    return;
  }

  const approveMatch = /^\/api\/sessions\/([^/]+)\/approve$/.exec(path);
  if (approveMatch?.[1] && method === 'POST') {
    handleApprove(ctx, res, decodeURIComponent(approveMatch[1]), await readBody(req));
    return;
  }

  if (path === '/api/pending' && method === 'GET') {
    sendJson(res, 200, { pending: ctx.bridge.list() });
    return;
  }

  sendJson(res, 404, { error: 'not_found', message: `no route for ${method} ${path}` });
}

/**
 * Serve the prebuilt browser bundle.
 *
 * Contract: the document GET may authenticate via `?token=` so the printed URL
 * works when pasted into a browser; API routes never accept a query token.
 * A missing bundle returns an actionable 503 rather than crashing the process —
 * running from a source checkout without `pnpm build:web-ui` is a normal state.
 */
async function serveStatic(
  _req: IncomingMessage,
  res: ServerResponse,
  path: string,
  rawUrl: string,
  token: string,
): Promise<void> {
  const isDocument = path === '/' || path === '/index.html';
  if (isDocument && !tokensMatch(token, tokenFromQuery(rawUrl))) {
    res.writeHead(401, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Missing or invalid token. Use the URL printed by `afk web`.');
    return;
  }

  const rel = isDocument ? 'index.html' : path.replace(/^\/+/, '');
  // Invariant: reject any traversal before touching the filesystem. `normalize`
  // collapses `..` segments, so a normalized path that still escapes the assets
  // root — or that was absolute to begin with — is refused outright.
  const normalized = normalize(rel);
  if (normalized.startsWith('..') || normalized.startsWith('/')) {
    res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  const file = join(getWebUiAssetsDir(), normalized);
  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': contentType(normalized),
      'content-length': body.byteLength,
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    if (isDocument) {
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('Web UI bundle not built. Run `pnpm build:web-ui` and retry.');
      return;
    }
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

function contentType(file: string): string {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.byteLength;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  if (chunks.length === 0) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}
