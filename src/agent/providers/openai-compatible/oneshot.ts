/**
 * One-shot Chat Completions helper for lightweight, non-conversational
 * completions on the OpenAI-compatible provider.
 *
 * Sibling of `anthropic-direct/oneshot.ts`. Use when you need a single short
 * reply from an OpenAI-compatible endpoint (real OpenAI, OpenRouter, or a
 * local MLX / llama.cpp / vLLM / ollama-openai shim) and the full
 * `OpenAICompatibleQuery` lifecycle (tool loop, history, hooks) would be
 * overkill — e.g. inline suggestions, classification, slug-generation.
 *
 * Convention: every `openai` SDK import lives under
 * `src/agent/providers/openai-compatible/`. Callers outside the providers
 * layer should reach this through `ModelProvider.complete()`, never import the
 * SDK directly.
 *
 * @module agent/providers/openai-compatible/oneshot
 */

import OpenAI from 'openai';
import { resolveOpenAIAuth } from './auth.js';
import { isReasoningModel } from '../../model-capabilities.js';

/** Test injection hook — supplants the real `OpenAI` constructor. */
export type OneShotOpenAIClientFactory = (opts: { apiKey: string; baseURL?: string }) => OpenAI;
let oneShotClientFactory: OneShotOpenAIClientFactory | null = null;

/**
 * Module-scope escape hatch used by tests; not part of the stable surface.
 * Pass `null` to restore the real `OpenAI` constructor.
 */
export function __setOpenAIOneShotClientFactory(factory: OneShotOpenAIClientFactory | null): void {
  oneShotClientFactory = factory;
}

export interface OpenAIOneShotInput {
  /**
   * Explicit API key. When omitted, resolved through {@link resolveOpenAIAuth}
   * (the standard `OPENAI_API_KEY` → `~/.codex/auth.json` precedence chain).
   * Local shims that ignore auth still need *some* string — pass any
   * placeholder or rely on the resolver returning one from env.
   */
  apiKey?: string;
  /** Endpoint override (local shim, OpenRouter, etc.). Defaults to OpenAI. */
  baseURL?: string;
  /** Model id, passed straight through to the API (no alias expansion). */
  model: string;
  /** System prompt. Sent as the first message with `role: 'system'`. */
  system: string;
  /** User message content. Sent with `role: 'user'`. */
  user: string;
  /** Hard cap on output tokens. Default 64 — suggestion-sized. */
  maxTokens?: number;
  /** Caller-controlled cancellation. Aborts the in-flight request. */
  signal?: AbortSignal;
  /**
   * Per-call factory override. Takes precedence over the module-scope test
   * hook. Lets callers inject a pre-built client without touching module state.
   */
  clientFactory?: OneShotOpenAIClientFactory;
}

/**
 * Single non-streaming `chat.completions.create` call. Returns the assistant
 * message text, trimmed.
 *
 * Throws on auth resolution failure or SDK errors (rate limit, network,
 * abort). Callers are expected to catch and fall back — this helper has no
 * opinion about retry policy.
 *
 * Token-limit field: chat models AND local OpenAI-shim runners (MLX,
 * llama.cpp, vLLM, ollama) accept `max_tokens` — and some shims reject the
 * newer `max_completion_tokens` — so `max_tokens` stays the default. The
 * reasoning models (o-series ∪ gpt-5.x) are the inverse: they reject
 * `max_tokens` with a 400 and require `max_completion_tokens`. We switch the
 * field only for those, keyed off the bare model id, so a reasoning-model
 * `AFK_SUGGEST_MODEL` override (or a reasoning session model inherited as the
 * suggest model) does not 400 on every keystroke.
 */
export async function oneShotChatCompletion(input: OpenAIOneShotInput): Promise<string> {
  const { apiKey, baseURL, model, system, user, maxTokens = 64, signal, clientFactory } = input;

  const auth = resolveOpenAIAuth(apiKey);
  if (auth.apiKey === null) {
    throw new Error('oneShotChatCompletion: no usable OpenAI auth (set OPENAI_API_KEY or pass apiKey)');
  }

  const clientOpts: { apiKey: string; baseURL?: string } = { apiKey: auth.apiKey };
  if (baseURL !== undefined) clientOpts.baseURL = baseURL;
  const factory = clientFactory ?? oneShotClientFactory;
  const client = factory ? factory(clientOpts) : new OpenAI(clientOpts);

  // Reasoning models (o-series ∪ gpt-5.x) reject `max_tokens` and require
  // `max_completion_tokens`; everything else (chat models + local shims) wants
  // `max_tokens`. Classification (incl. `provider/`-prefix strip) is shared —
  // see `isReasoningModel` in model-capabilities.ts.
  const tokenLimit = isReasoningModel(model)
    ? { max_completion_tokens: maxTokens }
    : { max_tokens: maxTokens };

  const response = await client.chat.completions.create(
    {
      model,
      ...tokenLimit,
      stream: false,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    },
    signal ? { signal } : undefined,
  );

  const content = response.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
}
