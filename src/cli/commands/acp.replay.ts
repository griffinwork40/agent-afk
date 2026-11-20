/**
 * ACP history replay: emit the human-visible journal as session/update
 * notifications in journal order.
 *
 * Contract:
 *   - Only user text, assistant text, and completed/failed tool calls are
 *     emitted. Permission prompts, thinking blocks, usage counters, and
 *     compaction bookkeeping are never replayed.
 *   - Historical tools are NEVER executed; replay is read-only.
 *   - One notification per journalled message (user → user_message_chunk,
 *     assistant text → agent_message_chunk, tool_use+tool_result pairs →
 *     tool_call with completed/failed status).
 *   - Replay sends rawOutput (bounded to 65 536 UTF-8 bytes per profile §5).
 *   - On empty history replayHistory resolves immediately (not an error).
 *
 * @module cli/commands/acp.replay
 */

import { loadDisplayMessages } from '../../agent/journal/display-fold.js';
import { hydrateMessages } from '../../agent/journal/reader.js';
import type { JournalBlock, JournalMessage } from '../../agent/journal/types.js';
import type { AcpClientPeer, SessionUpdate, ToolCall } from './acp.wire.js';

const MAX_RAW_OUTPUT_BYTES = 65_536;
const TRUNCATION_MARKER = '\n[truncated]';

/** Bound a tool result string to the profile's 65 536-byte UTF-8 limit. */
function boundOutput(text: string): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.length <= MAX_RAW_OUTPUT_BYTES) return text;
  const marker = Buffer.from(TRUNCATION_MARKER, 'utf8');
  const budget = MAX_RAW_OUTPUT_BYTES - marker.length;
  // Slice on UTF-8 boundary then re-decode.
  const sliced = buf.subarray(0, budget);
  const decoded = sliced.toString('utf8').replace(/\uFFFD$/, '');
  return decoded + TRUNCATION_MARKER;
}

/**
 * Collect all tool_use ids and their corresponding tool_result blocks from one
 * assistant+user message pair so we can pair them when emitting tool_calls.
 */
interface ToolPair {
  id: string;
  name: string;
  input: unknown;
  resultText: string | null;
  isError: boolean;
}

function extractToolPairs(
  assistantMsg: JournalMessage,
  resultMsg: JournalMessage | undefined,
): ToolPair[] {
  const uses: Array<Extract<JournalBlock, { type: 'tool_use' }>> = [];
  for (const b of assistantMsg.content) {
    if (b.type === 'tool_use') uses.push(b);
  }
  if (uses.length === 0) return [];

  // Build a lookup from toolUseId → result text
  const resultMap = new Map<string, { text: string | null; isError: boolean }>();
  if (resultMsg) {
    for (const b of resultMsg.content) {
      if (b.type !== 'tool_result') continue;
      let text: string | null = null;
      for (const part of b.content) {
        if (part.type === 'text') { text = part.text; break; }
        if (part.type === 'text_ref') { text = part.preview; break; }
      }
      resultMap.set(b.toolUseId, { text, isError: b.isError ?? false });
    }
  }

  return uses.map((u) => {
    const r = resultMap.get(u.id);
    return { id: u.id, name: u.name, input: u.input, resultText: r?.text ?? null, isError: r?.isError ?? false };
  });
}

/** Build a tool_call SessionUpdate for replay from a ToolPair. */
function toolCallUpdate(pair: ToolPair): SessionUpdate {
  const status = pair.isError ? 'failed' : 'completed';
  const update: ToolCall & { sessionUpdate: 'tool_call' } = {
    sessionUpdate: 'tool_call',
    toolCallId: pair.id,
    title: pair.name,
    name: pair.name,
    kind: 'other',
    status,
    ...(pair.input !== undefined ? { rawInput: pair.input as import('./acp.wire.js').JsonValue } : {}),
    ...(pair.resultText !== null ? {
      rawOutput: boundOutput(pair.resultText),
      content: [{ type: 'content' as const, content: { type: 'text' as const, text: boundOutput(pair.resultText) } }],
    } : {}),
  };
  return update;
}

/** Extract plain assistant text from an assistant message (skip thinking/tool_use). */
function assistantText(msg: JournalMessage): string {
  const parts: string[] = [];
  for (const b of msg.content) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'text_ref') parts.push(b.preview);
  }
  return parts.join('');
}

/** Extract plain user text from a user message (skip tool_result blocks). */
function userText(msg: JournalMessage): string {
  const parts: string[] = [];
  for (const b of msg.content) {
    if (b.type === 'text') parts.push(b.text);
    else if (b.type === 'text_ref') parts.push(b.preview);
  }
  return parts.join('');
}

/**
 * Build the ordered list of session/update payloads for the display history.
 * Exported for unit-testing without a live peer.
 */
export function buildReplayUpdates(messages: readonly JournalMessage[]): SessionUpdate[] {
  const updates: SessionUpdate[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;

    if (msg.role === 'user') {
      // Skip pure tool-result messages (no text content).
      const text = userText(msg);
      if (text.length > 0) {
        updates.push({
          sessionUpdate: 'user_message_chunk',
          content: { type: 'text', text },
        });
      }
      continue;
    }

    // assistant message: emit tool calls first, then text
    const nextMsg = messages[i + 1];
    const nextIsResult =
      nextMsg?.role === 'user' &&
      nextMsg.content.some((b) => b.type === 'tool_result');
    const resultMsg = nextIsResult ? nextMsg : undefined;

    const pairs = extractToolPairs(msg, resultMsg);
    for (const pair of pairs) {
      updates.push(toolCallUpdate(pair));
    }

    const text = assistantText(msg);
    if (text.length > 0) {
      updates.push({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text },
      });
    }

    // Skip the consumed tool-result user message
    if (resultMsg) i++;
  }

  return updates;
}

/**
 * Load the display history for `afkSessionId` and emit it as session/update
 * notifications on `peer` for `acpSessionId`. Resolves when all notifications
 * have been sent, or immediately when the history is empty.
 *
 * Throws on peer write failure — caller (loadAcpSession) must release partial
 * resources and return an internal error.
 */
export async function emitReplayUpdates(
  acpSessionId: string,
  afkSessionId: string,
  peer: AcpClientPeer,
): Promise<void> {
  const raw = loadDisplayMessages(afkSessionId);
  if (raw.length === 0) return;
  const messages = hydrateMessages(raw);
  const updates = buildReplayUpdates(messages);
  for (const update of updates) {
    await peer.notify('session/update', { sessionId: acpSessionId, update });
  }
}
