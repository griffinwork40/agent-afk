/**
 * Conversation-rewind handler for {@link OpenAICompatibleQuery} — the
 * provider half of the REPL "press Esc-Esc to edit a previous message" feature.
 *
 * Mirrors `anthropic-direct/query/rewind-conversation.ts` on the OpenAI
 * message shape. Two pure operations over `priorTurns`:
 *
 *   - {@link listOpenAIUserTurns} — enumerate user-authored turns, newest-first,
 *     via the shared structural rule in `agent/content/user-authored.ts`.
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
import { isUserAuthoredTurn, messageText } from '../../../content/user-authored.js';
import { stripPreamble } from '../../../session/preamble-strip.js';

const PREVIEW_MAX_CHARS = 72;

// Tool output uses role:'tool' in the OpenAI wire format, so it fails the
// shared rule's role check. Queued mid-turn messages (`harnessUserMessage`) are
// pushed as their own role:'user' messages (dispatch-append.ts) and stay
// rewindable. Image-only user turns have no text and are not targets.

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
    if (msg && isUserAuthoredTurn(msg)) {
      targets.push({ turnIndex: i, preview: toPreview(stripPreamble(messageText(msg.content))) });
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
  if (!target || !isUserAuthoredTurn(target)) {
    return { rewound: false, reason: 'invalid-target', messagesBefore, messagesAfter: messagesBefore };
  }

  // Framework context drained in front of the prompt ([placeholder-prevent],
  // bridge, jev digest) is not what the user typed: never reload it.
  const reloadText = stripPreamble(messageText(target.content));
  priorTurns.splice(turnIndex);

  return {
    rewound: true,
    reloadText,
    messagesBefore,
    messagesAfter: priorTurns.length,
  };
}
