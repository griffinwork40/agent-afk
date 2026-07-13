/**
 * Per-wire streaming request-body assembly for
 * {@link OpenAICompatibleQuery.runIteration}.
 *
 * The Responses-API and Chat-Completions wires build different request bodies
 * (`input` + `max_output_tokens` + `reasoning:{effort}` vs `messages` +
 * `max_tokens` + `reasoning_effort`), with the Responses path carrying the
 * private ChatGPT/Codex subscription-backend quirks. Both were inline in
 * `runIteration`; extracting them here keeps that method focused on the shared
 * retry/stream-drive handoff. Pure functions — no I/O, no control flow.
 *
 * @module agent/providers/openai-compatible/query/request-body
 */

import type { EffortLevel } from '../../../types/sdk-types.js';
import type { OpenAIMessage } from '../messages.js';
import type { OpenAIFunctionTool } from '../loop.js';
import { buildResponsesRequest } from '../responses-messages.js';
import { DEFAULT_RESPONSES_INSTRUCTIONS } from '../responses-config.js';
import {
  resolveEffectiveMaxOutputTokens,
  resolveReasoningEffort,
  resolveStreamingMaxTokens,
} from './model-params.js';

/** Inputs common to both wire request-body builders. */
export interface RequestBodyInputs {
  model: string;
  messages: OpenAIMessage[];
  /** Tools to advertise this turn; undefined on a wind-down round (tools stripped). */
  activeTools: OpenAIFunctionTool[] | undefined;
  maxOutputTokens: number | undefined;
  effort: EffortLevel | undefined;
}

/**
 * Build the Responses-API streaming request body. `messages` (built +
 * plan-mode-adjusted upstream) is converted to the Responses input shape; the
 * system prompt becomes `instructions`, tool calls/results become
 * function_call/_output items.
 *
 * `isChatGptBackend` scopes the private subscription-path quirks: it rejects
 * *every* output-cap parameter with an opaque HTTP 400, so the cap is omitted
 * there; and it requires a non-empty `instructions` plus `store: false`, which
 * the public API-key path does not.
 */
export function buildResponsesRequestBody(
  args: RequestBodyInputs & { isChatGptBackend: boolean },
): Record<string, unknown> {
  const req = buildResponsesRequest(args.messages, args.activeTools);
  const requestBody: Record<string, unknown> = {
    model: args.model,
    input: req.input,
    stream: true,
  };
  // Output-token cap. The Responses API uses `max_output_tokens` — NOT Chat
  // Completions' `max_tokens`/`max_completion_tokens`. Omit it entirely on the
  // ChatGPT/Codex subscription backend (it 400s on every output-cap param).
  if (!args.isChatGptBackend) {
    requestBody['max_output_tokens'] = resolveEffectiveMaxOutputTokens(args.model, args.maxOutputTokens);
  }
  const instructions =
    req.instructions ?? (args.isChatGptBackend ? DEFAULT_RESPONSES_INSTRUCTIONS : undefined);
  if (instructions !== undefined) requestBody['instructions'] = instructions;
  if (args.isChatGptBackend) requestBody['store'] = false;
  if (req.tools && req.tools.length > 0) requestBody['tools'] = req.tools;
  // Forward reasoning effort for o-series models via the Responses API's
  // `reasoning: { effort }` shape.
  const responsesEffort = resolveReasoningEffort(args.effort, args.model);
  if (responsesEffort !== undefined) {
    requestBody['reasoning'] = { effort: responsesEffort };
  }
  return requestBody;
}

/** Build the Chat-Completions streaming request body. */
export function buildChatCompletionsRequestBody(args: RequestBodyInputs): Record<string, unknown> {
  const requestBody: Record<string, unknown> = {
    model: args.model,
    messages: args.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  // Thread the output-token cap into the streaming request (parity with
  // Anthropic's always-forwarded max_tokens); reuses the o-series
  // field-selection logic.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
  Object.assign(requestBody, resolveStreamingMaxTokens(args.model, args.maxOutputTokens));
  // Only attach `tools` when there are any to advertise — empty arrays make
  // some providers reject the request.
  if (args.activeTools && args.activeTools.length > 0) {
    requestBody['tools'] = args.activeTools;
  }
  // Forward reasoning effort for o-series models via Chat Completions'
  // `reasoning_effort` field.
  const chatEffort = resolveReasoningEffort(args.effort, args.model);
  if (chatEffort !== undefined) {
    requestBody['reasoning_effort'] = chatEffort;
  }
  return requestBody;
}
