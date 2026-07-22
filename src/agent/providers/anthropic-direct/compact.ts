/**
 * Anthropic-direct compaction: the `CompactionOps<MessageParam>` implementation
 * plus back-compatible wrappers over the provider-neutral core in
 * `shared/compaction.ts`.
 *
 * The generic algorithm (boundary walk, transcript render, preamble splice,
 * saved-tokens estimate) and the summarization prompt now live in shared/ so
 * every provider can reuse them. This file supplies only the Anthropic message
 * representation (`MessageParam`) — how a tool round renders to text, which
 * turns are "fresh user turns", and the shape of the synthetic preamble.
 *
 * Invariant: every `tool_use` block travels with its matching `tool_result`.
 * The boundary rule (via {@link isFreshUserTurn}) never splits a tool round
 * because it lands the kept tail on a `role: 'user'` message whose content
 * carries no `tool_result` blocks.
 *
 * The exported `findCompactionBoundary` / `applyCompaction` / `estimateTokensSaved`
 * / `buildSummarizationRequest` keep their original signatures so existing
 * callers (`query/compact-handler.ts`) and tests resolve unchanged — they are
 * thin adapters binding the shared generics to {@link anthropicCompactionOps}.
 *
 * @module agent/providers/anthropic-direct/compact
 */
import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';
import type { AnthropicMessagesCreateParams } from './types.js';
import {
  COMPACT_ACK_TEXT,
  COMPACT_SUMMARY_HEADER,
  COMPACT_SYSTEM_PROMPT,
  applyCompaction as sharedApplyCompaction,
  estimateTokensSaved as sharedEstimateTokensSaved,
  findCompactionBoundary as sharedFindCompactionBoundary,
  findCompactionBoundaryAdaptive as sharedFindCompactionBoundaryAdaptive,
  renderTranscript as sharedRenderTranscript,
  wrapTranscriptForSummary,
  type CompactionOps,
} from '../shared/compaction.js';

// Re-export the shared constants so existing importers (compact-handler.ts,
// compact.test.ts) keep resolving them from this module.
export { COMPACT_ACK_TEXT, COMPACT_SUMMARY_HEADER, COMPACT_SYSTEM_PROMPT };

/**
 * Test whether a `MessageParam` represents a fresh user turn — real user input
 * rather than a tool-result follow-up the loop synthesized.
 *
 * String content is always fresh. Array content is fresh only if no block is a
 * `tool_result`.
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
 * Render one Anthropic message as a transcript block: a speaker label followed
 * by its content. `tool_use` blocks become `[tool call: NAME args]`;
 * `tool_result` blocks become `[tool result: <text>]`; images/documents become
 * short placeholders. Kept side-effect-free and stable so the summarizer input
 * (and thus summary quality) does not drift.
 */
function renderMessage(msg: MessageParam): string {
  const speaker = msg.role === 'user' ? 'User' : 'Assistant';
  const lines: string[] = [speaker + ':'];
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
  return lines.join('\n');
}

/** Approximate content-character count for one message (saved-tokens estimate). */
function countChars(msg: MessageParam): number {
  let total = 0;
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
        total += stringifyToolResultContent((block as { content?: unknown }).content).length;
      }
    }
  }
  return total;
}

/** Anthropic message-representation primitives for the shared compaction core. */
export const anthropicCompactionOps: CompactionOps<MessageParam> = {
  isFreshUserTurn,
  renderMessage,
  buildPreamble(summaryText: string): [MessageParam, MessageParam] {
    return [
      { role: 'user', content: COMPACT_SUMMARY_HEADER + '\n\n' + summaryText },
      { role: 'assistant', content: COMPACT_ACK_TEXT },
    ];
  },
  countChars,
};

/**
 * Find the index in `messages` that marks the start of the kept tail. Thin
 * adapter over the shared generic bound to {@link anthropicCompactionOps}.
 *
 * Returns `-1` when there are fewer than `keepLastN` fresh user turns; an index
 * `>= 0` otherwise (`messages.slice(boundary)` is the kept tail).
 */
export function findCompactionBoundary(
  messages: ReadonlyArray<MessageParam>,
  keepLastN: number,
): number {
  return sharedFindCompactionBoundary(messages, keepLastN, anthropicCompactionOps);
}

/**
 * Boundary selection with the token-fullness fallback. Thin adapter over the
 * shared {@link sharedFindCompactionBoundaryAdaptive} bound to
 * {@link anthropicCompactionOps}. See the shared docs: when the turn-count
 * keep-window is a no-op but `usedFraction >= shrinkAtFraction`, the keep-window
 * relaxes toward 1 turn so a short-but-full session can still be compacted.
 */
export function findCompactionBoundaryAdaptive(
  messages: ReadonlyArray<MessageParam>,
  keepLastN: number,
  usedFraction: number,
  shrinkAtFraction: number,
): number {
  return sharedFindCompactionBoundaryAdaptive(
    messages,
    keepLastN,
    anthropicCompactionOps,
    usedFraction,
    shrinkAtFraction,
  );
}

/**
 * Build the summarization request body. The older messages travel as a rendered
 * transcript, prefixed by a single user instruction. Non-streaming-safe,
 * tool-less, suitable for a one-shot `messages.create` call.
 */
export function buildSummarizationRequest(
  olderMessages: ReadonlyArray<MessageParam>,
  model: string,
  maxTokens: number,
): AnthropicMessagesCreateParams {
  const transcript = sharedRenderTranscript(olderMessages, anthropicCompactionOps);
  return {
    model,
    max_tokens: maxTokens,
    system: COMPACT_SYSTEM_PROMPT,
    messages: [{ role: 'user', content: wrapTranscriptForSummary(transcript) }],
    stream: true,
  };
}

/**
 * Splice in the synthetic preamble. Thin adapter over the shared generic bound
 * to {@link anthropicCompactionOps}. Returns a new array.
 */
export function applyCompaction(
  messages: ReadonlyArray<MessageParam>,
  boundary: number,
  summaryText: string,
): MessageParam[] {
  return sharedApplyCompaction(messages, boundary, summaryText, anthropicCompactionOps);
}

/**
 * Estimate input tokens saved by replacing `[0, boundary)` with the synthetic
 * preamble. Thin adapter over the shared generic.
 */
export function estimateTokensSaved(
  before: ReadonlyArray<MessageParam>,
  boundary: number,
  summaryText: string,
): number {
  return sharedEstimateTokensSaved(before, boundary, summaryText, anthropicCompactionOps);
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
