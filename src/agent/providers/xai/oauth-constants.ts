/**
 * Public xAI OAuth client constants shared by device-code and PKCE flows.
 *
 * Client ID is a public native/CLI client (PKCE, no secret) used by many open
 * Grok tools. Do not treat it as a confidential secret.
 *
 * @module agent/providers/xai/oauth-constants
 */

export const XAI_OAUTH_ISSUER = 'https://auth.x.ai';
export const XAI_OAUTH_CLIENT_ID = 'b1a00492-073a-47ea-816f-4c329264a828';

/**
 * Baseline scopes. Some CLI-proxy clients also request
 * `conversations:read conversations:write` — discovery / live check may extend
 * this at runtime via {@link XAI_OAUTH_SCOPES_EXTENDED}.
 */
export const XAI_OAUTH_SCOPES_BASE =
  'openid profile email offline_access grok-cli:access api:access';

/** Optional extended scopes used by some CLI-proxy clients. */
export const XAI_OAUTH_SCOPES_EXTENDED =
  `${XAI_OAUTH_SCOPES_BASE} conversations:read conversations:write`;

/** Default scopes for login (baseline; callers may pass extended). */
export const XAI_OAUTH_SCOPES = XAI_OAUTH_SCOPES_BASE;

/** Browser PKCE loopback (secondary interactive flow). */
export const XAI_OAUTH_LOOPBACK_PORT = 56121;
export const XAI_OAUTH_REDIRECT_URI = `http://127.0.0.1:${XAI_OAUTH_LOOPBACK_PORT}/callback`;

/**
 * Authorize-URL extras required by many working clients: without `plan=generic`
 * the consent screen can reject the loopback client.
 */
export const XAI_OAUTH_AUTHORIZE_PLAN = 'generic';
export const XAI_OAUTH_AUTHORIZE_REFERRER = 'https://grok.com';

/** Access-token refresh skew (seconds). Refresh this early before exp. */
export const XAI_REFRESH_SKEW_SECONDS = 3 * 60;
