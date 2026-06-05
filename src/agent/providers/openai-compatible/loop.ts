/**
 * Pure helpers for the tool-call iteration loop.
 *
 * The actual loop lives in `query.ts` because it needs to mutate
 * per-query state (priorTurns, abort controller, etc.). What lives here is
 * the wire-format translation between AFK's tool surface and OpenAI's:
 *
 *   - `toolDefsToOpenAIFunctions`: AnthropicToolDef[] → OpenAI `tools[]`
 *   - `accumulatedToolCallsToToolCalls`: translate.ts output → harness ToolCall[]
 *   - `toolResultsToMessages`: ToolResult[] → OpenAI `role: 'tool'` messages
 *   - `assistantMessageWithToolCalls`: build the assistant turn that wraps
 *     the tool_calls for the OpenAI request history.
 *
 * Per the audit (see docs/specs/provider-agnostic-wire-seam.md superseded
 * by the sibling-provider approach): `input_schema` → `parameters` is a
 * mechanical rename — same JSON Schema underneath.
 *
 * @module agent/providers/openai-compatible/loop
 */

import type { AnthropicToolDef } from '../anthropic-direct/types.js';
import type { ToolCall, ToolResult } from '../anthropic-direct/types.js';
import type { AccumulatedToolCall } from './translate.js';

/**
 * OpenAI function-tool shape. We keep this structurally typed (not pulled
 * from the SDK) so tests don't need to import OpenAI just to assert shape.
 */
export interface OpenAIFunctionTool {
  type: 'function';
  function: {
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
  };
}

/** Translate AFK's tool catalog into OpenAI's `tools[]` request field. */
export function toolDefsToOpenAIFunctions(defs: readonly AnthropicToolDef[]): OpenAIFunctionTool[] {
  return defs.map((def) => {
    const fn: OpenAIFunctionTool['function'] = {
      name: def.name,
      parameters: def.input_schema as Record<string, unknown>,
    };
    if (def.description !== undefined) fn.description = def.description;
    return { type: 'function', function: fn };
  });
}

/**
 * Translate accumulated stream-side tool calls into harness `ToolCall`s
 * the dispatcher consumes. JSON.parse failures are surfaced as a synthetic
 * error result rather than silently treated as `{}` — a malformed argument
 * payload from the model almost always means a real problem that should
 * land in the model's next-turn input verbatim.
 */
export function accumulatedToolCallsToToolCalls(
  calls: readonly AccumulatedToolCall[],
  signal: AbortSignal,
): { calls: ToolCall[]; parseErrors: Map<string, string> } {
  const parsed: ToolCall[] = [];
  const parseErrors = new Map<string, string>();
  for (const c of calls) {
    let input: unknown = {};
    if (c.argumentsRaw.length > 0) {
      try {
        input = JSON.parse(c.argumentsRaw);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        parseErrors.set(c.id, `Failed to parse tool arguments as JSON: ${msg}`);
        input = {};
      }
    }
    parsed.push({ id: c.id, name: c.name, input, signal });
  }
  return { calls: parsed, parseErrors };
}

/**
 * Build the OpenAI assistant message that records the model's tool calls.
 * This must be appended to the running history *before* the tool-result
 * messages so the next request has the correct alternating shape:
 *   ...prior..., assistant{ tool_calls: [...] }, tool{ tool_call_id: X, content }, tool{ tool_call_id: Y, content }, ...
 *
 * `content` is null on tool-only turns (OpenAI's convention) but we
 * accept any leftover text as content because some models emit a short
 * preamble alongside tool calls.
 */
export interface OpenAIAssistantToolCallMessage {
  role: 'assistant';
  content: string | null;
  tool_calls: Array<{
    id: string;
    type: 'function';
    function: { name: string; arguments: string };
  }>;
  /** See `OpenAIMessage.reasoning_content` for the protocol detail. */
  reasoning_content?: string;
}

/**
 * Build the assistant turn that wraps the model's tool_calls for the next
 * request's history.
 *
 * `reasoningText` is the accumulated `delta.reasoning` / `reasoning_content`
 * trace captured during the iteration (from `translate.ts:StreamState`). It's
 * echoed back on the assistant message because DeepSeek-R1 (and other
 * thinking-mode OpenAI-compatible providers like some Qwen variants on
 * OpenRouter) require it — calling their API without echoing the reasoning
 * trace from a thinking-mode response yields a 400 ("The `reasoning_content`
 * in the thinking mode must be passed back to the API"). Real OpenAI's
 * o-series doesn't expose its reasoning trace, so this field stays empty
 * for those calls and is omitted from the request body, leaving the wire
 * format unchanged for non-thinking providers.
 */
export function assistantMessageWithToolCalls(
  accumulatedText: string,
  toolCalls: readonly AccumulatedToolCall[],
  reasoningText: string = '',
): OpenAIAssistantToolCallMessage {
  const msg: OpenAIAssistantToolCallMessage = {
    role: 'assistant',
    content: accumulatedText.length > 0 ? accumulatedText : null,
    tool_calls: toolCalls.map((c) => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: c.argumentsRaw },
    })),
  };
  if (reasoningText.length > 0) {
    msg.reasoning_content = reasoningText;
  }
  return msg;
}

/**
 * Build OpenAI `role: 'tool'` messages from dispatcher results. Order is
 * preserved 1:1 with the input array (caller's responsibility to keep
 * positions aligned with the assistant's `tool_calls`).
 */
export interface OpenAIToolResultMessage {
  role: 'tool';
  tool_call_id: string;
  content: string;
}

export function toolResultsToMessages(
  results: readonly { call: ToolCall; result: ToolResult }[],
): OpenAIToolResultMessage[] {
  return results.map(({ call, result }) => ({
    role: 'tool',
    tool_call_id: call.id,
    // OpenAI tolerates an `is_error` field on tool messages on some
    // versions, but the canonical contract is "content carries the error
    // text and the model decides." Mirror that — embed a clear prefix when
    // isError so the model can spot failures in its context.
    content: result.isError ? `[error] ${result.content}` : result.content,
  }));
}

/** Render a short human-friendly summary of a batch of tool calls. */
export function summarizeToolCalls(calls: readonly AccumulatedToolCall[]): string {
  if (calls.length === 0) return '';
  if (calls.length === 1) return `called ${calls[0]!.name}`;
  return `called ${calls.length} tools: ${calls.map((c) => c.name).join(', ')}`;
}
