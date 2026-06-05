/**
 * Pure helpers for in-place history compaction in the `anthropic-direct`
 * provider. Kept side-effect-free so they can be unit-tested without an
 * Anthropic client.
 *
 * The provider's `messages: MessageParam[]` array grows unbounded across
 * turns. Compaction summarizes older turns into a short preamble while
 * preserving the last `keepLastN` raw user turns plus their tool rounds.
 *
 * Key invariant: every `tool_use` block must travel with its matching
 * `tool_result`. The boundary rule never splits a tool round because it
 * lands on a "fresh user turn" — a `role: 'user'` message whose content
 * carries no `tool_result` blocks.
 *
 * @module agent/providers/anthropic-direct/compact
 */
import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';
import type { AnthropicMessagesCreateParams } from './types.js';

/**
 * System instruction for the summarization call. Crafted to preserve what a
 * future turn actually needs: user intent and corrections, tool decisions
 * and outcomes, current state and next action, open questions, and key
 * facts discovered.
 */
export const COMPACT_SYSTEM_PROMPT = [
  'You are a conversation-summarization assistant. The user will paste a',
  'prior conversation between a user and an AI assistant that includes tool',
  'calls and tool results. Produce a concise but complete summary that lets',
  'the AI continue the conversation without losing track.',
  '',
  'Preserve, in this priority order:',
  '1. The user\'s original intent, explicit asks, constraints, corrections,',
  '   and preferences stated during the conversation.',
  '2. Tool decisions and their outcomes — file paths read or written, shell',
  '   commands run, search queries, URLs fetched, code edits made, tests',
  '   run, errors observed, and whether each action succeeded or failed.',
  '3. Current state: what has been completed, what remains unresolved, and',
  '   the safest next action.',
  '4. Open questions, pending decisions, blockers, and assumptions.',
  '5. Key facts the assistant discovered (function locations, schemas,',
  '   observed behaviors, important external findings).',
  '',
  'Drop prose narration, conversational filler, and exploratory dead-ends.',
  'Drop verbatim tool output unless an exact snippet, error, path, command,',
  'or result is needed for continuation.',
  'Do not invent details. If something is uncertain, mark it explicitly.',
  'Output plain text, no markdown headers. Aim for ~250 words; use up to',
  '~400 only when needed to preserve tool state or unresolved tasks.',
].join('\n');

/** Default key the summary message uses to flag itself in history. */
export const COMPACT_SUMMARY_HEADER = '[Compacted summary of earlier conversation]';

/** Default acknowledgement the synthetic assistant turn returns. */
export const COMPACT_ACK_TEXT =
  'Acknowledged. Continuing from the summary above.';

/**
 * Test whether a `MessageParam` represents a fresh user turn — i.e., real
 * user input rather than a tool-result follow-up the loop synthesized.
 *
 * String content is always fresh. Array content is fresh only if no block
 * is a `tool_result`.
 */
export function isFreshUserTurn(msg: MessageParam): boolean {
  if (msg.role !== 'user') return false;
  const content = msg.content;
  if (typeof content === 'string') return true;
  if (!Array.isArray(content)) return false;
  for (const block of content) {
    const t = (block as { type?: string }).type;
    if (t === 'tool_result') return false;
  }
  return true;
}

/**
 * Find the index in `messages` that marks the start of the kept tail. Walk
 * backwards counting fresh user turns; the boundary is the index of the
 * `keepLastN`-th fresh user turn from the end.
 *
 * Returns:
 *   - `-1` when there are fewer than `keepLastN` fresh user turns (caller
 *     should treat this as "history too short — no compaction").
 *   - An index `>= 0` otherwise. `messages.slice(boundary)` is the kept
 *     tail; `messages.slice(0, boundary)` is what gets summarized.
 *
 * The kept tail always starts with a fresh user turn so the synthetic
 * `[user_summary, assistant_ack]` preamble can be prepended without
 * breaking user/assistant alternation.
 */
export function findCompactionBoundary(
  messages: ReadonlyArray<MessageParam>,
  keepLastN: number,
): number {
  if (keepLastN <= 0) return messages.length;
  let count = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg && isFreshUserTurn(msg)) {
      count += 1;
      if (count === keepLastN) return i;
    }
  }
  return -1;
}

/**
 * Build the summarization request body. The older messages travel as the
 * conversation to summarize, prefixed by a single user instruction so the
 * model knows what to do.
 *
 * The returned params are non-streaming, tool-less, and suitable for a
 * one-shot `messages.create` call.
 */
export function buildSummarizationRequest(
  olderMessages: ReadonlyArray<MessageParam>,
  model: string,
  maxTokens: number,
): AnthropicMessagesCreateParams {
  // Render older messages as a plain transcript so the summarizer doesn't
  // need to interpret tool_use/tool_result block shapes — those are noise
  // for summarization and can confuse small models.
  const transcript = renderTranscript(olderMessages);
  return {
    model,
    max_tokens: maxTokens,
    system: COMPACT_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content:
          'Summarize the following conversation transcript. Follow the ' +
          'system instructions exactly.\n\n' +
          '<transcript>\n' +
          transcript +
          '\n</transcript>',
      },
    ],
    stream: true,
  };
}

/**
 * Splice in the synthetic preamble. Returns a new array; the caller decides
 * whether to assign it back to the provider's mutable `messages` slot.
 */
export function applyCompaction(
  messages: ReadonlyArray<MessageParam>,
  boundary: number,
  summaryText: string,
): MessageParam[] {
  const summaryBlock: MessageParam = {
    role: 'user',
    content: COMPACT_SUMMARY_HEADER + '\n\n' + summaryText,
  };
  const ackBlock: MessageParam = {
    role: 'assistant',
    content: COMPACT_ACK_TEXT,
  };
  return [summaryBlock, ackBlock, ...messages.slice(boundary)];
}

/**
 * Estimate input tokens saved by replacing `[0, boundary)` with the
 * synthetic preamble. Rough char/4 heuristic — good enough for a UX hint,
 * not for billing.
 */
export function estimateTokensSaved(
  before: ReadonlyArray<MessageParam>,
  boundary: number,
  summaryText: string,
): number {
  const droppedChars = countContentChars(before.slice(0, boundary));
  const addedChars =
    COMPACT_SUMMARY_HEADER.length + 2 + summaryText.length + COMPACT_ACK_TEXT.length;
  const delta = Math.max(0, droppedChars - addedChars);
  return Math.round(delta / 4);
}

/**
 * Render a slice of `MessageParam`s as a plain text transcript for the
 * summarizer. Tool-use blocks become `[tool: NAME args]`; tool-result
 * blocks become `[tool result: <text>]`; image blocks become `[image]`.
 */
function renderTranscript(messages: ReadonlyArray<MessageParam>): string {
  const lines: string[] = [];
  for (const msg of messages) {
    const speaker = msg.role === 'user' ? 'User' : 'Assistant';
    lines.push(speaker + ':');
    if (typeof msg.content === 'string') {
      lines.push(msg.content);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlockParam[]) {
        const t = (block as { type?: string }).type;
        if (t === 'text' && 'text' in block) {
          lines.push((block as { text: string }).text);
        } else if (t === 'tool_use') {
          const name = (block as { name?: string }).name ?? 'unknown';
          const inputJson = safeJson((block as { input?: unknown }).input);
          lines.push(`[tool call: ${name} ${inputJson}]`);
        } else if (t === 'tool_result') {
          const content = (block as { content?: unknown }).content;
          lines.push(`[tool result: ${stringifyToolResultContent(content)}]`);
        } else if (t === 'image') {
          lines.push('[image]');
        } else if (t === 'document') {
          lines.push('[document]');
        }
      }
    }
    lines.push('');
  }
  return lines.join('\n').trim();
}

function safeJson(v: unknown): string {
  try {
    const s = JSON.stringify(v);
    if (s.length > 240) return s.slice(0, 237) + '...';
    return s;
  } catch {
    return '{}';
  }
}

function stringifyToolResultContent(content: unknown): string {
  if (typeof content === 'string') {
    return content.length > 320 ? content.slice(0, 317) + '...' : content;
  }
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const block of content) {
      const t = (block as { type?: string }).type;
      if (t === 'text' && 'text' in (block as object)) {
        parts.push((block as { text: string }).text);
      }
    }
    const joined = parts.join(' ');
    return joined.length > 320 ? joined.slice(0, 317) + '...' : joined;
  }
  return '';
}

function countContentChars(messages: ReadonlyArray<MessageParam>): number {
  let total = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      total += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content as ContentBlockParam[]) {
        const t = (block as { type?: string }).type;
        if (t === 'text' && 'text' in block) {
          total += (block as { text: string }).text.length;
        } else if (t === 'tool_use') {
          total += safeJson((block as { input?: unknown }).input).length;
        } else if (t === 'tool_result') {
          total += stringifyToolResultContent(
            (block as { content?: unknown }).content,
          ).length;
        }
      }
    }
  }
  return total;
}
