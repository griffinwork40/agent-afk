/**
 * Invariant: the XSS cases in this file are the reason markdown-dom.ts exists
 * rather than a two-line `innerHTML = marked.parse(text)`. They assert that
 * hostile markup in agent- or tool-derived text lands as inert TEXT. If one of
 * them starts failing, the transcript has become a credential-stealing vector
 * against a page that holds a live bearer token — treat it as a security
 * regression, never as a test to update.
 */

// @vitest-environment jsdom

import { describe, it, expect } from 'vitest';
import { renderMarkdown } from './markdown-dom.js';

describe('renderMarkdown — structure', () => {
  it('renders headings at their markdown depth', () => {
    const out = renderMarkdown('# One\n\n## Two\n\n### Three\n');
    expect(out.querySelector('h1')?.textContent).toBe('One');
    expect(out.querySelector('h2')?.textContent).toBe('Two');
    expect(out.querySelector('h3')?.textContent).toBe('Three');
  });

  it('clamps a heading deeper than h6 instead of emitting an invalid tag', () => {
    const out = renderMarkdown('####### Seven\n');
    expect(out.querySelector('h7')).toBeNull();
  });

  it('renders emphasis, strong, and inline code as elements', () => {
    const out = renderMarkdown('Some **bold**, some *em*, some `code`.');
    expect(out.querySelector('strong')?.textContent).toBe('bold');
    expect(out.querySelector('em')?.textContent).toBe('em');
    expect(out.querySelector('code.md-code-inline')?.textContent).toBe('code');
  });

  it('renders a fenced code block preserving contents verbatim', () => {
    const out = renderMarkdown('```js\nconst x = 1;\n  indented\n```\n');
    const code = out.querySelector('pre.md-pre code');
    expect(code?.textContent).toBe('const x = 1;\n  indented');
    expect(code?.className).toContain('md-lang-js');
  });

  it('does not treat markdown inside a fenced block as markup', () => {
    const out = renderMarkdown('```\n# not a heading\n**not bold**\n```\n');
    expect(out.querySelector('h1')).toBeNull();
    expect(out.querySelector('strong')).toBeNull();
    expect(out.querySelector('pre code')?.textContent).toContain('# not a heading');
  });

  it('renders unordered and ordered lists', () => {
    const ul = renderMarkdown('- a\n- b\n');
    expect(ul.querySelectorAll('ul li')).toHaveLength(2);
    const ol = renderMarkdown('1. a\n2. b\n');
    expect(ol.querySelectorAll('ol li')).toHaveLength(2);
  });

  it('renders a table with header and body cells', () => {
    const out = renderMarkdown('| a | b |\n| - | - |\n| 1 | 2 |\n');
    expect(out.querySelectorAll('table th')).toHaveLength(2);
    expect(out.querySelectorAll('table td')).toHaveLength(2);
  });

  it('renders blockquotes and horizontal rules', () => {
    expect(renderMarkdown('> quoted\n').querySelector('blockquote')).not.toBeNull();
    expect(renderMarkdown('---\n').querySelector('hr')).not.toBeNull();
  });

  it('keeps plain prose as a paragraph without dropping text', () => {
    const out = renderMarkdown('just a sentence');
    expect(out.querySelector('p')?.textContent).toBe('just a sentence');
  });

  it('never throws on malformed or empty markdown', () => {
    for (const bad of ['', '   ', '```unterminated', '| broken |', '[x](']) {
      expect(() => renderMarkdown(bad)).not.toThrow();
    }
  });
});

describe('renderMarkdown — XSS containment', () => {
  it('renders a raw script tag as text, creating no script element', () => {
    const out = renderMarkdown('<script>alert(1)</script>');
    expect(out.querySelector('script')).toBeNull();
    expect(out.textContent).toContain('<script>');
  });

  it('renders an onerror image payload as text, creating no img element', () => {
    const out = renderMarkdown('<img src=x onerror=alert(1)>');
    expect(out.querySelector('img')).toBeNull();
    expect(out.textContent).toContain('onerror');
  });

  it('does not fetch markdown images — alt text only, no img element', () => {
    const out = renderMarkdown('![tracking pixel](https://evil.test/p.gif)');
    expect(out.querySelector('img')).toBeNull();
    expect(out.textContent).toContain('tracking pixel');
  });

  it('degrades a javascript: link to inert text', () => {
    const out = renderMarkdown('[click](javascript:alert(1))');
    expect(out.querySelector('a')).toBeNull();
    expect(out.textContent).toContain('click');
  });

  it('degrades a data: link to inert text', () => {
    const out = renderMarkdown('[x](data:text/html;base64,PHNjcmlwdD4=)');
    expect(out.querySelector('a')).toBeNull();
  });

  it('keeps http/https/mailto links and hardens the target', () => {
    const a = renderMarkdown('[ok](https://example.com/x)').querySelector('a');
    expect(a?.getAttribute('href')).toBe('https://example.com/x');
    expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
    expect(a?.getAttribute('target')).toBe('_blank');
    expect(renderMarkdown('[m](mailto:a@b.co)').querySelector('a')).not.toBeNull();
  });

  it('does not execute html embedded in a table cell or list item', () => {
    const out = renderMarkdown('- <script>alert(1)</script>\n');
    expect(out.querySelector('script')).toBeNull();
  });

  it('renders an iframe payload as text', () => {
    const out = renderMarkdown('<iframe src="https://evil.test"></iframe>');
    expect(out.querySelector('iframe')).toBeNull();
  });
});
