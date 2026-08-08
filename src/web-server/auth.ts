/**
 * Auth + CSRF primitives for the `afk web` surface.
 *
 * Invariant: this surface does NOT inherit the daemon control plane's trust
 * model. `src/agent/daemon.ts` serves an unauthenticated JSON API and documents
 * that as an accepted risk; it is read-mostly and its POST surface only touches
 * a local task list. The web surface accepts prompts and approvals — i.e. it can
 * make the agent run arbitrary tools — so it enforces three independent checks:
 *
 *   1. Bearer token on every /api/* request (constant-time compared).
 *   2. Origin validation on every mutating (non-GET) request. A loopback bind
 *      alone does NOT stop CSRF: any page open in the user's browser can POST
 *      to 127.0.0.1. The token is not automatically attached by the browser to
 *      a cross-origin form post, but Origin is checked as defence in depth and
 *      to reject same-origin-looking requests forged from another local port.
 *   3. Refusal to bind a non-loopback interface unless a token was explicitly
 *      supplied by the operator, so `--host 0.0.0.0` can never silently expose
 *      an agent with an auto-generated token printed only to a scrollback.
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';

/** Bytes of entropy in a generated session token. */
const TOKEN_BYTES = 32;

/** Mint a per-run bearer token (64 hex chars). */
export function mintToken(): string {
  return randomBytes(TOKEN_BYTES).toString('hex');
}

/**
 * Contract: constant-time token comparison.
 *
 * `timingSafeEqual` THROWS when the two buffers differ in length, so the length
 * check must happen first. Comparing lengths is not itself a meaningful leak —
 * the token length is a fixed public constant — but returning early on a length
 * mismatch keeps the crypto call total.
 */
export function tokensMatch(expected: string, provided: string | undefined): boolean {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** Extract a bearer token from an Authorization header value. */
export function bearerFromHeader(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || undefined;
}

/**
 * Extract the `token` query parameter from a request URL.
 *
 * Invariant: callers must only consult this for the initial document GET. The
 * printed URL carries `?token=` so the browser can bootstrap, but a query token
 * is never accepted on a mutating route — query strings leak into referrers,
 * shell history, and screen shares far more readily than a header does.
 */
export function tokenFromQuery(rawUrl: string): string | undefined {
  const qIndex = rawUrl.indexOf('?');
  if (qIndex === -1) return undefined;
  const params = new URLSearchParams(rawUrl.slice(qIndex + 1));
  return params.get('token') ?? undefined;
}

/** Name of the reload-safe session cookie mirroring the bearer token. */
export const TOKEN_COOKIE_NAME = 'afk_web_token';

/**
 * Extract the web token from a `Cookie` header value.
 *
 * Contract: callers must only consult this for the initial document GET, for
 * the same reason `tokenFromQuery` is so restricted. A cookie is replayed by
 * the browser automatically, which is precisely what makes it usable for a
 * refresh and precisely what would make it a CSRF vector on a mutating route —
 * so `/api/*` authenticates on the `Authorization` header alone.
 */
export function tokenFromCookie(header: string | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() !== TOKEN_COOKIE_NAME) continue;
    const raw = part.slice(eq + 1).trim();
    try {
      return decodeURIComponent(raw) || undefined;
    } catch {
      return raw || undefined;
    }
  }
  return undefined;
}

/**
 * Whether an Origin header is acceptable for a mutating request.
 *
 * A missing Origin is allowed: non-browser clients (curl, the test suite) omit
 * it entirely, and those requests still had to present a valid bearer token.
 * A PRESENT Origin must match one of this server's own origins — that is the
 * case that catches a browser page on another site trying to drive the agent.
 */
export function originAllowed(
  origin: string | undefined,
  host: string,
  port: number,
): boolean {
  if (origin === undefined || origin === '') return true;
  return allowedOrigins(host, port).includes(origin);
}

/**
 * The set of origins considered "this server".
 *
 * Invariant: a WILDCARD bind must include the loopback origins, not just the
 * literal bind host. `startWebServer` advertises (and auto-opens) `127.0.0.1`
 * when bound to `0.0.0.0`, because `http://0.0.0.0:<port>` is not a usable
 * browser URL. Allowing only the bind host therefore 403'd every POST from the
 * very URL the command printed. Loopback is enumerable and safe to allow; the
 * LAN hostnames a wildcard listener also answers on are NOT enumerable here, so
 * reaching a wildcard bind by LAN hostname still fails Origin validation by
 * design — widening that would mean accepting arbitrary Origins, which is the
 * CSRF hole this check exists to close.
 */
export function allowedOrigins(host: string, port: number): string[] {
  const hosts =
    isLoopback(host) || isWildcard(host) ? ['127.0.0.1', 'localhost', '[::1]'] : [host];
  return hosts.map((h) => `http://${h}:${port}`);
}

function isLoopback(host: string): boolean {
  return host === '127.0.0.1' || host === 'localhost' || host === '::1' || host === '[::1]';
}

/** Wildcard binds listen on every interface and are advertised as loopback. */
function isWildcard(host: string): boolean {
  return host === '0.0.0.0' || host === '::' || host === '[::]';
}

/** Result of validating startup binding options. */
export interface BindCheck {
  ok: boolean;
  reason?: string;
}

/**
 * Contract: refuse a non-loopback bind unless the operator explicitly supplied
 * a token. Binding 0.0.0.0 publishes an agent that can edit files and run shell
 * commands onto the local network; doing that with an auto-generated token the
 * operator never consciously chose is a footgun, so it fails closed.
 */
export function checkBind(host: string, tokenExplicit: boolean): BindCheck {
  if (isLoopback(host)) return { ok: true };
  if (tokenExplicit) return { ok: true };
  return {
    ok: false,
    reason:
      `refusing to bind non-loopback host "${host}" without an explicit token. ` +
      `Pass --token <value> or set AFK_WEB_TOKEN. This surface can run tools and edit files.`,
  };
}
