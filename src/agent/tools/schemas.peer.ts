/**
 * Tool schemas for peer-session messaging tools.
 *
 * Both tools are top-level only (not available to subagents) — enforced by
 * the dispatcher gate that checks `supportsBackgroundJobs` or the explicit
 * peer-tools gate in the toolDefs getter.
 *
 * @module agent/tools/schemas.peer
 */

import type { AnthropicToolDef } from './types.js';

export const listSessionsTool: AnthropicToolDef = {
  name: 'list_sessions',
  category: 'subagent',
  concurrencySafe: true,
  description:
    'List live afk peer sessions on this machine (excluding yourself). ' +
    'Returns an array of session objects: { sessionId, name, surface, cwd, branch, turnState, turnStateSince, heartbeatAgeMs, pendingMessages, blocked }. ' +
    'Use to discover who to send a message to before calling send_to_session. ' +
    'turnState reflects whether the session is idle (ready to be woken), busy (running a turn), or blocked (waiting on a human prompt). ' +
    'pendingMessages is the count of unread messages already queued in that session\'s inbox.',
  input_schema: {
    type: 'object',
    properties: {},
    required: [],
  },
};

export const sendToSessionTool: AnthropicToolDef = {
  name: 'send_to_session',
  category: 'subagent',
  concurrencySafe: false,
  description:
    'Send a message to another live afk session on this machine. ' +
    'Delivery semantics: idle receivers wake immediately and receive the message as a new turn; ' +
    'busy receivers (running a model turn) get the message delivered at their next turn boundary — this tool never interrupts a running turn. ' +
    'Replies from the other session arrive as a new turn wrapped in <peer-session-message> blocks. ' +
    'Use reply_to with the incoming message\'s id attribute to thread a reply. ' +
    'The to field accepts a full sessionId, a unique prefix (≥6 chars), or the session\'s name label. ' +
    'Returns { status: "queued"|"refused", messageId?, reason?, detail?, resolvedTo?, targetState? }. ' +
    'A refused status is NOT a fatal error — inspect reason and detail to understand why ' +
    '(e.g. "unknown-target", "rate-limited", "hop-limit", "too-large").',
  input_schema: {
    type: 'object',
    properties: {
      to: {
        type: 'string',
        description:
          'Target session identifier. Accepts: full sessionId, unique prefix (≥6 chars), or the session name from list_sessions.',
      },
      message: {
        type: 'string',
        description: 'The message body to deliver. Max 64KB UTF-8.',
      },
      reply_to: {
        type: 'string',
        description:
          'The id of an incoming peer-session-message you are replying to. Threads the reply so the recipient can correlate it.',
      },
    },
    required: ['to', 'message'],
  },
};

/** Names of the two peer tools — used for allowlist gating. */
export const PEER_TOOL_NAMES = [listSessionsTool.name, sendToSessionTool.name] as const;
