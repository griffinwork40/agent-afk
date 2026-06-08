/**
 * Conversation-history → OpenAI **Responses API** request builder.
 *
 * Sibling to `messages.ts` (which targets Chat Completions `messages[]`). The
 * Responses API takes a different shape:
 *   - the system prompt becomes the top-level `instructions` string
 *   - the conversation is an `input[]` array of typed items
 *   - an assistant tool call is a `{ type: 'function_call', call_id, name, arguments }`
 *     item (NOT an assistant message carrying a `tool_calls` field)
 *   - a tool result is a `{ type: 'function_call_output', call_id, output }` item
 *   - tools use the FLATTENED `{ type:'function', name, parameters }` shape,
 *     not Chat Completions' nested `{ type:'function', function:{...} }`
 *
 * This module consumes the SAME message objects `query.ts` already builds for
 * the Chat Completions path (`OpenAIMessage`, plus the `OpenAIAssistantToolCallMessage`
 * / `OpenAIToolResultMessage` shapes from `loop.ts`) via a structural superset,
 * so the loop's history assembly stays single-sourced and wire-agnostic.
 *
 * @module agent/providers/openai-compatible/responses-messages
 */

import type { OpenAIFunctionTool } from './loop.js';

/** A simple role+text input item (`EasyInputMessage` subset). */
export interface ResponsesInputMessage {
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string;
}

/** A model-issued function call, replayed into history as an input item. */
export interface ResponsesFunctionCall {
  type: 'function_call';
  call_id: string;
  name: string;
  arguments: string;
}

/** The result of executing a function call, fed back to the model. */
export interface ResponsesFunctionCallOutput {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

export type ResponsesInputItem =
  | ResponsesInputMessage
  | ResponsesFunctionCall
  | ResponsesFunctionCallOutput;

/** Flattened Responses-API function tool (no nested `function` wrapper). */
export interface ResponsesFunctionTool {
  type: 'function';
  name: string;
  parameters: Record<string, unknown>;
  description?: string;
}

/**
 * Structural superset of every message shape `query.ts` accumulates:
 * `OpenAIMessage`, `OpenAIAssistantToolCallMessage`, `OpenAIToolResultMessage`.
 * Typed structurally so this builder does not couple to the concrete classes.
 */
export interface BuildableMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type?: string; function: { name: string; arguments: string } }>;
}

export interface ResponsesRequest {
  /** System prompt → top-level instructions (undefined when no system message). */
  instructions?: string;
  input: ResponsesInputItem[];
  tools?: ResponsesFunctionTool[];
}

/**
 * Convert a Chat-Completions-shaped message array into a Responses request.
 *
 * System messages are hoisted into `instructions` (joined with a blank line if
 * more than one). Everything else maps to `input[]` items in order, preserving
 * the assistant-call → tool-result adjacency the model needs.
 */
export function buildResponsesRequest(
  messages: readonly BuildableMessage[],
  openAITools?: readonly OpenAIFunctionTool[],
): ResponsesRequest {
  const systemParts: string[] = [];
  const input: ResponsesInputItem[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (typeof msg.content === 'string' && msg.content.length > 0) systemParts.push(msg.content);
      continue;
    }

    if (msg.role === 'tool') {
      // Tool result → function_call_output linked by call_id.
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id ?? '',
        output: msg.content ?? '',
      });
      continue;
    }

    if (msg.role === 'assistant') {
      // Any assistant preamble text becomes its own message item first…
      if (typeof msg.content === 'string' && msg.content.length > 0) {
        input.push({ role: 'assistant', content: msg.content });
      }
      // …then each tool call becomes a function_call item.
      if (Array.isArray(msg.tool_calls)) {
        for (const tc of msg.tool_calls) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
      }
      continue;
    }

    // user
    input.push({ role: 'user', content: msg.content ?? '' });
  }

  const request: ResponsesRequest = { input };
  if (systemParts.length > 0) request.instructions = systemParts.join('\n\n');
  const tools = responsesToolsFromOpenAITools(openAITools);
  if (tools.length > 0) request.tools = tools;
  return request;
}

/**
 * Flatten Chat-Completions-shaped function tools (`{ type, function: {...} }`)
 * into the Responses-API shape (`{ type:'function', name, parameters }`).
 * Reuses the already-computed `this.openAITools` so the AFK→OpenAI schema
 * conversion (`toolDefsToOpenAIFunctions`) stays single-sourced.
 */
export function responsesToolsFromOpenAITools(
  openAITools?: readonly OpenAIFunctionTool[],
): ResponsesFunctionTool[] {
  if (!openAITools || openAITools.length === 0) return [];
  return openAITools.map((t) => {
    const out: ResponsesFunctionTool = {
      type: 'function',
      name: t.function.name,
      parameters: t.function.parameters,
    };
    if (t.function.description !== undefined) out.description = t.function.description;
    return out;
  });
}
