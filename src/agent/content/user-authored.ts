/**
 * The single "did the user author this message?" classifier, shared by every
 * consumer that walks conversation history looking for human turns: the
 * Esc-Esc rewind listers of both providers and the journal transcript replay.
 *
 * Invariant: the decision is STRUCTURAL, never textual. A role:user message
 * that carries a `tool_result` block is a tool-round carrier: the harness
 * appends its own sibling text blocks there (queued messages from a promoted
 * subagent, the per-round `[vitals]` note; see
 * `providers/anthropic-direct/loop/tool-results.ts`), so its text is never a
 * human turn. Treating it as one floods the rewind picker with every tool
 * round, and truncating at one discards real tool results, orphans the
 * preceding `tool_use`, and makes orphan repair fabricate an error result.
 * Text a human typed mid-turn is pushed as its own text-only user message
 * (`anthropic-direct/loop/inter-round.ts`, `openai-compatible` queued
 * messages), so it stays a human turn under this rule.
 *
 * The shapes are typed structurally so Anthropic `MessageParam`, OpenAI
 * `OpenAIMessage` (tool output is role:'tool', so it fails the role check),
 * and journal `JournalMessage` all fit without importing any SDK.
 *
 * @module agent/content/user-authored
 */

/** Any content block: a `type` discriminant and, for text blocks, `text`. */
export interface BlockLike {
  readonly type: string;
  readonly text?: unknown;
}

/** Any chat message: a role and either a plain string or a block array. */
export interface MessageLike {
  readonly role: string;
  readonly content: string | readonly BlockLike[] | null | undefined;
}

/** True when the content array carries at least one `tool_result` block. */
export function hasToolResultBlock(content: MessageLike['content']): boolean {
  return Array.isArray(content) && content.some((block) => block.type === 'tool_result');
}

/** The text blocks of a message joined with `separator` (plain strings pass through). */
export function messageText(content: MessageLike['content'], separator = ' '): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text);
  }
  return parts.join(separator);
}

/**
 * True for a message a human authored: role `user`, no `tool_result` block,
 * and at least one non-empty text block. Image-only turns are excluded (there
 * is no text to preview or reload).
 */
export function isUserAuthoredTurn(message: MessageLike): boolean {
  if (message.role !== 'user') return false;
  if (hasToolResultBlock(message.content)) return false;
  return messageText(message.content).trim().length > 0;
}
