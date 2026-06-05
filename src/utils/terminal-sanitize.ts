/**
 * Canonical terminal-display sanitiser.
 *
 * Strips every ANSI / terminal escape family and neutralises stray control
 * bytes from a string before it is written to a terminal surface. This is a
 * SECURITY boundary: tool, model, and user-derived strings can embed escape
 * sequences that clear the screen, reposition the cursor, set the window
 * title, smuggle OSC-8 hyperlinks, or switch screen buffers. Any such string
 * MUST pass through here before reaching the terminal.
 *
 * Lives in the neutral `utils/` layer (not `cli/`) so the agent layer
 * (e.g. `agent/tools/render-registry.ts`) can import it without a layering
 * inversion, while `cli/` surfaces use it too.
 *
 * Distinct from the two adjacent strippers (candidates to converge here later,
 * out of scope for now):
 *   - `src/cli/display.ts:stripAnsi` — width/wrap helper; removes escapes but
 *     keeps other control chars and does no word-boundary preservation.
 *   - `src/cli/_lib/sanitize.ts:sanitizeSchemaString` — MCP schema-field
 *     boundary; removes escapes and length-clamps.
 *
 * Pure leaf module — intentionally dependency-free so it can be imported from
 * any layer without pulling in width/measurement code.
 *
 * @module utils/terminal-sanitize
 */

// Invariant: alternation order and the two-pass sequence are load-bearing.
//
// Pass 1 (ESCAPE_RE) removes whole escape sequences. Its arms are ordered
// most-specific-first so structured sequences are consumed as a unit before
// the bare 2-byte ESC arm can match only their introducer:
//   1. OSC:            ESC ] … (BEL | ST)   — OSC-8 links, title sets, iTerm2 images
//   2. DCS/PM/APC/SOS: ESC (P|^|_|X) … ST    — device-control strings
//   3. CSI (7-bit):    ESC [ params … final  — SGR, cursor moves, clear-screen, DEC private (?…)
//   4. CSI (8-bit):    0x9B params … final    — 8-bit C1 equivalent of CSI
//   5. bare 2-byte:    ESC <0x40–0x5F>        — any other ESC-introduced pair
// If an OSC/DCS body were not consumed first, its payload (e.g. the URL inside
// an OSC-8 hyperlink) would survive as visible text — the partial-strip bug in
// the pre-extraction render-registry sanitiser that this module fixes.
//
// Pass 2 replaces any leftover C0 (0x00–0x1F), DEL (0x7F), and C1 (0x80–0x9F)
// control byte with a single space — preserving word boundaries in
// length-bounded displays — then trims. Pass 2 MUST run after Pass 1 so a lone
// 0x9B beginning a valid 8-bit CSI is consumed as a sequence rather than punched
// to a space that orphans its parameters as visible text. Code points >= 0xA0
// (emoji, CJK, accents) are never touched.
// eslint-disable-next-line no-control-regex
const ESCAPE_RE =
  /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B[P^_X][^\x1B]*\x1B\\|\x1B\[[0-?]*[ -/]*[@-~]|\x9B[0-?]*[ -/]*[@-~]|\x1B[@-_]/g;

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\x00-\x1F\x7F-\x9F]/g;

/**
 * Strip all terminal escape sequences and neutralise control bytes so a string
 * is safe to write to a terminal. Benign text is returned unchanged apart from
 * surrounding-whitespace trimming; only escape/control-bearing input is altered.
 *
 * @param s Raw, potentially untrusted string.
 * @returns A display-safe string with no executable terminal escapes.
 */
export function sanitizeForDisplay(s: string): string {
  return s.replace(ESCAPE_RE, '').replace(CONTROL_RE, ' ').trim();
}

/**
 * Strip escape sequences only, preserving newlines, tabs, and all other text.
 *
 * Removes CSI (7-bit and 8-bit C1), OSC (including OSC-8 hyperlinks), DCS,
 * PM, APC, SOS, and bare 2-byte ESC sequences using the module-level ESCAPE_RE
 * (which strips them as whole units, preventing URL payloads from leaking as
 * visible text). Unlike {@link sanitizeForDisplay} it does NOT run the second
 * pass that replaces control bytes with spaces, and it does NOT trim — making
 * it the right choice for multi-line captured output (e.g. bash/grep tool
 * results) that must keep line structure while shedding color, hyperlink, and
 * window-title escapes.
 *
 * @param s Raw string, potentially containing terminal escape sequences.
 * @returns The string with all escape sequences removed; newlines and tabs intact.
 */
export function stripEscapeSequences(s: string): string {
  return s.replace(ESCAPE_RE, '');
}
