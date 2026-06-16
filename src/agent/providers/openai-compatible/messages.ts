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

/**
 * A single OpenAI Chat Completions content part. The multimodal `content`
 * array shape (text + images) vision-capable models accept. We type
 * structurally so this module doesn't import the OpenAI SDK — these mirror
 * `ChatCompletionContentPartText` / `ChatCompletionContentPartImage` from
 * `openai@6`. `image_url.url` carries a `data:<mime>;base64,<data>` URI.
 */
export interface OpenAITextPart {
  type: 'text';
  text: string;
}
export interface OpenAIImagePart {
  type: 'image_url';
  image_url: { url: string };
}
export type OpenAIContentPart = OpenAITextPart | OpenAIImagePart;

/** Minimal OpenAI Chat Completions message shape. We type structurally so this
 * module doesn't import the OpenAI SDK. `content` is a plain string for
 * text-only turns, or a `OpenAIContentPart[]` when a vision-capable user turn
 * carries images. */
export interface OpenAIMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | OpenAIContentPart[];
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
 * Synthetic notice substituted for image content when the active model cannot
 * see images. Written as an instruction so the model both (a) understands an
 * image arrived and (b) tells the user it can't view it — the graceful-failure
 * contract for issue #127. `model` is folded in when known so the user learns
 * which model is the limitation.
 */
export function imageOmittedNotice(model: string | undefined, count: number): string {
  const subject = count === 1 ? 'An image was' : `${count} images were`;
  const noun = count === 1 ? 'an image' : 'images';
  const them = count === 1 ? 'it' : 'them';
  const modelLabel =
    model && model.trim().length > 0 ? `the current model ("${model.trim()}")` : 'the current model';
  return (
    `[${subject} attached to this message, but ${modelLabel} cannot view images. ` +
    `Acknowledge to the user that you received ${noun} but are unable to see ${them}, ` +
    `and suggest switching to a vision-capable model (e.g. gpt-4o or a Claude model).]`
  );
}

/**
 * Convert an Anthropic image `ContentBlockParam` into an OpenAI
 * `image_url.url` data-URI (or pass through a remote URL source). Returns
 * `null` for shapes we can't represent. AFK only ever emits base64 sources
 * (Telegram, CLI paste, tool results), but we tolerate URL sources too.
 */
function imageBlockToUrl(block: Extract<ContentBlockParam, { type: 'image' }>): string | null {
  const source = block.source;
  if (source.type === 'base64') {
    return `data:${source.media_type};base64,${source.data}`;
  }
  if (source.type === 'url') {
    return source.url;
  }
  return null;
}

/**
 * Flatten an AFK `ProviderUserTurn` into the plain-text string OpenAI's
 * `content` field expects, for the NON-vision path. Text blocks are joined;
 * any image blocks collapse into a single trailing {@link imageOmittedNotice}
 * so the model is told an image arrived and to inform the user — rather than
 * silently dropping the payload (issue #127).
 */
export function flattenUserContent(
  content: ProviderUserTurn['content'],
  model?: string,
): string {
  if (typeof content === 'string') return content;
  const textSegments: string[] = [];
  let imageCount = 0;
  for (const block of content) {
    if (typeof block === 'object' && block && 'type' in block) {
      if (block.type === 'text') textSegments.push(block.text);
      else if (block.type === 'image') imageCount += 1;
    }
  }
  const text = textSegments.join('\n');
  if (imageCount === 0) return text;
  const notice = imageOmittedNotice(model, imageCount);
  return text.length > 0 ? `${text}\n\n${notice}` : notice;
}

/**
 * Build the OpenAI `content` for a user turn from AFK's `ProviderUserTurn`
 * content, honoring vision capability (issue #127):
 *   - string content passes through unchanged;
 *   - vision-capable model + image blocks → a multimodal `OpenAIContentPart[]`
 *     (text parts + `image_url` data-URIs);
 *   - non-vision model → a flattened string with the graceful image notice.
 */
export function buildUserContent(
  content: ProviderUserTurn['content'],
  opts: { vision: boolean; model: string },
): string | OpenAIContentPart[] {
  if (typeof content === 'string') return content;
  if (!opts.vision) return flattenUserContent(content, opts.model);

  const parts: OpenAIContentPart[] = [];
  let hasImage = false;
  for (const block of content) {
    if (typeof block === 'object' && block && 'type' in block) {
      if (block.type === 'text') {
        parts.push({ type: 'text', text: block.text });
      } else if (block.type === 'image') {
        const url = imageBlockToUrl(block);
        if (url !== null) {
          parts.push({ type: 'image_url', image_url: { url } });
          hasImage = true;
        }
      }
    }
  }
  // No representable image → keep the plain string wire shape (also covers the
  // all-text multi-block and empty cases, and avoids an empty parts array that
  // some endpoints reject). Only emit the multimodal array when an image rides
  // along.
  if (!hasImage) return flattenUserContent(content, opts.model);
  return parts;
}

/**
 * Flatten an already-built OpenAI content value to a string, replacing any
 * image parts with a short placeholder. Used by {@link buildMessages} to
 * defensively down-convert history when the active model has no vision (a
 * mid-session `/model` switch can leave image parts in prior turns; sending
 * them to a text-only endpoint risks a 400).
 */
function flattenOpenAIParts(content: string | OpenAIContentPart[]): string {
  if (typeof content === 'string') return content;
  const textSegments: string[] = [];
  let imageCount = 0;
  for (const part of content) {
    if (part.type === 'text') textSegments.push(part.text);
    else imageCount += 1;
  }
  const text = textSegments.join('\n');
  if (imageCount === 0) return text;
  const placeholder = '[image not shown — the current model cannot view images]';
  return text.length > 0 ? `${text}\n\n${placeholder}` : placeholder;
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
  /**
   * Whether the target model accepts image input. When `false`, any image
   * parts still present in `priorTurns` are down-converted to text so no image
   * payload reaches a text-only endpoint (defends against a mid-session
   * `/model` switch from a vision model). Defaults to `true` (pass-through).
   */
  vision?: boolean;
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

  if (args.vision === false) {
    // Only ARRAY content (the multimodal vision shape: text + image_url parts)
    // needs down-converting to text for a non-vision endpoint. String content
    // is already text, and `null` content — which an assistant tool-call turn
    // legitimately carries (see `assistantMessageWithToolCalls`, whose
    // `content` is `null` on a tool-only turn) — must pass through untouched.
    //
    // Regression: the previous `typeof m.content === 'string' ? m : …` guard
    // sent that `null` into `flattenOpenAIParts`, whose `for (const part of
    // content)` threw `TypeError: <x> is not iterable` and crashed the SECOND
    // iteration of every tool-using turn on a non-vision model (the model's
    // tool-only assistant turn lands in `priorTurns` with `content: null`,
    // then the next request rebuild hits this map). `OpenAIMessage.content`'s
    // type omits `null`, so the `as unknown as OpenAIMessage` casts at the
    // priorTurns push sites hid the gap from the compiler.
    return messages.map((m) =>
      Array.isArray(m.content) ? { ...m, content: flattenOpenAIParts(m.content) } : m,
    );
  }

  return messages;
}
