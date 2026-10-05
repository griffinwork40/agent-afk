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

/**
 * Sanitise a message string and truncate it at a whole-line boundary, adding
 * an explicit count notice when lines are dropped.
 *
 * Unlike {@link sanitizeSchemaString}, which slices mid-character and appends
 * a bare `…`, this helper:
 *   1. Strips ANSI escapes and C1 control bytes (same as sanitizeSchemaString).
 *   2. Splits on newlines and keeps as many whole lines as fit within `maxLen`.
 *   3. When lines are dropped it appends
 *      `[list truncated: showing N of M lines]` so the operator knows how
 *      many lines were omitted — satisfying the #2366 explicit-count requirement.
 *
 * When the content is not newline-oriented (single line or very short), the
 * behaviour is identical to sanitizeSchemaString — no count notice is added.
 *
 * @param s      Raw string from an untrusted or internal source.
 * @param maxLen Character cap (default 256).
 */
export function truncateMessageWithCount(s: string, maxLen = 256): string {
  const stripped = stripEscapeSequences(s).replace(BARE_C1_RE, '');
  if (stripped.length <= maxLen) return stripped;

  // The notice `[list truncated: showing X of Y lines]` is at most ~50 chars.
  // Reserve room for it inside maxLen so the full output stays within budget.
  const NOTICE_RESERVE = 60;
  const contentBudget = maxLen - NOTICE_RESERVE;

  const lines = stripped.split('\n');
  const totalLines = lines.length;

  // Accumulate whole lines until we would exceed contentBudget.
  let kept = 0;
  let acc = 0;
  for (const line of lines) {
    // +1 accounts for the newline separator between lines.
    const needed = acc === 0 ? line.length : acc + 1 + line.length;
    if (needed > contentBudget) break;
    acc = needed;
    kept += 1;
  }

  if (kept === 0) {
    // Budget too small even for a single line — fall back to raw char slice.
    return stripped.slice(0, maxLen);
  }

  if (kept >= totalLines) {
    // All lines fit after all (can happen if NOTICE_RESERVE was over-estimated).
    return stripped.slice(0, maxLen);
  }

  const body = lines.slice(0, kept).join('\n');
  return `${body}\n[list truncated: showing ${kept} of ${totalLines} lines]`;
}
