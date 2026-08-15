/**
 * Sanitiser for strings crossing an external trust boundary into terminal output.
 *
 * MCP-controlled schema fields (description, title, enum values, type names)
 * are user-untrusted: a malicious or compromised MCP server can embed ANSI CSI
 * escape sequences to forge prompts, overwrite previous lines, or hide content.
 * This helper strips ANSI escapes and clamps length before any such string is
 * passed to `writer.line(...)` or any other terminal-bound surface.
 *
 * Non-ASCII Unicode (emoji, CJK, accents) is preserved — only the C1 / CSI
 * escape vocabulary is stripped.
 */

import { stripEscapeSequences } from '../../utils/terminal-sanitize.js';

// Defence-in-depth: strip bare C1 control bytes (0x80–0x9F) that survive
// sequence-level stripping (e.g. NEL U+0085, RI U+008D) — some terminals
// honour them even without an ESC prefix. Sequence-level stripping already
// handles 0x9B as an 8-bit CSI introducer; this covers the remainder.
// eslint-disable-next-line no-control-regex
const BARE_C1_RE = /[\x80-\x9F]/g;

/**
 * Strip ANSI escape sequences and clamp to `maxLen` characters. Used at the
 * trust boundary where MCP schema strings flow into terminal output.
 *
 * @param s     Raw string from an untrusted source.
 * @param maxLen Visible-character cap (default 128). Strings longer than this
 *              are truncated with a trailing `…`. The truncation is by JS
 *              `string.length`, not by display width — sufficient for the
 *              CSI-injection threat model.
 */
export function sanitizeSchemaString(s: string, maxLen = 128): string {
  const stripped = stripEscapeSequences(s).replace(BARE_C1_RE, '');
  return stripped.length > maxLen ? stripped.slice(0, maxLen) + '…' : stripped;
}
