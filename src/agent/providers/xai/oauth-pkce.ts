/**
 * Browser PKCE loopback flow for SuperGrok / SuperGrok Heavy / X Premium+.
 * Secondary to device-code; used for interactive login.
 *
 * @module agent/providers/xai/oauth-pkce
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  XAI_OAUTH_AUTHORIZE_PLAN,
  XAI_OAUTH_AUTHORIZE_REFERRER,
  XAI_OAUTH_CLIENT_ID,
  XAI_OAUTH_REDIRECT_URI,
  XAI_OAUTH_SCOPES,
} from './oauth-constants.js';
import type { XaiTokenBundle } from './auth-store.js';
import {
  asNonEmptyString,
  tokenResponseToBundle,
  type OAuthHttpDeps,
  type XaiOidcDiscovery,
} from './oauth-http.js';

export interface PkceAuthorizeParams {
  /** Full authorize URL (includes plan=generic + referrer + PKCE). */
  authorizationUrl: string;
  codeVerifier: string;
  state: string;
  redirectUri: string;
}

/** Generate a PKCE code_verifier (43–128 chars, unreserved). */
export function generateCodeVerifier(): string {
  return base64Url(randomBytes(32));
}

export function codeChallengeS256(verifier: string): string {
  return base64Url(createHash('sha256').update(verifier).digest());
}

export function generateOAuthState(): string {
  return base64Url(randomBytes(16));
}

/**
 * Build the authorize URL for browser PKCE.
 *
 * Contract: always includes `plan=generic` and a referrer query param — many
 * working clients require these or the consent screen rejects loopback.
 */
export function buildPkceAuthorizeUrl(
  discovery: XaiOidcDiscovery,
  opts: {
    codeVerifier: string;
    state: string;
    redirectUri?: string;
    clientId?: string;
    scopes?: string;
  },
): PkceAuthorizeParams {
  const redirectUri = opts.redirectUri ?? XAI_OAUTH_REDIRECT_URI;
  const clientId = opts.clientId ?? XAI_OAUTH_CLIENT_ID;
  const scopes = opts.scopes ?? XAI_OAUTH_SCOPES;
  const challenge = codeChallengeS256(opts.codeVerifier);
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('scope', scopes);
  url.searchParams.set('state', opts.state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  // Invariant: plan + referrer prevent loopback-client rejection on consent.
  url.searchParams.set('plan', XAI_OAUTH_AUTHORIZE_PLAN);
  url.searchParams.set('referrer', XAI_OAUTH_AUTHORIZE_REFERRER);
  return {
    authorizationUrl: url.toString(),
    codeVerifier: opts.codeVerifier,
    state: opts.state,
    redirectUri,
  };
}

/** Exchange an authorization code for tokens (PKCE). */
export async function exchangeAuthorizationCode(
  discovery: XaiOidcDiscovery,
  params: {
    code: string;
    codeVerifier: string;
    redirectUri?: string;
  },
  deps: OAuthHttpDeps = {},
): Promise<XaiTokenBundle> {
  const fetchFn = deps.fetchFn ?? fetch;
  const clientId = deps.clientId ?? XAI_OAUTH_CLIENT_ID;
  const redirectUri = params.redirectUri ?? XAI_OAUTH_REDIRECT_URI;
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code: params.code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: params.codeVerifier,
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
    throw new Error(`xAI authorization_code exchange failed: ${desc ? `${err}: ${desc}` : err}`);
  }
  const tokens = tokenResponseToBundle(json, deps.nowSeconds);
  if (!tokens) {
    throw new Error('xAI authorization_code response missing access_token or refresh_token');
  }
  return tokens;
}

function base64Url(buf: Buffer): string {
  return buf.toString('base64url');
}
