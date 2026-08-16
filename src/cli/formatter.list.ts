import { type Token, type Tokens } from 'marked';
import { displayWidth, padDisplay } from './display.js';
import { wrapToWidth } from './wrap.js';
import { palette } from './palette.js';

function visualWidth(s: string): number {
  return displayWidth(s);
}
function padDisplay_(
  content: string,
  width: number,
  align: 'left' | 'right' | 'center',
): string {
  return padDisplay(content, width, align);
}

/**
 * Render a GFM list token (ordered, unordered, or task) to ANSI-styled
 * terminal output.
 *
 * Accepts a `renderTokens` callback so the caller (renderMarkdownToTerminal)
 * can thread its recursive token renderer — list items can contain nested
 * inline tokens (bold, italic, codespan) and even nested lists.
 *
 * Invariant (TUI rhythm contract, docs/tui-rhythm.md): every block token
 * emits exactly ONE trailing '\n'.  Blank-line separation between blocks
 * comes solely from marked's `space` token.
 *
 * Hanging indent invariant: every continuation line — whether produced by
 * a source newline or by a width wrap — carries the prefix-width hanging
 * indent.  Wrap each source line to (maxTableWidth - prefixWidth) so
 * prefix + content == maxTableWidth == the outer wrap width; the outer pass
 * then never re-splits these lines.  breakLongWords is load-bearing: a bare
 * path/URL/`file.ts:12-34` codespan wider than innerWidth would otherwise
 * escape the branch over budget and the indent-blind commit pass would break
 * it at column 0, dissolving the list.
 */
export function renderList(
  list: Tokens.List,
  maxTableWidth: number | undefined,
  renderTokens: (tokens: Token[]) => string,
): string {
  const items: string[] = [];
  // marked preserves the source-level starting index in `list.start`
  // (e.g. "5. foo\n6. bar" → start=5). Using `i + 1` here would
  // re-number from 1 every time the streamer chunks a loose ordered
  // list at \n\n boundaries — each fragment gets re-lexed as its
  // own one-item list and renders "1." regardless of the source.
  const startNum = list.ordered ? (typeof list.start === 'number' ? list.start : 1) : 1;
  for (let i = 0; i < list.items.length; i++) {
    const item = list.items[i]!;
    // Task-list items: emit the ☑/☐ glyph and drop the leading
    // `checkbox` token so it does not also render raw "[x] ".
    // Invariant: the `checkbox` token is always the first child of a
    // task item — filter it out before passing tokens to renderTokens
    // (below), and emit the glyph in the prefix instead.
    // GFM allows task syntax on ordered items too (marked sets
    // `item.task` for "1. [x] done"). The `isTask` branch must be
    // reachable in BOTH the ordered and unordered cases: an ordered
    // task keeps its number AND gains the glyph ("1. ☑ done").
    // Checking `list.ordered` first without re-testing `isTask` dropped
    // the glyph for ordered tasks — and because the `checkbox` token is
    // filtered out regardless, the user got neither glyph nor "[x]".
    const isTask = item.task === true;
    const checkboxGlyph = item.checked ? '☑' : '☐';
    const prefix = list.ordered
      ? isTask
        ? `  ${startNum + i}. ${checkboxGlyph} `
        : `  ${startNum + i}. `
      : isTask
        ? `  ${checkboxGlyph} `
        : '  • ';
    const renderableTokens: Token[] = item.tokens
      ? (isTask ? (item.tokens as Token[]).filter((t) => t.type !== 'checkbox') : (item.tokens as Token[]))
      : [];
    const itemText = renderableTokens.length > 0 ? renderTokens(renderableTokens) : item.text;
    const lines: string[] = [];
    let first = true;
    const prefixWidth = visualWidth(prefix);
    const hang = padDisplay_(' '.repeat(prefixWidth), prefixWidth, 'left');
    // Invariant: every continuation line — whether produced by a source
    // newline or by a width wrap — must carry the prefix-width hanging
    // indent. The commit-time formatter runs an indent-blind
    // wrapToWidth pass after this; if a long item line leaves here
    // unwrapped, that pass reflows the continuation to column 0 and the
    // list visually dissolves. Wrap each source line to
    // (maxTableWidth - prefixWidth) so prefix + content == maxTableWidth
    // == the outer wrap width; the outer pass then never re-splits these
    // lines. Mirrors the blockquote branch below.
    //
    // breakLongWords is load-bearing, not cosmetic: word-wrap alone
    // (hard:false) leaves a token WIDER than innerWidth unbroken — a
    // bare path/URL/`file.ts:12-34` codespan, which afk emits
    // constantly — so the line escapes this branch over budget and the
    // indent-blind commit pass breaks it at column 0, dropping the
    // hanging indent. That is precisely the dissolution the invariant
    // above forbids; enforcing the width here is what makes it true.
    const innerWidth = maxTableWidth ? Math.max(1, maxTableWidth - prefixWidth) : undefined;
    for (const srcLine of itemText.trim().split('\n')) {
      const wrapped = innerWidth
        ? wrapToWidth(srcLine, innerWidth, { breakLongWords: true })
        : srcLine;
      const segs = wrapped.split('\n');
      for (let s = 0; s < segs.length; s++) {
        // Normalize continuation whitespace defensively at this formatting
        // boundary. wrapToWidth removes generated edge spaces while preserving
        // source indentation, but this branch also accepts styled and nested
        // list content whose first segment may intentionally begin with spaces.
        // Only continuations are left-trimmed; all segments are right-trimmed
        // so whitespace cannot inflate the line past the width budget.
        let seg = segs[s]!;
        if (s > 0) seg = seg.replace(/^ +/, '');
        seg = seg.replace(/ +$/, '');
        if (!seg) {
          // Blank interior line: keep the gap, never emit a
          // hanging-indent-only orphan row.
          lines.push('');
          continue;
        }
        if (first) {
          lines.push(palette.dim(prefix) + seg);
          first = false;
        } else {
          lines.push(hang + seg);
        }
      }
    }
    items.push(lines.join('\n'));
  }
  return items.join('\n') + '\n';
}
