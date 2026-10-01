/**
 * Conversation-rewind handler for {@link OpenAICompatibleQuery} — the
 * provider half of the REPL "press Esc-Esc to edit a previous message" feature.
 *
 * Mirrors `anthropic-direct/query/rewind-conversation.ts` on the OpenAI
 * message shape. Two pure operations over `priorTurns`:
 *
 *   - {@link listOpenAIUserTurns} — enumerate genuine user-text turns
 *     (skipping pure tool-result user messages), newest-first.
 *
 *   - {@link rewindOpenAIConversation} — discard a chosen user turn and
 *     everything after it. Returns the removed message's text so the surface
 *     can reload it into the input for editing.
 *
 * # Why in-place splice is safe
 *
 * `priorTurns` is a stable array reference mutated by `dispatchAndAppend`
 * and `compact`. Rewind uses the same in-place `splice` so the loop's held
 * reference stays valid. The `abort.isIdle()` guard (matching anthropic-direct)
 * prevents races with an in-flight tool round.
 *
 * @module agent/providers/openai-compatible/query/rewind-conversation
 */

import type {
  ProviderRewindConversationResult,
  RewindTarget,
} from '../../../provider.js';
import type { OpenAIMessage } from '../messages.js';
import type { AbortCoordinator } from '../../shared/abort-coordinator.js';

const PREVIEW_MAX_CHARS = 72;

/** Extract text content from an OpenAI message (role:'user' | 'assistant'). */
function extractOpenAIText(content: OpenAIMessage['content']): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const parts: string[] = [];
  for (const block of content as Array<{ type?: string; text?: string }>) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join(' ');
}

/**
 * A "genuine" user turn is one the user typed — role `user` with at least one
 * non-empty text block. Pure tool-result messages (which also have role `user`
 * in OpenAI's wire format) carry only tool-result content blocks and so are
 * excluded automatically by the text-extraction check.
 */
function isGenuineUserTurn(msg: OpenAIMessage): boolean {
  if (msg.role !== 'user') return false;
  // Tool-result messages use role:'tool' in the OpenAI wire format; the only
  // role:'user' messages that slip through are synthetic ones injected by
  // `harnessUserMessage` (queued_user_message). Both should be rewindable if
  // they contain text, so the text check is the right gate.
  // Note: image-only synthetic user turns (no extractable text) fail this
  // check and are intentionally unrewindable — same behaviour as anthropic-direct.
  return extractOpenAIText(msg.content).trim().length > 0;
}

function toPreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= PREVIEW_MAX_CHARS) return flat;
  return flat.slice(0, PREVIEW_MAX_CHARS - 1) + '…';
}

/**
 * Enumerate genuine user-text turns in `priorTurns`, newest-first.
 * `turnIndex` is the index in `priorTurns` — the token consumed by
 * {@link rewindOpenAIConversation}. Pure; does not mutate.
 */
export function listOpenAIUserTurns(priorTurns: readonly OpenAIMessage[]): RewindTarget[] {
  const targets: RewindTarget[] = [];
  for (let i = 0; i < priorTurns.length; i++) {
    const msg = priorTurns[i];
    if (msg && isGenuineUserTurn(msg)) {
      targets.push({ turnIndex: i, preview: toPreview(extractOpenAIText(msg.content)) });
    }
  }
  return targets.reverse();
}

/**
 * Rewind to `turnIndex`: discard that user turn and everything after it.
 * Mutates `priorTurns` in place on success; leaves history untouched on every
 * no-op path (session closed, turn in-flight, out-of-range, not a user turn).
 */
export function rewindOpenAIConversation(
  priorTurns: OpenAIMessage[],
  abort: AbortCoordinator,
  closed: boolean,
  turnIndex: number,
): ProviderRewindConversationResult {
  const messagesBefore = priorTurns.length;

  if (closed) {
    return { rewound: false, reason: 'session-closed', messagesBefore, messagesAfter: messagesBefore };
  }
  if (!abort.isIdle()) {
    return { rewound: false, reason: 'turn-in-flight', messagesBefore, messagesAfter: messagesBefore };
  }
  if (!Number.isInteger(turnIndex) || turnIndex < 0 || turnIndex >= messagesBefore) {
    return { rewound: false, reason: 'invalid-target', messagesBefore, messagesAfter: messagesBefore };
  }
  const target = priorTurns[turnIndex];
  if (!target || !isGenuineUserTurn(target)) {
    return { rewound: false, reason: 'invalid-target', messagesBefore, messagesAfter: messagesBefore };
  }

  const reloadText = extractOpenAIText(target.content);
  priorTurns.splice(turnIndex);

  return {
    rewound: true,
    reloadText,
    messagesBefore,
    messagesAfter: priorTurns.length,
  };
}
