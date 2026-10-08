/**
 * Tool schema for the `model_complete` built-in: one tool-less chat
 * completion against any configured model, routed through the same slot
 * bindings and per-provider credentials the session uses.
 *
 * @module agent/tools/schemas.model-complete
 */

import type { AnthropicToolDef } from './types.js';

export const modelCompleteTool: AnthropicToolDef = {
  name: 'model_complete',
  // Outbound, billed API call to a model provider: same bucket as image_generate.
  category: 'web',
  concurrencySafe: true,
  description:
    'Send ONE prompt to any configured model and return its text reply. No tools, no ' +
    'conversation, no subagent fork: a single cheap chat completion. Use it to offload ' +
    'bounded text work to another (often cheaper or local) model: summarizing a large ' +
    'file, classifying, rewriting, extracting fields, drafting, or a second opinion from ' +
    'a different model family. Use `agent` instead when the work needs tools or multiple ' +
    'steps.\n\n' +
    '`model` accepts a slot name (`local`, `small`, `medium`, `large`), a custom slot ' +
    'name from afk.config.json, an identity alias (`haiku`, `sonnet`, `opus`, `grok`), or ' +
    'a raw model id; the slot\'s provider, endpoint, and API key are applied. Defaults to ' +
    'the operator\'s configured default model (AFK_MODEL); pass `local` or `small` ' +
    'explicitly for cheap offloads. An unconfigured slot is an error, never a silent ' +
    'fallback.\n\n' +
    '`input_path` is read by the tool and appended to the prompt, so a large file can be ' +
    'processed without its contents entering your context; only the reply comes back. ' +
    'Note that the file contents ARE sent to the chosen model\'s provider.',
  input_schema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: 'The user message / instruction sent to the model.',
      },
      system: {
        type: 'string',
        description: 'Optional system prompt. Defaults to a short "answer directly" instruction.',
      },
      model: {
        type: 'string',
        description:
          'Model to call: slot name, custom slot name, identity alias, or raw model id. ' +
          'Default: the configured default model (AFK_MODEL, else `medium`).',
      },
      max_tokens: {
        type: 'number',
        description:
          'Maximum output tokens (default 4096, clamped to 1..32000). Reasoning models spend ' +
          'part of this budget on hidden reasoning.',
      },
      input_path: {
        type: 'string',
        description:
          'Optional text file (absolute or relative) to append to the prompt inside an ' +
          '<input> block. Subject to the same read-root policy as read_file; max 1 MB.',
      },
    },
    required: ['prompt'],
  },
};
