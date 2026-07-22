/**
 * Autocomplete dropdown + inline ghost-text logic, extracted from
 * terminal-compositor.ts. Follows the free-functions-on-host pattern used by
 * src/cli/_lib/stream-renderer-*: TerminalCompositor owns the state; these
 * functions operate on the narrow {@link AutocompleteHost} slice it passes as
 * `self`. No behavior change — bodies are moves with `this.` rewritten to
 * `self.`, intra-module calls (updateAutocomplete) made direct, and the shared
 * MAX_DROPDOWN_ROWS budget co-located here.
 */

import { InputCore, type InputCoreState } from './input-core.js';
import {
  detectTrigger,
  filterFileCandidatesAsync,
  filterFileCandidatesCached,
  filterFlagCandidates,
  filterSlashCandidates,
  invalidateFileScanCache,
} from './input/trigger.js';
import { stripGhostControlChars } from './input/suggest.js';
import type { AutocompleteState } from './input/autocomplete-state.js';
import type { SuggestContext, SuggestEngine } from './terminal-compositor.types.js';

/** Maximum dropdown rows to show inside the compositor frame. */
export const MAX_DROPDOWN_ROWS = 6;

/**
 * Narrowest TerminalCompositor state slice the autocomplete/ghost functions
 * touch. `input`/`activeGhost` are mutated; `autocompleteState` is
 * mutated in-place (never reassigned, so it stays a `readonly` view).
 * `repaint` is the cross-cluster render callback (a class method on the host).
 *
 * Note: applying a completion/ghost does NOT touch the pending-submission
 * queue — editing the live buffer is independent of committed messages
 * (commit-on-Enter), so the host needs no `queued`/`pendingSubmissions` slice.
 */
export interface AutocompleteHost {
  readonly autocompleteState?: AutocompleteState;
  input: InputCoreState;
  activeGhost: string | null;
  readonly ghostEngine: SuggestEngine | undefined;
  readonly ghostGetContext: (() => SuggestContext) | undefined;
  repaint(): void;
}

/**
 * Store a freshly-computed candidate list into the dropdown state and reclamp
 * the selection/viewport so they stay valid for the new length. Shared by the
 * synchronous branches of {@link updateAutocomplete} and by the async @-file
 * resolution so both apply results through identical selection math.
 */
function commitCandidates(ac: AutocompleteState, candidates: AutocompleteState['candidates']): void {
  ac.candidates = candidates;
  ac.dropdownOpen = candidates.length > 0;
  if (ac.selectedIndex >= ac.candidates.length) {
    ac.selectedIndex = Math.max(0, ac.candidates.length - 1);
  }
  if (ac.viewportStart > ac.selectedIndex) ac.viewportStart = ac.selectedIndex;
  if (ac.selectedIndex >= ac.viewportStart + MAX_DROPDOWN_ROWS) {
    ac.viewportStart = ac.selectedIndex - MAX_DROPDOWN_ROWS + 1;
  }
}

/**
 * Recompute autocomplete candidates from the current buffer/cursor and
 * store results back into the shared AutocompleteState. Called on every
 * printable keypress, backspace, and left/right so the dropdown stays
 * consistent with the buffer content during the agent turn.
 *
 * Invariant: MUST NOT block the keystroke path. The slash and flag branches
 * are pure/synchronous. The @-file branch reads the filesystem, so it is served
 * from a per-directory cache synchronously when possible and otherwise scanned
 * asynchronously (fire-and-forget) — mirroring the `getGhost().then(...)`
 * stale-async guard in {@link updateGhost}: the async result is applied only
 * when the buffer's trigger is still the SAME @-file query it was dispatched
 * for, and is silently dropped otherwise so a late scan never repaints over a
 * newer dropdown state. A repaint is scheduled only after the guard passes.
 */
export function updateAutocomplete(self: AutocompleteHost): void {
  const ac = self.autocompleteState;
  if (!ac) return;

  ac.trigger = detectTrigger(self.input.buffer, self.input.cursor);
  const currentSignature = `${self.input.cursor}:${self.input.buffer}`;
  if (ac.suppressedSignature !== null && ac.suppressedSignature !== currentSignature) {
    ac.suppressedSignature = null;
  }
  if (ac.trigger && ac.suppressedSignature === null) {
    if (ac.trigger.kind === 'slash') {
      commitCandidates(ac, filterSlashCandidates(ac.trigger.query).slice(0, 12));
    } else if (ac.trigger.kind === 'file') {
      updateFileCandidates(self, ac, ac.trigger.query);
    } else {
      commitCandidates(ac, filterFlagCandidates(ac.trigger.command, ac.trigger.query));
    }
  } else {
    commitCandidates(ac, []);
  }
}

/**
 * @-file branch of {@link updateAutocomplete}. Serves a fresh cache hit
 * synchronously so the common same-directory keystroke stays instant; on a
 * miss, dispatches the async scan and applies its result behind the stale
 * guard.
 *
 * Note: file candidates are bounded upstream (MAX_FILE_MATCHES) and the
 * dropdown scrolls; do NOT re-cap to 12, or entries past the 12th (e.g. src/,
 * tests/ in a typical cwd) become unreachable.
 */
function updateFileCandidates(self: AutocompleteHost, ac: AutocompleteState, query: string): void {
  const cached = filterFileCandidatesCached(query);
  if (cached !== null) {
    commitCandidates(ac, cached);
    return;
  }

  // Cache miss: leave the dropdown in its current (pre-scan) state — clearing
  // to closed here would flicker an open dropdown shut for one frame on every
  // fresh directory. Snapshot the query BEFORE dispatch; the resolve handler
  // discards the result unless the live trigger is still this exact @-file
  // query (stale guard), so a slow scan for query A that resolves after the
  // user has typed on to query B never repaints A's candidates.
  const requestedQuery = query;
  filterFileCandidatesAsync(query)
    .then((candidates) => {
      const live = ac.trigger;
      if (live?.kind === 'file' && live.query === requestedQuery && ac.suppressedSignature === null) {
        commitCandidates(ac, candidates);
        self.repaint();
      }
    })
    .catch(() => { /* filterFileCandidatesAsync never rejects, but be defensive */ });
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

  // Tier 1: synchronous, always runs.
  const ctx = self.ghostGetContext();
  const tier1 = self.ghostEngine.getDeterministicGhost(buffer, ctx);
  if (tier1 !== null) {
    self.activeGhost = tier1;
    return;
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
 * Apply the currently highlighted dropdown candidate to the buffer. Mirrors
 * `applySelection` in `src/cli/input/reader.ts` so Tab behaves identically
 * across the user-turn and agent-turn input surfaces.
 *
 * Returns `true` when a candidate was actually applied. `false` when the
 * dropdown is closed or empty (caller can fall through to a no-op without
 * spuriously closing the dropdown).
 */
export function applyDropdownSelection(self: AutocompleteHost): boolean {
  const ac = self.autocompleteState;
  if (!ac?.dropdownOpen || ac.candidates.length === 0) return false;
  const selected = ac.candidates[ac.selectedIndex];
  if (!selected) return false;

  const upToCursor = self.input.buffer.slice(0, self.input.cursor);
  const afterCursor = self.input.buffer.slice(self.input.cursor);

  let start: number;
  let text: string;
  if (ac.trigger?.kind === 'slash') {
    const match = /\/[A-Za-z_-]*$/.exec(upToCursor);
    start = match ? upToCursor.length - match[0].length : self.input.cursor;
    text = selected.value + (afterCursor.startsWith(' ') ? '' : ' ');
  } else if (ac.trigger?.kind === 'flag') {
    const match = /--[a-z0-9-]*$/.exec(upToCursor);
    start = match ? upToCursor.length - match[0].length : self.input.cursor;
    text = selected.value + (afterCursor.startsWith(' ') ? '' : ' ');
  } else {
    // File `@token`: token boundary = start of trailing non-whitespace run.
    const tokenStart = upToCursor.search(/[^\s]*$/);
    start = tokenStart >= 0 ? tokenStart : self.input.cursor;
    text = selected.value;
  }

  const next = InputCore.replaceRange(
    self.input,
    { start, end: self.input.cursor },
    text,
  );
  if (next === self.input) return false;
  self.input = next;
  // Accepting a candidate ends this dropdown episode — drop the directory-scan
  // cache so a directory mutated since the scan is re-read fresh next time
  // (explicit invalidation alongside the TTL; see invalidateFileScanCache).
  invalidateFileScanCache();
  // Reset dropdown viewport — same as reader.ts:303-305. The follow-up
  // updateAutocomplete() call may re-open the dropdown if the new cursor
  // position still matches a trigger (e.g. after applying `/mint ` the
  // cursor sits past the space, so `detectTrigger` returns null and the
  // dropdown stays closed). Resetting here makes that the steady state.
  ac.dropdownOpen = false;
  ac.candidates = [];
  ac.viewportStart = 0;
  ac.selectedIndex = 0;
  updateAutocomplete(self);
  self.repaint();
  return true;
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
  updateAutocomplete(self);
  self.repaint();
  return true;
}
