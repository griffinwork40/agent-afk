/**
 * Pure auth helpers for the `anthropic-direct` provider.
 *
 * Shape detection + config builders. No I/O, no SDK construction, no side
 * effects — every function is deterministic in its arguments. Recipe is
 * derived from the proven-working flow in `scripts/oauth-test.mjs` (Test #6).
 *
 * @module agent/providers/anthropic-direct/auth
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { AuthMode } from './types.js';

/**
 * `anthropic-beta` header value for OAuth mode.
 *
 * Includes `interleaved-thinking-2025-05-14` unconditionally — this matches
 * Claude Code CLI behaviour and is required for 4.x models to return visible
 * thinking blocks (without it the server sends thinking blocks containing only
 * a `signature_delta` with zero `thinking_delta` events).
 *
 * Includes `extended-cache-ttl-2025-04-11` to activate the 1-hour prompt-cache
 * TTL that `cache-policy.ts` already stamps (`TTL_DEFAULT = '1h'`). Without this
 * beta the server silently downgrades every `cache_control` breakpoint to the
 * default 5-minute TTL, so the longer-lived cache the policy intends never
 * takes effect.
 */
export const OAUTH_BETA_HEADER =
  'claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14,extended-cache-ttl-2025-04-11';

/**
 * Additional `anthropic-beta` entry that gates the `output_config.effort`
 * field.  Only appended to the header when the request body carries an
 * `output_config` with a non-null `effort` value — the server rejects the
 * field if the beta is absent.
 */
export const EFFORT_BETA_HEADER = 'effort-2025-11-24';

/** `User-Agent` value the cli sends; servers gate fast-mode features on this string. */
export const CLI_USER_AGENT = 'claude-cli/1.0.0 (external, cli)';

/**
 * Billing-header text block embedded into the system prompt for OAuth mode.
 * `cch=00000` is a placeholder — the server tolerates any value (only gates
 * fast-mode features).
 */
export const BILLING_HEADER_TEXT =
  'x-anthropic-billing-header: cc_version=1.0.0.test; cc_entrypoint=cli; cch=00000;';

/** Shape-sniff a token to pick the auth mode. */
export function detectAuthMode(token: string): AuthMode {
  return token.startsWith('sk-ant-oat01-') ? 'oauth' : 'api-key';
}

/** Build the constructor opts for `new Anthropic(...)`.
 *
 * `baseUrl`, when non-empty, is forwarded as the SDK's camelCase `baseURL`
 * option. Used by the local-server path (`AFK_LOCAL_BASE_URL`) to point
 * Messages traffic at a self-hosted Anthropic-compatible shim. The SDK
 * appends `/v1/messages` to whatever is passed.
 */
export function buildClientOptions(
  token: string,
  mode: AuthMode,
  baseUrl?: string,
): ({ authToken: string } | { apiKey: string }) & { baseURL?: string } {
  const base = mode === 'oauth'
    ? { authToken: token }
    : { apiKey: token };
  if (typeof baseUrl === 'string' && baseUrl.length > 0) {
    return { ...base, baseURL: baseUrl };
  }
  return base;
}

/**
 * Build per-request HTTP headers.
 *
 * OAuth adds the cli-mimicry headers (always includes the interleaved-thinking
 * beta so 4.x models return visible reasoning blocks).  API-key mode returns
 * an empty object.
 *
 * @param withEffort - When `true`, appends {@link EFFORT_BETA_HEADER} to the
 *   `anthropic-beta` value.  Pass this flag only when the request body carries
 *   `output_config.effort`; the server rejects the field when the beta is
 *   absent, and sending the beta unnecessarily is a no-op but needlessly
 *   broadens the negotiated feature set.
 */
export function buildRequestHeaders(
  mode: AuthMode,
  sessionId: string,
  requestId: string,
  withEffort?: boolean,
): Record<string, string> {
  if (mode !== 'oauth') {
    return {};
  }
  const betaHeader = withEffort
    ? `${OAUTH_BETA_HEADER},${EFFORT_BETA_HEADER}`
    : OAUTH_BETA_HEADER;
  return {
    'anthropic-beta': betaHeader,
    'x-app': 'cli',
    'User-Agent': CLI_USER_AGENT,
    'X-Claude-Code-Session-Id': sessionId,
    'x-client-request-id': requestId,
  };
}

/**
 * Build the system-prompt prefix. OAuth mode returns the billing-header block
 * array; api-key mode returns null (no prefix needed).
 */
export function buildSystemPrefix(mode: AuthMode): ContentBlockParam[] | null {
  if (mode !== 'oauth') {
    return null;
  }
  return [{ type: 'text', text: BILLING_HEADER_TEXT }];
}
