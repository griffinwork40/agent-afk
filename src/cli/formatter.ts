import chalk from 'chalk';
import { Lexer, type Token, type Tokens } from 'marked';
import { env } from '../config/env.js';
import { displayWidth, padDisplay, truncateDisplayWidth } from './display.js';
import { highlightCode } from './syntax-highlight.js';
import { wrapToWidth } from './wrap.js';
import { palette } from './palette.js';

function visualWidth(s: string): number {
  return displayWidth(s);
}
function padCell(
  content: string,
  width: number,
  align: 'left' | 'right' | 'center' | null,
): string {
  return padDisplay(content, width, align ?? 'left');
}

interface RenderMarkdownOptions {
  maxWidth?: number;
}

/** Matches a whole codespan text that is a slash command (no surrounding path segments). */
const SLASH_CODESPAN_RE = /^\/[A-Za-z][\w:-]*$/;

/** Matches bare slash-command tokens in prose. Avoids filesystem paths by requiring word boundaries. */
const SLASH_TOKEN_RE = /(?<=\s|^)(\/[A-Za-z][\w:-]*)(?=\s|[,.:;!?]?$|[,.:;!?]\s)/g;

function renderInlineTokens(tokens?: Tokens.Generic[]): string {
  if (!tokens) return '';
  return tokens.map((token) => {
    switch (token.type) {
      case 'codespan': {
        const csText = (token as Tokens.Codespan).text;
        return SLASH_CODESPAN_RE.test(csText) ? palette.brand(csText) : palette.user(csText);
      }
      case 'strong': {
        const strong = token as Tokens.Strong;
        return palette.bold(strong.tokens ? renderInlineTokens(strong.tokens as Tokens.Generic[]) : strong.text);
      }
      case 'em': {
        const em = token as Tokens.Em;
        return palette.italic(em.tokens ? renderInlineTokens(em.tokens as Tokens.Generic[]) : em.text);
      }
      case 'text':
        return (token as Tokens.Text).text.replace(SLASH_TOKEN_RE, (t) => palette.brand(t));
      case 'link': {
        const link = token as Tokens.Link;
        const linkText = link.tokens ? renderInlineTokens(link.tokens as Tokens.Generic[]) : link.text;
        // Bare auto-link (linkText === href): emit the URL once. Otherwise show
        // text plus parenthesized href so the destination is still visible.
        return linkText === link.href
          ? linkText
          : linkText + palette.dim(` (${link.href})`);
      }
      case 'escape':
        // marked emits `raw='\\*'` and `text='*'` for backslash-escaped chars;
        // render the unescaped char, not the raw source with backslash.
        return (token as Tokens.Escape).text;
      default:
        return token.raw;
    }
  }).join('');
}

const RAW_PASSTHROUGH_TYPES = new Set([
  'code', 'table', 'blockquote', 'hr', 'html',
]);

/**
 * Render inline markdown (bold, italic, code, links) to ANSI-styled text.
 * Headings and lists are projected to single-line bold/bullet form.
 * Truly unprojectible blocks (code fences, tables, blockquotes, hr, html)
 * are returned as raw text — card bodies are single-line summaries.
 */
export function renderCardLine(text: string): string {
  // Safety net: drop an orphaned leading bold marker (`** value`) that marked
  // would otherwise print literally — `** ` (with a trailing space) is not a
  // valid CommonMark opener. The whitespace guard spares globs (`**/*.ts`) and
  // identifiers (`__init__`), which have no space after the marker.
  const normalized = text.replace(/^(?:\*\*|__)\s/, '');
  const tokens = Lexer.lex(normalized);
  // Types that cannot be meaningfully projected to a single line — return the
  // raw input unchanged. Return `normalized` (not `text`) so the orphaned-marker
  // strip above still applies on this path: a body like `** > quote` lexes to a
  // blockquote and would otherwise leak the literal `**`. `normalized` differs
  // from `text` only by that stripped leading marker, so non-orphan lines are
  // byte-identical here.
  const hasRawPassthrough = tokens.some((t) => RAW_PASSTHROUGH_TYPES.has(t.type));
  if (hasRawPassthrough) return normalized;
  return tokens.map((t) => {
    switch (t.type) {
      case 'heading': {
        const h = t as Tokens.Heading;
        return palette.bold(renderInlineTokens(h.tokens as Tokens.Generic[]));
      }
      case 'list': {
        const l = t as Tokens.List;
        return l.items
          .map((item) => {
            const firstToken = item.tokens[0] as { tokens?: Token[] } | undefined;
            const inlineTokens = (firstToken?.tokens ?? []) as Tokens.Generic[];
            return '• ' + renderInlineTokens(inlineTokens);
          })
          .join(', ');
      }
      case 'paragraph': {
        const para = t as Tokens.Paragraph;
        return renderInlineTokens(para.tokens as Tokens.Generic[]);
      }
      case 'text': {
        const txt = t as Tokens.Text;
        return txt.tokens ? renderInlineTokens(txt.tokens as Tokens.Generic[]) : txt.text;
      }
      case 'space':
        return '';
      default:
        return t.raw;
    }
  }).join('');
}

/**
 * Render markdown text to terminal-friendly ANSI output using marked tokens.
 */
export function renderMarkdownToTerminal(text: string, opts: RenderMarkdownOptions = {}): string {
  const tokens = Lexer.lex(text);
  const maxTableWidth = Number.isFinite(opts.maxWidth) ? Math.floor(opts.maxWidth ?? 0) : undefined;

  function renderInline(tokens?: Tokens.Generic[]): string {
    return renderInlineTokens(tokens);
  }

  function renderTokens(tokens: Token[]): string {
    return tokens.map((token) => {
      switch (token.type) {
        case 'heading': {
          const heading = token as Tokens.Heading;
          const headingText = heading.tokens ? renderInline(heading.tokens as Tokens.Generic[]) : heading.text;
          // H1 → brand (warm orange, bold) — top-level identity tone.
          // H2 → palette.heading (bold white) — strong but neutral.
          // H3+ → bold (terminal default weight, no hue).
          // Invariant (TUI rhythm contract, docs/tui-rhythm.md): every block
          // token emits exactly ONE trailing '\n' (a line terminator, not a
          // blank line) and NO leading blank. Blank-line separation between
          // blocks comes solely from marked's `space` token (one source blank
          // line → one '\n'). A leading '\n' here would stack with the
          // predecessor block's separation into a double blank — and in the
          // streaming commit path it survives `formatBlockForCommit` (which
          // strips trailing newlines) as a leading blank before the heading.
          if (heading.depth === 1) return palette.brand.bold(headingText) + '\n';
          if (heading.depth === 2) return palette.heading(headingText) + '\n';
          return palette.bold(headingText) + '\n';
        }
        case 'paragraph': {
          // One trailing '\n' (line terminator), not '\n\n'. marked already
          // emits a `space` token for the source blank line that follows a
          // paragraph; adding a second '\n' here double-spaced every block
          // boundary in non-streamed rendering. See the heading invariant above.
          const para = token as Tokens.Paragraph;
          return renderInline(para.tokens as Tokens.Generic[]) + '\n';
        }
        case 'code': {
          const code = token as Tokens.Code;
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
          const highlighted = highlightCode(code.text, lang);
          const bodyLines = highlighted.split('\n');
          // Drop trailing empty line so adjacent blocks don't double-space.
          if (bodyLines.length > 0 && bodyLines[bodyLines.length - 1] === '') bodyLines.pop();
          const gutter = palette.dim('│ ');
          const body = bodyLines.map((line) => gutter + line).join('\n');
          // Language tag only when explicitly given; no literal "[code]" header
          // when the fence has no language. The dim left gutter visually marks
          // the block (mirrors the blockquote convention above).
          const header = code.lang ? palette.dim(`│ ${code.lang}`) + '\n' : '';
          return header + body + '\n';
        }
        case 'codespan': {
          const raw = (token as Tokens.Codespan).text;
          return SLASH_CODESPAN_RE.test(raw) ? palette.brand(raw) : palette.user(raw);
        }
        case 'strong': {
          const strong = token as Tokens.Strong;
          return palette.bold(strong.tokens ? renderInline(strong.tokens as Tokens.Generic[]) : strong.text);
        }
        case 'em': {
          const em = token as Tokens.Em;
          return palette.italic(em.tokens ? renderInline(em.tokens as Tokens.Generic[]) : em.text);
        }
        case 'text': {
          // Marked emits block-level 'text' tokens inside tight list items.
          // Its `.tokens` holds inline children (strong, em, codespan, …) —
          // render them through renderInline so bold/italic don't leak.
          const t = token as Tokens.Text;
          return t.tokens ? renderInline(t.tokens as Tokens.Generic[]) : t.text;
        }
        case 'list': {
          const list = token as Tokens.List;
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
            const hang = padDisplay(' '.repeat(prefixWidth), prefixWidth, 'left');
            // Invariant: every continuation line — whether produced by a source
            // newline or by a width wrap — must carry the prefix-width hanging
            // indent. The commit-time formatter runs an indent-blind
            // wrapToWidth pass after this; if a long item line leaves here
            // unwrapped, that pass reflows the continuation to column 0 and the
            // list visually dissolves. Wrap each source line to
            // (maxTableWidth - prefixWidth) so prefix + content == maxTableWidth
            // == the outer wrap width; the outer pass then never re-splits these
            // lines. Mirrors the blockquote branch below.
            const innerWidth = maxTableWidth ? Math.max(1, maxTableWidth - prefixWidth) : undefined;
            for (const srcLine of itemText.trim().split('\n')) {
              const wrapped = innerWidth ? wrapToWidth(srcLine, innerWidth) : srcLine;
              const segs = wrapped.split('\n');
              for (let s = 0; s < segs.length; s++) {
                // wrapToWidth runs wrap-ansi with trim:false, so a wrap at a
                // space keeps that space at the START of the next segment.
                // Strip it on wrap continuations (s > 0) only — otherwise the
                // hanging indent sits one column past the item text. The first
                // segment of each source line keeps its leading whitespace so
                // nested-list indentation survives. Also drop trailing spaces so
                // they don't inflate the line past the width budget.
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
        case 'space':
          return '\n';
        case 'hr': {
          // Use the configured maxTableWidth so the rule tracks the wrap width
          // instead of overflowing or falling short — it is already the
          // compositor's row budget, so no separate capping is needed. Fall
          // back to 40 when no width is set (e.g. direct callers that omit opts).
          const hrWidth = maxTableWidth ?? 40;
          return palette.dim('─'.repeat(hrWidth)) + '\n';
        }
        case 'blockquote': {
          const bq = token as Tokens.Blockquote;
          const inner = bq.tokens ? renderTokens(bq.tokens as Token[]) : bq.text;
          const prefix = palette.dim('  │ ');
          const prefixCols = 4; // "  │ " = 2 spaces + box-draw + space
          const innerWidth = maxTableWidth ? Math.max(1, maxTableWidth - prefixCols) : undefined;
          const lines: string[] = [];
          for (const para of inner.split('\n')) {
            const wrapped = innerWidth ? wrapToWidth(para, innerWidth) : para;
            for (const line of wrapped.split('\n')) {
              // Only stamp the prefix on non-empty lines; empty lines (produced
              // by trailing \n\n on the inner paragraph token) must not become
              // orphaned "  │ " rows at the end of the blockquote.
              lines.push(line ? prefix + line : '');
            }
          }
          return lines.join('\n') + '\n';
        }
        case 'table': {
          const table = token as Tokens.Table;
          const renderCell = (cell: Tokens.TableCell) =>
            cell.tokens ? renderInline(cell.tokens as Tokens.Generic[]) : cell.text;
          const headerCells = table.header.map(renderCell);
          const dataRows = table.rows.map((row) => row.map(renderCell));
          const colCount = headerCells.length;
          const widths: number[] = new Array<number>(colCount).fill(0);
          // longestWord[i] = widest UNBREAKABLE token in column i. A word cannot
          // be wrapped, so it is the column's incompressible minimum — used by the
          // squeeze below as a per-column floor so a narrow single-word column
          // (e.g. a "Verdict" of CONFIRMED/OVERSTATED) is never crushed below its
          // own content and chopped to an ellipsis.
          const longestWord: number[] = new Array<number>(colCount).fill(0);
          const wordWidth = (s: string): number => {
            let max = 0;
            for (const tok of s.split(/\s+/)) {
              if (tok) max = Math.max(max, visualWidth(tok));
            }
            return max;
          };
          for (let i = 0; i < colCount; i++) {
            let w = visualWidth(headerCells[i] ?? '');
            let lw = wordWidth(headerCells[i] ?? '');
            for (const row of dataRows) {
              w = Math.max(w, visualWidth(row[i] ?? ''));
              lw = Math.max(lw, wordWidth(row[i] ?? ''));
            }
            widths[i] = w;
            longestWord[i] = lw;
          }

          const targetWidth = maxTableWidth ?? Number.POSITIVE_INFINITY;
          const chromeWidth = (3 * colCount) + 1;
          const availableContentWidth = Math.max(0, targetWidth - chromeWidth);
          const totalContentWidth = widths.reduce((sum, width) => sum + width, 0);
          if (Number.isFinite(targetWidth) && totalContentWidth > availableContentWidth) {
            // Invariant: after this block sum(widths) <= availableContentWidth, so
            // every emitted row fits maxTableWidth and the commit-time second
            // wrapToWidth pass (markdown-stream-format.ts) stays a no-op for tables
            // (a row even 1 col over budget would re-split at its last space into a
            // fragment + orphan '│' line and desync the compositor's row count).
            //
            // Allocation is floor-based water-filling, NOT uniform proportional
            // shrink. Proportional shrink scaled every column by the same factor,
            // so a high overflow ratio crushed narrow single-word columns (a
            // "Verdict" of CONFIRMED/OVERSTATED) below their content width and
            // truncateDisplayWidth chopped them to "Verd…". Instead: floor each
            // column at min(natural, longestWord, WORD_FLOOR_CAP) — its
            // incompressible width, capped so one long token (a path/URL) cannot
            // starve the rest — then hand the leftover budget to columns in
            // proportion to their reducible slack (natural - floor). All the
            // squeeze lands on genuinely wide columns; narrow ones stay readable.
            const WORD_FLOOR_CAP = 14;
            const floors = widths.map((w, i) =>
              Math.min(w, Math.max(1, Math.min(longestWord[i] ?? 1, WORD_FLOOR_CAP))),
            );
            const floorTotal = floors.reduce((sum, w) => sum + w, 0);
            const constrained = floors.slice();
            if (floorTotal <= availableContentWidth) {
              const slack = widths.map((w, i) => Math.max(0, w - (floors[i] ?? 0)));
              const slackTotal = slack.reduce((sum, s) => sum + s, 0);
              const leftover = availableContentWidth - floorTotal;
              if (slackTotal > 0 && leftover > 0) {
                for (let i = 0; i < colCount; i++) {
                  constrained[i] = (floors[i] ?? 0) +
                    Math.floor(((slack[i] ?? 0) / slackTotal) * leftover);
                }
                // Hand the Math.floor remainder to the widest-slack columns until
                // the total reaches exactly availableContentWidth (never over it).
                const order = constrained
                  .map((_, i) => i)
                  .sort((a, b) => (slack[b] ?? 0) - (slack[a] ?? 0));
                let used = constrained.reduce((sum, w) => sum + w, 0);
                let guard = 0;
                while (used < availableContentWidth && order.length > 0 && guard < colCount * 4) {
                  const i = order[guard % order.length]!;
                  if ((constrained[i] ?? 0) < (widths[i] ?? 0)) {
                    constrained[i] = (constrained[i] ?? 0) + 1;
                    used += 1;
                  }
                  guard += 1;
                }
              }
            } else {
              // Degenerate: even the floors exceed the budget (too many columns
              // for the width — chromeWidth alone can dominate). Shrink the floors
              // proportionally to fit, preserving relative column sizes. The
              // return-line cap below still guarantees no line exceeds the budget.
              const scale = availableContentWidth / floorTotal;
              for (let i = 0; i < colCount; i++) {
                constrained[i] = Math.max(1, Math.floor((floors[i] ?? 0) * scale));
              }
              let constrainedTotal = constrained.reduce((sum, w) => sum + w, 0);
              while (constrainedTotal > availableContentWidth) {
                let widest = -1;
                for (let i = 0; i < colCount; i++) {
                  if ((constrained[i] ?? 0) > 1 &&
                      (widest === -1 || (constrained[i] ?? 0) > (constrained[widest] ?? 0))) {
                    widest = i;
                  }
                }
                if (widest === -1) break;
                constrained[widest] = (constrained[widest] ?? 0) - 1;
                constrainedTotal -= 1;
              }
            }
            for (let i = 0; i < colCount; i++) {
              widths[i] = constrained[i] ?? widths[i] ?? 0;
            }
          }

          const aligns = table.align;
          const borderLine = (left: string, mid: string, right: string) =>
            palette.dim(left + widths.map((w) => '─'.repeat(w + 2)).join(mid) + right);
          const wrapCell = (content: string, width: number) => {
            if (width <= 0) return [''];
            const rendered = wrapToWidth(content, width);
            return rendered.split('\n').map((line) => truncateDisplayWidth(line, width));
          };
          const dataLines = (cells: string[], header = false) => {
            const wrapped = cells.map((cell, i) =>
              wrapCell(
                header ? palette.bold(cell) : cell,
                widths[i] ?? 0,
              ),
            );
            const rowHeight = Math.max(1, ...wrapped.map((lines) => lines.length));
            const lines: string[] = [];
            for (let row = 0; row < rowHeight; row++) {
              lines.push(
                palette.dim('│') +
                  wrapped
                    .map((cellLines, i) => ' ' + padCell(cellLines[row] ?? '', widths[i] ?? 0, aligns[i] ?? null) + ' ')
                    .join(palette.dim('│')) +
                  palette.dim('│'),
              );
            }
            return lines;
          };
          const lines: string[] = [borderLine('┌', '┬', '┐')];
          lines.push(...dataLines(headerCells, true));
          lines.push(borderLine('├', '┼', '┤'));

          for (let rowIdx = 0; rowIdx < dataRows.length; rowIdx++) {
            lines.push(...dataLines(dataRows[rowIdx]!));
            // Add a thin row separator between data rows (but not after the last row)
            if (rowIdx < dataRows.length - 1) {
              lines.push(borderLine('├', '┼', '┤'));
            }
          }

          lines.push(borderLine('└', '┴', '┘'));
          // Safety net: hard-cap every emitted line to the budget. In the normal
          // and degenerate squeeze paths the rows already fit, so this is a no-op;
          // it only bites in pathological cases (e.g. chromeWidth alone exceeds
          // targetWidth), guaranteeing the downstream wrapToWidth never re-splits
          // a structural table row regardless of column math.
          if (!Number.isFinite(targetWidth)) {
            return lines.join('\n') + '\n';
          }
          const lineCap = Math.floor(targetWidth);
          return lines.map((line) => truncateDisplayWidth(line, lineCap)).join('\n') + '\n';
        }
        default:
          return token.raw;
      }
    }).join('');
  }

  return renderTokens(tokens);
}

/**
 * Format assistant responses with syntax highlighting and colors
 */
export class OutputFormatter {
  private useColors: boolean;

  constructor(useColors: boolean = true) {
    this.useColors = useColors && !!chalk.level;
  }

  /**
   * Format markdown-style text with syntax highlighting via marked tokens.
   */
  formatMarkdown(text: string): string {
    if (!this.useColors) return text;
    return renderMarkdownToTerminal(text);
  }

  /**
   * Format error messages
   */
  formatError(message: string, error?: Error): string {
    let output = palette.error('✗ Error: ') + message;
    
    if (error && error.message) {
      output += '\n' + palette.error(error.message);
    }

    if (error && error.stack && env.DEBUG) {
      output += '\n' + palette.dim(error.stack);
    }

    return output;
  }

  /**
   * Format success messages
   */
  formatSuccess(message: string): string {
    return palette.success('✓ ') + message;
  }

  /**
   * Format info messages
   */
  formatInfo(message: string): string {
    return palette.info('ℹ ') + message;
  }

  /**
   * Format warnings
   */
  formatWarning(message: string): string {
    return palette.warning('⚠ ') + message;
  }

  /**
   * Format system commands (like /help, /exit)
   */
  formatCommand(command: string): string {
    return palette.dim(command);
  }

  /**
   * Format the prompt prefix in interactive mode
   */
  formatPrompt(modelName: string): string {
    return palette.bold(palette.plan(`afk (${modelName})`)) + palette.dim(' › ');
  }

  /**
   * Format model info
   */
  formatModelInfo(model: string, maxTokens: number, temp: number): string {
    // chalk.white kept raw — no semantic palette role for neutral terminal-default text.
    return palette.dim(
      `Model: ${chalk.white(model)} | Max tokens: ${chalk.white(maxTokens)} | Temperature: ${chalk.white(temp)}`
    );
  }

  /**
   * Create a separator line
   */
  separator(char: string = '─', width: number = 50): string {
    return palette.dim(char.repeat(width));
  }

  /**
   * Format help text with sections
   */
  formatHelp(sections: { title: string; items: string[] }[]): string {
    const lines: string[] = [];

    for (const section of sections) {
      lines.push(palette.heading(`\n${section.title}`));
      lines.push(this.separator());
      
      for (const item of section.items) {
        lines.push(`  ${item}`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Format streaming text (for partial responses)
   */
  formatStreaming(text: string): string {
    return this.useColors ? text : text;
  }
}

/**
 * Default formatter instance
 */
export const formatter = new OutputFormatter();

/**
 * Truncate text to a maximum length
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Wrap text to a maximum width
 */
export function wordWrap(text: string, width: number): string {
  const words = text.split(' ');
  const lines: string[] = [];
  let currentLine = '';

  for (const word of words) {
    if (currentLine.length + word.length + 1 <= width) {
      currentLine += (currentLine ? ' ' : '') + word;
    } else {
      if (currentLine) lines.push(currentLine);
      currentLine = word;
    }
  }

  if (currentLine) lines.push(currentLine);
  return lines.join('\n');
}
