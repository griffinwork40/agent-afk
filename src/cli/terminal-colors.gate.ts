/**
 * Whether the REPL should run the terminal color query at startup.
 *
 * Kept apart from terminal-colors.ts so that module stays free of the reveal
 * modules: smoke-reveal.cells.ts imports terminal-colors.ts, and importing
 * smoke-reveal.ts back from there would close an import cycle.
 *
 * @module cli/terminal-colors.gate
 */

import { env } from '../config/env.js';
import { isExplicitlyDisabled } from '../config/env-helpers.js';
import { detectReducedMotion } from './_lib/capture-mode.js';
import { isInkTextEnabled, isSmokeTextEnabled } from './smoke-reveal.js';

/**
 * True when a reveal will actually animate (ink or smoke enabled on a capable
 * terminal, motion not reduced) and the operator has not opted out via
 * `AFK_TERM_COLOR_QUERY=0`. The TTY check itself lives in the query.
 */
export function shouldQueryTerminalColors(): boolean {
  const raw = env.AFK_TERM_COLOR_QUERY;
  if (raw && isExplicitlyDisabled(raw)) return false;
  if (detectReducedMotion()) return false;
  return isInkTextEnabled() || isSmokeTextEnabled();
}
