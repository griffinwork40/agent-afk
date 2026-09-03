import { type Token, type Tokens } from 'marked';
import { wrapToWidth, hardWrapToWidth } from './wrap.js';
import { highlightCode } from './syntax-highlight.js';
import { palette } from './palette.js';
import { registerCodeBlock } from './code-block-register.js';

/**
 * Render a blockquote token to ANSI-styled terminal output.
 *
 * Accepts a `renderTokens` callback so the caller (renderMarkdownToTerminal)
 * can thread its recursive token renderer — blockquotes can contain any
 * block-level content (paragraphs, lists, nested blockquotes, code blocks).
 *
 * Invariant (TUI rhythm contract, docs/tui-rhythm.md): emits exactly ONE
 * trailing '\n'.  Blank-line separation between blocks comes solely from
 * marked's `space` token.
 *
 * The `│ ` gutter is stamped only on non-empty lines; empty lines (produced
 * by trailing \n\n on the inner paragraph token) must not become orphaned
 * "  │ " rows at the end of the blockquote.
 *
 * breakLongWords: same contract as the list branch — an unbreakable token
 * wider than innerWidth would otherwise leave here over budget, and the
 * indent-blind commit-time wrap would re-split it at column 0, orphaning
 * the continuation outside the `│ ` gutter.
 */
export function renderBlockquote(
  bq: Tokens.Blockquote,
  maxTableWidth: number | undefined,
  renderTokens: (tokens: Token[], maxWidth?: number) => string,
): string {
  const prefix = palette.dim('  │ ');
  const prefixCols = 4; // "  │ " = 2 spaces + box-draw + space
  const innerWidth = maxTableWidth !== undefined
    ? Math.max(1, maxTableWidth - prefixCols)
    : undefined;
  // Render nested blocks against the space left after this blockquote's
  // prefix. In particular, code blocks must wrap once at their final inner
  // width rather than first at the terminal width and then again here.
  const inner = bq.tokens ? renderTokens(bq.tokens as Token[], innerWidth) : bq.text;
  const lines: string[] = [];
  for (const para of inner.split('\n')) {
    // breakLongWords: same contract as the list branch above — an
    // unbreakable token wider than innerWidth would otherwise leave
    // here over budget, and the indent-blind commit-time wrap would
    // re-split it at column 0, orphaning the continuation outside the
    // `│ ` gutter.
    const wrapped = innerWidth !== undefined
      ? wrapToWidth(para, innerWidth, { breakLongWords: true })
      : para;
    for (const line of wrapped.split('\n')) {
      // Only stamp the prefix on non-empty lines; empty lines (produced
      // by trailing \n\n on the inner paragraph token) must not become
      // orphaned "  │ " rows at the end of the blockquote.
      lines.push(line ? prefix + line : '');
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Render a fenced code block token to ANSI-styled terminal output.
 *
 * Applies syntax highlighting via `highlightCode` and wraps each body line
 * with a dim `│ ` gutter.  The language tag appears as a dim header line
 * only when the fence explicitly names a language; an unlabelled fence has
 * no header.
 *
 * Empty fence guard: a model emitting "```bash\n```" (open + language + close
 * with no body) used to render as just "│ bash" with no body line —
 * visually indistinguishable from a render bug.  The empty case surfaces a
 * loud placeholder so reviewers see the missing command instead of assuming
 * it rendered fine.
 *
 * Invariant (TUI rhythm contract, docs/tui-rhythm.md): emits exactly ONE
 * trailing '\n'.  Blank-line separation between blocks comes solely from
 * marked's `space` token.
 */
export function renderCodeBlock(
  code: Tokens.Code,
  maxTableWidth: number | undefined,
): string {
  const lang = code.lang || 'text';
  // Loud-fail empty fences. Without this guard, a model emitting
  // "```bash\n```" (open + language + close with no body) renders as
  // just "│ bash" with no body line — visually indistinguishable from
  // a code block whose contents got eaten by a render bug. Surface the
  // omission as an explicit placeholder so reviewers see the missing
  // command instead of assuming it rendered fine.
  if (code.text.trim() === '') {
    const label = code.lang ? `(empty ${code.lang} block)` : '(empty code block)';
    // One trailing '\n' (line terminator), not '\n\n' — the same block
    // rhythm invariant as the non-empty branch below and the heading /
    // paragraph cases above (docs/tui-rhythm.md): every block token owns
    // exactly one trailing newline; the inter-block blank comes solely
    // from marked's `space` token. Emitting '\n\n' here double-spaced the
    // gap after an empty fence in the non-streamed render paths.
    return palette.dim(`│ ${label}`) + '\n';
  }
  // Register the raw text before any ANSI decoration so `/copy N` can
  // retrieve clean, paste-ready source. The index is 1-based per turn.
  const blockIndex = registerCodeBlock(lang, code.text);

  const highlighted = highlightCode(code.text, lang);
  const rawBodyLines = highlighted.split('\n');
  // Drop trailing empty line so adjacent blocks don't double-space.
  if (rawBodyLines.length > 0 && rawBodyLines[rawBodyLines.length - 1] === '') rawBodyLines.pop();
  const gutter = palette.dim('│ ');
  // Invariant: gutter is "│ " — exactly 2 display columns (box-draw char + space).
  // When maxTableWidth is provided, hard-wrap each body line to the available
  // content width (maxTableWidth - 2) so that lines wider than the terminal do
  // not cause the terminal to auto-wrap at column 0 and lose the gutter prefix
  // on continuation rows. hardWrapToWidth is character-level (not word-aware),
  // matching terminal behavior for code, and preserves ANSI styling across rows.
  // When maxTableWidth is undefined (non-streaming path), leave behavior unchanged.
  // U+2502 is one column on standard terminals, plus the following space.
  // Terminals that render East Asian Ambiguous characters wide remain a
  // broader, pre-existing edge case for the TUI's box-drawing characters.
  const gutterCols = 2; // Unicode box-drawing U+2502 (1 display col) + space (1 col)
  const contentWidth = maxTableWidth !== undefined ? Math.max(1, maxTableWidth - gutterCols) : undefined;
  const bodyLines: string[] = [];
  for (const line of rawBodyLines) {
    if (contentWidth !== undefined) {
      const wrapped = hardWrapToWidth(line, contentWidth);
      const rows = wrapped.split('\n');
      // A wrapping implementation may terminate an exactly-full final row
      // with a newline. Do not turn that implementation detail into a
      // content-free gutter row; genuine blank source lines still arrive as
      // their own entry in rawBodyLines and remain visible.
      if (rows.length > 1 && rows[rows.length - 1] === '') rows.pop();
      for (const row of rows) {
        bodyLines.push(row);
      }
    } else {
      bodyLines.push(line);
    }
  }
  const body = bodyLines.map((line) => gutter + line).join('\n');
  // Language tag + copy hint. The `/cp N` hint tells the user which index
  // to pass to `/copy` to grab this block. When there is no explicit
  // language tag, emit a bare hint line instead of no header at all —
  // the hint is the point.
  const copyHint = palette.dim(` ── /cp ${blockIndex}`);
  const header = code.lang
    ? palette.dim(`│ ${code.lang}`) + copyHint + '\n'
    : palette.dim('│') + copyHint + '\n';
  return header + body + '\n';
}
