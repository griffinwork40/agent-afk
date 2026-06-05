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

// Matches:
//   - OSC sequences (`ESC ] … BEL` or `ESC ] … ESC \`) — terminal title sets etc.
//   - CSI (`ESC [ ... letter`) and other 7-bit ESC-prefixed 2-byte escapes
//   - C1 CSI (`0x9B … letter`) — 8-bit equivalent of `ESC [ …`
//   - bare C1 control bytes (0x80–0x9F) — defence-in-depth against any
//     uncaught C1 control that some terminals honour (e.g. NEL, ST)
// Alternation order matters: OSC must precede the generic ESC arm so the OSC
// body is consumed before the bare-ESC branch can match just `\x1B]`.
// Mirrors + extends the pattern in `src/cli/display.ts`.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B\][^\x07\x1B]*(?:\x07|\x1B\\)|\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])|\x9B[0-?]*[ -/]*[@-~]|[\x80-\x9F]/g;

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
  const stripped = s.replace(ANSI_RE, '');
  return stripped.length > maxLen ? stripped.slice(0, maxLen) + '…' : stripped;
}
