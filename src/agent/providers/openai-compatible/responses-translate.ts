/**
 * Wire ↔ harness translation for the OpenAI **Responses API** streaming
 * surface (`client.responses.create({ stream: true })`).
 *
 * Sibling to `translate.ts` (Chat Completions). The Responses API does not
 * stream `choices[].delta` chunks — it streams typed semantic events
 * (`response.output_text.delta`, `response.function_call_arguments.delta`,
 * `response.completed`, …). This module maps that event stream onto the same
 * normalized `ProviderEvent`s the harness already consumes.
 *
 * Invariant: writes into the SAME `StreamState` shape that `translate.ts`
 * produces and mutates. That is the whole point of the sibling design — the
 * post-stream consumers (`usageFromState`, `finalizedToolCalls`,
 * `isToolCallStop` here; `assistantMessageWithToolCalls` / `toolResultsToMessages`
 * in `loop.ts`) are wire-agnostic and must keep working unchanged regardless
 * of whether a turn came from Chat Completions or Responses. Therefore we
 * normalize Responses `usage` (input_tokens/output_tokens) back into the
 * Chat-Completions-shaped `state.usage` (prompt_tokens/completion_tokens) so
 * `usageFromState` needs no Responses-specific branch.
 *
 * Tool calls are keyed by `output_index` (the Responses analogue of the Chat
 * Completions `tool_calls[].index`). The canonical id for linking a call to
 * its later `function_call_output` is `item.call_id`, learned from the
 * `response.output_item.added` event that precedes the argument deltas.
 *
 * @module agent/providers/openai-compatible/responses-translate
 */

import type { ProviderEvent } from '../../provider.js';
import type { StreamState } from './translate.js';
import { isOpenAIOverloadError } from './query/retry.js';

/**
 * Structural subset of the OpenAI Responses streaming event union we consume.
 * Kept SDK-free (mirroring `OpenAIChunk` in `translate.ts`) so tests feed
 * synthetic events without importing the OpenAI SDK. Fields are optional
 * because each concrete event type populates only the ones it owns.
 */
export interface ResponsesStreamEvent {
  /** Discriminator, e.g. `response.output_text.delta`. */
  type: string;
  /** Incremental text for *.delta events (text, reasoning, function args). */
  delta?: string;
  /** Which output item a delta belongs to (function-call accumulation key). */
  output_index?: number;
  /** The output item's own id (not the call_id). */
  item_id?: string;
  /** Complete argument string, carried by `response.function_call_arguments.done`. */
  arguments?: string;
  /** Function name, carried by `response.function_call_arguments.done`. */
  name?: string;
  /** Carried by `response.output_item.added` / `.done`. */
  item?: {
    type?: string;
    id?: string;
    call_id?: string;
    name?: string;
    arguments?: string;
  };
  /** Carried by `response.completed` / `.failed` / `.incomplete`. */
  response?: {
    status?: string;
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      total_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
    };
    incomplete_details?: { reason?: string };
    /** Carried by `response.failed`; contains the server's error code + message. */
    error?: { code?: string; message?: string } | null;
  };
  /**
   * Error code carried by the top-level `{type:'error'}` SSE event
   * (`ResponseErrorEvent`). The SDK yields this as a normal event (no `error`
   * key), so the openai iterator never throws for it — we must handle it here.
   */
  code?: string | null;
  /**
   * Error message carried by the top-level `{type:'error'}` SSE event.
   * Also used by `response.failed` when the response body carries a message.
   */
  message?: string;
}

/**
 * Translate a single Responses stream event into zero or more `ProviderEvent`s
 * and mutate the running `state`. Synchronous generator, exactly like
 * `translateChunk` — `query.ts` re-yields each event upstream.
 *
 * Emits `delta.text` / `delta.reasoning` live; tool calls accumulate silently
 * into `state.toolCallsByIndex` (the harness loop fires `tool.use.start` after
 * the turn completes, identical to the Chat Completions path).
 */
export function* translateResponsesEvent(
  event: ResponsesStreamEvent,
  state: StreamState,
  sessionId: string,
): Generator<ProviderEvent> {
  switch (event.type) {
    // ── Top-level SSE error event (`ResponseErrorEvent`) ───────────────────────
    // Shape: { type:'error', code:'server_is_overloaded', message, param, … }
    // The OpenAI SDK does NOT throw for this shape (it has no `error` key), so it
    // arrives here as a normal event. Throw an Error that `isOpenAIOverloadError`
    // recognises when the code/message indicate a transient overload; throw a
    // plain Error for all other codes so the stream error reaches the caller as a
    // fatal event (non-overload errors must still surface).
    case 'error': {
      const err = Object.assign(
        new Error(
          typeof event.message === 'string' && event.message.length > 0
            ? event.message
            : `Responses stream error${typeof event.code === 'string' ? `: ${event.code}` : ''}`,
        ),
        // Carry code so isOpenAIOverloadError's OVERLOAD_CODES check matches
        // 'server_is_overloaded' directly on the thrown error object.
        typeof event.code === 'string' ? { code: event.code } : {},
      );
      throw err;
    }

    case 'response.output_text.delta': {
      if (typeof event.delta === 'string' && event.delta.length > 0) {
        state.assistantText += event.delta;
        yield { type: 'delta.text', text: event.delta, sessionId };
      }
      return;
    }

    // Reasoning trace: o-series / gpt-5 over Responses surface both a raw
    // reasoning stream and a summarized one depending on the `reasoning`
    // request param. Treat both as reasoning deltas.
    case 'response.reasoning_text.delta':
    case 'response.reasoning_summary_text.delta': {
      if (typeof event.delta === 'string' && event.delta.length > 0) {
        state.reasoningText += event.delta;
        yield { type: 'delta.reasoning', text: event.delta, sessionId };
      }
      return;
    }

    // A new output item began. For function calls this carries the name +
    // call_id we need to seed the accumulator before argument deltas arrive.
    case 'response.output_item.added': {
      const item = event.item;
      if (item?.type === 'function_call' && typeof event.output_index === 'number') {
        const existing = state.toolCallsByIndex.get(event.output_index);
        // Preserve any args already accumulated from earlier delta events —
        // `item.arguments` on `added` is normally an empty string, and `??`
        // would NOT fall back on '' (only null/undefined), clobbering them.
        const accumulatedArgs = existing?.argumentsRaw ?? '';
        state.toolCallsByIndex.set(event.output_index, {
          index: event.output_index,
          id: item.call_id ?? existing?.id ?? '',
          name: item.name ?? existing?.name ?? '',
          argumentsRaw: accumulatedArgs.length > 0 ? accumulatedArgs : (item.arguments ?? ''),
          startEmitted: existing?.startEmitted ?? false,
        });
      }
      return;
    }

    // Streaming function-call argument fragments, keyed by output_index.
    case 'response.function_call_arguments.delta': {
      if (typeof event.output_index === 'number' && typeof event.delta === 'string') {
        const existing = state.toolCallsByIndex.get(event.output_index) ?? {
          index: event.output_index,
          id: '',
          name: '',
          argumentsRaw: '',
          startEmitted: false,
        };
        existing.argumentsRaw += event.delta;
        state.toolCallsByIndex.set(event.output_index, existing);
      }
      return;
    }

    // Terminal events for a function call. Each carries the COMPLETE argument
    // string. The ChatGPT Codex backend (chatgpt-oauth wire) can omit the
    // `.delta` stream entirely for parallel calls and deliver arguments only
    // here, so ignoring these left every call in the batch with `{}` input
    // ("file_path must be a string" storms). A non-empty `.done` value is
    // authoritative and replaces any delta accumulation.
    case 'response.function_call_arguments.done': {
      if (typeof event.output_index === 'number') {
        settleFunctionCall(state, event.output_index, { name: event.name, arguments: event.arguments });
      }
      return;
    }

    case 'response.output_item.done': {
      const item = event.item;
      if (item?.type === 'function_call' && typeof event.output_index === 'number') {
        settleFunctionCall(state, event.output_index, item);
      }
      return;
    }

    case 'response.completed': {
      applyResponsesUsage(state, event);
      // A turn that produced any function_call items is a tool-call stop;
      // otherwise a normal completion. `isToolCallStop` is also defensive on
      // toolCallsByIndex.size, so this is belt-and-suspenders.
      state.finishReason = state.toolCallsByIndex.size > 0 ? 'tool_calls' : 'stop';
      return;
    }

    case 'response.incomplete': {
      applyResponsesUsage(state, event);
      state.finishReason = event.response?.incomplete_details?.reason ?? 'incomplete';
      return;
    }

    case 'response.failed': {
      applyResponsesUsage(state, event);
      // If the failure carries an overload indicator, surface it as a thrown
      // overload error so the inline retry and overload-pause tier can react.
      // Construct a wrapper whose `.error` body carries the server's code +
      // message, matching the shape `isOpenAIOverloadError` checks on `.error`.
      // Non-overload `response.failed` reasons continue to set finishReason so
      // they surface as they did before this fix.
      const respErr = event.response?.error;
      if (respErr != null) {
        const candidate = Object.assign(new Error(respErr.message ?? 'response.failed'), {
          error: respErr,
        });
        if (isOpenAIOverloadError(candidate)) throw candidate;
      }
      state.finishReason = 'failed';
      return;
    }

    default:
      // Unhandled event types (audio, web_search, mcp, content_part framing,
      // text *.done duplicates, etc.) are intentionally ignored — they carry no
      // information the harness needs beyond what the deltas already conveyed.
      return;
  }
}

/**
 * Apply a terminal function-call payload (`*.done`) to the accumulator.
 * Contract: a non-empty `done.arguments` replaces the accumulated string (it
 * is the complete value); an empty/absent one leaves accumulation intact.
 * Missing id/name are seeded so a call whose `added` event was lost still
 * dispatches under the right tool.
 */
function settleFunctionCall(
  state: StreamState,
  index: number,
  done: { call_id?: string | undefined; name?: string | undefined; arguments?: string | undefined },
): void {
  const existing = state.toolCallsByIndex.get(index) ?? {
    index,
    id: '',
    name: '',
    argumentsRaw: '',
    startEmitted: false,
  };
  if (!existing.id && done.call_id) existing.id = done.call_id;
  if (!existing.name && done.name) existing.name = done.name;
  if (typeof done.arguments === 'string' && done.arguments.length > 0) {
    existing.argumentsRaw = done.arguments;
  }
  state.toolCallsByIndex.set(index, existing);
}

/**
 * Map Responses `usage` onto the Chat-Completions-shaped `state.usage` so the
 * shared `usageFromState` helper needs no Responses branch. No-op when the
 * event carries no usage block.
 */
function applyResponsesUsage(state: StreamState, event: ResponsesStreamEvent): void {
  const u = event.response?.usage;
  if (!u) return;
  const inputTokens = u.input_tokens ?? 0;
  const outputTokens = u.output_tokens ?? 0;
  state.usage = {
    prompt_tokens: inputTokens,
    completion_tokens: outputTokens,
    total_tokens: u.total_tokens ?? inputTokens + outputTokens,
    prompt_tokens_details: { cached_tokens: u.input_tokens_details?.cached_tokens ?? 0 },
  };
}
