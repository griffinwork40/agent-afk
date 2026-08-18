/**
 * Shared HTTP/OIDC helpers for xAI OAuth (discovery + token response parse).
 *
 * @module agent/providers/xai/oauth-http
 */

import { XAI_OAUTH_ISSUER, XAI_REFRESH_SKEW_SECONDS } from './oauth-constants.js';
import type { XaiTokenBundle } from './auth-store.js';

export type FetchFn = typeof fetch;

/** TTL for the in-memory OIDC discovery cache (24 hours in milliseconds). */
const OIDC_DISCOVERY_TTL_MS = 24 * 60 * 60 * 1000;

/** Cached OIDC discovery result; keyed implicitly to the single issuer per process. */
let cachedDiscovery: { result: XaiOidcDiscovery; expiresAt: number } | null = null;

export interface XaiOidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  device_authorization_endpoint?: string;
  userinfo_endpoint?: string;
}

export interface OAuthHttpDeps {
  fetchFn?: FetchFn;
  /** Override issuer for tests (defaults to auth.x.ai). */
  issuer?: string;
  clientId?: string;
  scopes?: string;
  nowSeconds?: () => number;
  /** Override wall-clock ms for cache TTL in tests. */
  nowMs?: () => number;
}

export function asNonEmptyString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

export async function safeText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 200);
  } catch {
    return '';
  }
}

/**
 * Reset the module-scope OIDC discovery cache. Intended for tests only.
 */
export function clearOidcCache(): void {
  cachedDiscovery = null;
}

/**
 * Fetch OIDC discovery document from `{issuer}/.well-known/openid-configuration`.
 */
export async function discoverXaiOidc(deps: OAuthHttpDeps = {}): Promise<XaiOidcDiscovery> {
  const fetchFn = deps.fetchFn ?? fetch;
  const issuer = (deps.issuer ?? XAI_OAUTH_ISSUER).replace(/\/$/, '');
  const url = `${issuer}/.well-known/openid-configuration`;
  const res = await fetchFn(url, { method: 'GET' });
  if (!res.ok) {
    throw new Error(`xAI OIDC discovery failed: HTTP ${res.status} from ${url}`);
  }
  const body = (await res.json()) as Record<string, unknown>;
  const authorization_endpoint = asNonEmptyString(body['authorization_endpoint']);
  const token_endpoint = asNonEmptyString(body['token_endpoint']);
  if (!authorization_endpoint || !token_endpoint) {
    throw new Error('xAI OIDC discovery missing authorization_endpoint or token_endpoint');
  }
  // RFC 8414 §3: token_endpoint and authorization_endpoint must share the issuer's origin.
  const resolvedIssuer = asNonEmptyString(body['issuer']) ?? issuer;
  const issuerOrigin = new URL(resolvedIssuer).origin;
  if (new URL(token_endpoint).origin !== issuerOrigin) {
    throw new Error('OIDC discovery: token_endpoint origin does not match issuer');
  }
  if (new URL(authorization_endpoint).origin !== issuerOrigin) {
    throw new Error('OIDC discovery: authorization_endpoint origin does not match issuer');
  }
  const out: XaiOidcDiscovery = {
    issuer: resolvedIssuer,
    authorization_endpoint,
    token_endpoint,
  };
  const device = asNonEmptyString(body['device_authorization_endpoint']);
  if (device) out.device_authorization_endpoint = device;
  const userinfo = asNonEmptyString(body['userinfo_endpoint']);
  if (userinfo) out.userinfo_endpoint = userinfo;
  return out;
}

/**
 * Cached wrapper around {@link discoverXaiOidc}.
 *
 * Returns the cached discovery document if it was fetched within the last 24 hours
 * (or `OIDC_DISCOVERY_TTL_MS` when `deps.nowMs` is injected for testing).
 * On cache miss or expiry, fetches fresh and stores the result.
 *
 * The cache is process-scoped: different issuer overrides in tests should call
 * {@link clearOidcCache} before each case to avoid cross-test contamination.
 */
export async function discoverXaiOidcCached(deps: OAuthHttpDeps = {}): Promise<XaiOidcDiscovery> {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const now = nowMs();
  if (cachedDiscovery && cachedDiscovery.expiresAt > now) {
    return cachedDiscovery.result;
  }
  const result = await discoverXaiOidc(deps);
  cachedDiscovery = { result, expiresAt: now + OIDC_DISCOVERY_TTL_MS };
  return result;
}

/**
 * Map a token-endpoint JSON body to {@link XaiTokenBundle}.
 * When `fallbackRefresh` is set and the response omits refresh_token, use it
 * (refresh grants that omit rotation — xAI usually rotates).
 */
export function tokenResponseToBundle(
  json: Record<string, unknown>,
  nowSeconds?: () => number,
  fallbackRefresh?: string,
): XaiTokenBundle | null {
  const access = asNonEmptyString(json['access_token']);
  if (!access) return null;
  const refresh = asNonEmptyString(json['refresh_token']) ?? fallbackRefresh;
  if (!refresh) return null;
  const now = (nowSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  const rawExpiresIn = typeof json['expires_in'] === 'number' ? json['expires_in'] : 3600;
  // Keep malformed/too-short lifetimes beyond the proactive refresh window.
  // Otherwise every access sees the freshly stored token as already stale and
  // a malformed refresh response can still cause a sequential refresh storm.
  const expiresIn = Math.min(Math.max(rawExpiresIn, XAI_REFRESH_SKEW_SECONDS + 60), 86400);
  const bundle: XaiTokenBundle = {
    access_token: access,
    refresh_token: refresh,
    expires_at: now + expiresIn,
  };
  if (typeof json['token_type'] === 'string') bundle.token_type = json['token_type'];
  if (typeof json['scope'] === 'string') bundle.scope = json['scope'];
  return bundle;
}
