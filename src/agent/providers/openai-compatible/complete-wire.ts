/**
 * Wire selection for `OpenAICompatibleProvider.complete()`.
 *
 * Invariant: a ChatGPT-subscription OAuth credential (`auth.source ===
 * 'chatgpt-oauth'`) only works on the private ChatGPT backend over the
 * Responses wire. Sent over Chat Completions to `api.openai.com` it is billed
 * against the platform org and fails (429 "no credits", or 401). The live
 * session (`query.ts`, via {@link resolveWireMode}) and cross-provider
 * compaction (`shared/compact-summarizer.ts`) both route it correctly; this
 * module gives `complete()` (the side-channel used by ghost-text suggestions)
 * the same rule, sourced from the same `resolveWireMode` so the three paths
 * cannot drift.
 *
 * Contract: only the ChatGPT-OAuth case changes wire. The public
 * `AFK_OPENAI_USE_RESPONSES` opt-in is deliberately NOT honoured here: Chat
 * Completions works on every API-key endpoint (including local shims, several
 * of which lack a Responses route), so switching those one-shots would add
 * risk without fixing anything.
 *
 * @module agent/providers/openai-compatible/complete-wire
 */

import OpenAI from 'openai';
import { resolveOpenAIAuth, type AuthResolverDeps } from './auth.js';
import {
  oneShotChatCompletion,
  oneShotResponses,
  type OpenAIOneShotInput,
} from './oneshot.js';
import { resolveWireMode } from './responses-config.js';
import { h1ModelFetch } from '../shared/h1-fetch.js';

/** Re-exported so `index.ts` (at its line baseline) keeps a single import line. */
export type { OpenAIOneShotInput } from './oneshot.js';

/** Options for the Responses-wire client. Injectable for tests. */
export interface CompleteWireClientOptions {
  apiKey: string;
  baseURL?: string;
  defaultHeaders?: Record<string, string>;
  /** Always 0: a one-shot side-channel owns no retry policy (abort budget is tiny). */
  maxRetries: number;
  /** Invariant: always h1ModelFetch — force HTTP/1.1. See h1-fetch.ts. */
  fetch: typeof globalThis.fetch;
}

export type CompleteWireClientFactory = (opts: CompleteWireClientOptions) => OpenAI;

const defaultClientFactory: CompleteWireClientFactory = (opts) => new OpenAI(opts);

/**
 * Single-shot completion that picks the wire from the resolved credential.
 *
 * ChatGPT-OAuth -> Responses on the ChatGPT backend (base URL + account-id
 * headers from `resolveWireMode`, which win over any caller endpoint, as in
 * `query.ts`). Everything else -> the unchanged Chat Completions path, handed
 * the already-resolved key so auth is not resolved twice.
 *
 * @param authDeps - Injectable auth-resolver dependencies (env/fs). Used by
 *   tests to drive the Responses-wire path without real credentials.  Production
 *   callers omit this and get the real env + file-system resolvers.
 */
export async function completeWithWire(
  input: OpenAIOneShotInput,
  clientFactory: CompleteWireClientFactory = defaultClientFactory,
  authDeps: AuthResolverDeps = {},
): Promise<string> {
  const auth = resolveOpenAIAuth(input.apiKey, authDeps, input.forceChatgptOAuth ?? false);
  const wire = resolveWireMode(auth);

  if (wire.mode === 'responses' && auth.apiKey !== null) {
    const clientOpts: CompleteWireClientOptions = { apiKey: auth.apiKey, maxRetries: 0, fetch: h1ModelFetch };
    const baseURL = wire.baseURL ?? input.baseURL;
    if (baseURL !== undefined) clientOpts.baseURL = baseURL;
    const headers = { ...input.defaultHeaders, ...wire.headers };
    if (Object.keys(headers).length > 0) clientOpts.defaultHeaders = headers;
    return oneShotResponses({
      client: clientFactory(clientOpts),
      model: input.model,
      system: input.system,
      user: input.user,
      isChatGptBackend: auth.source === 'chatgpt-oauth',
      ...(input.maxTokens !== undefined ? { maxTokens: input.maxTokens } : {}),
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
  }

  // Chat Completions: unchanged behaviour. Forward the resolved key (when
  // there is one) so oneShotChatCompletion does not re-read ~/.codex/auth.json;
  // on a null key it keeps throwing its own "no usable OpenAI auth" error.
  return oneShotChatCompletion(
    auth.apiKey !== null ? { ...input, apiKey: auth.apiKey } : input,
  );
}
