/**
 * Provider-aware credential provenance (#4882).
 *
 * Contract: returns a stable, token-free id naming the credential that serves
 * `model`, chosen by the provider that actually serves it. A consumer (the Q
 * ledger) must be able to classify billing from the id alone:
 *
 *   Anthropic (unprefixed, unchanged since #4779):
 *     'ANTHROPIC_API_KEY'            metered API key
 *     'CLAUDE_CODE_OAUTH_TOKEN'      subscription login (env token)
 *     'claude-code-keychain'         subscription login (Claude Code store)
 *     'claude-code-session-refresh'  subscription login (refreshed this process)
 *     'anthropic:config'             metered (per-slot API key)
 *   OpenAI-compatible:
 *     'openai:env' | 'openai:config' | 'openai:codex-cli'  metered API key
 *     'openai:chatgpt-oauth'                             subscription login
 *   xAI:
 *     'xai:env' | 'xai:config'   metered API key
 *     'xai:oauth'                subscription login (SuperGrok)
 *   'local'  a custom / self-hosted endpoint (slot `baseUrl`,
 *            `AFK_LOCAL_BASE_URL`, `AFK_OPENAI_BASE_URL`): no cash cost.
 *
 * `undefined` when no usable credential resolves — never a guess. Ids only:
 * no token material, suffix or last4 ever leaves this module.
 *
 * @module agent/auth/credential-source
 */

import { providerForModel, type ProviderRouteHints } from '../providers/index.js';
import { resolveBinding } from '../session/model-slots.js';
import { resolveOpenAIAuth } from '../providers/openai-compatible/auth.js';
import { resolveXaiAuth } from '../providers/xai/auth.js';
import { resolveAnthropicCredential } from './credential-resolver.js';
import { env } from '../../config/env.js';

/** Fixed id for a custom or self-hosted endpoint (no cash cost). */
export const LOCAL_CREDENTIAL_SOURCE = 'local';

function nonEmpty(v: string | undefined): v is string {
  return typeof v === 'string' && v.trim().length > 0;
}

/** Options for {@link credentialSourceForModel}. */
export interface CredentialSourceOptions {
  /**
   * Bounded, quiet credential-store read (fork-time / per-dispatch callers):
   * the Claude Code store read times out instead of waiting on an OS unlock
   * dialog. See `loadClaudeCodeOauthToken` in keychain.ts.
   */
  background?: boolean;
}

/**
 * Resolve the credential source id for the provider serving `model`.
 * Mirrors the routing in `resolveCredentialForModel` + `applySlotCredentials`.
 */
export function credentialSourceForModel(
  model: string | undefined,
  hints?: ProviderRouteHints,
  opts?: CredentialSourceOptions,
): string | undefined {
  const binding = resolveBinding(model, hints?.slots);
  const provider = providerForModel(model, hints);
  if (provider === 'openai-compatible' || provider === 'openai-codex') {
    if (nonEmpty(binding.baseUrl)) return LOCAL_CREDENTIAL_SOURCE;
    const forceChatgpt = binding.provider === 'chatgpt-oauth';
    if (!forceChatgpt && nonEmpty(hints?.openaiBaseUrl ?? env.AFK_OPENAI_BASE_URL)) {
      return LOCAL_CREDENTIAL_SOURCE;
    }
    const auth = resolveOpenAIAuth(binding.apiKey, {}, forceChatgpt);
    return auth.apiKey !== null ? `openai:${auth.source}` : undefined;
  }
  if (provider === 'xai' || provider === 'xai-oauth') {
    if (nonEmpty(binding.baseUrl)) return LOCAL_CREDENTIAL_SOURCE;
    const force = binding.provider === 'xai-oauth' || provider === 'xai-oauth'
      ? 'oauth'
      : binding.provider === 'xai' ? 'apikey' : undefined;
    const auth = resolveXaiAuth(binding.apiKey, force);
    if (auth.apiKey === null) return undefined;
    return auth.source === 'xai-oauth' ? 'xai:oauth' : `xai:${auth.source}`;
  }
  // Anthropic-routed (anthropic-direct / anthropic).
  if (nonEmpty(binding.baseUrl) || nonEmpty(env.AFK_LOCAL_BASE_URL)) return LOCAL_CREDENTIAL_SOURCE;
  if (nonEmpty(binding.apiKey)) return 'anthropic:config';
  return resolveAnthropicCredential(
    opts?.background === true ? { background: true, quiet: true } : undefined,
  )?.source;
}

/**
 * Best-effort wrapper for observability call sites: never throws (trace
 * writers are fire-and-forget, INV-040).
 */
export function tryCredentialSourceForModel(
  model: string | undefined,
  hints?: ProviderRouteHints,
  opts?: CredentialSourceOptions,
): string | undefined {
  try {
    return credentialSourceForModel(model, hints, opts);
  } catch {
    return undefined;
  }
}
