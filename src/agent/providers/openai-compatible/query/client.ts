/**
 * OpenAI client construction for the openai-compatible provider, plus the
 * test-injection factory hook and the rate-limit admission fetch builder.
 * Extracted from `query.ts` so the query module carries only the session class
 * and its turn loop.
 *
 * @module agent/providers/openai-compatible/query/client
 */

import OpenAI from 'openai';
import { globalRateLimitBucket } from '../../shared/rate-limit-bucket.js';
import { parseOpenAIRateLimitHeaders } from '../../shared/rate-limit-headers.js';
import { makeOpenAITracingFetch } from '../tracing-fetch.js';

/**
 * Test injection hook for the OpenAI client. Set to a factory to swap in a
 * mock client; pass `null` to restore the real constructor. Not part of the
 * stable surface — tests reach into this module (re-exported via `query.ts`)
 * directly.
 */
export type OpenAIClientFactory = (opts: {
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}) => OpenAI;

let clientFactory: OpenAIClientFactory | null = null;

export function __setOpenAIClientFactory(factory: OpenAIClientFactory | null): void {
  clientFactory = factory;
}

function defaultClientFactory(opts: {
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  fetch?: typeof globalThis.fetch;
}): OpenAI {
  const clientOpts: ConstructorParameters<typeof OpenAI>[0] = { apiKey: opts.apiKey };
  if (opts.baseURL !== undefined) clientOpts.baseURL = opts.baseURL;
  if (opts.defaultHeaders !== undefined) clientOpts.defaultHeaders = opts.defaultHeaders;
  if (opts.fetch !== undefined) clientOpts.fetch = opts.fetch;
  return new OpenAI(clientOpts);
}

/**
 * Return the active client factory: the test-injected one when set, else the
 * real `new OpenAI(...)` constructor. Encapsulates the mutable injection state
 * so callers never read the module global directly.
 */
export function resolveClientFactory(): OpenAIClientFactory {
  return clientFactory ?? defaultClientFactory;
}

/** Local-endpoint substrings that indicate a self-hosted shim (no rate limits). */
const LOCAL_PATTERNS = ['localhost', '127.', '0.0.0.0'];

/**
 * Build a rate-limit admission fetch wrapper for the OpenAI SDK.
 * Returns `undefined` for local-shim endpoints (no meaningful rate limits there).
 * See `rate-limit-bucket.ts` and `rate-limit-headers.ts` for the bucket details.
 */
export function buildOpenAIAdmissionFetch(baseURL: string | undefined): typeof fetch | undefined {
  const effective = baseURL ?? '';
  if (LOCAL_PATTERNS.some((p) => effective.includes(p))) return undefined;
  const rateLimitObserver = (headers: Headers): void => {
    const snapshot = parseOpenAIRateLimitHeaders(headers);
    if (snapshot !== undefined) globalRateLimitBucket.update(snapshot);
  };
  return makeOpenAITracingFetch(globalThis.fetch, undefined, rateLimitObserver, globalRateLimitBucket);
}
