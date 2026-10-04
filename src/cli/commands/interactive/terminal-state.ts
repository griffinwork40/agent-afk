/**
 * Terminal-state parser — cli re-export shim.
 *
 * The canonical implementation now lives at
 * `src/agent/outcomes/terminal-state.ts` so `derive.ts` (which must not
 * import `src/cli/`) can call the same parser. All existing importers of this
 * path continue to work unchanged — the public API is byte-identical.
 *
 * The pure implementation lives in `src/agent/terminal-state.ts` so the
 * session layer and daemon can use it without importing from the cli layer
 * (layering invariant: `src/agent/` must not import from `src/cli/`). This
 * module re-exports everything from there so all existing importers — verdict-
 * card.ts, verdict-ledger.ts, turn-handler.completion.ts, afk-push.ts, etc. —
 * continue to work unchanged.
 *
 * The parser is a pure function: no I/O, no globals, no dependencies on the
 * runtime. It is exercised by `tests/cli/commands/interactive/terminal-state.test.ts`.
 */

export {
  type TerminalKind,
  type TerminalState,
  findTerminalStateHeadingOffset,
  parseTerminalState,
} from '../../../agent/terminal-state.js';
