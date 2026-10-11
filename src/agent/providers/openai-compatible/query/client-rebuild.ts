/**
 * Client-rebuild helper for the openai-compatible provider's mid-session
 * ChatGPT-OAuth token refresh (issue #3396).
 *
 * Extracted from `query.ts` so that module stays under the 350-code-line
 * ceiling. The class method `OpenAICompatibleQuery.rebuildClient` delegates
 * entirely to this function.
 *
 * @module agent/providers/openai-compatible/query/client-rebuild
 */

import OpenAI from 'openai';
import { resolveWireMode, envFlagEnabled } from '../responses-config.js';
import { resolveClientFactory, buildOpenAIAdmissionFetch } from './client.js';
import { h1ModelFetch } from '../../shared/h1-fetch.js';
import { env } from '../../../../config/env.js';
import type { OpenAIAuthResolution } from '../auth.js';
import type { OpenAICompatibleQueryOptions } from './query-options.js';

/**
 * Build a fresh OpenAI client from `newAuth` using the same wire-mode
 * resolution and endpoint configuration as the original constructor.
 *
 * Called by `OpenAICompatibleQuery.rebuildClient` when `wrapTurnWithOAuthRefresh`
 * detects a 401 and `codex` has written a fresh token to `~/.codex/auth.json`.
 * Re-runs `resolveWireMode` so the wire headers (chatgpt-account-id, beta
 * flags) are derived from the new auth bundle — the account-id embedded in
 * the JWT may differ across refreshes.
 *
 * AFK is read-only: this function NEVER writes `~/.codex/auth.json`.
 *
 * @param newAuth - The freshly resolved auth (caller verified it differs from the old one).
 * @param opts    - The query's immutable options bag (provides baseURL, headers, etc.).
 * @returns A new OpenAI client configured for `newAuth`, or null (typed as OpenAI)
 *   when `newAuth.apiKey === null` (caller should check before using the result).
 */
export function buildRefreshedClient(
  newAuth: OpenAIAuthResolution,
  opts: OpenAICompatibleQueryOptions,
): OpenAI {
  if (newAuth.apiKey === null) {
    // Caller (rebuildClient) must set _client = null; we return a sentinel.
    return null as unknown as OpenAI;
  }
  const responsesOptIn =
    (opts.useResponsesApi ?? false) || envFlagEnabled(env.AFK_OPENAI_USE_RESPONSES);
  const wire = resolveWireMode(newAuth, responsesOptIn);
  const ctor = resolveClientFactory();
  const clientOpts: {
    apiKey: string;
    baseURL?: string;
    defaultHeaders?: Record<string, string>;
    fetch?: typeof globalThis.fetch;
  } = { apiKey: newAuth.apiKey };
  const baseURL = wire.baseURL ?? opts.baseURL;
  if (baseURL !== undefined) clientOpts.baseURL = baseURL;
  if (wire.headers !== undefined) clientOpts.defaultHeaders = wire.headers;
  else if (opts.defaultHeaders !== undefined) clientOpts.defaultHeaders = opts.defaultHeaders;
  const admissionFetch = buildOpenAIAdmissionFetch(baseURL);
  clientOpts.fetch = admissionFetch ?? h1ModelFetch;
  return ctor(clientOpts);
}
