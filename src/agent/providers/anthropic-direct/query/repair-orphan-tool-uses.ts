/**
 * Self-healing guards for the Anthropic Messages API message-array contract.
 *
 * Two invariants are enforced:
 *
 *   1. **tool_use/tool_result pairing:** Every assistant `tool_use` block must
 *      be followed immediately by a user message whose `tool_result` blocks
 *      cover every id. Orphans get synthetic `is_error: true` placeholders.
 *
 *   2. **Role alternation:** Messages must alternate user/assistant. Consecutive
 *      same-role messages (which can arise when `resumeHistoryToMessages` skips
 *      a user turn because both `turn.user` and `turn.userContentBlocks` are
 *      empty) get a synthetic bridging message spliced between them.
 *
 * Both passes mutate `messages` in place. The orphan pass runs first (it may
 * insert user messages that fix some alternation violations for free); the
 * alternation pass runs second as a catch-all.
 *
 * Paths that reach this function with broken history include:
 *   1. A session restored from a persisted history where a mid-turn interrupt
 *      left a non-tail orphan (the primary motivation for the full-scan).
 *   2. A session restored from a corrupted on-disk persist (older builds
 *      that lacked the rollback could leak orphans at the tail).
 *   3. A forked session (`/fork`) whose sidecar, when resumed, produces a
 *      message array with a skipped user turn (empty user text + no
 *      userContentBlocks), creating consecutive assistant messages.
 *   4. A defensive fallback if some future codepath bypasses the loop's
 *      rollback.
 *
 * Scanning is done from the end of the array toward the front so that
 * splice insertions do not shift the indices of messages yet to be visited.
 *
 * Extracted from `query.ts` to keep the orchestrator focused. Sibling
 * unit tests live at `../repair-orphan-tool-uses.test.ts`.
 *
 * @module agent/providers/anthropic-direct/query/repair-orphan-tool-uses
 */

import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';

/**
 * Collect all `tool_result` IDs from a user message's content, or return an
 * empty set when the message is not a user message or has string content.
 */
function coveredToolResultIds(msg: MessageParam | undefined): Set<string> {
  if (!msg || msg.role !== 'user' || typeof msg.content === 'string') {
    return new Set();
  }
  const covered = new Set<string>();
  for (const b of msg.content as ContentBlockParam[]) {
    if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
      covered.add(b.tool_use_id);
    }
  }
  return covered;
}

// Invariant: repairOrphanToolUses runs BEFORE repairRoleAlternation so that
// synthetic tool_result user messages resolve some alternation violations for
// free. repairRoleAlternation is the catch-all for any remaining gaps.

function repairOrphanToolUsesPass(messages: MessageParam[]): void {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!msg || msg.role !== 'assistant' || typeof msg.content === 'string') {
      continue;
    }

    const blocks = msg.content as ContentBlockParam[];
    const toolUseIds: string[] = [];
    for (const b of blocks) {
      if (b.type === 'tool_use' && typeof b.id === 'string') {
        toolUseIds.push(b.id);
      }
    }
    if (toolUseIds.length === 0) continue;

    const covered = coveredToolResultIds(messages[i + 1]);
    const orphanIds = toolUseIds.filter((id) => !covered.has(id));
    if (orphanIds.length === 0) continue;

    const repair: MessageParam = {
      role: 'user',
      content: orphanIds.map((id) => ({
        type: 'tool_result' as const,
        tool_use_id: id,
        content: 'Tool call interrupted before completing — no result recorded.',
        is_error: true,
      })) as ContentBlockParam[],
    };
    messages.splice(i + 1, 0, repair);
  }
}

/**
 * Fix consecutive same-role messages by inserting synthetic bridging messages.
 *
 * The Anthropic Messages API requires strict user/assistant alternation.
 * Consecutive assistant messages arise when `resumeHistoryToMessages` skips a
 * user turn (both `turn.user === ''` and `turn.userContentBlocks` is
 * empty/undefined). Consecutive user messages can arise from similar edge
 * cases in corrupted sidecars.
 *
 * A forward scan is used (not reverse) because bridging messages do not
 * interact with each other and the splice offset is adjusted by incrementing
 * the loop index past the insertion.
 */
function repairRoleAlternation(messages: MessageParam[]): void {
  for (let i = 0; i < messages.length - 1; i++) {
    const curr = messages[i];
    const next = messages[i + 1];
    if (!curr || !next || curr.role !== next.role) continue;

    // Insert a bridging message with the opposite role.
    const bridgeRole = curr.role === 'assistant' ? 'user' : 'assistant';
    const bridge: MessageParam = {
      role: bridgeRole,
      content: '[resumed]',
    };
    messages.splice(i + 1, 0, bridge);
    // Skip past the inserted bridge so we do not re-examine it.
    i++;
  }
}

export function repairOrphanToolUses(messages: MessageParam[]): void {
  if (messages.length === 0) return;

  // Pass 1: fix orphaned tool_use blocks (may insert user messages that also
  // resolve some alternation violations).
  repairOrphanToolUsesPass(messages);

  // Pass 2: fix any remaining consecutive same-role messages.
  repairRoleAlternation(messages);
}
