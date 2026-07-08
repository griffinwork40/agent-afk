/**
 * OpenAI client construction for the openai-compatible provider, plus the
 * test-injection factory hook. Extracted from `query.ts` so the query module
 * carries only the session class and its turn loop.
 *
 * @module agent/providers/openai-compatible/query/client
 */

import OpenAI from 'openai';

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
}) => OpenAI;

let clientFactory: OpenAIClientFactory | null = null;

export function __setOpenAIClientFactory(factory: OpenAIClientFactory | null): void {
  clientFactory = factory;
}

function defaultClientFactory(opts: {
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
}): OpenAI {
  const clientOpts: ConstructorParameters<typeof OpenAI>[0] = { apiKey: opts.apiKey };
  if (opts.baseURL !== undefined) clientOpts.baseURL = opts.baseURL;
  if (opts.defaultHeaders !== undefined) clientOpts.defaultHeaders = opts.defaultHeaders;
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
