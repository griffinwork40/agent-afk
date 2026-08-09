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
import { bearerFromHeader, checkBind, mintToken, originAllowed, tokensMatch } from './auth.js';
import { serveStatic, type StaticAuth } from './static-assets.js';
import { HandoffNonces } from './handoff.js';
import { WebElicitationBridge } from './elicitation-web.js';
import type { CreateSessionRequest, SessionOwner } from './session-owner.js';
import {
  handleApprove,
  handleApproveByRequestId,
  handleCommands,
  handleCreateSession,
  handleInterrupt,
  handleListSessions,
  handlePrompt,
  header,
  sendJson,
  type RouteContext,
} from './routes.js';
import { handleStream } from './stream-route.js';

export const DEFAULT_WEB_PORT = 4141;
export const DEFAULT_WEB_HOST = '127.0.0.1';

/** Cap on a request body; prompts are text, so this is generous. */
const MAX_BODY_BYTES = 1_000_000;

export interface WebServerOptions {
  port?: number;
  host?: string;
  /** Explicit token (flag/env). When absent one is minted. */
  token?: string;
  /**
   * Whether `token` was EXPLICITLY supplied by the operator (`--token`/env)
   * rather than merely present. Load-bearing: `checkBind` refuses a
   * non-loopback bind without it. Absent means "infer from the token", which
   * preserves the behaviour of every caller that predates this field.
   */
  tokenExplicit?: boolean;
  /** Session ids this process owns. Shared by reference with the caller. */
  owned?: Set<string>;
  submitPrompt?: (sessionId: string, text: string) => Promise<void>;
  /**
   * Backpressure predicate: true while a session already has a turn in
   * flight. `handlePrompt` 409s on it rather than chaining another turn.
   * Same precedence as `submitPrompt` — an explicit option wins over `owner`;
   * with neither, `handlePrompt` sees "never busy" so attach-only mode (no
   * owner at all) is unaffected.
   */
  isBusy?: (sessionId: string) => boolean;
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
  /** Human-readable URL carrying `?token=`. Safe to print; NEVER pass to exec. */
  url: string;
  /**
   * URL for the auto-open path, carrying a single-use `?k=` handoff nonce.
   *
   * Invariant: this is the only URL that may be handed to `open`/`xdg-open`.
   * Process arguments are world-readable, so opening `url` would publish the
   * bearer token to every local user for the life of the browser process.
   */
  openUrl: string;
  bridge: WebElicitationBridge;
  stop: () => Promise<void>;
}

export async function startWebServer(options: WebServerOptions = {}): Promise<WebServerHandle> {
  const host = options.host ?? DEFAULT_WEB_HOST;
  const hasToken = typeof options.token === 'string' && options.token.length > 0;
  // Invariant: `tokenExplicit: true` with no token is a contradiction, not a
  // combination to infer through. It would clear checkBind's non-loopback
  // guard while `token` below still auto-mints a credential nobody chose —
  // exactly the LAN-exposure-under-an-unseen-token footgun checkBind exists to
  // block (see its contract comment in auth.ts). Fail fast instead of letting
  // the two fields silently disagree.
  if (options.tokenExplicit === true && !hasToken) {
    throw new Error(
      'startWebServer: tokenExplicit is true but no token was supplied — ' +
        'an explicit token requires a non-empty options.token.',
    );
  }
  // Contract: `tokenExplicit` is the operator's real intent as computed by
  // `resolveWebToken`; the presence check is the legacy fallback for callers
  // that do not pass it. Inferring explicitness from a non-empty token is what
  // made the documented "explicit token" invariant true only by coincidence.
  const tokenExplicit = options.tokenExplicit ?? hasToken;
  const bind = checkBind(host, tokenExplicit);
  if (!bind.ok) throw new Error(bind.reason ?? 'refusing to bind');

  // Invariant: keyed on token PRESENCE, never on `tokenExplicit`. They are no
  // longer the same predicate — `tokenExplicit: true` with no token is now
  // expressible, and reading the token off that flag would yield `undefined`.
  const token = hasToken ? (options.token as string) : mintToken();
  // Invariant: minted independently of `token` and never compared against it.
  // This is the ONLY value the reload cookie carries, so a sibling loopback
  // port that captures the cookie gains the static bundle and nothing more.
  const docKey = mintToken();
  const nonces = new HandoffNonces();
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
    // Contract: same "explicit option wins over owner" precedence as
    // submitPrompt above, but the no-owner fallback is "never busy" rather
    // than a throw — attach-only mode (no owner) 409s every prompt on
    // ownership already, so isBusy is never even consulted for it, and
    // defaulting to false keeps that path's existing behaviour unchanged.
    // `?? false` also covers a test-injected owner fake that omits `isBusy`
    // (the real SessionOwner always defines it) — treated as never-busy
    // rather than a thrown TypeError.
    isBusy:
      options.isBusy ??
      (options.owner ? (id: string) => options.owner!.isBusy?.(id) ?? false : () => false),
    ...(options.owner
      ? {
          createSession: (req: CreateSessionRequest) => options.owner!.create(req),
          interrupt: (id: string) => options.owner!.interrupt(id),
        }
      : {}),
  };

  const server = createServer((req, res) => {
    const auth: StaticAuth = { token, docKey, nonces };
    void dispatch(req, res, ctx, auth, host, actualPort(server), streams).catch((err: unknown) => {
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
    openUrl: `http://${displayHost}:${port}/?k=${nonces.mint()}`,
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
      // Invariant: abort -> close() -> closeAllConnections(), in that order.
      // Aborting ends the event-stream RESPONSE, but this route sets
      // `connection: keep-alive`, so the SOCKET survives the response and
      // `server.close()` keeps waiting on it — shutdown still stalled for
      // seconds. `close()` must be called before reaping sockets so the server
      // stops accepting new ones first; `closeAllConnections()` then destroys
      // the lingering keep-alive sockets. Forcible destruction is correct here:
      // this runs only on an explicit stop/SIGINT.
      const closed = new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections();
      await closed;
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
  auth: StaticAuth,
  host: string,
  port: number,
  streams: Set<AbortController>,
): Promise<void> {
  const rawUrl = req.url ?? '/';
  const path = rawUrl.split('?')[0] ?? '/';
  const method = req.method ?? 'GET';

  if (!path.startsWith('/api/')) {
    await serveStatic(req, res, path, rawUrl, auth);
    return;
  }

  // ---- auth: bearer required on every API route -------------------------
  if (!tokensMatch(auth.token, bearerFromHeader(header(req, 'authorization')))) {
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

  // Contract: session-agnostic approval. An elicitation record does not always
  // carry a sessionId, and the old route's ownership check constrained nothing
  // anyway — it resolved by requestId alone. The bridge only ever holds
  // elicitations raised by sessions THIS process owns, and the bearer + Origin
  // gates above already ran, so identity is established without the id.
  if (path === '/api/approve' && method === 'POST') {
    handleApproveByRequestId(ctx, res, await readBody(req));
    return;
  }

  if (path === '/api/pending' && method === 'GET') {
    sendJson(res, 200, { pending: ctx.bridge.list() });
    return;
  }

  if (path === '/api/commands' && method === 'GET') {
    await handleCommands(res);
    return;
  }

  sendJson(res, 404, { error: 'not_found', message: `no route for ${method} ${path}` });
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
