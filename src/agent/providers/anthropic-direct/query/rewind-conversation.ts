/**
 * Conversation-rewind handler for {@link AnthropicDirectQuery} — the
 * provider half of the REPL "press Esc-Esc to edit a previous message"
 * feature.
 *
 * Two pure operations over `state.messages`:
 *
 *   - {@link listUserTurns} — enumerate the genuine user-text turns
 *     (skipping pure `tool_result` user messages), newest-first, with a
 *     short single-line preview. Read-only.
 *
 *   - {@link rewindConversationHistory} — discard a chosen user turn and
 *     everything after it, then run {@link repairOrphanToolUses} so the new
 *     tail never ends on an assistant `tool_use` without its `tool_result`
 *     (Anthropic API contract). Returns the removed message's text so the
 *     surface can reload it into the input for editing.
 *
 * # Why in-place splice is safe here
 *
 * Invariant: this mutates `state.messages` in place (`splice`) rather than
 * reassigning — identical to how `compact-handler.ts` applies compaction —
 * so the loop's held array reference and the identity-based tests stay
 * valid. The race that would make an unguarded splice dangerous (auto-compact
 * splicing the SAME array after a turn) is closed by the same `abort.isIdle()`
 * interlock `compact()` uses: rewind only proceeds when no turn is in flight.
 * The REPL only offers rewind at the idle prompt, so this is belt-and-braces.
 *
 * @module agent/providers/anthropic-direct/query/rewind-conversation
 */

import type { ContentBlockParam, MessageParam } from '@anthropic-ai/sdk/resources';
import type {
  ProviderRewindConversationResult,
  RewindTarget,
} from '../../../provider.js';
import { repairOrphanToolUses } from './repair-orphan-tool-uses.js';
import type { SessionState } from './session-state.js';
import type { AbortCoordinator } from './abort-coordinator.js';

const PREVIEW_MAX_CHARS = 72;

/** Concatenate the text blocks of a user message into a single string. */
function extractUserText(content: MessageParam['content']): string {
  if (typeof content === 'string') return content;
  const parts: string[] = [];
  for (const block of content as ContentBlockParam[]) {
    if (block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    }
  }
  return parts.join(' ');
}

/**
 * A "genuine" user turn is one the user actually typed — role `user` with at
 * least one non-empty text block. Pure `tool_result` user messages (the
 * synthetic turns that carry tool output back to the model) are excluded:
 * they are not rewind targets and truncating at one would strand the paired
 * `tool_use`.
 */
function isGenuineUserTurn(message: MessageParam): boolean {
  if (message.role !== 'user') return false;
  return extractUserText(message.content).trim().length > 0;
}

/** Collapse whitespace to single spaces and truncate for a one-line preview. */
function toPreview(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= PREVIEW_MAX_CHARS) return flat;
  return flat.slice(0, PREVIEW_MAX_CHARS - 1) + '…';
}

/**
 * Enumerate the genuine user-text turns, newest-first. `turnIndex` is the
 * message's index in `messages` — the handle {@link rewindConversationHistory}
 * consumes. Pure; does not mutate.
 */
export function listUserTurns(messages: readonly MessageParam[]): RewindTarget[] {
  const targets: RewindTarget[] = [];
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message && isGenuineUserTurn(message)) {
      targets.push({ turnIndex: i, preview: toPreview(extractUserText(message.content)) });
    }
  }
  // Newest-first so the most-recent prompt sits at the top of the picker.
  return targets.reverse();
}

/** Injected collaborators for {@link rewindConversationHistory}. */
export interface RewindHandlerDeps {
  state: SessionState;
  abort: AbortCoordinator;
}

/**
 * Rewind to `turnIndex`: discard that user turn and everything after it.
 * Mutates `state.messages` in place on success; leaves history untouched on
 * every no-op path (closed, in-flight, out-of-range, not-a-user-turn).
 */
export function rewindConversationHistory(
  deps: RewindHandlerDeps,
  turnIndex: number,
): ProviderRewindConversationResult {
  const { state, abort } = deps;
  const messagesBefore = state.messages.length;

  if (state.closed) {
    return { rewound: false, reason: 'session-closed', messagesBefore, messagesAfter: messagesBefore };
  }
  if (!abort.isIdle()) {
    return { rewound: false, reason: 'turn-in-flight', messagesBefore, messagesAfter: messagesBefore };
  }
  if (!Number.isInteger(turnIndex) || turnIndex < 0 || turnIndex >= messagesBefore) {
    return { rewound: false, reason: 'invalid-target', messagesBefore, messagesAfter: messagesBefore };
  }
  const target = state.messages[turnIndex];
  if (!target || !isGenuineUserTurn(target)) {
    return { rewound: false, reason: 'invalid-target', messagesBefore, messagesAfter: messagesBefore };
  }

  const reloadText = extractUserText(target.content);

  // Discard the target user turn and everything after it, in place.
  state.messages.splice(turnIndex);
  // Defensive: a completed turn ends with a resolved assistant message, so the
  // new tail is normally clean — but repair covers histories restored from an
  // older persist that leaked an orphan.
  repairOrphanToolUses(state.messages);

  return {
    rewound: true,
    reloadText,
    messagesBefore,
    messagesAfter: state.messages.length,
  };
}
