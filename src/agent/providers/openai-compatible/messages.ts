/**
 * Conversation-history → OpenAI Chat Completions message-array builder.
 *
 * Separated from `query.ts` so it's trivially unit-testable. Builds the
 * `messages: [{ role, content }, ...]` array that Chat Completions expects,
 * threading system prompt, prior turns (from `resumeHistory`), and the
 * current user turn.
 *
 * @module agent/providers/openai-compatible/messages
 */

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources';
import type { AgentConfig, ResumeHistoryTurn } from '../../types/config-types.js';
import type { ProviderUserTurn } from '../../provider.js';

/** Minimal OpenAI Chat Completions message shape. We type structurally so this
 * module doesn't import the OpenAI SDK. */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  tool_call_id?: string;
  /**
   * Reasoning-trace echo. DeepSeek-R1 and other thinking-mode models on
   * OpenAI-compatible endpoints emit a `reasoning_content` field separate
   * from `content` in their responses; DeepSeek's API rejects subsequent
   * requests with a 400 ("The `reasoning_content` in the thinking mode must
   * be passed back to the API") unless that field is echoed back on the
   * assistant turn it came from. Real OpenAI's o-series doesn't expose its
   * reasoning, so this field stays absent for those calls and the wire
   * stays bog-standard OpenAI. Only populated when the previous response
   * actually produced reasoning text — empty/absent fields are stripped at
   * the serialization seam in `query.ts:defaultClientFactory`.
   */
  reasoning_content?: string;
  // Future: tool_calls array on assistant messages. Slice 3 territory.
}

/**
 * Flatten an AFK `ProviderUserTurn` into the plain-text string OpenAI's
 * `content` field expects. Image blocks are stubbed to `[image omitted]`
 * for parity with the legacy openai-codex flatten at lines 496–506 of that
 * file — vision-capable Chat Completions takes a content-block array shape
 * that we'll add later when image paste matters for OpenAI.
 */
export function flattenUserContent(content: ProviderUserTurn['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((block: ContentBlockParam) => {
      if (typeof block === 'object' && block && 'type' in block) {
        if (block.type === 'text') return block.text;
        if (block.type === 'image') return '[image omitted]';
      }
      return '';
    })
    .join('\n');
}

/**
 * Resolve a plain string `systemPrompt` from the AgentConfig permutations.
 *
 * AFK's `systemPrompt` may be:
 *   - a string (use as-is)
 *   - `{ type: 'preset', preset: 'claude_code', append? }` — Anthropic-only
 *     concept; for OpenAI we drop the preset and use only the append portion
 *   - undefined
 *
 * Mirrors `openai-codex.ts:resolveSystemPromptString` behavior so users
 * migrating from the legacy provider see the same effective prompt.
 */
export function resolveSystemPrompt(config: AgentConfig): string | undefined {
  const sp = config.systemPrompt;
  if (sp === undefined) return undefined;
  if (typeof sp === 'string') return sp.length > 0 ? sp : undefined;
  if (typeof sp === 'object' && sp !== null && 'append' in sp) {
    const append = (sp as { append?: string }).append;
    return append && append.length > 0 ? append : undefined;
  }
  return undefined;
}

/**
 * Build the full `messages[]` array for a Chat Completions request.
 *
 * Order:
 *   1. system message (if any)
 *   2. resumeHistory turns expanded to alternating user/assistant pairs
 *   3. accumulated assistant/tool messages from prior loop iterations this
 *      session (passed in as `priorTurns` — slice 3 will use this for the
 *      tool-call ping-pong)
 *   4. the new user turn (if provided)
 */
export function buildMessages(args: {
  config: AgentConfig;
  resumeHistory?: ResumeHistoryTurn[];
  priorTurns?: OpenAIMessage[];
  currentUserText?: string;
}): OpenAIMessage[] {
  const messages: OpenAIMessage[] = [];

  const sys = resolveSystemPrompt(args.config);
  if (sys !== undefined) {
    messages.push({ role: 'system', content: sys });
  }

  if (args.resumeHistory) {
    for (const turn of args.resumeHistory) {
      if (turn.user) messages.push({ role: 'user', content: turn.user });
      if (turn.assistant) messages.push({ role: 'assistant', content: turn.assistant });
    }
  }

  if (args.priorTurns) {
    for (const m of args.priorTurns) messages.push(m);
  }

  if (args.currentUserText !== undefined) {
    messages.push({ role: 'user', content: args.currentUserText });
  }

  return messages;
}
