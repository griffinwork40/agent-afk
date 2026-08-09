/**
 * ANSI/terminal-escape stripping for the `afk web` frontend transcript.
 *
 * Deliberately does not define a new escape regex — `src/utils/terminal-sanitize.ts`
 * is the canonical stripper and already covers OSC/DCS/CSI (7-bit and 8-bit)
 * sequences. This module re-exports its multi-line-safe function under a
 * frontend-local name so view-model/render code depends on `web-server/frontend/*`
 * rather than reaching across into `utils/` directly.
 *
 * @module web-server/frontend/ansi-strip
 */

import { stripEscapeSequences } from '../../utils/terminal-sanitize.js';

/**
 * Remove ANSI/terminal escape sequences from tool output, thinking text, or
 * any other agent-produced string rendered in the web transcript, while
 * preserving newlines and tabs (tool output is frequently multi-line).
 *
 * Wraps {@link stripEscapeSequences} — see that module for the exact
 * sequence families removed (OSC incl. OSC-8 hyperlinks, DCS/PM/APC/SOS,
 * CSI 7-bit and 8-bit, bare 2-byte ESC). Unlike `sanitizeForDisplay` in the
 * same module, this does not blank C0/C1 control bytes or trim — the web
 * frontend renders into HTML (not a raw terminal), so stray control bytes
 * are not an escape-injection risk here, only the ESC-prefixed sequences are.
 *
 * @param s Raw string, potentially containing terminal escape sequences.
 * @returns The string with escape sequences removed; all other characters,
 *   including newlines and tabs, are preserved verbatim.
 */
export function stripAnsi(s: string): string {
  return stripEscapeSequences(s);
}
