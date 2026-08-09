/**
 * How the browser bundle obtains and retains its bearer token.
 *
 * Invariant: the token is stored in `sessionStorage`, which is scoped by ORIGIN
 * — scheme, host AND port. That port component is the whole point. The token
 * previously survived a refresh by riding in a cookie, but cookies are scoped
 * by host only, so every other `http://127.0.0.1:<port>` service the browser
 * spoke to received the full agent-driving credential in a `Cookie` header and
 * could replay it server-side as `Authorization: Bearer`. Moving it to
 * `sessionStorage` makes it unreadable by any sibling loopback port, whether
 * that port is a page (no cross-origin read) or a server (nothing is sent to
 * it automatically).
 *
 * The server still sets a cookie, but its value is now an opaque document key
 * that only unlocks the non-secret static bundle — a captured cookie cannot be
 * escalated, because the server templates the bearer token into the document
 * only for a request that presented `?token=` or a single-use handoff nonce.
 */

/** Value the server replaces when templating the document; never a real token. */
export const TOKEN_PLACEHOLDER = '__AFK_WEB_TOKEN__';

/** `sessionStorage` key holding the bearer token for this tab. */
const STORAGE_KEY = 'afk_web_token';

/**
 * Fallback when `sessionStorage` is unavailable.
 *
 * Contract: Safari's private mode and some embedded webviews throw on access
 * rather than returning null. A token held only here does not survive a
 * refresh — the user re-opens the printed URL — but the page still works for
 * the current load instead of failing outright.
 */
let memoryToken = '';

/**
 * Read the token for this page, and scrub any credential from the visible URL.
 *
 * Contract: the scrub is unconditional on a credential's PRESENCE — it keeps
 * both `?token=` and `?k=` out of the address bar, the history entry, and any
 * pasted screenshot. Returns `''` when no token is available from either the
 * document or storage; callers must treat that as "no credential" so requests
 * fail with a real 401 rather than authenticating as nobody.
 */
export function readAndScrubToken(): string {
  const params = new URLSearchParams(location.search);
  if (params.get('token') || params.get('k')) {
    history.replaceState(null, '', location.pathname);
  }
  // A bootstrap load carries the token in the document; a cookie-authenticated
  // refresh serves an empty placeholder, so fall back to this tab's storage.
  const fromMeta = readMetaToken();
  if (fromMeta) {
    saveToken(fromMeta);
    return fromMeta;
  }
  return loadToken();
}

/** The `<meta name="afk-token">` content, or `''` when absent/untemplated. */
export function readMetaToken(): string {
  const content = document.querySelector('meta[name="afk-token"]')?.getAttribute('content');
  if (!content || content === TOKEN_PLACEHOLDER) return '';
  return content;
}

function saveToken(token: string): void {
  memoryToken = token;
  try {
    sessionStorage.setItem(STORAGE_KEY, token);
  } catch {
    // Storage disabled; `memoryToken` carries this load.
  }
}

function loadToken(): string {
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    if (stored) return stored;
  } catch {
    // Fall through to the in-memory value.
  }
  return memoryToken;
}
