import { Lexer, type Token, type Tokens } from 'marked';
import { palette } from './palette.js';
import { renderTable } from './formatter.table.js';
import { renderList } from './formatter.list.js';
import { renderBlockquote, renderCodeBlock } from './formatter.block.js';
import { registerArtifact } from './code-block-register.js';

/** Matches a whole codespan text that is a slash command (no surrounding path segments). */
const SLASH_CODESPAN_RE = /^\/[A-Za-z][\w:-]*$/;

/** Matches bare slash-command tokens in prose. Avoids filesystem paths by requiring word boundaries. */
const SLASH_TOKEN_RE = /(?<=\s|^)(\/[A-Za-z][\w:-]*)(?=\s|[,.:;!?]?$|[,.:;!?]\s)/g;

/**
 * Invariant: CLI_PREFIX_RE matches multi-word backtick spans that look like
 * shell commands. Single-word tokens are excluded because they are almost
 * always identifiers or flag names rather than runnable commands.
 * Common prefixes cover npm/pnpm/yarn, git, docker, curl/wget, package
 * managers, and the `afk` binary. The leading-word match is word-boundary-safe
 * because the codespan text has already been stripped of backticks.
 */
const CLI_PREFIXES =
  'npm|pnpm|yarn|git|docker|curl|wget|apt|apt-get|brew|pip|pip3|cargo|afk|cd|mkdir|ls|cat|grep|sed|awk|find|chmod|chown|sudo|make|go|node|npx|python|python3|ruby|bash|sh|zsh|fish';

const CLI_PREFIX_RE = new RegExp(`^(?:${CLI_PREFIXES})\\s+\\S`);

/** Matches a standalone http/https URL (the full token IS the URL). */
const URL_RE = /^https?:\/\/\S+$/;

/**
 * Matches a prose line that starts with a shell prompt character (`$` or `>`
 * followed by a space and at least one non-whitespace character). Captures
 * the command body after the prompt so the registered text is clean.
 */
const SHELL_PROMPT_LINE_RE = /^[$>]\s+(\S.*)$/;

function renderInlineTokens(tokens?: Tokens.Generic[], commitOnly = false): string {
  if (!tokens) return '';
  return tokens.map((token) => {
    switch (token.type) {
      case 'codespan': {
        const csText = (token as Tokens.Codespan).text;
        // Register CLI commands and URLs embedded in backtick spans so
        // `/copy N` works for inline shell snippets without a fenced block.
        // Guard behind commitOnly so streaming pending-buffer repaints do not
        // register duplicates — artifacts are captured only on the final commit.
        if (commitOnly) {
          if (CLI_PREFIX_RE.test(csText)) registerArtifact('command', '', csText);
          else if (URL_RE.test(csText)) registerArtifact('url', '', csText);
        }
        return SLASH_CODESPAN_RE.test(csText) ? palette.brand(csText) : palette.tool(csText);
      }
      case 'strong': {
        const strong = token as Tokens.Strong;
        return palette.bold(strong.tokens ? renderInlineTokens(strong.tokens as Tokens.Generic[], commitOnly) : strong.text);
      }
      case 'em': {
        const em = token as Tokens.Em;
        return palette.italic(em.tokens ? renderInlineTokens(em.tokens as Tokens.Generic[], commitOnly) : em.text);
      }
      case 'text':
        return (token as Tokens.Text).text.replace(SLASH_TOKEN_RE, (t) => palette.brand(t));
      case 'link': {
        const link = token as Tokens.Link;
        const linkText = link.tokens ? renderInlineTokens(link.tokens as Tokens.Generic[], commitOnly) : link.text;
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
  /**
   * When true, artifact registration (`registerArtifact`) fires for inline
   * commands and URLs found during this render. Must be false (or omitted)
   * during streaming pending-buffer repaints so that a single response block
   * is not registered N+1 times, which would shift all /copy indices.
   */
  isCommit?: boolean;
}

/**
 * Render markdown text to terminal-friendly ANSI output using marked tokens.
 */
export function renderMarkdownToTerminal(text: string, opts: RenderMarkdownOptions = {}): string {
  const tokens = Lexer.lex(text);
  const maxTableWidth = Number.isFinite(opts.maxWidth) ? Math.floor(opts.maxWidth ?? 0) : undefined;
  const commitOnly = opts.isCommit === true;

  function renderInline(tokens?: Tokens.Generic[]): string {
    return renderInlineTokens(tokens, commitOnly);
  }

  function renderTokens(tokens: Token[], availableWidth = maxTableWidth): string {
    return tokens.map((token, idx) => {
      // Repeated, compatible headers represent one logical table. Merge the
      // rows before rendering so the group shares column widths and emits no
      // blank-line seam. Schema comparison prevents unrelated adjacent tables
      // from losing their headers.
      if (token.type === 'table') {
        const table = token as Tokens.Table;
        const header = table.header.map((cell) => renderInline(cell.tokens as Tokens.Generic[]));
        let end = idx + 1;
        const rows = [...table.rows];
        while (tokens[end]?.type === 'table' ||
          (tokens[end]?.type === 'space' && tokens[end + 1]?.type === 'table')) {
          const nextIndex = tokens[end]?.type === 'table' ? end : end + 1;
          const next = tokens[nextIndex] as Tokens.Table;
          const nextHeader = next.header.map((cell) => renderInline(cell.tokens as Tokens.Generic[]));
          const sameSchema = nextHeader.length === header.length &&
            nextHeader.every((cell, i) => cell === header[i]) &&
            next.align.every((align, i) => align === table.align[i]);
          if (!sameSchema) break;
          rows.push(...next.rows);
          // The map callback cannot skip entries, so mark the consumed space
          // and table as inert tokens local to this render invocation.
          if (nextIndex !== end) tokens[end] = { type: 'space', raw: '' } as Token;
          tokens[nextIndex] = { type: 'space', raw: '' } as Token;
          end = nextIndex + 1;
        }
        return renderTable({ ...table, rows }, availableWidth, renderInline);
      }
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
          // Scan raw paragraph lines for standalone URLs and shell-prompt
          // commands not inside backticks (codespan tokens handle backtick-
          // wrapped text in renderInlineTokens above).
          // Guard behind commitOnly — same rationale as renderInlineTokens.
          if (commitOnly) {
            for (const rawLine of para.raw.split('\n')) {
              const trimmed = rawLine.trim();
              if (URL_RE.test(trimmed)) {
                registerArtifact('url', '', trimmed);
              } else {
                const shellMatch = SHELL_PROMPT_LINE_RE.exec(trimmed);
                if (shellMatch?.[1]) registerArtifact('command', '', shellMatch[1]);
              }
            }
          }
          result = renderInline(para.tokens as Tokens.Generic[]) + '\n';
          break;
        }
        case 'code':
          result = renderCodeBlock(token as Tokens.Code, availableWidth);
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
          result = renderList(token as Tokens.List, availableWidth, renderTokens);
          break;
        case 'space':
          return token.raw ? '\n' : '';
        case 'hr': {
          // Use the configured maxTableWidth so the rule tracks the wrap width
          // instead of overflowing or falling short — it is already the
          // compositor's row budget, so no separate capping is needed. Fall
          // back to 40 when no width is set (e.g. direct callers that omit opts).
          const hrWidth = availableWidth ?? 40;
          result = palette.dim('─'.repeat(hrWidth)) + '\n';
          break;
        }
        case 'blockquote':
          result = renderBlockquote(token as Tokens.Blockquote, availableWidth, renderTokens);
          break;
        default:
          result = token.raw;
          break;
      }
      return result;
    }).join('');
  }

  return renderTokens(tokens);
}

// Re-export for callers that import renderInlineTokens directly.
export { renderInlineTokens };
