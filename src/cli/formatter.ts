import { Lexer, type Token, type Tokens } from 'marked';
import { palette } from './palette.js';
import { renderTable } from './formatter.table.js';
import { renderList } from './formatter.list.js';
import { renderBlockquote, renderCodeBlock } from './formatter.block.js';

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
        return SLASH_CODESPAN_RE.test(csText) ? palette.brand(csText) : palette.tool(csText);
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

interface RenderMarkdownOptions {
  maxWidth?: number;
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
    // Track previous/next non-space block type so consecutive tables can
    // suppress chrome (borders + header), rendering a seamless continuation
    // instead of a duplicated header seam. Space tokens are transparent —
    // they don't break table-to-table adjacency.
    let prevBlockType: string | undefined;
    // Precompute: for each table token, is the next non-space token also a table?
    const nextNonSpaceIsTable = (idx: number): boolean => {
      for (let j = idx + 1; j < tokens.length; j++) {
        if (tokens[j]!.type === 'space') continue;
        return tokens[j]!.type === 'table';
      }
      return false;
    };
    return tokens.map((token, idx) => {
      let result: string;
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
          if (heading.depth === 1) result = palette.brand.bold(headingText) + '\n';
          else if (heading.depth === 2) result = palette.heading(headingText) + '\n';
          else result = palette.bold(headingText) + '\n';
          break;
        }
        case 'paragraph': {
          // One trailing '\n' (line terminator), not '\n\n'. marked already
          // emits a `space` token for the source blank line that follows a
          // paragraph; adding a second '\n' here double-spaced every block
          // boundary in non-streamed rendering. See the heading invariant above.
          const para = token as Tokens.Paragraph;
          result = renderInline(para.tokens as Tokens.Generic[]) + '\n';
          break;
        }
        case 'code':
          result = renderCodeBlock(token as Tokens.Code, maxTableWidth);
          break;
        case 'codespan': {
          const raw = (token as Tokens.Codespan).text;
          result = SLASH_CODESPAN_RE.test(raw) ? palette.brand(raw) : palette.tool(raw);
          break;
        }
        case 'strong': {
          const strong = token as Tokens.Strong;
          result = palette.bold(strong.tokens ? renderInline(strong.tokens as Tokens.Generic[]) : strong.text);
          break;
        }
        case 'em': {
          const em = token as Tokens.Em;
          result = palette.italic(em.tokens ? renderInline(em.tokens as Tokens.Generic[]) : em.text);
          break;
        }
        case 'text': {
          // Marked emits block-level 'text' tokens inside tight list items.
          // Its `.tokens` holds inline children (strong, em, codespan, …) —
          // render them through renderInline so bold/italic don't leak.
          const t = token as Tokens.Text;
          result = t.tokens ? renderInline(t.tokens as Tokens.Generic[]) : t.text;
          break;
        }
        case 'list':
          result = renderList(token as Tokens.List, maxTableWidth, renderTokens);
          break;
        case 'space':
          // Space tokens are transparent to prevBlockType — they don't break
          // table-to-table adjacency. Return early without updating tracker.
          return '\n';
        case 'hr': {
          // Use the configured maxTableWidth so the rule tracks the wrap width
          // instead of overflowing or falling short — it is already the
          // compositor's row budget, so no separate capping is needed. Fall
          // back to 40 when no width is set (e.g. direct callers that omit opts).
          const hrWidth = maxTableWidth ?? 40;
          result = palette.dim('─'.repeat(hrWidth)) + '\n';
          break;
        }
        case 'blockquote':
          result = renderBlockquote(token as Tokens.Blockquote, maxTableWidth, renderTokens);
          break;
        case 'table': {
          const isContinuation = prevBlockType === 'table';
          const hasContinuation = nextNonSpaceIsTable(idx);
          result = renderTable(token as Tokens.Table, maxTableWidth, renderInline,
            (isContinuation || hasContinuation)
              ? { suppressTopChrome: isContinuation, suppressBottomBorder: hasContinuation }
              : undefined);
          break;
        }
        default:
          result = token.raw;
          break;
      }
      prevBlockType = token.type;
      return result;
    }).join('');
  }

  return renderTokens(tokens);
}

// Re-export for callers that import renderInlineTokens directly.
export { renderInlineTokens };
