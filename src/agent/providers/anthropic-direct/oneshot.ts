/**
 * One-shot Anthropic Messages helper for lightweight, non-conversational
 * completions.
 *
 * Use this when you need a single short reply from a model and the full
 * `AgentSession` lifecycle (tool dispatcher, hooks, skill manifest, system
 * prompts, conversation history) would be massive overkill — e.g.
 * slug-generation from a user prompt, classification, short summarization.
 *
 * Convention: every `@anthropic-ai/sdk` import lives under
 * `src/agent/providers/anthropic-direct/`. Callers outside the providers
 * layer should import this helper, never the SDK directly.
 *
 * @module agent/providers/anthropic-direct/oneshot
 */

import Anthropic from '@anthropic-ai/sdk';
import { detectAuthMode, buildClientOptions, buildRequestHeaders } from './auth.js';
import { resolveModelId } from '../../session/model-resolution.js';
import { randomUUID } from 'node:crypto';

export interface OneShotInput {
  /** API key or OAuth token (`sk-ant-oat01-...`). Required. */
  token: string;
  /** Model id — accepts full ids (`claude-haiku-4-5-...`) or short aliases (`haiku`). */
  model: string;
  /** System prompt. Sent as a single text block. */
  system: string;
  /** User message content. Sent as a single text block. */
  user: string;
  /** Hard cap on output tokens. Default 64 — slug-sized. */
  maxTokens?: number;
  /** Caller-controlled cancellation. Aborts the in-flight request. */
  signal?: AbortSignal;
  /**
   * Test/factory hook. When set, supplants the real `Anthropic` constructor.
   * The factory must return a SDK-compatible client; only `messages.create`
   * is exercised.
   */
  clientFactory?: (opts: { authToken: string } | { apiKey: string }) => Anthropic;
}

/**
 * Single non-streaming `messages.create` call. Returns the concatenated text
 * of every text-shaped content block in the response, with leading/trailing
 * whitespace trimmed.
 *
 * Throws on SDK errors (auth failure, rate limit, network, abort). Callers
 * are expected to catch and fall back — this helper has no opinion about
 * retry policy.
 */
export async function oneShotCompletion(input: OneShotInput): Promise<string> {
  const { token, model, system, user, maxTokens = 64, signal, clientFactory } = input;

  if (!token) {
    throw new Error('oneShotCompletion: token required');
  }

  const mode = detectAuthMode(token);
  const clientOpts = buildClientOptions(token, mode);
  const client = clientFactory
    ? clientFactory(clientOpts)
    : new Anthropic(clientOpts);

  const sessionId = randomUUID();
  const requestId = randomUUID();
  const headers = buildRequestHeaders(mode, sessionId, requestId);

  // Invariant: the Anthropic Messages API rejects short aliases like `'haiku'`
  // with `404 model: haiku not_found_error` under OAuth tokens (verified
  // against `sk-ant-oat01-*` 2026-05-25). The SDK does not auto-expand them.
  // Resolve via the canonical `MODEL_MAP` here so callers can pass either
  // form — matches what `AgentSession` does for the streaming Messages call
  // and what the doc on `OneShotInput.model` promises.
  // `resolveModelId` returns the full id for known aliases and passes
  // anything else through unchanged; the `?? model` fallback covers the
  // (currently unreachable, but defensive) `undefined` return.
  const resolvedModel = resolveModelId(model) ?? model;

  // CONSTRAINT (sequencing): user content first, system as a top-level field
  // — the SDK's Messages API rejects `role: 'system'` in the messages array.
  const requestOptions: { headers?: Record<string, string>; signal?: AbortSignal } = {};
  if (Object.keys(headers).length > 0) requestOptions.headers = headers;
  if (signal) requestOptions.signal = signal;

  const response = await client.messages.create(
    {
      model: resolvedModel,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    },
    Object.keys(requestOptions).length > 0 ? requestOptions : undefined,
  );

  // Concatenate every text block; ignore tool_use / thinking blocks (we
  // requested neither, but be defensive against future API additions).
  const parts: string[] = [];
  for (const block of response.content) {
    if (block.type === 'text') parts.push(block.text);
  }
  const result = parts.join('').trim();
  if (result.length === 0) {
    // T21: warn when the model returns no usable text so callers can diagnose
    // silent failures without setting log level to debug.
    // eslint-disable-next-line no-console
    console.warn('oneShotCompletion: response contained no text blocks — returning empty string');
  }
  return result;
}
