/**
 * Renders markdown into DOM NODES — never into an HTML string.
 *
 * Invariant: this module exists to resolve a direct collision between two
 * requirements. Assistant prose is markdown and must render as such, but
 * `render.ts` forbids passing model- or tool-derived text through innerHTML,
 * because that text is attacker-influencable (an agent can be induced to cat a
 * crafted file) and the page holds a live bearer token — so injected markup
 * would be a credential-stealing stored-XSS hole.
 *
 * The resolution: use marked's `Lexer` for TOKENS ONLY and walk them building
 * elements by hand. marked's HTML compiler (`parse`/`Renderer`) is never
 * invoked, so no HTML string is ever produced to be injected. Every leaf lands
 * via `textContent`, which parses nothing. A payload like
 * `<img src=x onerror=alert(1)>` therefore becomes a visible text node and
 * cannot execute.
 *
 * Two further hardening rules follow from the same threat model:
 *   - `html` tokens render as literal TEXT, never as markup.
 *   - link hrefs are scheme-checked against an allowlist, so `javascript:` and
 *     `data:` URLs degrade to inert text rather than becoming clickable.
 *   - images are NOT fetched; only their alt text renders. A remote image in an
 *     agent transcript is a tracking pixel that would also confirm to a third
 *     party that the payload was viewed.
 */

import { Lexer, type Token, type Tokens } from 'marked';

/** Schemes permitted on rendered links. Everything else degrades to text. */
const SAFE_SCHEMES = ['http:', 'https:', 'mailto:'];

/**
 * Contract: returns the href only when it parses AND carries an allowlisted
 * scheme. Relative URLs are rejected too — a transcript link is always absolute
 * in practice, and resolving one against this origin would point it at the
 * authenticated UI itself.
 */
function safeHref(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return SAFE_SCHEMES.includes(url.protocol) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  return node;
}

/** Append inline tokens (bold, code, links, …) as children of `parent`. */
function appendInline(parent: HTMLElement, tokens: Token[] | undefined): void {
  if (!tokens) return;

  for (const token of tokens) {
    switch (token.type) {
      case 'strong': {
        const node = el('strong');
        appendInline(node, (token as Tokens.Strong).tokens);
        parent.appendChild(node);
        break;
      }

      case 'em': {
        const node = el('em');
        appendInline(node, (token as Tokens.Em).tokens);
        parent.appendChild(node);
        break;
      }

      case 'del': {
        const node = el('s');
        appendInline(node, (token as Tokens.Del).tokens);
        parent.appendChild(node);
        break;
      }

      case 'codespan': {
        const node = el('code', 'md-code-inline');
        node.textContent = (token as Tokens.Codespan).text;
        parent.appendChild(node);
        break;
      }

      case 'link': {
        const link = token as Tokens.Link;
        const href = safeHref(link.href);
        if (href === undefined) {
          // Unsafe scheme: render the label as inert text, not a live anchor.
          const span = el('span');
          appendInline(span, link.tokens);
          parent.appendChild(span);
          break;
        }
        const anchor = el('a', 'md-link');
        anchor.href = href;
        anchor.target = '_blank';
        anchor.rel = 'noopener noreferrer';
        appendInline(anchor, link.tokens);
        parent.appendChild(anchor);
        break;
      }

      case 'image': {
        // Never fetch remote media — see the module header. Alt text only.
        const span = el('span', 'md-image');
        span.textContent = `[image: ${(token as Tokens.Image).text || 'untitled'}]`;
        parent.appendChild(span);
        break;
      }

      case 'br':
        parent.appendChild(el('br'));
        break;

      default: {
        // text, escape, html, and any token marked's inline lexer adds later.
        // All land as literal text, which is the safe default for `html`.
        const raw = (token as { text?: string }).text ?? '';
        const nested = (token as { tokens?: Token[] }).tokens;
        if (nested && nested.length > 0 && token.type === 'text') {
          appendInline(parent, nested);
        } else if (raw) {
          parent.appendChild(document.createTextNode(raw));
        }
        break;
      }
    }
  }
}

function renderList(token: Tokens.List): HTMLElement {
  const list = token.ordered ? el('ol', 'md-list') : el('ul', 'md-list');
  if (token.ordered && typeof token.start === 'number' && token.start > 1) {
    (list as HTMLOListElement).start = token.start;
  }

  for (const raw of token.items) {
    const li = el('li');
    if (raw.task) {
      const box = el('input', 'md-task') as HTMLInputElement;
      box.type = 'checkbox';
      box.checked = Boolean(raw.checked);
      box.disabled = true;
      li.appendChild(box);
    }
    appendBlocks(li, raw.tokens);
    list.appendChild(li);
  }
  return list;
}

function renderCode(token: Tokens.Code): HTMLElement {
  const pre = el('pre', 'md-pre');
  const code = el('code');
  if (token.lang) code.className = `md-lang-${token.lang.split(/\s+/)[0] ?? ''}`;
  code.textContent = token.text;
  pre.appendChild(code);
  return pre;
}

function renderTable(token: Tokens.Table): HTMLElement {
  const table = el('table', 'md-table');
  const thead = el('thead');
  const headRow = el('tr');
  for (const cell of token.header) {
    const th = el('th');
    appendInline(th, cell.tokens);
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const row of token.rows) {
    const tr = el('tr');
    for (const cell of row) {
      const td = el('td');
      appendInline(td, cell.tokens);
      tr.appendChild(td);
    }
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  return table;
}

/** Append block-level tokens as children of `parent`. */
function appendBlocks(parent: HTMLElement, tokens: Token[]): void {
  for (const token of tokens) {
    switch (token.type) {
      case 'heading': {
        const depth = Math.min(Math.max((token as Tokens.Heading).depth, 1), 6);
        const node = el(`h${depth}` as 'h1', 'md-heading');
        appendInline(node, (token as Tokens.Heading).tokens);
        parent.appendChild(node);
        break;
      }

      case 'paragraph': {
        const node = el('p', 'md-p');
        appendInline(node, (token as Tokens.Paragraph).tokens);
        parent.appendChild(node);
        break;
      }

      case 'code':
        parent.appendChild(renderCode(token as Tokens.Code));
        break;

      case 'list':
        parent.appendChild(renderList(token as Tokens.List));
        break;

      case 'blockquote': {
        const node = el('blockquote', 'md-quote');
        appendBlocks(node, (token as Tokens.Blockquote).tokens);
        parent.appendChild(node);
        break;
      }

      case 'table':
        parent.appendChild(renderTable(token as Tokens.Table));
        break;

      case 'hr':
        parent.appendChild(el('hr', 'md-hr'));
        break;

      case 'space':
        break;

      case 'html': {
        // Literal text, never markup — the core anti-XSS rule of this module.
        const node = el('p', 'md-p');
        node.textContent = (token as Tokens.HTML).text;
        parent.appendChild(node);
        break;
      }

      default: {
        const nested = (token as { tokens?: Token[] }).tokens;
        if (nested && nested.length > 0) {
          const node = el('p', 'md-p');
          appendInline(node, nested);
          parent.appendChild(node);
          break;
        }
        const raw = (token as { text?: string }).text ?? '';
        if (raw.trim()) {
          const node = el('p', 'md-p');
          node.textContent = raw;
          parent.appendChild(node);
        }
        break;
      }
    }
  }
}

/**
 * Render `source` as markdown into a fresh element.
 *
 * Contract: never throws. A lexer failure degrades to a plain-text node with
 * the original source intact — a transcript that renders unstyled is a far
 * better outcome than one that renders nothing.
 */
export function renderMarkdown(source: string, className = 'md'): HTMLElement {
  const root = el('div', className);
  try {
    appendBlocks(root, new Lexer().lex(source));
  } catch {
    root.textContent = source;
  }
  return root;
}
