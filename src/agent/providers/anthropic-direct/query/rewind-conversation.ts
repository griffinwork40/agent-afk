/**
 * Conversation-rewind handler for {@link AnthropicDirectQuery} — the
 * provider half of the REPL "press Esc-Esc to edit a previous message"
 * feature.
 *
 * Two pure operations over `state.messages`:
 *
 *   - {@link listUserTurns} — enumerate the user-authored turns, newest-first,
 *     with a short single-line preview. Read-only. "User-authored" is the
 *     shared structural rule in `agent/content/user-authored.ts`: any message
 *     carrying a `tool_result` block is a tool-round carrier, never a target,
 *     whatever harness text (queued messages, `[vitals]`) rides beside it.
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

import type { MessageParam } from '@anthropic-ai/sdk/resources';
import type {
  ProviderRewindConversationResult,
  RewindTarget,
} from '../../../provider.js';
import { repairOrphanToolUses } from './repair-orphan-tool-uses.js';
import { isUserAuthoredTurn, messageText } from '../../../content/user-authored.js';
import { stripPreamble } from '../../../session/preamble-strip.js';
import type { SessionState } from './session-state.js';
import type { AbortCoordinator } from '../../shared/abort-coordinator.js';

const PREVIEW_MAX_CHARS = 72;

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
    if (message && isUserAuthoredTurn(message)) {
      targets.push({ turnIndex: i, preview: toPreview(stripPreamble(messageText(message.content))) });
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
  if (!target || !isUserAuthoredTurn(target)) {
    return { rewound: false, reason: 'invalid-target', messagesBefore, messagesAfter: messagesBefore };
  }

  // Framework context drained in front of the prompt ([placeholder-prevent],
  // bridge, jev digest) is not what the user typed: never reload it.
  const reloadText = stripPreamble(messageText(target.content));

  // Discard the target user turn and everything after it, in place.
  state.messages.splice(turnIndex);
  // Defensive: a completed turn ends with a resolved assistant message, so the
  // new tail is normally clean — but repair covers histories restored from an
  // older persist that leaked an orphan.
  repairOrphanToolUses(state.messages);
  // Journal the rewind as a truncate at the divergence (plus any repair).
  state.journalSync.sync(state.messages, { reason: 'rewind' });
  state.messageJournal?.mark('rewind', { turnIndex });

  return {
    rewound: true,
    reloadText,
    messagesBefore,
    messagesAfter: state.messages.length,
  };
}
