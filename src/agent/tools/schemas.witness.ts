/**
 * Tool schemas for witness-layer search tools.
 *
 * Extracted from `schemas.ts` to satisfy the 350-line ceiling ratchet
 * (baselined files may shrink, never grow). Imported and re-registered
 * in `builtinToolSchemas[]` by the parent module.
 *
 * @module agent/tools/schemas.witness
 */

import type { AnthropicToolDef } from './types.js';

export const readWitnessTool: AnthropicToolDef = {
  name: 'read_witness',
  category: 'read',
  concurrencySafe: true,
  description:
    'Read and filter events from a session\'s witness trace (the durable record of ' +
    'everything the agent did). Returns structured trace events in chronological order. ' +
    'Use to inspect tool calls, errors, subagent lifecycles, costs, and session phases ' +
    'from a specific session. Defaults to the most recent session.\n\n' +
    'SCOPE: trace events record which tools fired, timing, byte counts, ' +
    'error/success, session phases, and some semantic snippets (e.g. subagent ' +
    'promptHead, compaction summaries, claims). They do NOT contain full ' +
    'conversation text, user/assistant messages, complete tool arguments, or ' +
    'tool output. To find a session by what was *discussed*, search transcripts ' +
    'or session events via bash (paths vary with AFK_STATE_DIR). ' +
    'To recall cross-session context by topic, use memory_search.',
  input_schema: {
    type: 'object',
    properties: {
      session: {
        type: 'string',
        description:
          'Session ID to read, or "latest" (default). Use search_witness to find session IDs.',
      },
      kinds: {
        type: 'array',
        items: { type: 'string' },
        description:
          'Filter by event kind(s). Values: tool_call, subagent_lifecycle, ' +
          'session_phase, closure, abort, budget, hook_decision, browser_event, ' +
          'claim, compaction, background_agent, queued_user_message, session_sealed.',
      },
      tool_name: {
        type: 'string',
        description: 'Filter tool_call events to only this tool name (e.g. "bash", "edit_file").',
      },
      errors_only: {
        type: 'boolean',
        description:
          'When true, show only error events: failed tool calls and failed subagents. Default: false.',
      },
      limit: {
        type: 'number',
        description:
          'Max events to return (default: 50, max: 200). Returns the N most recent matching events.',
      },
    },
    required: [],
  },
};

export const searchWitnessTool: AnthropicToolDef = {
  name: 'search_witness',
  category: 'read',
  concurrencySafe: true,
  description:
    'Search across multiple sessions\' witness traces for a text pattern. Returns matching ' +
    'trace events grouped by session. Use to find patterns across sessions — recurring errors, ' +
    'specific tool usage, cost spikes, or any text that appears in trace event payloads. ' +
    'Scans the N most recent sessions (default 20). Results are capped at 200 total matches ' +
    'across all scanned sessions.\n\n' +
    'SCOPE: searches trace event payloads — tool names, session phases, subagent IDs, ' +
    'error classes, timing, and semantic snippets like subagent promptHead (first 80 ' +
    'chars), compaction summaries, and claims. Does NOT contain full conversation ' +
    'text, user/assistant messages, complete tool arguments, or tool output. ' +
    'To find a prior session by topic or what was said, search transcripts ' +
    'or session events via bash (paths vary with AFK_STATE_DIR), ' +
    'or use memory_search for cross-session topic recall.',
  input_schema: {
    type: 'object',
    properties: {
      query: {
        type: 'string',
        description: 'Text pattern to search for (case-insensitive substring match).',
      },
      sessions: {
        type: 'number',
        description:
          'Number of recent sessions to scan (default: 20, max: 100). ' +
          'The result includes sessionsAvailable (sessions in this window before ' +
          'any since filter) and sessionsSearched (sessions actually read after ' +
          'the since filter) so you can distinguish "few sessions exist" from ' +
          '"the date filter excluded most of them".',
      },
      kinds: {
        type: 'array',
        items: { type: 'string' },
        description: 'Filter results to specific event kinds (same values as read_witness).',
      },
      since: {
        type: 'string',
        description: 'ISO date string — only search sessions modified after this date.',
      },
      tool_name: {
        type: 'string',
        description:
          'Filter tool_call events to only this tool name (e.g. "bash", "edit_file"). ' +
          'Non-tool_call events are excluded when set.',
      },
    },
    required: ['query'],
  },
};
