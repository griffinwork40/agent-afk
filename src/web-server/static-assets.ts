/**
 * Static asset serving + response security headers for the `afk web` surface.
 *
 * Invariant: the bundle is byte-served with exactly ONE exception — the
 * document is templated so the page receives its bearer token in a `<meta>`
 * tag. Every other asset is returned verbatim, so the token can never leak
 * into a cacheable subresource.
 */

import { readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, normalize } from 'node:path';
import { getWebUiAssetsDir } from '../paths.js';
import {
  DOC_COOKIE_NAME,
  docKeyFromCookie,
  nonceFromQuery,
  tokenFromQuery,
  tokensMatch,
} from './auth.js';
import type { HandoffNonces } from './handoff.js';

/**
 * Credentials `serveStatic` authenticates against.
 *
 * Contract: `token` is the bearer credential and is templated into the
 * document ONLY on a bootstrap load. `docKey` is an opaque per-run value that
 * is all the reload cookie ever carries. They must never be the same string.
 */
export interface StaticAuth {
  /** Per-run bearer token. Drives `/api/*`; templated in on bootstrap only. */
  token: string;
  /** Opaque per-run cookie value. Never the bearer token. */
  docKey: string;
  /** Single-use nonces backing the auto-opened URL. */
  nonces: HandoffNonces;
}

/**
 * Contract: sent on EVERY response this surface produces — JSON and asset
 * alike — so there is no route through which an unprotected response escapes.
 *
 * `script-src 'self'` is why the page may not carry an inline `<script>`: the
 * document is templated with a live bearer token, and an inline script is
 * exactly the injection sink that would turn a templating bug into token
 * disclosure. `img-src` must allow `data:` because index.html answers the
 * browser's unconditional `/favicon.ico` request with an inline data-URI
 * rather than an extra round trip. `connect-src 'self'` covers both the
 * `fetch` calls and the `EventSource` stream, which are same-origin by
 * construction.
 */
export const SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:",
  'x-content-type-options': 'nosniff',
  'x-frame-options': 'DENY',
  'referrer-policy': 'no-referrer',
});

/** Replaced with the live bearer token when the document is served. */
export const TOKEN_PLACEHOLDER = '__AFK_WEB_TOKEN__';

/**
 * Escape a value for interpolation into an HTML attribute.
 *
 * The token is generated hex (or an operator-supplied string), so this is
 * defence in depth rather than a live escape — but the document is the one
 * templated response on this surface, and templating without escaping is how
 * that stops being true after the next change.
 */
function escapeHtmlAttribute(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Serve the prebuilt browser bundle.
 *
 * Invariant: EVERY asset requires the same credential, not just the document.
 * `/app.js` and `/styles.css` were previously served to any unauthenticated
 * client because the 401 fired only on the document. Browsers replay the
 * session cookie automatically on same-origin subresources, so gating all
 * paths costs the real client nothing.
 *
 * Contract: the document GET may authenticate via `?token=` so the printed URL
 * works when pasted into a browser; API routes never accept a query token.
 * A missing bundle returns an actionable 503 rather than crashing the process —
 * running from a source checkout without `pnpm build:web-ui` is a normal state.
 */
export async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  rawUrl: string,
  auth: StaticAuth,
): Promise<void> {
  const isDocument = path === '/' || path === '/index.html';
  // Invariant: the query token, the handoff nonce, and the document cookie are
  // honoured HERE and nowhere else. `/api/*` is gated on the Authorization
  // header well before this function is reachable, so none of these three can
  // ever drive the agent.
  //
  // Invariant: a BOOTSTRAP load is one that presented a credential the browser
  // does not replay by itself — `?token=` typed/pasted, or a single-use nonce.
  // Only a bootstrap load receives the bearer token in its HTML. A load
  // authenticated by the cookie ALONE gets the same bundle with an empty token,
  // which is what makes a cookie captured by a sibling loopback port worthless:
  // it can fetch the public static shell and cannot escalate to the credential.
  const viaQueryToken = tokensMatch(auth.token, tokenFromQuery(rawUrl));
  // `redeem` burns the nonce, so it must not run for subresources or for a
  // request already authenticated by the query token.
  const viaNonce = !viaQueryToken && isDocument && auth.nonces.redeem(nonceFromQuery(rawUrl));
  const bootstrap = viaQueryToken || viaNonce;
  const authed = bootstrap || tokensMatch(auth.docKey, docKeyFromCookie(req.headers.cookie));
  if (!authed) {
    res.writeHead(401, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
    res.end('Missing or invalid token. Use the URL printed by `afk web`.');
    return;
  }

  // Invariant: the cookie is minted the moment AUTHENTICATION succeeds, not
  // when the asset happens to exist. A source checkout without a built bundle
  // answers the document with 503, and withholding the cookie there would mean
  // the very next refresh had no credential to replay.
  const docHeaders = isDocument ? { 'set-cookie': documentCookie(auth.docKey) } : {};

  const rel = isDocument ? 'index.html' : path.replace(/^\/+/, '');
  // Invariant: reject any traversal before touching the filesystem. `normalize`
  // collapses `..` segments, so a normalized path that still escapes the assets
  // root — or that was absolute to begin with — is refused outright.
  const normalized = normalize(rel);
  if (normalized.startsWith('..') || normalized.startsWith('/')) {
    res.writeHead(403, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    return;
  }

  const file = join(getWebUiAssetsDir(), normalized);
  try {
    const raw = await readFile(file);
    // Invariant: the token reaches the page through the SERVED HTML, but only
    // on a bootstrap load. On a cookie-authenticated refresh the placeholder is
    // replaced with the EMPTY string, and the page recovers its credential from
    // `sessionStorage` — which, unlike a cookie, is scoped by origin (scheme +
    // host + PORT) and so is unreadable by any sibling loopback port.
    const body = isDocument
      ? Buffer.from(
          raw
            .toString('utf8')
            .split(TOKEN_PLACEHOLDER)
            .join(bootstrap ? escapeHtmlAttribute(auth.token) : ''),
        )
      : raw;
    res.writeHead(200, {
      ...SECURITY_HEADERS,
      'content-type': contentType(normalized),
      'content-length': body.byteLength,
      'cache-control': 'no-store',
      ...docHeaders,
    });
    res.end(body);
  } catch {
    if (isDocument) {
      res.writeHead(503, {
        ...SECURITY_HEADERS,
        ...docHeaders,
        'content-type': 'text/plain; charset=utf-8',
      });
      res.end('Web UI bundle not built. Run `pnpm build:web-ui` and retry.');
      return;
    }
    res.writeHead(404, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

/**
 * Contract: no `Secure` attribute and no `__Host-` prefix. Both require HTTPS,
 * and this server is plain-http loopback by design — either one would stop the
 * browser from storing the cookie at all, which would silently reintroduce the
 * 401-on-refresh bug this cookie exists to prevent.
 */
function documentCookie(docKey: string): string {
  return `${DOC_COOKIE_NAME}=${encodeURIComponent(docKey)}; Path=/; HttpOnly; SameSite=Strict`;
}

function contentType(file: string): string {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}
