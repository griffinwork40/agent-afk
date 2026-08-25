import { type Token, type Tokens } from 'marked';
import { wrapToWidth } from './wrap.js';
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
  renderTokens: (tokens: Token[]) => string,
): string {
  const inner = bq.tokens ? renderTokens(bq.tokens as Token[]) : bq.text;
  const prefix = palette.dim('  │ ');
  const prefixCols = 4; // "  │ " = 2 spaces + box-draw + space
  const innerWidth = maxTableWidth ? Math.max(1, maxTableWidth - prefixCols) : undefined;
  const lines: string[] = [];
  for (const para of inner.split('\n')) {
    // breakLongWords: same contract as the list branch above — an
    // unbreakable token wider than innerWidth would otherwise leave
    // here over budget, and the indent-blind commit-time wrap would
    // re-split it at column 0, orphaning the continuation outside the
    // `│ ` gutter.
    const wrapped = innerWidth
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
  // maxTableWidth is accepted but not currently used — reserved for a future
  // hard-wrap pass on code blocks, and accepted here so the signature is
  // forward-compatible without a breaking API change.
  void maxTableWidth;
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
  const bodyLines = highlighted.split('\n');
  // Drop trailing empty line so adjacent blocks don't double-space.
  if (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();
  const gutter = palette.dim('│ ');
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
