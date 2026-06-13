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
import type { OpenAIContentPart } from './messages.js';

/**
 * A Responses-API content part. `input_text` / `input_image` mirror the SDK's
 * `ResponseInputText` / `ResponseInputImage`. Note `image_url` is a bare
 * data-URI string here (unlike Chat Completions' `{ url }` object), and
 * `detail` is a required field.
 */
export interface ResponsesInputText {
  type: 'input_text';
  text: string;
}
export interface ResponsesInputImage {
  type: 'input_image';
  image_url: string;
  detail: 'auto' | 'low' | 'high';
}
export type ResponsesContentPart = ResponsesInputText | ResponsesInputImage;

/** A role + content input item (`EasyInputMessage` subset). Content is a plain
 * string, or a `ResponsesContentPart[]` when a vision-capable user turn carries
 * images. */
export interface ResponsesInputMessage {
  role: 'user' | 'assistant' | 'system' | 'developer';
  content: string | ResponsesContentPart[];
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
  content: string | OpenAIContentPart[] | null;
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
      // Tool result → function_call_output linked by call_id. Tool messages
      // only ever carry string content (images ride a follow-up user message),
      // but coerce defensively to satisfy the widened content type.
      input.push({
        type: 'function_call_output',
        call_id: msg.tool_call_id ?? '',
        output: typeof msg.content === 'string' ? msg.content : '',
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

    // user (may carry multimodal parts on vision-capable models)
    input.push({ role: 'user', content: toResponsesContent(msg.content) });
  }

  const request: ResponsesRequest = { input };
  if (systemParts.length > 0) request.instructions = systemParts.join('\n\n');
  const tools = responsesToolsFromOpenAITools(openAITools);
  if (tools.length > 0) request.tools = tools;
  return request;
}

/**
 * Convert a Chat-Completions-shaped user `content` (string | parts) into the
 * Responses-API content shape. Text parts → `input_text`; image parts →
 * `input_image` (the Chat `image_url.url` data-URI becomes the bare
 * `image_url` string the Responses API expects). History reaching here is
 * already vision-sanitized upstream by `buildMessages`, so a non-vision turn
 * arrives as a plain string and passes through untouched.
 */
function toResponsesContent(
  content: string | OpenAIContentPart[] | null,
): string | ResponsesContentPart[] {
  if (content === null) return '';
  if (typeof content === 'string') return content;
  const parts: ResponsesContentPart[] = [];
  for (const part of content) {
    if (part.type === 'text') {
      parts.push({ type: 'input_text', text: part.text });
    } else {
      parts.push({ type: 'input_image', image_url: part.image_url.url, detail: 'auto' });
    }
  }
  return parts;
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
