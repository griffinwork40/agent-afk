/**
 * Next-turn context injections drained at the top of every REPL turn, plus
 * the presence turn-state marker. Extracted from `runInputLoop` so adding a
 * new injection source never grows that grandfathered function.
 *
 * Invariant: drain order fixes prompt order. Each drain PREPENDS, so the last
 * one drained sits first in the prompt: peer messages, then background
 * results, then shell output, then the user's text. Every drain is one-shot
 * (its buffer clears on read), so a single turn carries everything that
 * accumulated since the previous one.
 *
 * @module cli/commands/interactive/loop-iteration.injections
 */

import { setPresenceTurnState } from '../../../agent/awareness/presence.peer.js';
import {
  setPresenceActivityPromptHead,
  setPresenceActivityTurnEnd,
} from '../../../agent/awareness/presence.activity.js';

/**
 * User-message text seeded when a pending injection auto-resumes an idle REPL.
 * The injected envelope(s) are prepended at drain time (`runText = envelope +
 * this`), so the model sees the content followed by an explicit, honest
 * continue instruction, never a spoofed empty turn. The `[auto-resume]` tag
 * makes the woken turn legible in scrollback. Background results take the
 * original wording; a wake caused only by peer messages says so instead.
 */
export function autoResumeDirective(bgResultPending: boolean): string {
  return bgResultPending
    ? '[auto-resume] The background task above has finished. Continue the work it was dispatched for.'
    : '[auto-resume] A message from another afk session arrived above. Handle it per the peer-message rules; reply with send_to_session only if a reply is useful.';
}

/** Anything exposing a one-shot `drainInjections()`. */
export interface InjectionSource {
  drainInjections(): string;
}

/**
 * Prepend every source's pending injection to `runText`, in argument order:
 * shell-passthrough `!cmd` output (Claude Code transcript semantics),
 * settled background-subagent results (each drain emits a `delivered`
 * witness event; /bgsub:join remains for replay), then cross-session peer
 * messages (the claimed files stay in `delivered/` for forensics).
 */
export function prependTurnInjections(runText: string, sources: readonly InjectionSource[]): string {
  let out = runText;
  for (const source of sources) {
    const injection = source.drainInjections();
    if (injection.length > 0) out = injection + out;
  }
  return out;
}

/**
 * Best-effort, fire-and-forget presence `turnState` update so peers'
 * `list_sessions` can see whether this session is idle or mid-turn. No-op
 * before the first turn mints a session id.
 *
 * When state is `'busy'`, `rawUserText` is the RAW user-typed text (before
 * peer-message or bg-subagent injections are prepended) — it is stored as
 * `activity.promptHead` so peers can see what this session is working on.
 * This parameter MUST be the pre-injection text; passing the composited
 * `runText` would leak peer message bodies into the presence file.
 *
 * When state is `'idle'`, `totalTurns` is `ctx.stats.totalTurns` after the
 * turn is counted — stored directly so resumed sessions start from the
 * correct historical total rather than resetting to 1. `rawUserText` is also
 * forwarded for first-turn fallback (see setPresenceActivityTurnEnd JSDoc).
 */
export function markPresenceTurn(
  sessionId: string | undefined,
  state: 'idle' | 'busy',
  rawUserText?: string,
  totalTurns?: number,
): void {
  if (!sessionId) return;
  void setPresenceTurnState(sessionId, state);
  if (state === 'busy' && rawUserText !== undefined) {
    void setPresenceActivityPromptHead(sessionId, rawUserText);
  } else if (state === 'idle') {
    void setPresenceActivityTurnEnd(sessionId, totalTurns ?? 0, rawUserText);
  }
}
