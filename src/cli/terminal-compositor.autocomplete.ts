/**
 * Autocomplete dropdown logic, extracted from terminal-compositor.ts. Follows
 * the free-functions-on-host pattern used by src/cli/_lib/stream-renderer-*:
 * TerminalCompositor owns the state; these functions operate on the narrow
 * {@link AutocompleteHost} slice it passes as `self`. The shared
 * MAX_DROPDOWN_ROWS budget is co-located here.
 *
 * Scope: the DROPDOWN — candidates derived synchronously from the buffer on
 * every keystroke, plus Tab-apply. Inline ghost text is the other suggestion
 * surface and has a different lifecycle (async tiers, a per-turn empty-prompt
 * proposal that persists across keystrokes); it lives in
 * ./terminal-compositor.ghost.ts, which imports {@link AutocompleteHost} and
 * {@link updateAutocomplete} from here. The dependency runs one way — nothing
 * in this module calls into the ghost module.
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
import type { AutocompleteState } from './input/autocomplete-state.js';
import type { IHistoryRing } from './input/types.js';
import type { SuggestContext, SuggestEngine } from './terminal-compositor.types.js';

/** Maximum dropdown rows to show inside the compositor frame. */
export const MAX_DROPDOWN_ROWS = 6;

/**
 * Narrowest TerminalCompositor state slice the autocomplete/ghost functions
 * touch. Shared with ./terminal-compositor.ghost.ts so both suggestion
 * surfaces are wired against one host contract. `input`/`activeGhost` are
 * mutated; `autocompleteState` is mutated in-place (never reassigned, so it
 * stays a `readonly` view). `repaint` is the cross-cluster render callback (a
 * class method on the host).
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
  /**
   * Input history, read newest-first to rank slash candidates by recency.
   * Deliberately NOT sourced from `ghostGetContext`: dropdown ordering must
   * stay correct when ghost text is disabled (`AFK_SUGGEST_GHOST=0`), which
   * leaves that context undefined.
   */
  readonly history?: IHistoryRing;
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
      commitCandidates(
        ac,
        filterSlashCandidates(ac.trigger.query, self.history?.getEntries?.() ?? []).slice(0, 12),
      );
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
