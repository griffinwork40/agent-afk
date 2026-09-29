/**
 * Self-healing guard for the OpenAI Chat Completions message-array contract.
 *
 * OpenAI's Chat Completions API enforces two invariants on the
 * assistant ↔ tool message sequence:
 *
 *   1. **Orphaned tool_calls:** Every assistant message that carries a
 *      `tool_calls` array must be immediately followed by a contiguous run
 *      of `role:'tool'` messages that covers *every* `tool_calls[i].id`. If
 *      any id is missing the API responds with a 400 ("messages with role
 *      'tool' must be a response to a preceding message with 'tool_calls'").
 *      This function inserts a synthetic `role:'tool'` message with the text
 *      "Tool call interrupted before completing — no result recorded." for
 *      each missing id (preserving `tool_calls` order) so the array is valid
 *      before the request is sent.
 *
 *   2. **Stray tool messages:** A `role:'tool'` message whose `tool_call_id`
 *      has no matching id in the immediately-preceding assistant `tool_calls`
 *      is also rejected. This function drops such stray messages.
 *
 * **When does bad history arise?**
 *
 *   - A session crashed / was interrupted between appending the assistant
 *     `tool_calls` message and appending the `role:'tool'` result messages.
 *   - A session is restored from a persisted sidecar (`resumeHistory`) that
 *     captured the assistant call but not the results (the text path used by
 *     `buildMessages` doesn't produce this shape, but structured replay paths
 *     could — and future work will expand replay fidelity).
 *
 * The injection point is the tail of `buildMessages` (`../messages.ts`), the
 * single assembly point for every outgoing request (`runIteration`,
 * compaction, fast-tier). It is the analog of `round-request.ts` in
 * anthropic-direct, where `repairOrphanToolUses` runs before every
 * `messages.create` call. This module mirrors that pattern for the OpenAI
 * wire format.
 *
 * Anthropic-direct analog:
 *   `src/agent/providers/anthropic-direct/query/repair-orphan-tool-uses.ts`
 *
 * Issue: #2417
 *
 * @module agent/providers/openai-compatible/query/repair-orphan-tool-calls
 */

import type { OpenAIMessage, OpenAIToolCall } from '../messages.js';

/** Interrupted-call placeholder — mirrors the anthropic-direct wording exactly. */
const INTERRUPTED_CONTENT =
  'Tool call interrupted before completing — no result recorded.';

/**
 * Extract the `tool_calls` id list from a message, deduplicated, or return
 * `null` when the message is not an assistant message with tool_calls.
 *
 * Deduplication: when a provider (or replay path) produces duplicate ids in
 * one assistant turn, only the first occurrence is kept so that the result
 * set remains minimal and each synthetic response is inserted exactly once.
 */
function getToolCallIds(msg: OpenAIMessage): string[] | null {
  if (msg.role !== 'assistant') return null;
  const tc: OpenAIToolCall[] | undefined = msg.tool_calls;
  if (!Array.isArray(tc) || tc.length === 0) return null;
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const c of tc) {
    if (typeof c.id === 'string' && !seen.has(c.id)) {
      seen.add(c.id);
      ids.push(c.id);
    }
  }
  return ids.length > 0 ? ids : null;
}

/**
 * Repair an OpenAI Chat Completions message array so that:
 *
 *   - Every assistant `tool_calls` turn is immediately followed by a
 *     contiguous run of `role:'tool'` messages covering all call ids.
 *     Missing ids get a synthetic error result inserted **in `tool_calls`
 *     declaration order** — interleaved among any real results so the output
 *     sequence matches the assistant's call order exactly.
 *
 *   - Stray `role:'tool'` messages — those not immediately after an assistant
 *     `tool_calls` message, or whose `tool_call_id` doesn't match any id in
 *     that assistant message — are dropped.
 *
 * The function returns the input array reference unchanged when no repair is
 * needed (fast path: no assistant tool_calls and no tool messages in history).
 * When repair is required it returns a new array; the original is left
 * untouched in either case.
 *
 * @param messages  The message array assembled by {@link buildMessages} before
 *                  being sent to the Chat Completions / Responses API.
 * @returns         The original array reference when no repair is needed (fast
 *                  path), or a new repaired array when invariants were violated.
 */
export function repairOrphanToolCalls(messages: OpenAIMessage[]): OpenAIMessage[] {
  if (messages.length === 0) return messages;

  // Fast path: skip the full scan when no message can possibly need repair.
  // Repair is needed when any assistant message carries tool_calls (potential
  // orphan or stray) OR when any tool message carries a defined tool_call_id
  // (potential stray with no owning assistant). When neither is true the array
  // is already valid and we return it as-is without allocating a new array.
  const hasAssistantToolCalls = messages.some(
    (m) => m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
  );
  const hasToolMessages = messages.some((m) => m.role === 'tool' && m.tool_call_id !== undefined);
  if (!hasAssistantToolCalls && !hasToolMessages) {
    return messages;
  }

  // Build the output in a single forward pass.
  // We accumulate messages one by one; when we encounter an assistant message
  // with tool_calls we remember its ids, then consume the immediately-following
  // tool messages, drop strays, and inject synthetics for missing ids.
  const out: OpenAIMessage[] = [];
  let i = 0;

  while (i < messages.length) {
    const msg = messages[i]!;
    const callIds = getToolCallIds(msg);

    if (callIds === null) {
      // Not an assistant+tool_calls message. Drop stray tool messages that
      // appear outside of a tool-call run (no owning assistant message) —
      // UNLESS tool_call_id is undefined, which is the Ollama shim shape
      // for tool results with no correlation id. Preserve those conservatively
      // rather than silently discarding valid model output.
      if (msg.role === 'tool') {
        if (msg.tool_call_id === undefined) {
          // Ollama-style: no id to match, preserve as-is.
          out.push(msg);
        }
        // else: stray with an id but no owning assistant — drop.
        i++;
        continue;
      }
      out.push(msg);
      i++;
      continue;
    }

    // This is an assistant message with tool_calls.
    out.push(msg);
    i++;

    // Collect the immediately-following contiguous run of role:'tool' messages.
    const toolMsgs: OpenAIMessage[] = [];
    while (i < messages.length && messages[i]!.role === 'tool') {
      toolMsgs.push(messages[i]!);
      i++;
    }

    // Index the existing tool messages by tool_call_id for O(1) lookup, and
    // collect Ollama-style messages (undefined id) to preserve in order.
    const ownedIds = new Set(callIds);
    const byId = new Map<string, OpenAIMessage>();
    const noIdMsgs: OpenAIMessage[] = [];
    for (const tm of toolMsgs) {
      const tcid = tm.tool_call_id;
      if (tcid === undefined) {
        // Ollama-style: no correlation id — preserve in encountered order.
        noIdMsgs.push(tm);
      } else if (typeof tcid === 'string' && ownedIds.has(tcid)) {
        byId.set(tcid, tm);
      }
      // else: stray with a defined id that doesn't belong to this assistant — drop.
    }

    // Emit Ollama-style results first (no id to place them by), then results in
    // `tool_calls` declaration order: the real message when present, otherwise a
    // synthetic placeholder. This keeps the output sequence aligned with the
    // assistant's call order rather than appending synthetics at the tail —
    // strict local OpenAI-compatible shims (e.g. llama.cpp, vLLM) require this.
    for (const msg of noIdMsgs) out.push(msg);
    for (const id of callIds) {
      const real = byId.get(id);
      if (real !== undefined) {
        out.push(real);
      } else {
        out.push({
          role: 'tool',
          content: INTERRUPTED_CONTENT,
          tool_call_id: id,
        });
      }
    }
  }

  return out;
}
