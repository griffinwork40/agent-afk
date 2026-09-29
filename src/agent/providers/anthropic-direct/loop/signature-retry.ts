/**
 * One-shot retry for Anthropic HTTP 400 "invalid signature in thinking block".
 *
 * When a provider switch (e.g. Anthropic → OpenAI → Anthropic) replays a turn
 * that contains earlier-turn thinking blocks, Anthropic may reject the request
 * because signatures from a previous session are no longer accepted. The fix is
 * to strip `thinking` and `redacted_thinking` blocks from assistant messages in
 * EARLIER turns (before the last real user turn) and retry once. In-flight
 * thinking (after the last real user turn) must be preserved — the API requires
 * it to balance tool_use blocks emitted in that same loop.
 *
 * Contract: `stripEarlierThinking` is pure and returns a new array; the caller
 * decides whether to mutate the working messages array in place. We DO mutate it
 * (`input.messages.splice(0, …, ...stripped)`) so subsequent rounds in the same
 * tool loop do not re-fail with the same stale signatures. The journal differ
 * records this as a truncate+re-append, which is fine for this rare path.
 *
 * @module agent/providers/anthropic-direct/loop/signature-retry
 */

import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';

/** Block types that carry Anthropic-session-specific signatures. */
const THINKING_TYPES = new Set<string>(['thinking', 'redacted_thinking']);

/**
 * Classify an error as the Anthropic HTTP 400 "invalid signature" rejection.
 *
 * Positive match requires BOTH the HTTP status (400) and a message that
 * mentions `signature` in a thinking-block context. A plain 400 for an
 * unrelated reason (e.g. bad tool schema, missing field) must NOT trigger
 * the retry.
 *
 * The Anthropic SDK surfaces the HTTP status as `error.status` on its typed
 * error subclasses; we also check `error.message` for the numeric literal
 * "400" as a belt-and-braces fallback for plain `Error` wrappings and mocks
 * in tests.
 */
export function isInvalidSignatureError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const msg = err.message;
  if (!msg.includes('signature') || !msg.toLowerCase().includes('thinking')) return false;
  // The SDK's BadRequestError sets `.status = 400`.
  const status = (err as unknown as Record<string, unknown>)['status'];
  if (status === 400) return true;
  // Fallback: the stringified error text contains the status code.
  return msg.includes('400');
}

/**
 * Return the index of the last "real" user message — a user message that
 * is NOT purely `tool_result` blocks (i.e. an actual human turn, not a
 * synthetic tool-results commit). In-flight thinking sits after this index.
 */
function lastRealUserIndex(messages: MessageParam[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i]!;
    if (msg.role !== 'user') continue;
    const content = msg.content;
    if (typeof content === 'string') return i;   // plain text — definitely real
    const blocks = content as ContentBlockParam[];
    const allToolResults = blocks.every((b) => b.type === 'tool_result');
    if (!allToolResults) return i;
  }
  return -1;
}

/**
 * Strip `thinking` and `redacted_thinking` blocks from every assistant message
 * whose index is BEFORE `lastRealUserIdx`. Returns a new array (pure).
 *
 * Contract: when stripping empties an assistant message's content array, replace
 * it with a minimal `[{type:'text', text:'...'}]` placeholder to keep the
 * user↔assistant alternation valid. This mirrors what `filterContentBlocks`
 * does on resume — the API rejects empty content arrays.
 */
export function stripEarlierThinking(
  messages: MessageParam[],
  lastRealUserIdx: number,
): MessageParam[] {
  return messages.map((msg, i) => {
    if (i >= lastRealUserIdx) return msg;          // in-flight window — keep as-is
    if (msg.role !== 'assistant') return msg;
    const content = msg.content;
    if (typeof content === 'string') return msg;   // plain string — no blocks to strip
    const blocks = content as ContentBlockParam[];
    const stripped = blocks.filter((b) => !THINKING_TYPES.has(b.type));
    if (stripped.length === blocks.length) return msg; // nothing changed
    const finalBlocks: ContentBlockParam[] =
      stripped.length > 0 ? stripped : [{ type: 'text', text: '[thinking redacted]' }];
    return { role: 'assistant' as const, content: finalBlocks };
  });
}

/**
 * Build the stripped message array for the one-shot signature retry.
 *
 * Returns `null` when there is nothing to strip (no earlier-turn thinking
 * found) — the caller should NOT retry in that case.
 */
export function buildSignatureRetryMessages(
  messages: MessageParam[],
): MessageParam[] | null {
  const lastRealUserIdx = lastRealUserIndex(messages);
  // Nothing before the last real user message → nothing earlier to strip.
  if (lastRealUserIdx <= 0) return null;
  // Check if any earlier assistant turn actually has thinking blocks.
  let hasThinking = false;
  for (let i = 0; i < lastRealUserIdx; i++) {
    const msg = messages[i]!;
    if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;
    const blocks = msg.content as ContentBlockParam[];
    if (blocks.some((b) => THINKING_TYPES.has(b.type))) {
      hasThinking = true;
      break;
    }
  }
  if (!hasThinking) return null;
  return stripEarlierThinking(messages, lastRealUserIdx);
}
