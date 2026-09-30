/**
 * Terminal-state parser — cli re-export shim.
 *
 * AFK's system prompt mandates that every assistant turn end in one of four
 * named terminal states — Done / Blocked / Asking / Interrupted — with a
 * structured set of bullets describing the outcome (per `system-prompt.md`,
 * §"End-of-turn"). The parser extracts that structure from the trailing
 * portion of the assistant's final text so the REPL can render it as a
 * first-class verdict surface instead of leaving it buried in the markdown
 * stream.
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
