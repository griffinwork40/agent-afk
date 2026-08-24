/**
 * Dual inference endpoint resolution for the xAI provider.
 *
 * Live evidence (2026): API-key traffic uses `https://api.x.ai/v1`; SuperGrok
 * / SuperGrok Heavy / X Premium+ OAuth often requires the CLI chat proxy
 * `https://cli-chat-proxy.grok.com/v1` (402/403 on api.x.ai for some accounts).
 * Modes therefore MUST NOT share a single hardcoded base URL.
 *
 * @module agent/providers/xai/endpoints
 */

import { env } from '../../../config/env.js';
import {
  isCliChatProxyBaseUrl,
  resolveGrokCliIdentityHeaders,
  type GrokCliHeaderDeps,
} from './headers.js';

/** Auth mode selects which default endpoint + header policy apply. */
export type XaiAuthMode = 'apikey' | 'oauth';

export const DEFAULT_XAI_API_BASE_URL = 'https://api.x.ai/v1';
export const DEFAULT_XAI_OAUTH_BASE_URL = 'https://cli-chat-proxy.grok.com/v1';

export interface XaiEndpointResolution {
  /** OpenAI-compatible base URL (no trailing slash required; SDK normalizes). */
  baseURL: string;
  /** Extra default headers for the OpenAI client (Bearer is separate via apiKey). */
  defaultHeaders: Record<string, string>;
  /** Which mode produced this resolution (for diagnostics). */
  mode: XaiAuthMode;
  /** True when CLI-proxy identity headers were attached. */
  proxyHeadersApplied: boolean;
}

export interface XaiEndpointDeps {
  /** Returns env value for key, or undefined. Defaults go through `env` (audit-env). */
  readEnv?: (key: string) => string | undefined;
  /** Internal compatibility/test seam for proxy identity headers. */
  clientVersion?: string;
  /**
   * Intentional xAI endpoint override (per-slot `baseUrl` only). Must NOT be
   * global `AFK_OPENAI_BASE_URL` — that hijacks Grok onto OpenAI shims.
   */
  baseUrlOverride?: string;
  /**
   * Injectable sources for Grok CLI header resolution (env override, version
   * file, home dir). Forwarded verbatim to `resolveGrokCliIdentityHeaders` so
   * endpoint-layer tests can control the full version-resolution chain without
   * touching real env vars or the filesystem.
   */
  headerDeps?: GrokCliHeaderDeps;
}

/** Default env reader — only xAI endpoint vars; uses the typed `env` object. */
function defaultReadEnv(key: string): string | undefined {
  if (key === 'AFK_XAI_BASE_URL') return env.AFK_XAI_BASE_URL;
  if (key === 'AFK_XAI_OAUTH_BASE_URL') return env.AFK_XAI_OAUTH_BASE_URL;
  return undefined;
}

/**
 * Resolve the inference base URL and optional CLI-proxy headers for a mode.
 *
 * Precedence:
 *   apikey → AFK_XAI_BASE_URL || DEFAULT_XAI_API_BASE_URL
 *   oauth  → AFK_XAI_OAUTH_BASE_URL || DEFAULT_XAI_OAUTH_BASE_URL
 *
 * Proxy identity headers attach when the resolved OAuth base URL targets the
 * CLI chat proxy host (or when the hostname matches).
 */
export function resolveXaiEndpoint(
  mode: XaiAuthMode,
  deps: XaiEndpointDeps = {},
): XaiEndpointResolution {
  const readEnv = deps.readEnv ?? defaultReadEnv;
  // Slot override wins over AFK_XAI_* env, which wins over mode defaults.
  // Global AFK_OPENAI_BASE_URL is intentionally never consulted here.
  const override = deps.baseUrlOverride?.trim();
  if (override) {
    const baseURL = stripTrailingSlash(override);
    const useProxyHeaders = isCliChatProxyBaseUrl(baseURL);
    return {
      baseURL,
      defaultHeaders: useProxyHeaders
        ? resolveGrokCliIdentityHeaders({ clientVersion: deps.clientVersion }, deps.headerDeps)
        : {},
      mode,
      proxyHeadersApplied: useProxyHeaders,
    };
  }

  if (mode === 'apikey') {
    const raw = readEnv('AFK_XAI_BASE_URL');
    const baseURL = (raw && raw.trim()) || DEFAULT_XAI_API_BASE_URL;
    return {
      baseURL: stripTrailingSlash(baseURL),
      defaultHeaders: {},
      mode,
      proxyHeadersApplied: false,
    };
  }

  const raw = readEnv('AFK_XAI_OAUTH_BASE_URL');
  const baseURL = stripTrailingSlash((raw && raw.trim()) || DEFAULT_XAI_OAUTH_BASE_URL);
  const useProxyHeaders = isCliChatProxyBaseUrl(baseURL);
  const defaultHeaders = useProxyHeaders
    ? resolveGrokCliIdentityHeaders({ clientVersion: deps.clientVersion }, deps.headerDeps)
    : {};
  return {
    baseURL,
    defaultHeaders,
    mode,
    proxyHeadersApplied: useProxyHeaders,
  };
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
