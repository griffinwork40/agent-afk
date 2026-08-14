/**
 * Grok CLI identity headers for the SuperGrok CLI chat proxy path.
 *
 * When OAuth inference uses `https://cli-chat-proxy.grok.com/v1`, working open
 * clients send Grok-CLI identity headers in addition to `Authorization: Bearer`.
 * Exact values are encapsulated here so they stay one-file tunable if the
 * proxy tightens checks.
 *
 * Safety: never put access tokens into these headers.
 *
 * @module agent/providers/xai/headers
 */

/** Hostname of the subscription CLI chat proxy. */
export const CLI_CHAT_PROXY_HOST = 'cli-chat-proxy.grok.com';

export interface GrokCliHeaderOptions {
  /** agent-afk / Grok-CLI-compat version string. */
  clientVersion?: string;
  /** Client identifier the proxy expects. */
  clientIdentifier?: string;
}

/**
 * Return true when `baseURL` targets the CLI chat proxy (host match).
 * Operators who point `AFK_XAI_OAUTH_BASE_URL` at `api.x.ai` get bare Bearer.
 */
export function isCliChatProxyBaseUrl(baseURL: string): boolean {
  try {
    const host = new URL(baseURL).hostname.toLowerCase();
    return host === CLI_CHAT_PROXY_HOST || host.endsWith(`.${CLI_CHAT_PROXY_HOST}`);
  } catch {
    // Non-absolute override — treat as non-proxy so we do not invent headers.
    return baseURL.toLowerCase().includes(CLI_CHAT_PROXY_HOST);
  }
}

/**
 * Default identity headers for CLI-proxy requests.
 *
 * Values mirror widely used Grok-CLI-compatible clients. Adjust here only —
 * callers should not hardcode header names at use sites.
 */
export function resolveGrokCliIdentityHeaders(
  opts: GrokCliHeaderOptions = {},
): Record<string, string> {
  const version = opts.clientVersion?.trim() || 'agent-afk';
  const identifier = opts.clientIdentifier?.trim() || 'grok-shell';
  return {
    'X-XAI-Token-Auth': 'xai-grok-cli',
    'x-grok-client-version': version,
    'x-grok-client-identifier': identifier,
    'User-Agent': `agent-afk/${version} (grok-cli-compat)`,
  };
}
