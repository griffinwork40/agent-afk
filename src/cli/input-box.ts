/**
 * Public entry for the raw-mode terminal input component with inline
 * autocomplete dropdown.
 *
 * The implementation is split across `./input/` for clarity:
 *   - `./input/types.ts`        - shared types (Trigger, Candidate, opts/result)
 *   - `./input/trigger.ts`      - detectTrigger + candidate filters (pure)
 *   - `./input/dropdown.ts`     - dropdown row formatting (pure)
 *   - `./input/echo.ts`         - submit-echo + visual-row math (pure)
 *   - `./input/raw-mode.ts`     - raw-mode + bracketed-paste setup/teardown
 *   - `./input/non-tty.ts`      - non-TTY fallback delegating to readline
 *   - `./input/reader.ts`       - TTY orchestrator (keypress loop, repaint)
 *
 * This module wires the TTY decision and re-exports the public API used by
 * `commands/interactive/repl-loop.ts` and the input-box tests.
 *
 * When TTY is available:
 *   - Enters raw mode and listens to keypress events.
 *   - Displays an inline dropdown below the cursor for slash commands (`/cmd`) or files (`@path`).
 *   - Arrow keys navigate; Enter/Tab accepts; Esc closes dropdown.
 *
 * Non-TTY fallback:
 *   - Delegates to readInput() from multi-line-reader.ts and installs a
 *     process-level SIGINT handler so `opts.onSigint` fires there too.
 */

import { readNonTty } from './input/non-tty.js';
import { readWithAutocompleteTty } from './input/reader.js';
import type {
  ReadWithAutocompleteOpts,
  ReadWithAutocompleteResult,
} from './input/types.js';

export { detectTrigger, filterFlagCandidates } from './input/trigger.js';
export { formatSubmittedEcho, visualRowCount } from './input/echo.js';
export type {
  ReadWithAutocompleteOpts,
  ReadWithAutocompleteResult,
} from './input/types.js';

export async function readWithAutocomplete(
  opts: ReadWithAutocompleteOpts,
): Promise<ReadWithAutocompleteResult> {
  // Non-TTY fallback: delegate to multi-line-reader (with SIGINT bridging)
  if (!process.stdout.isTTY || !process.stdin.isTTY) {
    return readNonTty(opts);
  }
  return readWithAutocompleteTty(opts);
}
