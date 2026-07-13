/**
 * Token resolution for {@link AnthropicDirectProvider.query}.
 *
 * Preserves the direct provider's credential precedence exactly:
 *
 * - local-server mode (`baseUrl` set): `config.apiKey` → `AFK_LOCAL_API_KEY` → `'local'`
 * - Anthropic mode: `config.apiKey` → `ANTHROPIC_API_KEY` → `CLAUDE_CODE_OAUTH_TOKEN` → `''`
 *
 * @module agent/providers/anthropic-direct/query/token-resolution
 */

import type { AgentConfig } from '../../../types/config-types.js';
import { env } from '../../../../config/env.js';

export interface ResolvedQueryToken {
  localMode: boolean;
  token: string;
}

/** Resolve the SDK token and local-server mode flag for a query call. */
export function resolveQueryToken(config: AgentConfig): ResolvedQueryToken {
  // Local-server mode (active when `config.baseUrl` is set) intentionally
  // does NOT fall back to `ANTHROPIC_API_KEY` / `CLAUDE_CODE_OAUTH_TOKEN`.
  // Sending real Anthropic credentials to a self-hosted shim is a footgun;
  // a placeholder `'local'` token keeps the SDK happy (it just needs *some*
  // string) without leaking real keys.
  const localMode = typeof config.baseUrl === 'string' && config.baseUrl.length > 0;
  const token = localMode
    ? (config.apiKey && config.apiKey.length > 0
        ? config.apiKey
        : (env.AFK_LOCAL_API_KEY || 'local'))
    : (config.apiKey && config.apiKey.length > 0
        ? config.apiKey
        : (env.ANTHROPIC_API_KEY || env.CLAUDE_CODE_OAUTH_TOKEN || ''));

  return { localMode, token };
}
