/**
 * Outcome recording for AI ghost text, split out of terminal-compositor.ghost.ts.
 *
 * The engine records what the suggestion model GENERATED; this module records
 * what the user DID with it (accept, word-accept, dismiss), via the engine's
 * `recordOutcome` so both halves reach the same sink (the session journal, see
 * docs/message-journal.md).
 *
 * Invariant: only AI-sourced ghosts are recorded. A Tier-1 ghost is the
 * user's own history or a dropdown candidate, not model output. The source is
 * captured at ASSIGNMENT time (`noteGhostSource`, called wherever ghost.ts sets
 * `activeGhost`) rather than re-derived at accept time, because Tier-1's
 * dropdown-candidate match depends on dropdown state that has changed by the
 * time Tab is pressed. A source is trusted only while the ghost it was noted
 * for is still the one on screen (string identity check), so a stale note can
 * never mislabel a later ghost.
 *
 * Keyed by host in a WeakMap so TerminalCompositor needs no new field and a
 * disposed compositor's entry is collected with it.
 */

import type { AutocompleteHost } from './terminal-compositor.autocomplete.js';

/** Where an on-screen ghost came from; `null` = not AI output (Tier-1). */
export type GhostSource = 'completion' | 'prompt' | null;

const sources = new WeakMap<AutocompleteHost, { ghost: string; source: GhostSource }>();

/** Note the source of the ghost just assigned to `self.activeGhost`. */
export function noteGhostSource(self: AutocompleteHost, ghost: string, source: GhostSource): void {
  sources.set(self, { ghost, source });
}

/** The AI source of `ghost`, or null when it is not (or no longer) AI output. */
function aiSourceOf(self: AutocompleteHost, ghost: string): GhostSource {
  const noted = sources.get(self);
  return noted !== undefined && noted.ghost === ghost ? noted.source : null;
}

/**
 * Record an accept of `ghost`. Call BEFORE the buffer is rewritten: `buffer`
 * in the record is what the user had typed when they accepted. `full` is true
 * when the accept consumes the whole ghost (Tab, or a final word-nibble that
 * exhausts the suggestion) — emits `accepted`. `full` is false for a partial
 * nibble that leaves ghost text remaining — emits `word_accepted`.
 */
export function recordGhostAccept(self: AutocompleteHost, ghost: string, full: boolean): void {
  const source = aiSourceOf(self, ghost);
  if (source === null) return;
  self.ghostEngine?.recordOutcome?.({
    event: full ? 'accepted' : 'word_accepted',
    source,
    text: ghost,
    ...(source === 'completion' ? { buffer: self.input.buffer } : {}),
  });
}

/** Record an explicit dismissal (Esc) of the empty-prompt proposal `text`. */
export function recordPromptDismiss(self: AutocompleteHost, text: string): void {
  self.ghostEngine?.recordOutcome?.({ event: 'dismissed', source: 'prompt', text });
}
