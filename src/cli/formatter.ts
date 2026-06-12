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
          if (heading.depth === 1) return palette.brand.bold('\n' + headingText + '\n');
          if (heading.depth === 2) return palette.heading('\n' + headingText + '\n');
          return palette.bold('\n' + headingText + '\n');
        }
        case 'paragraph': {
          const para = token as Tokens.Paragraph;
          return renderInline(para.tokens as Tokens.Generic[]) + '\n\n';
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
            return palette.dim(`│ ${label}`) + '\n\n';
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
            const prefix = list.ordered ? `  ${startNum + i}. ` : '  • ';
            const itemText = item.tokens ? renderTokens(item.tokens as Token[]) : item.text;
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
        case 'hr':
          return palette.dim('─'.repeat(40)) + '\n';
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
          for (let i = 0; i < colCount; i++) {
            let w = visualWidth(headerCells[i] ?? '');
            for (const row of dataRows) {
              w = Math.max(w, visualWidth(row[i] ?? ''));
            }
            widths[i] = w;
          }

          const targetWidth = maxTableWidth ?? Number.POSITIVE_INFINITY;
          const chromeWidth = (3 * colCount) + 1;
          const minColWidth = targetWidth >= chromeWidth + colCount ? 1 : 0;
          const availableContentWidth = Math.max(colCount * minColWidth, targetWidth - chromeWidth);
          let totalContentWidth = widths.reduce((sum, width) => sum + width, 0);
          if (Number.isFinite(targetWidth) && totalContentWidth > availableContentWidth) {
            const constrained = widths.slice();
            const reducibleTotal = constrained.reduce(
              (sum, w) => sum + Math.max(0, w - minColWidth), 0,
            );
            if (reducibleTotal > 0) {
              const excess = totalContentWidth - availableContentWidth;
              const ratio = Math.min(1, excess / reducibleTotal);
              for (let i = 0; i < constrained.length; i++) {
                const reducible = Math.max(0, constrained[i]! - minColWidth);
                constrained[i] = Math.max(minColWidth, constrained[i]! - Math.round(reducible * ratio));
              }
              // Invariant: sum(constrained) must not exceed availableContentWidth.
              // Per-column Math.round above can under-reduce (round-down error
              // accumulates across columns), leaving rows 1+ col wider than
              // maxWidth. Downstream, formatBlockForCommit re-wraps committed
              // output at contentWidth with word-wrap: a row even 1 col over
              // splits at its last space into a fragment + orphan '│' line,
              // inflating the physical line count and corrupting the
              // compositor's row accounting (clipped table tails + blank gaps
              // in the REPL). Trim the widest reducible column until the total
              // fits so rendered rows never exceed the budget.
              let constrainedTotal = constrained.reduce((sum, w) => sum + w, 0);
              while (constrainedTotal > availableContentWidth) {
                let widest = -1;
                for (let i = 0; i < constrained.length; i++) {
                  if (constrained[i]! > minColWidth &&
                      (widest === -1 || constrained[i]! > constrained[widest]!)) {
                    widest = i;
                  }
                }
                if (widest === -1) break; // nothing left above minColWidth
                constrained[widest] = constrained[widest]! - 1;
                constrainedTotal -= 1;
              }
            }
            for (let i = 0; i < constrained.length; i++) {
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
          return lines.join('\n') + '\n';
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
