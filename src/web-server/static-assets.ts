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
import { TOKEN_COOKIE_NAME, tokenFromCookie, tokenFromQuery, tokensMatch } from './auth.js';

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
  token: string,
): Promise<void> {
  const isDocument = path === '/' || path === '/index.html';
  // Invariant: the query token and the session cookie are honoured HERE and
  // nowhere else. `/api/*` is gated on the Authorization header well before
  // this function is reachable, so neither credential can ever drive the agent.
  const fromQuery = tokenFromQuery(rawUrl);
  const authed =
    tokensMatch(token, fromQuery) || tokensMatch(token, tokenFromCookie(req.headers.cookie));
  if (!authed) {
    res.writeHead(401, { ...SECURITY_HEADERS, 'content-type': 'text/plain; charset=utf-8' });
    res.end('Missing or invalid token. Use the URL printed by `afk web`.');
    return;
  }

  // Invariant: the cookie is minted the moment AUTHENTICATION succeeds, not
  // when the asset happens to exist. A source checkout without a built bundle
  // answers the document with 503, and withholding the cookie there would mean
  // the very next refresh had no credential to replay.
  const docHeaders = isDocument ? { 'set-cookie': documentCookie(token) } : {};

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
    // Invariant: the token reaches the page through the SERVED HTML, and the
    // cookie is set by the SERVER with HttpOnly. A JS-written cookie was
    // readable via `document.cookie` by any page on any other loopback port —
    // cookies are scoped by host, not by port — which handed the full bearer
    // token to any local origin. HttpOnly closes that read path while keeping
    // the automatic replay that makes a bare refresh authenticate.
    const body = isDocument
      ? Buffer.from(raw.toString('utf8').split(TOKEN_PLACEHOLDER).join(escapeHtmlAttribute(token)))
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
function documentCookie(token: string): string {
  return `${TOKEN_COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict`;
}

function contentType(file: string): string {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  return 'application/octet-stream';
}
