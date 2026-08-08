/**
 * How the browser bundle obtains its bearer token.
 *
 * Invariant: the token is READ from the `<meta name="afk-token">` tag the
 * server templates into the document, and is never written anywhere the page
 * can read back. It used to be mirrored into `document.cookie` so a refresh had
 * a credential to replay, but cookies are scoped by HOST and not by port — so
 * any page on any other `http://127.0.0.1:<port>` origin could read the full
 * bearer token out of `document.cookie` and drive the agent with it. The server
 * now sets that cookie itself with `HttpOnly`, which preserves the automatic
 * replay that makes a bare refresh authenticate while removing the JS read path.
 */

/** Value the server replaces when templating the document; never a real token. */
export const TOKEN_PLACEHOLDER = '__AFK_WEB_TOKEN__';

/**
 * Read the token from the document, and scrub `?token=` from the visible URL.
 *
 * Contract: the scrub is unconditional on the query token's PRESENCE and is
 * independent of where the token is read from — it keeps the credential out of
 * the address bar, the history entry, and any pasted screenshot. Returns `''`
 * when the document carries no usable token (missing tag, or an unsubstituted
 * placeholder from a hand-copied bundle); callers must treat that as "no
 * credential" so requests fail with a real 401 rather than authenticating as
 * nobody.
 */
export function readAndScrubToken(): string {
  const params = new URLSearchParams(location.search);
  if (params.get('token')) {
    history.replaceState(null, '', location.pathname);
  }
  return readMetaToken();
}

/** The `<meta name="afk-token">` content, or `''` when absent/untemplated. */
export function readMetaToken(): string {
  const content = document.querySelector('meta[name="afk-token"]')?.getAttribute('content');
  if (!content || content === TOKEN_PLACEHOLDER) return '';
  return content;
}
