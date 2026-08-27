/**
 * Strips markdown syntax from a string so the result is suitable for
 * plain-text contexts (Slack, email, SMS).
 *
 * Rules (applied in order):
 *   - ANSI escape sequences → removed
 *   - Fenced code blocks (``` … ```) → content indented 2 spaces; fence lines dropped
 *   - H1 headings (# …)  → UPPERCASE text, blank line below
 *   - H2 headings (## …) → UPPERCASE text, blank line below
 *   - H3–H6 headings     → text only (no case transform)
 *   - Horizontal rules (---, ***) → blank line
 *   - Bold (**text** or __text__) → text
 *   - Italic (*text* or _text_)   → text
 *   - Inline code (`text`)        → text
 *   - Unordered list items (- / * / +) → • item
 *   - Ordered list items (1. …)  → kept as-is (number preserved)
 *   - Blockquote markers (> )    → stripped
 *   - Trailing whitespace per line → trimmed
 *   - Runs of 3+ blank lines → collapsed to 2
 *
 * Does NOT parse links or images (angle-bracket, reference, or
 * [label](url) forms) — those are left as-is; the plain-text consumer
 * can see the label and URL without extra work.
 */

// Contract: input is arbitrary assistant text (may contain ANSI from stream
// renderer fragments that escaped stripping). Output is pure UTF-8 plaintext
// with no ANSI codes and no markdown syntax characters for the transforms above.

// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1b\[[0-9;]*m/g;

/** Strip all ANSI SGR escape sequences. */
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

/** Convert a heading line's text to uppercase (H1/H2 only). */
function headingToUppercase(text: string): string {
  return text.toUpperCase();
}

/**
 * Strip markdown from `input` and return plain text.
 * The function is pure — no module state, no side effects.
 */
export function stripMarkdown(input: string): string {
  // 1. Remove ANSI codes.
  const clean = stripAnsi(input);

  const lines = clean.split('\n');
  const out: string[] = [];

  let inFence = false;
  let fenceLang = '';

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? '';

    // --- Fenced code block handling ---
    const fenceMatch = /^(`{3,}|~{3,})(\w*)/.exec(raw);
    if (fenceMatch && !inFence) {
      inFence = true;
      fenceLang = fenceMatch[2] ?? '';
      // Emit a label line instead of the fence marker.
      if (fenceLang) {
        out.push(`[${fenceLang}]`);
      }
      continue;
    }
    if (inFence) {
      if (fenceMatch) {
        // Closing fence — exit block mode.
        inFence = false;
        fenceLang = '';
      } else {
        // Inside a fence — indent 2 spaces, no further transforms.
        out.push(`  ${raw}`);
      }
      continue;
    }

    let line = raw;

    // --- Horizontal rule (---, ***, ___) → blank ---
    if (/^(\s*[-*_]){3,}\s*$/.test(line)) {
      out.push('');
      continue;
    }

    // --- ATX headings ---
    const h1 = /^#{1}\s+(.+)/.exec(line);
    const h2 = /^#{2}\s+(.+)/.exec(line);
    const hN = /^#{3,6}\s+(.+)/.exec(line);
    if (h1 && !h2) {
      const text = headingToUppercase((h1[1] ?? '').trim());
      out.push(text);
      out.push('');
      continue;
    }
    if (h2) {
      const text = headingToUppercase((h2[1] ?? '').trim());
      out.push(text);
      out.push('');
      continue;
    }
    if (hN) {
      out.push((hN[1] ?? '').trim());
      continue;
    }

    // --- Blockquote marker ---
    line = line.replace(/^>\s?/, '');

    // --- Unordered list items: - / * / + at start of line ---
    line = line.replace(/^(\s*)[-*+]\s+/, (_m, indent: string) => `${indent}• `);

    // --- Inline code: `…` → placeholder (protect content from emphasis transforms) ---
    const codeSpans: string[] = [];
    line = line.replace(/`([^`]+)`/g, (_m, content: string) => {
      codeSpans.push(content);
      return `\x00CS${codeSpans.length - 1}\x00`;
    });

    // --- Bold: **…** or __…__ ---
    line = line.replace(/\*\*(.+?)\*\*/g, '$1');
    line = line.replace(/__(.+?)__/g, '$1');

    // --- Italic: *…* or _…_ (must not be __ or **) ---
    line = line.replace(/\*([^*]+)\*/g, '$1');
    line = line.replace(/_([^_]+)_/g, '$1');

    // --- Restore inline code placeholders ---
    // eslint-disable-next-line no-control-regex
    line = line.replace(/\x00CS(\d+)\x00/g, (_m, idx: string) => codeSpans[Number(idx)] ?? '');

    // Trim trailing whitespace.
    out.push(line.trimEnd());
  }

  // Collapse runs of 3+ blank lines to 2.
  const collapsed: string[] = [];
  let blanks = 0;
  for (const l of out) {
    if (l.trim() === '') {
      blanks++;
      if (blanks <= 2) collapsed.push(l);
    } else {
      blanks = 0;
      collapsed.push(l);
    }
  }

  return collapsed.join('\n').trimEnd();
}
