/**
 * Tool schema for the session journal reader.
 *
 * Peer to `schemas.witness.ts` (trace metadata). This tool exposes
 * full conversation content from the message journal — the data that
 * `read_witness` explicitly does NOT carry.
 *
 * @module agent/tools/schemas.journal
 */

import type { AnthropicToolDef } from './types.js';

export const readJournalTool: AnthropicToolDef = {
  name: 'read_journal',
  category: 'read',
  concurrencySafe: true,
  description:
    'Read full conversation content from a session\'s message journal. ' +
    'Complements read_witness (which returns trace metadata: timing, byte counts, errors) ' +
    'by providing the data read_witness explicitly lacks: complete tool arguments, ' +
    'full tool output, and user/assistant message text.\n\n' +
    'Two modes:\n' +
    '- **Tool result lookup**: pass `tool_use_id` to fetch the full hydrated output of one ' +
    'specific tool call (the most common use case after finding a toolUseId via read_witness). ' +
    'Output is capped at 64 KB per result.\n' +
    '- **Conversation messages**: omit `tool_use_id` to retrieve recent conversation messages. ' +
    'Filter by `kinds` (user, assistant, tool_use, tool_result) and `limit` to scope the response. ' +
    'Message content is previewed (text capped at 2000 chars, tool inputs at 500 chars) to ' +
    'keep responses manageable.\n\n' +
    'Session resolution follows the same rules as read_witness: accepts a session ID, ' +
    'session name, or "latest" (default).',
  input_schema: {
    type: 'object',
    properties: {
      session: {
        type: 'string',
        description:
          'Session ID, name, or "latest" (default). Same resolution as read_witness.',
      },
      tool_use_id: {
        type: 'string',
        description:
          'Fetch the full output of one specific tool call by its tool_use id ' +
          '(found in read_witness tool_call events). Returns the complete hydrated ' +
          'result, capped at 64 KB. When set, kinds and limit are ignored.',
      },
      kinds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Filter conversation messages by block type. ' +
          'Values: "user", "assistant", "tool_use", "tool_result". ' +
          'Default: all types returned.',
      },
      limit: {
        type: 'number',
        description:
          'Max messages to return (default: 20, max: 100). ' +
          'Returns the N most recent matching messages.',
      },
    },
    required: [],
  },
};
