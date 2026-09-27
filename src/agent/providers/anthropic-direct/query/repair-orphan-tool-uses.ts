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
 * Report describing what `repairOrphanToolUses` changed.
 *
 * Returned as the function value when a repair was performed; `null` is
 * returned when history is healthy and no mutation occurred.
 *
 * Index semantics: all index fields refer to positions in the ORIGINAL
 * (pre-repair) message array. Exception: `bridgedIndices` is measured against
 * the array as it stood AFTER Pass 1 (orphan repair) and names the FIRST message
 * of each same-role pair (the bridge lands at index + 1). It equals the original
 * index only when Pass 1 inserted nothing.
 *
 * The `shapeBefore` string is computed lazily — only when a repair is
 * detected — from a shallow copy of the pre-repair array. It is a compact
 * structural summary of each message: `<idx>:<role>[<blockType>*<N>, ...]`.
 * Example: `0:u[text] 1:a[text,tool_use*2] 2:u[tool_result*2] 3:a[text]`.
 * It NEVER contains message text, tool inputs, or tool result content.
 * Capped at 2000 characters; if truncated a `…` marker is appended.
 */
export interface OrphanRepairReport {
  /** Original indices of user messages where tool_result blocks were hoisted
   *  to the front (Pass 0 fix). */
  hoistedMessageIndices: number[];
  /** tool_use ids that had no paired tool_result (Pass 1 orphan fix). */
  orphanToolUseIds: string[];
  /** Original indices of assistant messages that owned orphaned tool_use blocks. */
  orphanAssistantIndices: number[];
  /** Indices (relative to the post-Pass-1 array) of the first message in each
   *  same-role pair where a bridging message was inserted (Pass 2 fix). */
  bridgedIndices: number[];
  /** Length of the message array before any repair. */
  messageCountBefore: number;
  /** Compact structural shape of the array before repair (roles + block types +
   *  counts only — never content). Computed lazily, capped at 2000 chars. */
  shapeBefore: string;
}

const SHAPE_CAP = 2000;

/**
 * Build a compact structural summary of a message array.
 * Roles: `u` = user, `a` = assistant. Block types are abbreviated by `type`.
 * Repeated block types in one message are collapsed into `type*N`.
 * Never includes text content, tool inputs, or tool result content.
 */
function buildShape(messages: readonly MessageParam[]): string {
  const parts: string[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    const role = msg.role === 'user' ? 'u' : 'a';
    let blockSummary: string;
    if (typeof msg.content === 'string') {
      blockSummary = 'text';
    } else {
      // Count occurrences of each block type in order.
      const counts = new Map<string, number>();
      const order: string[] = [];
      for (const b of msg.content as ContentBlockParam[]) {
        const t = b.type;
        if (!counts.has(t)) { counts.set(t, 0); order.push(t); }
        counts.set(t, counts.get(t)! + 1);
      }
      blockSummary = order.map((t) => {
        const n = counts.get(t)!;
        return n === 1 ? t : `${t}*${n}`;
      }).join(',');
      if (blockSummary === '') blockSummary = 'empty';
    }
    parts.push(`${i}:${role}[${blockSummary}]`);
  }
  let shape = parts.join(' ');
  if (shape.length > SHAPE_CAP) {
    shape = shape.slice(0, SHAPE_CAP) + '…';
  }
  return shape;
}

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

/**
 * Move every `tool_result` block to the front of its user message, keeping
 * relative order within each group (stable partition).
 *
 * Invariant: the Messages API rejects a user message in which any other block
 * (typically `text`) precedes a `tool_result` answering the previous assistant
 * turn's `tool_use`, with the same 400 as a missing result. Sidecars written by
 * builds whose `buildUserContentBlocks` emitted text first carry exactly that
 * shape on disk, so this pass heals them on resume. It must run before the
 * orphan pass, whose coverage check only tests presence, not position.
 *
 * Returns the original (pre-mutation) indices of messages that were modified.
 */
function hoistToolResultsPass(messages: MessageParam[]): number[] {
  const hoisted: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i]!;
    if (msg.role !== 'user' || typeof msg.content === 'string') continue;
    const blocks = msg.content as ContentBlockParam[];
    const firstOther = blocks.findIndex((b) => b.type !== 'tool_result');
    if (firstOther === -1) continue;
    const misplaced = blocks.slice(firstOther).some((b) => b.type === 'tool_result');
    if (!misplaced) continue;
    msg.content = [
      ...blocks.filter((b) => b.type === 'tool_result'),
      ...blocks.filter((b) => b.type !== 'tool_result'),
    ];
    hoisted.push(i);
  }
  return hoisted;
}

// Invariant: repairOrphanToolUses runs BEFORE repairRoleAlternation so that
// synthetic tool_result user messages resolve some alternation violations for
// free. repairRoleAlternation is the catch-all for any remaining gaps.

/**
 * Returns { orphanIds, assistantIndices } describing what was repaired.
 * `assistantIndices` are positions in the ORIGINAL array.
 *
 * Index semantics: we scan backward and splice at i+1 (always above the
 * current scan cursor), so messages at positions 0..i are never shifted by
 * an insertion at i+1. The original index of the message at current position
 * i is therefore exactly i throughout the scan.
 */
function repairOrphanToolUsesPass(messages: MessageParam[]): {
  orphanIds: string[];
  assistantIndices: number[];
} {
  const orphanIds: string[] = [];
  const assistantIndices: number[] = [];
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
    const localOrphans = toolUseIds.filter((id) => !covered.has(id));
    if (localOrphans.length === 0) continue;

    // Original index: because all prior insertions were at positions > i
    // (splice at i+1), the messages at 0..i are unshifted — original index = i.
    orphanIds.push(...localOrphans);
    assistantIndices.push(i);

    const repair: MessageParam = {
      role: 'user',
      content: localOrphans.map((id) => ({
        type: 'tool_result' as const,
        tool_use_id: id,
        content: 'Tool call interrupted before completing — no result recorded.',
        is_error: true,
      })) as ContentBlockParam[],
    };
    messages.splice(i + 1, 0, repair);
  }
  return { orphanIds, assistantIndices };
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
 *
 * Returns, for each inserted bridge, the index of the first message of the
 * same-role pair in the array as passed in (i.e. after Pass 1), not counting
 * bridges inserted earlier in this scan.
 */
function repairRoleAlternation(messages: MessageParam[], originalLength: number): number[] {
  const bridged: number[] = [];
  let insertedCount = 0;
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
    // Original index of `curr` in the pre-repair array.
    const originalIndex = i - insertedCount;
    if (originalIndex < originalLength) {
      bridged.push(originalIndex);
    }
    insertedCount++;
    // Skip past the inserted bridge so we do not re-examine it.
    i++;
  }
  return bridged;
}

/**
 * Repair the message array in place and return a report describing what was
 * changed, or `null` if nothing was changed (healthy history).
 *
 * Existing callers that ignore the return value continue to work unchanged.
 */
export function repairOrphanToolUses(messages: MessageParam[]): OrphanRepairReport | null {
  if (messages.length === 0) return null;

  const messageCountBefore = messages.length;

  // Snapshot the pre-repair structure for the shape string (cheap shallow copy;
  // shape is only computed when a repair is found).
  const snapshot = messages.slice();

  // Pass 0: put tool_result blocks first in each user message (heals sidecars
  // persisted with text-before-tool_result ordering).
  const hoistedMessageIndices = hoistToolResultsPass(messages);

  // Pass 1: fix orphaned tool_use blocks (may insert user messages that also
  // resolve some alternation violations).
  const { orphanIds: orphanToolUseIds, assistantIndices: orphanAssistantIndices } =
    repairOrphanToolUsesPass(messages);

  // Pass 2: fix any remaining consecutive same-role messages.
  const bridgedIndices = repairRoleAlternation(messages, messageCountBefore);

  const repaired =
    hoistedMessageIndices.length > 0 ||
    orphanToolUseIds.length > 0 ||
    bridgedIndices.length > 0;

  if (!repaired) return null;

  return {
    hoistedMessageIndices,
    orphanToolUseIds,
    orphanAssistantIndices,
    bridgedIndices,
    messageCountBefore,
    shapeBefore: buildShape(snapshot),
  };
}
