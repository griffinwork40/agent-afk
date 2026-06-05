/**
 * Self-healing guard: scan the tail of `messages` for an assistant message
 * whose `content` carries `tool_use` blocks not followed by a user
 * `tool_result` covering each id. When found, insert a synthetic user
 * message of `is_error: true` `tool_result` placeholders so the next
 * Messages API call satisfies Anthropic's contract: "Each `tool_use`
 * block must have a corresponding `tool_result` block in the next message."
 *
 * Mutates `messages` in place by splicing a single repair message after
 * the offending assistant turn. Only the tail is checked — the loop's
 * own rollback covers throws inside `runTurn`, so the only paths that
 * reach this function with broken history are:
 *   1. A session restored from a corrupted on-disk persist (older builds
 *      that lacked the rollback could leak orphans).
 *   2. A defensive fallback if some future codepath bypasses the loop's
 *      rollback.
 *
 * Extracted from `query.ts` to keep the orchestrator focused. Sibling
 * unit tests live at `../repair-orphan-tool-uses.test.ts`.
 *
 * @module agent/providers/anthropic-direct/query/repair-orphan-tool-uses
 */

import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';

export function repairOrphanToolUses(messages: MessageParam[]): void {
  if (messages.length === 0) return;
  const last = messages[messages.length - 1];
  if (!last || last.role !== 'assistant' || typeof last.content === 'string') {
    return;
  }
  const blocks = last.content as ContentBlockParam[];
  const orphanIds: string[] = [];
  for (const b of blocks) {
    if (b.type === 'tool_use' && typeof b.id === 'string') {
      orphanIds.push(b.id);
    }
  }
  if (orphanIds.length === 0) return;

  const repair: MessageParam = {
    role: 'user',
    content: orphanIds.map((id) => ({
      type: 'tool_result' as const,
      tool_use_id: id,
      content: 'Tool call interrupted before completing — no result recorded.',
      is_error: true,
    })) as ContentBlockParam[],
  };
  messages.push(repair);
}
