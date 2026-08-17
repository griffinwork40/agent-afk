/**
 * SuperGrok / SuperGrok Heavy / X Premium+ OAuth for the xAI provider.
 *
 * Barrel + owned refresh with refresh_token rotation. Device-code and PKCE
 * live in sibling modules; discovery helpers in `oauth-http.ts`.
 *
 * Invariant: every successful token response that includes a refresh_token
 * MUST overwrite both access_token and refresh_token in the store. xAI issues
 * a new refresh_token on each refresh; keeping the old one breaks the next call.
 *
 * @module agent/providers/xai/oauth
 */

import { XAI_OAUTH_CLIENT_ID, XAI_REFRESH_SKEW_SECONDS } from './oauth-constants.js';
import {
  type XaiAuthStoreDeps,
  type XaiTokenBundle,
  clearXaiTokens,
  getXaiAuthPath,
  readXaiTokens,
  writeXaiTokens,
} from './auth-store.js';
import {
  asNonEmptyString,
  discoverXaiOidcCached,
  tokenResponseToBundle,
  type OAuthHttpDeps,
} from './oauth-http.js';

export type { FetchFn, OAuthHttpDeps, XaiOidcDiscovery } from './oauth-http.js';
export { clearOidcCache, discoverXaiOidc, discoverXaiOidcCached, tokenResponseToBundle } from './oauth-http.js';
export {
  startDeviceCodeFlow,
  pollDeviceCodeToken,
  type DeviceCodeStart,
  type DevicePollResult,
} from './oauth-device.js';
export {
  buildPkceAuthorizeUrl,
  codeChallengeS256,
  exchangeAuthorizationCode,
  generateCodeVerifier,
  generateOAuthState,
  type PkceAuthorizeParams,
} from './oauth-pkce.js';

/**
 * Single-flight refresh keyed by store path: concurrent callers for the *same*
 * token store share one HTTP refresh (rotating refresh_token). Different
 * AFK_STATE_DIR / injected auth paths never join each other's in-flight work.
 */
const refreshInFlightByPath = new Map<string, Promise<XaiTokenBundle>>();

function storePathKey(store: XaiAuthStoreDeps | undefined): string {
  if (store?.authPath) return store.authPath();
  return getXaiAuthPath();
}

/**
 * Refresh the access token. On success, ALWAYS write both tokens via
 * {@link writeXaiTokens} when `persist` is true (default).
 */
export async function refreshXaiTokens(
  refreshToken: string,
  deps: OAuthHttpDeps & { store?: XaiAuthStoreDeps; persist?: boolean } = {},
): Promise<XaiTokenBundle> {
  const discovery = await discoverXaiOidcCached(deps);
  const fetchFn = deps.fetchFn ?? fetch;
  const clientId = deps.clientId ?? XAI_OAUTH_CLIENT_ID;
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
  });
  const res = await fetchFn(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) {
    const err = asNonEmptyString(json['error']) ?? `http_${res.status}`;
    const desc = asNonEmptyString(json['error_description']);
    throw new Error(`xAI token refresh failed: ${desc ? `${err}: ${desc}` : err}`);
  }
  // Invariant: prefer the NEW refresh_token from the response; if the IdP
  // omits it (unusual for xAI), fall back to the previous refresh token so
  // we still persist a usable bundle.
  const tokens = tokenResponseToBundle(json, deps.nowSeconds, refreshToken);
  if (!tokens) {
    throw new Error('xAI refresh response missing access_token');
  }
  if (deps.persist !== false) {
    writeXaiTokens(tokens, deps.store ?? {});
  }
  return tokens;
}

/**
 * Return a usable access token: refresh if within skew of expiry.
 * Returns null when no stored tokens or refresh fails.
 *
 * Concurrent callers share one in-flight refresh (rotating refresh_token).
 */
export async function ensureFreshAccessToken(
  deps: OAuthHttpDeps & { store?: XaiAuthStoreDeps; skewSeconds?: number } = {},
): Promise<XaiTokenBundle | null> {
  const store = deps.store ?? {};
  const bundle = readXaiTokens(store);
  if (!bundle) return null;
  const now = (deps.nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  const skew = deps.skewSeconds ?? XAI_REFRESH_SKEW_SECONDS;
  if (bundle.expires_at - skew > now) {
    return bundle;
  }

  const pathKey = storePathKey(store);

  // Single-flight per store path: join an in-progress refresh instead of racing.
  const existing = refreshInFlightByPath.get(pathKey);
  if (existing) {
    try {
      return await existing;
    } catch {
      // Winner failed; re-read store (may have been cleared).
      return readXaiTokens(store);
    }
  }

  const flight = (async () => {
    try {
      return await refreshXaiTokens(bundle.refresh_token, { ...deps, store, persist: true });
    } catch (err) {
      if (bundle.expires_at <= now) {
        clearXaiTokens(store);
      }
      throw err;
    } finally {
      refreshInFlightByPath.delete(pathKey);
    }
  })();
  refreshInFlightByPath.set(pathKey, flight);

  try {
    return await flight;
  } catch {
    // Refresh failed. If the access token is still within hard expiry, return
    // it so a transient failure does not abort a live session.
    if (bundle.expires_at > now) return bundle;
    return null;
  }
}
