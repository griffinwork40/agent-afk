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
import { detectAuthMode, buildClientOptions, buildRequestHeaders, buildSystemPrefix } from './auth.js';
import { resolveModelId } from '../../session/model-resolution.js';
import { isHaiku55 } from './resolve-params.js';
import { randomUUID } from 'node:crypto';

/**
 * The stop reason reported by {@link oneShotCompletionWithStop} and the
 * corresponding OpenAI-compatible variant. Defined here (closest to the
 * Anthropic implementation) and re-exported from the shared router so
 * callers import from one place without an import cycle.
 *
 * - `'max_tokens'`  — the model was cut off by the token limit.
 * - `'end'`         — the model finished naturally (end_turn / stop_sequence / stop).
 * - `'other'`       — any other stop reason (e.g. content_filter).
 */
export type OneShotStopReason = 'max_tokens' | 'end' | 'other';

export interface OneShotInput {
  /** API key or OAuth token (`sk-ant-oat01-...`). Required. */
  token: string;
  /** Model id — accepts full ids (`claude-haiku-5-5`) or short aliases (`haiku`). */
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
   * Optional base URL override. When set, the Anthropic client is constructed
   * with this endpoint instead of api.anthropic.com — used for local
   * Anthropic-compatible servers or cross-provider compaction targets that
   * supply a custom binding.baseUrl.
   */
  baseUrl?: string;
  /**
   * Test/factory hook. When set, supplants the real `Anthropic` constructor.
   * The factory must return a SDK-compatible client; only `messages.create`
   * is exercised.
   */
  clientFactory?: (opts: { authToken: string } | { apiKey: string }) => Anthropic;
}

/**
 * Single non-streaming `messages.create` call. Returns the concatenated text
 * of every text-shaped content block in the response paired with the mapped
 * {@link OneShotStopReason}:
 *   - `'max_tokens'` when `stop_reason === 'max_tokens'`
 *   - `'end'`        when `stop_reason === 'end_turn' | 'stop_sequence'`
 *   - `'other'`      for any other stop reason
 *
 * Throws on SDK errors (auth failure, rate limit, network, abort). Callers
 * are expected to catch and fall back — this helper has no opinion about
 * retry policy.
 */
export async function oneShotCompletionWithStop(
  input: OneShotInput,
): Promise<{ text: string; stopReason: OneShotStopReason }> {
  const { token, model, system, user, maxTokens = 64, signal, baseUrl, clientFactory } = input;

  if (!token) {
    throw new Error('oneShotCompletion: token required');
  }

  const mode = detectAuthMode(token);
  const clientOpts = buildClientOptions(token, mode, baseUrl);
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

  // Invariant: OAuth (subscription) tokens must carry the same billing system
  // prefix the streaming path sends (query/client-setup.ts buildSystemPrefix);
  // without it the API answers 429 rate_limit_error for every non-haiku model,
  // which made one-shot callers silently haiku-only under OAuth.
  const prefix = buildSystemPrefix(mode);
  // buildSystemPrefix only ever returns text blocks; cast so the SDK's
  // system param (string | TextBlockParam[]) is satisfied without the dead
  // flatMap filter that would silently drop future non-text blocks.
  const systemParam = prefix
    ? ([...prefix, { type: 'text' as const, text: system }] as Anthropic.Messages.TextBlockParam[])
    : system;

  // Invariant: one-shot calls carry slug/classifier-sized budgets (default 64)
  // and read only text blocks. Claude Haiku 5.5 runs adaptive thinking when no
  // `thinking` field is sent, and thinking tokens count toward `max_tokens`,
  // so a small budget can stop at `max_tokens` after a thinking block with no
  // text at all. Haiku 5.5 accepts `{type:'disabled'}` at its default effort
  // (`medium`; only xhigh/max reject it, and this helper sends no effort), so
  // turn thinking off to keep the Haiku 4.5 contract every caller was built
  // on. Source: platform.claude.com/docs/en/build-with-claude/thinking
  // ("Turning thinking off", verified 2026-10-08).
  const thinkingParam = isHaiku55(resolvedModel) ? { thinking: { type: 'disabled' as const } } : {};

  const response = await client.messages.create(
    {
      model: resolvedModel,
      max_tokens: maxTokens,
      system: systemParam,
      messages: [{ role: 'user', content: user }],
      ...thinkingParam,
    },
    Object.keys(requestOptions).length > 0 ? requestOptions : undefined,
  );

  // Concatenate every text block; ignore tool_use / thinking blocks (we
  // requested neither, but be defensive against future API additions).
  const parts: string[] = [];
  for (const block of response.content) {
    if (block.type === 'text') parts.push(block.text);
  }
  const text = parts.join('').trim();
  if (text.length === 0) {
    // T21: warn when the model returns no usable text so callers can diagnose
    // silent failures without setting log level to debug.
    // eslint-disable-next-line no-console
    console.warn('oneShotCompletion: response contained no text blocks — returning empty string');
  }

  // Map the raw stop_reason to the canonical OneShotStopReason vocabulary.
  let stopReason: OneShotStopReason;
  if (response.stop_reason === 'max_tokens') {
    stopReason = 'max_tokens';
  } else if (response.stop_reason === 'end_turn' || response.stop_reason === 'stop_sequence') {
    stopReason = 'end';
  } else {
    stopReason = 'other';
  }

  return { text, stopReason };
}

/**
 * Thin wrapper around {@link oneShotCompletionWithStop} that discards the
 * stop reason and returns only the reply text — preserving the original
 * surface for the ~9 direct callers that do not need stop-reason visibility.
 *
 * Throws on SDK errors (auth failure, rate limit, network, abort). Callers
 * are expected to catch and fall back — this helper has no opinion about
 * retry policy.
 */
export async function oneShotCompletion(input: OneShotInput): Promise<string> {
  const { text } = await oneShotCompletionWithStop(input);
  return text;
}
