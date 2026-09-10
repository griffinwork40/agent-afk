/**
 * API client for the AFK web-server.
 *
 * Reads the bearer token from the `<meta name="afk-token">` tag (templated by
 * the server on bootstrap) or from sessionStorage on refresh. All fetches go
 * through `apiFetch` which attaches the Authorization header.
 */

const TOKEN_STORAGE_KEY = 'afk_web_token';

/** The server replaces this in the HTML; when we read it raw, there is no token. */
const TOKEN_PLACEHOLDER = '__AFK_WEB_TOKEN__';

let cachedToken: string | null = null;

/** Evict the in-memory token cache (e.g. after a 401 response). */
function clearTokenCache(): void {
  cachedToken = null;
  try {
    sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  } catch {
    // sessionStorage may be unavailable in some contexts
  }
}

/** Read the bearer token, preferring the meta tag, falling back to storage. */
export function getToken(): string {
  if (cachedToken) return cachedToken;

  const meta = document.querySelector<HTMLMetaElement>('meta[name="afk-token"]');
  const metaValue = meta?.content;

  if (metaValue && metaValue !== TOKEN_PLACEHOLDER) {
    cachedToken = metaValue;
    try {
      sessionStorage.setItem(TOKEN_STORAGE_KEY, metaValue);
    } catch {
      // sessionStorage may be unavailable in some contexts
    }
    // Scrub the token from the URL bar if present
    scrubTokenFromUrl();
    return metaValue;
  }

  // Fallback: cookie-authenticated refresh, token in sessionStorage
  try {
    const stored = sessionStorage.getItem(TOKEN_STORAGE_KEY);
    if (stored) {
      cachedToken = stored;
      return stored;
    }
  } catch {
    // sessionStorage unavailable
  }

  return '';
}

function scrubTokenFromUrl(): void {
  const url = new URL(window.location.href);
  if (url.searchParams.has('token') || url.searchParams.has('k')) {
    url.searchParams.delete('token');
    url.searchParams.delete('k');
    window.history.replaceState({}, '', url.toString());
  }
}

/** Fetch wrapper that attaches auth + sets JSON content type for bodies. */
export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  const token = getToken();
  const headers = new Headers(options.headers);
  if (token) {
    headers.set('Authorization', `Bearer ${token}`);
  }
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, { ...options, headers });
  if (!res.ok) {
    // On 401 the server may have rotated the token — clear the cache so the
    // next request re-reads from the meta tag instead of reusing the stale one.
    if (res.status === 401) clearTokenCache();
    const text = await res.text().catch(() => res.statusText);
    throw new ApiError(res.status, text);
  }
  return res.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(`API ${status}: ${message}`);
    this.name = 'ApiError';
  }
}
