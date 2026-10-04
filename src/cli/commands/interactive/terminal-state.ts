/**
 * Terminal-state parser — re-export shim.
 *
 * The canonical implementation now lives at
 * `src/agent/outcomes/terminal-state.ts` so `derive.ts` (which must not
 * import `src/cli/`) can call the same parser. All existing importers of this
 * path continue to work unchanged — the public API is byte-identical.
 *
 * #2777: moved pure parsing logic to src/agent/outcomes/terminal-state.ts.
 * #2794: `fencedLines()` now enforces CommonMark indent (0–3 spaces) and
 * info-string rules so unbalanced fence-like lines no longer hide the
 * end-of-turn heading. The REPL card and daemon gate now see the correct state.
 */
export type { TerminalKind, TerminalState } from '../../../agent/outcomes/terminal-state.js';
export {
  parseTerminalState,
  findTerminalStateHeadingOffset,
} from '../../../agent/outcomes/terminal-state.js';
