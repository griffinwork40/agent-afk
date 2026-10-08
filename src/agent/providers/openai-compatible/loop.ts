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
import type { OpenAIContentPart, OpenAIMessage } from './messages.js';
import { errorMessage } from '../../../utils/errors.js';
import { tagResultFlags } from '../../journal/index.js';

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
 * Names of tools whose input schema declares at least one required field.
 * Feeds the empty-arguments guard in {@link accumulatedToolCallsToToolCalls}:
 * an empty argument stream is legitimate for a no-arg tool (some local
 * OpenAI shims send "" rather than "{}"), but for these tools it can only
 * mean the arguments were lost in transit.
 */
export function toolsRequiringArgs(defs: readonly AnthropicToolDef[]): Set<string> {
  const names = new Set<string>();
  for (const def of defs) {
    if ((def.input_schema.required?.length ?? 0) > 0) names.add(def.name);
  }
  return names;
}

/**
 * {@link toolsRequiringArgs} for a dispatcher's catalog. `toolDefs` is not on
 * the ToolDispatcher interface; query.ts reads it the same structural way.
 * Returns `undefined` (empty-args guard off) when the dispatcher has no defs.
 */
export function requiredArgToolsOf(dispatcher: unknown): Set<string> | undefined {
  const defs = (dispatcher as { toolDefs?: readonly AnthropicToolDef[] } | undefined)?.toolDefs;
  return Array.isArray(defs) ? toolsRequiringArgs(defs) : undefined;
}

/** Diagnostic for a tool call that needs arguments but received none. */
export function noArgumentsReceivedMessage(name: string): string {
  return (
    `No arguments received from the API for tool "${name}": the argument stream was empty. ` +
    'This is a provider/wire delivery failure, not malformed model output.'
  );
}

/**
 * Translate accumulated stream-side tool calls into harness `ToolCall`s
 * the dispatcher consumes. JSON.parse failures are surfaced as a synthetic
 * error result rather than silently treated as `{}` — a malformed argument
 * payload from the model almost always means a real problem that should
 * land in the model's next-turn input verbatim.
 *
 * Contract: when `requiredArgTools` contains a call's name and its
 * `argumentsRaw` is empty, a "no arguments received" diagnostic is recorded
 * in `parseErrors` so the failure reads as a delivery problem instead of the
 * tool's own "<field> must be a string" validation error. Omitting the set
 * disables the guard (prior behaviour).
 */
export function accumulatedToolCallsToToolCalls(
  calls: readonly AccumulatedToolCall[],
  signal: AbortSignal,
  requiredArgTools?: ReadonlySet<string>,
): { calls: ToolCall[]; parseErrors: Map<string, string> } {
  const parsed: ToolCall[] = [];
  const parseErrors = new Map<string, string>();
  for (const c of calls) {
    let input: unknown = {};
    if (c.argumentsRaw.length > 0) {
      try {
        input = JSON.parse(c.argumentsRaw);
      } catch (err) {
        const msg = errorMessage(err);
        parseErrors.set(c.id, `Failed to parse tool arguments as JSON: ${msg}`);
        input = {};
      }
    } else if (requiredArgTools?.has(c.name)) {
      parseErrors.set(c.id, noArgumentsReceivedMessage(c.name));
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
  /**
   * DeepSeek-R1 convention: echo reasoning under the same field it arrived in.
   * See `OpenAIMessage.reasoning_content` for the DeepSeek protocol detail.
   */
  reasoning_content?: string;
  /**
   * Cerebras convention: Cerebras streams reasoning as `delta.reasoning` and
   * rejects `reasoning_content` in history (HTTP 400). Echo under `reasoning`
   * when the stream delivered it via that field.
   */
  reasoning?: string;
}

/**
 * Build the assistant turn that wraps the model's tool_calls for the next
 * request's history.
 *
 * `reasoningText` is the accumulated reasoning trace from `translate.ts:StreamState`.
 * `reasoningField` controls which wire key it is echoed under — must match the
 * field the provider delivered it in:
 *   - `'reasoning_content'` (default): DeepSeek-R1 and compatible providers.
 *     Their API rejects subsequent requests with 400 unless echoed under this key.
 *   - `'reasoning'`: Cerebras and providers that stream `delta.reasoning`.
 *     Cerebras rejects `reasoning_content` with 400 ("property is unsupported").
 * Real OpenAI o-series doesn't expose its reasoning trace, so `reasoningText`
 * is empty and neither field is set, leaving the wire format unchanged.
 */
export function assistantMessageWithToolCalls(
  accumulatedText: string,
  toolCalls: readonly AccumulatedToolCall[],
  reasoningText: string = '',
  reasoningField: 'reasoning_content' | 'reasoning' = 'reasoning_content',
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
    msg[reasoningField] = reasoningText;
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
  // Invariant: an OpenAI Chat Completions `role:'tool'` message can only carry
  // a string `content` — never image parts. So `result.image` (set by e.g.
  // browser_screenshot) is NOT emitted here; the text summary (path/dimensions)
  // rides the tool message, and on vision-capable models the actual pixels ride
  // a separate follow-up `role:'user'` message built by
  // `toolImageFollowupMessage`. See query.ts:dispatchAndAppend.
  return results.map(({ call, result }) => {
    const msg: OpenAIToolResultMessage = {
      role: 'tool',
      tool_call_id: call.id,
      // OpenAI tolerates an `is_error` field on tool messages on some
      // versions, but the canonical contract is "content carries the error
      // text and the model decides." Mirror that — embed a clear prefix when
      // isError so the model can spot failures in its context.
      content: result.isError ? `[error] ${result.content}` : result.content,
    };
    // Partial-answer flags ride beside the message (never sent on the wire)
    // so the journal adapter can persist them (#2978).
    tagResultFlags(msg, result);
    return msg;
  });
}

/**
 * Build the follow-up `role:'user'` message that carries any tool-result images
 * for the NEXT model call (issue #127). OpenAI tool messages can't hold images
 * (see `toolResultsToMessages`), so an image-producing tool (e.g.
 * browser_screenshot) surfaces its pixels here instead — as `image_url` parts
 * prefixed by a short text label linking them to the originating tool call(s).
 *
 * Returns `undefined` when the model lacks vision (the text summary already
 * rode the tool message) or no result carried an image — so the caller appends
 * nothing in the common case. Must be pushed AFTER the `role:'tool'` messages
 * so the sequence stays assistant(tool_calls) → tool(result)… → user(images).
 */
export function toolImageFollowupMessage(
  results: readonly { call: ToolCall; result: ToolResult }[],
  opts: { vision: boolean },
): OpenAIMessage | undefined {
  if (!opts.vision) return undefined;
  const imageParts: OpenAIContentPart[] = [];
  const toolNames: string[] = [];
  for (const { call, result } of results) {
    if (result.image) {
      imageParts.push({
        type: 'image_url',
        image_url: { url: `data:${result.image.mediaType};base64,${result.image.data}` },
      });
      toolNames.push(call.name);
    }
  }
  if (imageParts.length === 0) return undefined;
  const label =
    toolNames.length === 1
      ? `Image output from the \`${toolNames[0]}\` tool call (referenced above):`
      : `Image output from ${toolNames.length} tool calls (${toolNames.join(', ')}):`;
  return { role: 'user', content: [{ type: 'text', text: label }, ...imageParts] };
}

/** Render a short human-friendly summary of a batch of tool calls. */
export function summarizeToolCalls(calls: readonly AccumulatedToolCall[]): string {
  if (calls.length === 0) return '';
  if (calls.length === 1) return `called ${calls[0]!.name}`;
  return `called ${calls.length} tools: ${calls.map((c) => c.name).join(', ')}`;
}
