/**
 * Inter-round steering injection for the anthropic-direct provider loop.
 * Called after each tool-round returns 'continue', before openRound().
 *
 * @module agent/providers/anthropic-direct/loop/inter-round
 */

import type { RunTurnInput } from '../request-types.js';
import { emitQueuedUserMessage } from '../../../trace/emit.js';

/**
 * If `steeringText` is non-empty, append it as a text block to the last
 * message in `input.messages` (the tool_result user turn committed by
 * runToolRound). Mirrors the harnessNotes pattern at tool-results.ts:141-152.
 *
 * Also fires a fire-and-forget `queued_user_message` trace event.
 */
export function applyBeforeNextRound(
  input: RunTurnInput,
  steeringText: string | undefined,
): void {
  if (!steeringText) return;

  // Append steering text to the last user turn (the tool_result commit).
  const last = input.messages.at(-1);
  if (!last || last.role !== 'user') return;

  if (Array.isArray(last.content)) {
    last.content.push({ type: 'text', text: steeringText });
  } else {
    // Safety: last.content is a string (shouldn't happen at tool_result
    // boundary, but guard defensively).
    (last as { role: string; content: unknown[] }).content = [
      { type: 'text', text: last.content as string },
      { type: 'text', text: steeringText },
    ];
  }

  // Fire-and-forget trace event.
  void emitQueuedUserMessage(input.traceWriter, {
    jobId: input.subagentId ?? '',
    subagentId: input.subagentId ?? '',
    byteLength: Buffer.byteLength(steeringText, 'utf8'),
  });
}
