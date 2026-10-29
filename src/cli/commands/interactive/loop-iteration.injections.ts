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
import type { TurnProvenance } from '../../../agent/turn-provenance.js';

/**
 * User-message text seeded when a pending injection auto-resumes an idle REPL.
 * The injected envelope(s) are prepended at drain time (`runText = envelope +
 * this`), so the model sees the content followed by an explicit, honest
 * continue instruction, never a spoofed empty turn. The `[auto-resume]` tag
 * identifies internal model context, not a submitted human prompt. Background results take the
 * original wording; a wake caused only by peer messages says so instead.
 */
export function autoResumeDirective(bgResultPending: boolean): string {
  return bgResultPending
    ? '[auto-resume] The background task above has finished. Continue the work it was dispatched for.'
    : '[auto-resume] A message from another afk session arrived above. Handle it per the peer-message rules; reply with send_to_session only if a reply is useful.';
}

/**
 * Prefix shared by every auto-resume directive. Used to guard `promptHead` so
 * synthetic wakeup text never masquerades as operator-typed content in the
 * presence file.
 */
export const AUTO_RESUME_PREFIX = '[auto-resume]';

/** Anything exposing a one-shot `drainInjections()` and a non-destructive probe. */
export interface InjectionSource {
  drainInjections(): string;
  /**
   * True when at least one injection is buffered and ready to drain.
   * Non-destructive: does not consume the buffer.
   */
  hasPendingInjections(): boolean;
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
 * Auto-resume directives (text starting with `[auto-resume]`) are skipped:
 * they are synthetic wakeup text, not operator-typed content, so they must
 * never appear in `activity.promptHead`.
 *
 * When state is `'idle'`, `totalTurns` is `ctx.stats.totalTurns` after the
 * turn is counted — stored directly so resumed sessions start from the
 * correct historical total rather than resetting to 1. `rawUserText` is
 * forwarded for first-turn fallback (see setPresenceActivityTurnEnd JSDoc),
 * but `setPresenceActivityTurnEnd` will silently discard it when it is a
 * synthetic auto-resume directive — those must never appear as promptHead.
 *
 * @param provenance  Optional per-turn provenance (issue #2906, PR A).
 *   When supplied on the `'busy'` path, its `origin` is forwarded to
 *   `setPresenceActivityPromptHead` so peer sessions can answer "is a human
 *   watching?" without guessing from `surface`.
 */
export function markPresenceTurn(sessionId: string | undefined, state: 'busy', rawUserText?: string, provenance?: TurnProvenance): void;
export function markPresenceTurn(sessionId: string | undefined, state: 'idle', rawUserText: string | undefined, totalTurns: number): void;
export function markPresenceTurn(
  sessionId: string | undefined,
  state: 'idle' | 'busy',
  rawUserText?: string,
  totalTurnsOrProvenance?: number | TurnProvenance,
): void {
  if (!sessionId) return;
  void setPresenceTurnState(sessionId, state);
  if (state === 'busy' && rawUserText !== undefined) {
    // Skip auto-resume directives: they are synthetic wakeup text seeded into
    // seedBuffer by tryAutoResume, not operator-typed content. Storing them
    // in activity.promptHead would give peers a misleading "[auto-resume] …"
    // presence snippet rather than the actual work the session was doing.
    if (rawUserText.startsWith(AUTO_RESUME_PREFIX)) return;
    const provenance = typeof totalTurnsOrProvenance === 'object' ? totalTurnsOrProvenance : undefined;
    void setPresenceActivityPromptHead(sessionId, rawUserText, provenance?.origin);
  } else if (state === 'idle') {
    void setPresenceActivityTurnEnd(sessionId, totalTurnsOrProvenance as number, rawUserText);
  }
}
