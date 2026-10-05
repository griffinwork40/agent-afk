/**
 * Inter-round steering injection for the anthropic-direct provider loop.
 * Called after each tool-round returns 'continue', before openRound().
 *
 * @module agent/providers/anthropic-direct/loop/inter-round
 */

import type { RunTurnInput } from '../request-types.js';
import type { MessageParam } from '@anthropic-ai/sdk/resources';
import { emitQueuedUserMessage } from '../../../trace/emit.js';

/**
 * If `steeringText` is non-empty, push it as a NEW user turn after the
 * tool_result batch committed by runToolRound. A fresh message object is used
 * rather than mutating the tool_result turn in place; JournalSync compares by
 * object reference (docs/message-journal.md invariant), so an in-place
 * mutation of an already-synced object is invisible to the journal. A new
 * push is always detected and journaled before the next model request.
 *
 * Also fires a fire-and-forget `queued_user_message` trace event.
 */
export function applyBeforeNextRound(
  input: RunTurnInput,
  steeringText: string | undefined,
): void {
  if (!steeringText) return;

  // Guard: we must be after a tool round, so the last message should be a
  // user turn with tool_result blocks. If somehow the last turn is not a user
  // turn (e.g., empty messages array), skip injection rather than corrupting
  // history.
  const last = input.messages.at(-1);
  if (!last || last.role !== 'user') return;

  // Push a fresh user turn. This is detectable by JournalSync (reference
  // comparison) unlike an in-place mutation of the already-committed message.
  // The Anthropic API allows consecutive user messages; the tool_result blocks
  // above already satisfy the tool_use/tool_result pairing contract.
  const steeringTurn: MessageParam = {
    role: 'user',
    content: [{ type: 'text', text: steeringText }],
  };
  input.messages.push(steeringTurn);

  // Fire-and-forget trace event.
  void emitQueuedUserMessage(input.traceWriter, {
    jobId: input.subagentId ?? '',
    subagentId: input.subagentId ?? '',
    byteLength: Buffer.byteLength(steeringText, 'utf8'),
  });
}
