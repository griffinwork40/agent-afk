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
 * Apply a ChatGPT-OAuth token refresh to a query instance: mutate opts.auth
 * and rebuild the backing OpenAI client in one atomic step.
 *
 * Extracted from `OpenAICompatibleQuery.rebuildClient` to keep query.ts under
 * the 350-code-line ceiling. Callers pass the mutable opts bag cast to allow
 * the `auth` write — TurnDriverContext declares `auth` readonly to prevent
 * accidental writes elsewhere; this is the one intentional exception.
 */
export function applyOAuthRefresh(
  mutableOpts: { auth: OpenAIAuthResolution } & OpenAICompatibleQueryOptions,
  newAuth: OpenAIAuthResolution,
): OpenAI {
  mutableOpts.auth = newAuth;
  return buildRefreshedClient(newAuth, mutableOpts);
}

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
  const wire = resolveWireMode(newAuth, responsesOptIn, opts.baseURL);
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
