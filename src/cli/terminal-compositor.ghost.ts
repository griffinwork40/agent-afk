/**
 * Inline ghost-text logic, split out of terminal-compositor.autocomplete.ts.
 *
 * The dropdown and the ghost are two different suggestion surfaces with two
 * different lifecycles: the dropdown is derived synchronously from the buffer
 * on every keystroke, while the ghost is a mix of a synchronous Tier-1 lookup,
 * a fire-and-forget Tier-2 request, and a per-turn empty-prompt proposal that
 * survives across keystrokes until it is accepted, dismissed, or superseded.
 * They are kept in separate modules so that lifecycle lives in one place.
 *
 * Same free-functions-on-host pattern as its sibling (and as
 * src/cli/_lib/stream-renderer-*): TerminalCompositor owns the state; these
 * functions operate on the {@link AutocompleteHost} slice it passes as `self`.
 * Depends on the sibling module one way only (for `updateAutocomplete` after an
 * accept rewrites the buffer) — nothing in the dropdown module calls back here.
 */

import { InputCore } from './input-core.js';
import { stripGhostControlChars } from './input/suggest.js';
import {
  updateAutocomplete,
  type AutocompleteHost,
} from './terminal-compositor.autocomplete.js';

/**
 * Request an empty-prompt suggestion for the turn that is starting, then show
 * it if the user has not begun typing.
 *
 * Contract: fire-and-forget. The caller (the per-turn `readLine` handoff) must
 * not await this — a suggestion is a nicety and must never delay handing the
 * prompt to the user. Mirrors the Tier-2 stale-guard: the result is only
 * surfaced when the buffer is STILL empty on resolve, so a user who starts
 * typing immediately never sees a late ghost appear under their text.
 *
 * Overlapping primes are newest-wins — the engine aborts the predecessor and
 * ignores its late reply (see cli/input/suggest-prompt-state.ts), so calling
 * this again before the previous turn's request settles is safe.
 */
export function primePromptGhost(self: AutocompleteHost): void {
  const engine = self.ghostEngine;
  const getContext = self.ghostGetContext;
  if (!engine || !getContext) return;
  // Only propose into a genuinely empty prompt.
  if (self.input.buffer.length > 0) return;

  // A suggestion from the previous turn is stale the moment a new turn ends.
  engine.clearPromptSuggestion();

  void engine
    .primePromptSuggestion(getContext())
    .then(() => {
      if (self.input.buffer.length !== 0) return;
      if (engine.peekPromptSuggestion() === null) return;
      updateGhost(self);
      self.repaint();
    })
    .catch(() => {
      /* engine never throws; defensive */
    });
}

/**
 * Drop the stored empty-prompt suggestion (and the ghost currently rendering
 * it). Called when the user signals they do not want it — ESC at an empty
 * idle prompt — and internally the moment the user starts editing or accepts.
 *
 * Invariant: clearing the ghost alone is NOT enough. The proposal lives in the
 * engine, and `updateGhost` re-reads it on every edit that lands back at an
 * empty buffer, so a suggestion dropped only from `activeGhost` reappears on
 * the next backspace-to-empty (or Ctrl+U). Both must go.
 */
export function dismissPromptGhost(self: AutocompleteHost): boolean {
  const engine = self.ghostEngine;
  if (!engine) return false;
  const hadSuggestion = (engine.peekPromptSuggestion?.() ?? null) !== null;
  if (!hadSuggestion) return false;
  // Optional-called for the same reason as `peekPromptSuggestion` below: a
  // hand-rolled test double predating the feature must not throw here.
  engine.clearPromptSuggestion?.();
  if (self.activeGhost !== null && self.input.buffer.length === 0) {
    self.activeGhost = null;
  }
  return true;
}

/**
 * Update the active ghost text for the current buffer state.
 *
 * Called from `applyEdit` (every buffer/cursor change) so the ghost is
 * always consistent with the current input. Never called while `pasting`
 * — the paste burst suppresses per-character repaints and a ghost mid-paste
 * would be stale by the time the paste ends.
 *
 * Invariant: MUST NOT block the keystroke path. `getDeterministicGhost` is
 * synchronous (safe). `getGhost` is fire-and-forget — its resolution only
 * stores a result when the buffer is still identical to what was requested
 * (stale-async guard captures the buffer snapshot before dispatch and
 * compares on resolve; mismatched buffer → result is silently dropped).
 * A repaint is scheduled only after the guard passes.
 *
 * Invariant: when the dropdown is open, ghost text is suppressed in
 * `renderInputLine` (ghost defers to the dropdown UI). We still eagerly
 * compute the Tier-1 ghost here so it is ready the moment the dropdown
 * closes — no additional async round-trip needed.
 */
export function updateGhost(self: AutocompleteHost): void {
  if (!self.ghostEngine || !self.ghostGetContext) return;
  const buffer = self.input.buffer;

  // Stale-invalidation: clear any ghost that no longer extends the buffer.
  if (self.activeGhost !== null && !self.activeGhost.startsWith(buffer)) {
    self.activeGhost = null;
  }

  // The user has begun editing: retire the empty-prompt proposal for good.
  // It is only ever readable at an empty buffer, so leaving it stored would
  // make it RESURFACE the moment the buffer returns to empty — backspacing
  // over a typed character, or Ctrl+U — long after the user implicitly
  // declined it by typing something else.
  if (buffer.length > 0) {
    self.ghostEngine.clearPromptSuggestion?.();
  }

  // Tier 1: synchronous, always runs.
  const ctx = self.ghostGetContext();
  const tier1 = self.ghostEngine.getDeterministicGhost(buffer, ctx);
  if (tier1 !== null) {
    self.activeGhost = tier1;
    return;
  }

  // Empty-prompt suggestion. The completion tiers are guarded off at an empty
  // buffer by design (they complete a prefix; there is nothing to complete), so
  // this is the only source permitted to produce a ghost here. It must be read
  // BEFORE the `activeGhost = null` below, which would otherwise wipe it on
  // every edit that lands back at an empty buffer.
  if (buffer.length === 0) {
    // Optional-called on purpose. Test files are excluded from `tsc`
    // (tsconfig `exclude`), so a hand-rolled SuggestEngine mock predating this
    // method type-checks fine and would throw here on the input hot path —
    // every backspace-to-empty. A missing implementation means "no suggestion".
    const primed = self.ghostEngine.peekPromptSuggestion?.() ?? null;
    if (primed !== null) {
      self.activeGhost = primed;
      return;
    }
  }

  // No Tier-1 match — clear any stale ghost and, when the dropdown is
  // closed, kick off a Tier-2 async request (fire-and-forget).
  self.activeGhost = null;
  const ac = self.autocompleteState;
  if (ac?.dropdownOpen) return;

  // Stale-async guard: snapshot the buffer BEFORE the async dispatch.
  // The resolve handler will discard the result if the buffer has changed.
  const requestedBuffer = buffer;
  self.ghostEngine.getGhost(buffer, ctx).then((result) => {
    // Contract: only store the result when the buffer is still the same
    // and the result is a strict prefix-extension (safety net against a
    // misbehaving engine returning a non-prefix string).
    if (
      result !== null &&
      self.input.buffer === requestedBuffer &&
      result.startsWith(requestedBuffer) &&
      result.length > requestedBuffer.length
    ) {
      self.activeGhost = result;
      self.repaint();
    }
  }).catch(() => { /* engine never throws, but be defensive */ });
}

/**
 * Accept the current ghost text: replace the buffer with the full ghost
 * string, move the cursor to the end, clear the ghost, and repaint.
 *
 * Returns `true` when a ghost was accepted; `false` when there was no
 * active ghost to accept (or the preconditions were not met). Callers
 * check the return to decide whether to fall through to their own logic.
 *
 * Preconditions (all must hold):
 *   - `activeGhost` is set
 *   - cursor is at end-of-buffer
 *   - the ghost still strictly extends the current buffer (strict-prefix check)
 *   - the autocomplete dropdown is closed
 */
export function applyGhostAccept(self: AutocompleteHost): boolean {
  const ghost = self.activeGhost;
  if (ghost === null) return false;
  const ac = self.autocompleteState;
  if (ac?.dropdownOpen) return false;
  if (self.input.cursor !== self.input.buffer.length) return false;
  if (!ghost.startsWith(self.input.buffer) || ghost.length <= self.input.buffer.length) return false;
  // Replace buffer with the full ghost and position cursor at end. Sanitize
  // the suggested *remainder* before committing it (mirrors the render-path
  // strip in renderInputLine): the typed prefix is the user's own clean
  // input, but a Tier-1 candidate sourced from history could carry an
  // embedded newline / control char that would otherwise be injected
  // verbatim into the buffer — and then submitted — on accept.
  const sanitizedGhost =
    self.input.buffer + stripGhostControlChars(ghost.slice(self.input.buffer.length));
  const next = InputCore.seed(sanitizedGhost);
  self.input = next;
  self.activeGhost = null;
  // The empty-prompt proposal is consumed by an accept: its text is now the
  // user's own buffer. Leaving it stored would re-offer it as a ghost as soon
  // as the buffer went empty again (accept, then Ctrl+U or backspace over it).
  self.ghostEngine?.clearPromptSuggestion?.();
  updateAutocomplete(self);
  self.repaint();
  return true;
}
