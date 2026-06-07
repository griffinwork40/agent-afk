/**
 * Wire-mode resolution for the `openai-compatible` provider.
 *
 * Decides whether a request goes over Chat Completions (the default, unchanged
 * path) or the Responses API, and — for the ChatGPT-subscription path — supplies
 * the base URL override and the extra request headers.
 *
 * Two ways to land on Responses:
 *   1. ChatGPT-subscription OAuth (`auth.source === 'chatgpt-oauth'`): forced to
 *      Responses against the private ChatGPT backend, with the `chatgpt-account-id`
 *      + beta + originator headers. (Authorization: Bearer <access_token> is set
 *      by the OpenAI SDK from `apiKey`.)
 *   2. Public opt-in (`AFK_OPENAI_USE_RESPONSES` truthy, or a construction-time
 *      flag): Responses against the normal/configured base URL using an API key.
 *
 * @module agent/providers/openai-compatible/responses-config
 */

import type { OpenAIAuthResolution } from './auth.js';

/** Private ChatGPT backend that bills against a ChatGPT subscription. */
export const CHATGPT_BACKEND_BASE_URL = 'https://chatgpt.com/backend-api/codex';

/**
 * Fallback `instructions` for the ChatGPT backend, which rejects requests with
 * `{"detail":"Instructions are required"}` when the field is empty. Only used
 * when the session has no system prompt of its own (rare — AFK normally has
 * one). The public Responses API does not require this.
 */
export const DEFAULT_RESPONSES_INSTRUCTIONS = 'You are a helpful assistant.';

/** Env var that opts a normal API-key session into the Responses API. */
export const RESPONSES_OPT_IN_ENV = 'AFK_OPENAI_USE_RESPONSES';

export type WireMode = 'chat-completions' | 'responses';

export interface WireResolution {
  mode: WireMode;
  /** Overrides the client baseURL (subscription → ChatGPT backend). */
  baseURL?: string;
  /** Extra request headers (subscription → account id + beta + originator). */
  headers?: Record<string, string>;
}

/**
 * Parse a truthy env-flag string (`1`, `true`, `yes`, `on`; case-insensitive).
 * Pure — the caller is responsible for sourcing the raw value from the central
 * `env` module (this module never touches `process.env`, per the env-access
 * audit). Exported so the wire-mode caller can reuse the exact parse.
 */
export function envFlagEnabled(value: string | undefined): boolean {
  if (!value) return false;
  const n = value.trim().toLowerCase();
  return n === '1' || n === 'true' || n === 'yes' || n === 'on';
}

/** Headers required by the ChatGPT backend Responses endpoint. */
export function buildChatGptOAuthHeaders(accountId?: string): Record<string, string> {
  const headers: Record<string, string> = {
    'OpenAI-Beta': 'responses=experimental',
    originator: 'agent-afk',
  };
  if (accountId) headers['chatgpt-account-id'] = accountId;
  return headers;
}

/**
 * Resolve the wire mode for a session.
 *
 * @param auth - the resolved auth (its `source` + `accountId` drive subscription mode)
 * @param responsesOptIn - public Responses opt-in, pre-resolved by the caller
 *   from `env.AFK_OPENAI_USE_RESPONSES` (see {@link RESPONSES_OPT_IN_ENV}) and/or
 *   a construction-time flag.
 */
export function resolveWireMode(
  auth: Pick<OpenAIAuthResolution, 'source' | 'accountId'>,
  responsesOptIn = false,
): WireResolution {
  if (auth.source === 'chatgpt-oauth') {
    return {
      mode: 'responses',
      baseURL: CHATGPT_BACKEND_BASE_URL,
      headers: buildChatGptOAuthHeaders(auth.accountId),
    };
  }
  if (responsesOptIn) {
    return { mode: 'responses' };
  }
  return { mode: 'chat-completions' };
}
