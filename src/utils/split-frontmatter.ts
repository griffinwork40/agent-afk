/**
 * Canonical frontmatter splitter shared by all three SKILL.md / agent-markdown
 * parsers in the repo.
 *
 * Previously each parser had its own inline splitting logic that disagreed on
 * two edge-cases (fixes #3841):
 *
 *  1. Closer at EOF with no trailing newline:
 *       - `parseSkillMd` required `\n---\n` → missed the EOF case.
 *       - `tool-injector` and `parseAgentMarkdown` accepted `\n---` (no newline
 *         required after) → they parsed it; `parseSkillMd` returned null.
 *
 *  2. Opener strictness:
 *       - `parseAgentMarkdown` only checked `startsWith('---')`, so `----` or
 *         `---title` (no newline) were accepted as valid openers.
 *       - The other two required `startsWith('---\n')`.
 *
 *  3. Closer greediness:
 *       - `tool-injector` and `parseAgentMarkdown` used `indexOf('\n---')`,
 *         which matches `\n----`, `\n---foo`, etc. inside the body.
 *
 * Canonical rules implemented here:
 *   opener : `^---\r?\n`          (exactly three dashes, then CRLF or LF)
 *   closer : `\r?\n---[ \t]*(\r?\n|$)` (exactly three dashes on their own line,
 *             optional trailing whitespace, followed by a newline OR end-of-string)
 *
 * Each caller still owns its own key-level parsing; the field sets differ
 * between SKILL.md metadata, plugin metadata, and agent definitions.
 *
 * @module utils/split-frontmatter
 */

/** Result of a successful frontmatter split. */
export interface SplitFrontmatter {
  /** Raw YAML text between the opening and closing `---` delimiters. */
  yaml: string;
  /** Everything after the closing delimiter line (may be empty string). */
  body: string;
}

/**
 * Split a markdown document into its YAML frontmatter block and body.
 *
 * Returns `null` when:
 *   - the document does not start with `---` followed immediately by LF or CRLF
 *   - there is no valid closing `---` line (exactly three dashes, optional
 *     trailing horizontal whitespace, then newline or end-of-string)
 *
 * A `----` or `---foo` line inside the body is NOT treated as a closer because
 * the closer regex anchors on word-boundary trailing space/end.  Likewise a
 * `----` opener is rejected because the opener requires exactly `---\r?\n`.
 *
 * CRLF line endings are normalised in the opener/closer search but preserved
 * verbatim inside `yaml` and `body` so callers can handle them as needed.
 */
export function splitFrontmatter(content: string): SplitFrontmatter | null {
  // Opener: must be exactly `---` then LF or CRLF (no extra dashes, no text).
  if (!content.startsWith('---\n') && !content.startsWith('---\r\n')) {
    return null;
  }

  // Skip past the opening delimiter line.
  const openerLen = content.startsWith('---\r\n') ? 5 : 4; // "---\r\n" or "---\n"
  const afterOpener = content.slice(openerLen);

  // Closer: `\n---` or `\r\n---` followed by optional horizontal whitespace
  // then either a newline (LF or CRLF) or end-of-string.
  // We search for `\n---` and then validate what follows.
  let searchFrom = 0;
  while (true) {
    const idx = afterOpener.indexOf('\n---', searchFrom);
    if (idx === -1) {
      // No `\n---` found at all → no valid closer.
      return null;
    }

    // The char before `\n` might be `\r` (CRLF line ending). That's fine —
    // the `\n---` is still the right anchor; CRLF is inside the yaml text.

    // Validate that the `---` is exactly three dashes (not `----` or `---foo`).
    const closerStart = idx + 1; // position of first `-` in `---`
    const afterDashes = afterOpener.slice(closerStart + 3); // text after `---`

    // afterDashes must be: optional spaces/tabs, then \n, \r\n, or end-of-string.
    const trailingMatch = /^[ \t]*(\r?\n|$)/.exec(afterDashes);
    if (trailingMatch === null) {
      // This `\n---` is `\n----` or `\n---word` — keep searching.
      searchFrom = idx + 1;
      continue;
    }

    // Valid closer found.
    const yaml = afterOpener.slice(0, idx); // text from after opener to before `\n---`
    const closerLineLen = 3 + trailingMatch[0].length; // `---` + trailing whitespace + newline
    const bodyStart = closerStart + closerLineLen;
    const body = afterOpener.slice(bodyStart);

    return { yaml, body };
  }
}
