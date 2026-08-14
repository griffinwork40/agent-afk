/**
 * RFC 8628 device-code flow for SuperGrok / SuperGrok Heavy / X Premium+.
 * Preferred for daemon / Telegram / SSH.
 *
 * @module agent/providers/xai/oauth-device
 */

import { XAI_OAUTH_CLIENT_ID, XAI_OAUTH_ISSUER, XAI_OAUTH_SCOPES } from './oauth-constants.js';
import type { XaiTokenBundle } from './auth-store.js';
import {
  asNonEmptyString,
  discoverXaiOidc,
  safeText,
  tokenResponseToBundle,
  type OAuthHttpDeps,
  type XaiOidcDiscovery,
} from './oauth-http.js';

export interface DeviceCodeStart {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete?: string;
  expires_in: number;
  interval: number;
}

export type DevicePollResult =
  | { status: 'pending' }
  | { status: 'slow_down'; interval: number }
  | { status: 'expired' }
  | { status: 'denied' }
  | { status: 'success'; tokens: XaiTokenBundle }
  | { status: 'error'; message: string };

/**
 * Normalize a server-supplied seconds value. Defends against NaN / ≤0 / non-finite
 * (OpenCode: setTimeout(NaN) busy-loops the token endpoint).
 */
export function positiveSeconds(value: unknown, defaultSeconds: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : defaultSeconds;
}

/**
 * Start a device-code flow. Caller prints user_code + verification_uri and
 * then polls via {@link pollDeviceCodeToken}.
 */
export async function startDeviceCodeFlow(deps: OAuthHttpDeps = {}): Promise<{
  discovery: XaiOidcDiscovery;
  device: DeviceCodeStart;
}> {
  const discovery = await discoverXaiOidc(deps);
  const deviceEndpoint =
    discovery.device_authorization_endpoint ??
    `${(deps.issuer ?? XAI_OAUTH_ISSUER).replace(/\/$/, '')}/oauth2/device/auth`;
  const fetchFn = deps.fetchFn ?? fetch;
  const clientId = deps.clientId ?? XAI_OAUTH_CLIENT_ID;
  const scopes = deps.scopes ?? XAI_OAUTH_SCOPES;

  const body = new URLSearchParams({
    client_id: clientId,
    scope: scopes,
  });
  const res = await fetchFn(deviceEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await safeText(res);
    throw new Error(`xAI device-code start failed: HTTP ${res.status}${text ? ` — ${text}` : ''}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  const device_code = asNonEmptyString(json['device_code']);
  const user_code = asNonEmptyString(json['user_code']);
  const verification_uri = asNonEmptyString(json['verification_uri']);
  if (!device_code || !user_code || !verification_uri) {
    throw new Error('xAI device-code response missing device_code, user_code, or verification_uri');
  }
  // Reject NaN / ≤0 (OpenCode footgun: setTimeout(NaN) busy-loops the token EP).
  const expires_in = positiveSeconds(json['expires_in'], 600);
  const interval = positiveSeconds(json['interval'], 5);
  const device: DeviceCodeStart = {
    device_code,
    user_code,
    verification_uri,
    expires_in,
    interval,
  };
  const complete = asNonEmptyString(json['verification_uri_complete']);
  if (complete) device.verification_uri_complete = complete;
  return { discovery, device };
}

/**
 * One poll of the token endpoint for a device-code grant.
 * Caller owns the sleep loop (daemon-friendly).
 */
export async function pollDeviceCodeToken(
  discovery: XaiOidcDiscovery,
  deviceCode: string,
  deps: OAuthHttpDeps = {},
): Promise<DevicePollResult> {
  const fetchFn = deps.fetchFn ?? fetch;
  const clientId = deps.clientId ?? XAI_OAUTH_CLIENT_ID;
  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    device_code: deviceCode,
    client_id: clientId,
  });
  const res = await fetchFn(discovery.token_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (res.ok) {
    const tokens = tokenResponseToBundle(json, deps.nowSeconds);
    if (!tokens) return { status: 'error', message: 'token response missing access_token or refresh_token' };
    return { status: 'success', tokens };
  }
  const err = asNonEmptyString(json['error']) ?? `http_${res.status}`;
  if (err === 'authorization_pending') return { status: 'pending' };
  if (err === 'slow_down') {
    // RFC 8628: bump by at least 5s; prefer server interval when sane.
    const interval = positiveSeconds(json['interval'], 5);
    return { status: 'slow_down', interval };
  }
  if (err === 'expired_token') return { status: 'expired' };
  if (err === 'access_denied') return { status: 'denied' };
  const desc = asNonEmptyString(json['error_description']);
  return { status: 'error', message: desc ? `${err}: ${desc}` : err };
}
