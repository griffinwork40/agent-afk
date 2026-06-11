/**
 * Wire ↔ harness translation for the OpenAI-compatible provider.
 *
 * Two responsibilities:
 *
 *   1. **OpenAI streaming chunks → AFK `ProviderEvent`s.** Chat Completions
 *      streams `chat.completion.chunk` objects with `choices[0].delta` carrying
 *      incremental fields. We diff against per-stream state and emit `delta.text`
 *      / `delta.reasoning` events. Tool-call accumulation is handled here so
 *      `query.ts` only needs to consume the resulting normalized events.
 *
 *   2. **AFK harness message shapes → OpenAI request messages.** Specifically,
 *      converting harness conversation history (text-only strings today) plus
 *      the system prompt into `chat.completion.create` `messages[]`.
 *
 * What is *not* here:
 *   - Tool schema conversion (lives next to the dispatcher integration in `query.ts`)
 *   - Auth (lives in `auth.ts`)
 *   - Loop / turn orchestration (lives in `loop.ts`)
 *
 * @module agent/providers/openai-compatible/translate
 */

import type { ProviderEvent, ProviderUsage } from '../../provider.js';

/**
 * Minimal shape of a Chat Completions streaming chunk. We do not import the
 * OpenAI SDK type here — keeping this typed against a structural subset means
 * the translator can be unit-tested with synthetic chunks and doesn't pull
 * the SDK into test files.
 */
export interface OpenAIChunk {
  id?: string;
  model?: string;
  choices?: Array<{
    index?: number;
    delta?: {
      role?: string;
      content?: string | null;
      /** Some OpenAI-compatible providers expose reasoning trace as a top-level delta field. */
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: 'function';
        function?: { name?: string; arguments?: string };
      }>;
    };
    finish_reason?: string | null;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

/**
 * Per-stream accumulator. One instance per `chat.completions.create` call.
 *
 * Tracks:
 *   - assembled assistant text (so we can fire `assistant.message` on stream end)
 *   - whether any text was emitted at all (a tool-only turn fires `assistant.message`
 *     with empty text — consumer treats it as no-op per stream-consumer.ts:282)
 *   - per-index tool-call assembly (OpenAI streams tool_calls as partial deltas
 *     keyed by `index`; name + arguments arrive in pieces)
 *   - final `finish_reason` (drives stop-reason translation)
 *   - final `usage` block (sent on the last chunk when `stream_options.include_usage`
 *     is set)
 */
export interface StreamState {
  assistantText: string;
  reasoningText: string;
  toolCallsByIndex: Map<number, AccumulatedToolCall>;
  finishReason: string | null;
  usage: OpenAIChunk['usage'] | null;
  model: string | null;
  id: string | null;
}

export interface AccumulatedToolCall {
  index: number;
  id: string;
  name: string;
  argumentsRaw: string;
  /** Whether we have emitted `tool.use.start` for this tool call yet. */
  startEmitted: boolean;
}

export function createStreamState(): StreamState {
  return {
    assistantText: '',
    reasoningText: '',
    toolCallsByIndex: new Map(),
    finishReason: null,
    usage: null,
    model: null,
    id: null,
  };
}

/**
 * Translate a single OpenAI chunk into zero or more `ProviderEvent`s and
 * mutate the running `state`.
 *
 * Streaming text: each `delta.content` chunk is emitted directly as a
 * `delta.text` event — no diffing needed because Chat Completions sends
 * **deltas** (Codex's `agent_message` items send full snapshots; OpenAI
 * sends incremental fragments).
 *
 * Tool calls: accumulated silently into `state.toolCallsByIndex` until the
 * stream finishes. We do NOT emit `tool.use.start` mid-stream — the harness
 * loop fires it after the model turn completes, just like the Anthropic
 * provider does. The reason: OpenAI's tool_call deltas can arrive
 * interleaved with text, and the function name arrives in pieces; firing
 * `tool.use.start` mid-stream would mean firing with a partial name. We
 * defer until the stream-end view is consistent.
 *
 * `sessionId` is woven onto every event so downstream consumers can route
 * by session even when multiple sessions share a process.
 */
export function* translateChunk(
  chunk: OpenAIChunk,
  state: StreamState,
  sessionId: string,
): Generator<ProviderEvent> {
  if (chunk.id && !state.id) state.id = chunk.id;
  if (chunk.model && !state.model) state.model = chunk.model;
  if (chunk.usage) state.usage = chunk.usage;

  const choice = chunk.choices?.[0];
  if (!choice) return;

  if (choice.finish_reason) state.finishReason = choice.finish_reason;

  const delta = choice.delta;
  if (!delta) return;

  // Reasoning content (DeepSeek-R1 style and some o-series surfaces).
  const reasoningDelta = delta.reasoning_content ?? delta.reasoning;
  if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
    state.reasoningText += reasoningDelta;
    yield { type: 'delta.reasoning', text: reasoningDelta, sessionId };
  }

  // Visible assistant text.
  if (typeof delta.content === 'string' && delta.content.length > 0) {
    state.assistantText += delta.content;
    yield { type: 'delta.text', text: delta.content, sessionId };
  }

  // Tool-call accumulation. No events emitted here — see fn docstring.
  if (delta.tool_calls && delta.tool_calls.length > 0) {
    for (const tc of delta.tool_calls) {
      const existing = state.toolCallsByIndex.get(tc.index) ?? {
        index: tc.index,
        id: '',
        name: '',
        argumentsRaw: '',
        startEmitted: false,
      };
      if (tc.id) existing.id = tc.id;
      if (tc.function?.name) existing.name = tc.function.name;
      if (tc.function?.arguments) existing.argumentsRaw += tc.function.arguments;
      state.toolCallsByIndex.set(tc.index, existing);
    }
  }
}

/**
 * Build the `ProviderUsage` object the harness expects on `turn.completed`.
 *
 * Cost: not computed here — providers vary wildly in pricing and we have no
 * single source of truth. Callers can multiply by their own rate table.
 */
export function usageFromState(state: StreamState): ProviderUsage {
  const u = state.usage;
  if (!u) {
    return {
      stopReason: state.finishReason ?? null,
      resultSubtype: 'success',
      isError: false,
    };
  }
  const cachedInputTokens = u.prompt_tokens_details?.cached_tokens ?? 0;
  const inputTokens = u.prompt_tokens ?? 0;
  const outputTokens = u.completion_tokens ?? 0;
  return {
    inputTokens,
    outputTokens,
    cachedInputTokens,
    totalTokens: u.total_tokens ?? inputTokens + outputTokens,
    stopReason: state.finishReason ?? null,
    resultSubtype: 'success',
    isError: false,
    raw: { ...u },
  };
}

/**
 * Sorted view of accumulated tool calls, ready for dispatch. Empty when the
 * turn produced text only.
 */
export function finalizedToolCalls(state: StreamState): AccumulatedToolCall[] {
  return [...state.toolCallsByIndex.values()].sort((a, b) => a.index - b.index);
}

/**
 * Did the model finish because it wants to call tools? Mirrors Anthropic's
 * `stop_reason === 'tool_use'` check at `anthropic-direct/loop.ts:228`.
 *
 * Note: some providers (and the legacy completions endpoint) use
 * `function_call` instead of `tool_calls`. We accept both because this
 * provider may be pointed at non-OpenAI endpoints later (e.g. NVIDIA NIM).
 */
export function isToolCallStop(state: StreamState): boolean {
  if (state.finishReason === 'tool_calls' || state.finishReason === 'function_call') return true;
  // An explicit non-tool finish_reason ('stop', 'length', 'content_filter', …)
  // is authoritative: the model ended the turn for THAT reason, not to call a
  // tool. Some local MLX/llama.cpp shims wrongly send finish_reason:'stop'
  // while also streaming partial tool_calls; honoring the size>0 fallback there
  // dispatches a half-built (often empty-id) call, which poisons history with
  // an empty tool_call_id and gets the next request rejected with HTTP 400.
  if (state.finishReason !== null) return false;
  // Defensive fallback ONLY when the provider sent no finish_reason at all
  // (some OpenAI-compatible endpoints omit it): treat as a tool stop only if
  // every accumulated call is complete enough to round-trip — non-empty id AND
  // name. A partial or empty call is not a real tool stop.
  if (state.toolCallsByIndex.size === 0) return false;
  return [...state.toolCallsByIndex.values()].every(
    (c) => c.id.length > 0 && c.name.length > 0,
  );
}
