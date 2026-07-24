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
import type { OpenAIMessage } from './messages.js';
import { buildResponsesRequestBody } from './query/request-body.js';
import { createStreamState } from './translate.js';
import { translateResponsesEvent, type ResponsesStreamEvent } from './responses-translate.js';

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
  /**
   * Pre-built client to use verbatim. When provided, auth resolution and client
   * construction are skipped entirely — the caller's client (with its own
   * baseURL, headers, and credentials) is used as-is. This lets a live session
   * reuse `this.client` for an in-session one-shot (e.g. history compaction)
   * so the summarize call lands on the SAME custom endpoint / ChatGPT backend
   * as the conversation, without re-resolving auth. Takes precedence over
   * `apiKey` / `baseURL` / `clientFactory`.
   */
  client?: OpenAI;
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

  // A caller-supplied client (a live session reusing `this.client`) is used
  // verbatim — no auth resolution, no reconstruction — so the call inherits the
  // session's endpoint, headers, and credentials.
  let client: OpenAI;
  if (input.client !== undefined) {
    client = input.client;
  } else {
    const auth = resolveOpenAIAuth(apiKey);
    if (auth.apiKey === null) {
      throw new Error('oneShotChatCompletion: no usable OpenAI auth (set OPENAI_API_KEY or pass apiKey)');
    }
    const clientOpts: { apiKey: string; baseURL?: string } = { apiKey: auth.apiKey };
    if (baseURL !== undefined) clientOpts.baseURL = baseURL;
    const factory = clientFactory ?? oneShotClientFactory;
    client = factory ? factory(clientOpts) : new OpenAI(clientOpts);
  }

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

export interface OpenAIResponsesOneShotInput {
  /**
   * Pre-built client, used verbatim (its baseURL, credentials, ChatGPT-OAuth
   * headers, and account-id). REQUIRED — unlike {@link oneShotChatCompletion}
   * there is no auth-resolution fallback: a Responses-wire summarize is only
   * meaningful reusing a live session's client, which is where the Responses
   * wire (and the private ChatGPT/Codex backend) is configured.
   */
  client: OpenAI;
  /** Model id, passed straight through to the API (no alias expansion). */
  model: string;
  /** System prompt. Becomes the Responses `instructions` field. */
  system: string;
  /** User message content. Becomes the single Responses `input` item. */
  user: string;
  /**
   * True on the private ChatGPT/Codex subscription backend. Scopes the
   * request-body quirks that {@link buildResponsesRequestBody} applies: omit
   * every output-cap param (the backend 400s on them), force `store: false`,
   * and require a non-empty `instructions`. Mirror the caller's own
   * `auth.source === 'chatgpt-oauth'` check.
   */
  isChatGptBackend: boolean;
  /**
   * Soft output cap, applied ONLY on the public API-key path. Default 1024 —
   * summary-sized. Omitted entirely when `isChatGptBackend` (that backend
   * rejects `max_output_tokens`).
   */
  maxTokens?: number;
  /** Caller-controlled cancellation. Aborts the in-flight request. */
  signal?: AbortSignal;
}

/**
 * Single one-shot summarization over the OpenAI **Responses** wire. The
 * Responses-wire sibling of {@link oneShotChatCompletion}; it exists so history
 * compaction works on responses-mode sessions (ChatGPT-OAuth and the
 * `AFK_OPENAI_USE_RESPONSES` opt-in), where `chat.completions.create` is
 * rejected by the backend — issue #653.
 *
 * Design:
 *   - Reuses {@link buildResponsesRequestBody} (so every ChatGPT-backend quirk
 *     stays in one place) and {@link translateResponsesEvent} (the single
 *     source of truth for which stream event carries assistant text), so the
 *     summarize path can never drift from the turn path.
 *   - Streams (`stream: true`, set by the body builder) rather than issuing a
 *     non-streaming call. Deliberate: the ChatGPT/Codex backend is only ever
 *     streamed to, so a throwaway summarize rides the one proven wire.
 *   - Drains the stream in ISOLATION — its own {@link createStreamState}, the
 *     yielded `ProviderEvent`s discarded — so it never touches session state
 *     (`lastUsage`, `priorTurns`), emits no trace, and dispatches no tools.
 *   - Has no retry opinion (like `oneShotChatCompletion`): it throws on SDK
 *     error, and the compaction core treats that as a safe no-op (history
 *     untouched).
 *
 * Returns the accumulated assistant text, trimmed.
 */
export async function oneShotResponses(input: OpenAIResponsesOneShotInput): Promise<string> {
  const { client, model, system, user, isChatGptBackend, maxTokens = 1024, signal } = input;

  const messages: OpenAIMessage[] = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
  const requestBody = buildResponsesRequestBody({
    model,
    messages,
    // A summarize advertises no tools — with none, the model must answer in text.
    activeTools: undefined,
    // Public path: bound the summary length. On the ChatGPT backend the builder
    // omits the cap entirely (it 400s there), so this value is simply ignored.
    maxOutputTokens: maxTokens,
    // No reasoning on a summarize — cheaper/faster, and a compaction summary
    // needs none. resolveReasoningEffort(undefined, ...) yields no reasoning key.
    effort: undefined,
    isChatGptBackend,
  });

  const stream = (await client.responses.create(
    requestBody as never,
    signal ? { signal } : undefined,
  )) as unknown as AsyncIterable<ResponsesStreamEvent>;

  // Drain into a private StreamState. `translateResponsesEvent` mutates only the
  // state we pass (accumulating `response.output_text.delta` into
  // `assistantText`); the ProviderEvents it yields have no consumer here, so we
  // exhaust the generator purely for its state mutation.
  const state = createStreamState();
  for await (const event of stream) {
    const events = translateResponsesEvent(event, state, 'compact-oneshot');
    while (!events.next().done) {
      // Discard — assistant text is accumulated into `state`, not emitted.
    }
  }
  return state.assistantText.trim();
}
