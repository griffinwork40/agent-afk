/**
 * Tool schemas for user-interaction and media built-ins:
 * ask_question, image_generate (moved to web-tools), clipboard_write, clipboard_read.
 *
 * Holds ask_question — extracted into its own file to satisfy the 350-code-line
 * ratchet on `schemas.ts` (baselined files may shrink, never grow). Imported and
 * re-exported from `schemas.ts` so callers import from the primary module.
 *
 * @module agent/tools/schemas.interaction-tools
 */

import type { AnthropicToolDef } from './types.js';

export const askQuestionTool: AnthropicToolDef = {
  name: 'ask_question',
  category: 'other',
  concurrencySafe: false,
  description:
    'Ask the human operator a question and wait for their answer. ' +
    'This is a LAST RESORT, not a first move — it blocks on a human who is often away from keyboard. ' +
    'Before calling it, exhaust your tools: read files, check git, search the code and docs, inspect runtime state. ' +
    'If a tool can answer the question, use the tool instead of asking. When a wrong guess would be cheap or ' +
    'reversible, make a reasonable assumption, proceed, and state it rather than asking. ' +
    'Reserve this tool for what no tool can resolve: a genuinely ambiguous requirement whose readings lead to ' +
    'materially different work, a decision with significant or irreversible consequences, or context that exists ' +
    "only in the operator's head (a preference, a secret, an external constraint). " +
    '\n\n' +
    'Answerability: `daemon` sessions and sub-agent forks have no elicitation handler — the call\n' +
    "returns `{ action: 'decline' }` instantly. Even interactive surfaces may be unattended.\n" +
    'Treat this tool as best-effort: `decline` or `cancel` means "no answer is coming." When unsure\n' +
    'a human will answer: (1) proceed on a stated assumption and record it in your terminal state,\n' +
    'or (2) end with a **Blocked** state naming exactly what the operator must supply.\n' +
    '\n' +
    'Question types:\n' +
    '- `text` (default): free-form text answer. Use for open-ended questions.\n' +
    '- `confirm`: yes/no question. Returns `{ action: "accept", value: true|false }`.\n' +
    '- `choice`: single selection from a list. Requires `choices` array.\n' +
    '- `multi_choice`: multiple selections. Requires `choices` array.\n' +
    '- `number`: numeric input. Supports optional `min`/`max` bounds.\n' +
    '\n' +
    'Guidelines:\n' +
    '- Ask one focused question at a time; fold genuine unknowns into the single most decision-relevant question rather than stacking calls.\n' +
    '- Do NOT use for anything answerable via your tools (files, git, search, runtime state).\n' +
    '- Do NOT use when the user has already provided enough context — infer and proceed.\n' +
    '- Prefer a stated assumption over a question whenever the choice is low-stakes or reversible.\n' +
    '- The result `action` will be one of: `accept` (answered), `cancel` (user interrupted), ' +
    '`decline` (no handler available), or `skip` (user skipped an optional question).\n' +
    '- `allow_custom`: for `choice`/`multi_choice` only — lets the operator type a free-form answer instead of picking from the list. On accept, `content.custom_value` holds the typed text and `content.value` is `null`.',
  input_schema: {
    type: 'object',
    properties: {
      question: {
        type: 'string',
        description:
          'The question to ask the operator. Keep it to one or two sentences; put background, ' +
          'trade-offs, and detail in `context`, and keep each choice short (Telegram buttons show ~60 characters).',
      },
      type: {
        type: 'string',
        enum: ['text', 'confirm', 'choice', 'multi_choice', 'number'],
        description: 'Question type. Defaults to "text".',
      },
      choices: {
        type: 'array',
        items: { type: 'string' },
        description: 'Required for `choice` and `multi_choice` types. The list of options.',
      },
      context: {
        type: 'string',
        description: 'Optional background context to display above the question.',
      },
      default: {
        oneOf: [{ type: 'string' }, { type: 'boolean' }, { type: 'number' }],
        description: 'Optional default value (shown as a hint to the user).',
      },
      min_length: {
        type: 'number',
        description: 'For `text` type: minimum character length.',
      },
      max_length: {
        type: 'number',
        description: 'For `text` type: maximum character length.',
      },
      min: {
        type: 'number',
        description: 'For `number` type: minimum value (inclusive).',
      },
      max: {
        type: 'number',
        description: 'For `number` type: maximum value (inclusive).',
      },
      allow_skip: {
        type: 'boolean',
        description: 'Whether the user may skip this question (submit empty). Defaults to false.',
      },
      allow_custom: {
        type: 'boolean',
        description:
          'For `choice` and `multi_choice` types only: if true, the operator is offered ' +
          'a "type your own answer" option in addition to the provided choices. ' +
          'When the operator enters a custom answer, the result is ' +
          '`{ action: "accept", content: { value: null, custom_value: "<typed-text>" } }`. ' +
          'Check `content.custom_value !== undefined` to detect a free-form answer.',
      },
    },
    required: ['question'],
  },
};

export const clipboardWriteTool: AnthropicToolDef = {
  name: 'clipboard_write',
  category: 'write',
  concurrencySafe: false,
  description:
    'Write a string to the system clipboard. ' +
    'Reuses the platform-detection logic (pbcopy on macOS, clip on Windows, ' +
    'wl-copy / xclip / xsel on Linux) with an OSC 52 fallback for SSH sessions. ' +
    'Returns success or a graceful failure message when no clipboard utility is ' +
    'available (headless, CI, or SSH-only environments).',
  input_schema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: 'The text to copy to the clipboard.',
      },
    },
    required: ['text'],
  },
};

export const clipboardReadTool: AnthropicToolDef = {
  name: 'clipboard_read',
  category: 'other',
  concurrencySafe: false,
  riskClass: 'caution',
  description:
    'Read the current clipboard contents as text. ' +
    'IMPORTANT: requires explicit operator confirmation on every call — ' +
    'the clipboard may contain passwords, API tokens, or other sensitive data. ' +
    'The returned text is run through the standard secret-redaction pipeline ' +
    '(Bearer tokens, Anthropic keys, JWTs, AWS IAM ids, generic long tokens) ' +
    'before reaching the model context. ' +
    'Returns a graceful error when no clipboard read utility is available ' +
    '(headless, CI, or SSH-only environments).',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
};
