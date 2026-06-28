/**
 * Unit tests for the HTML → markdown extraction pipeline (src/web/extract.ts).
 *
 * Strategy: feed HTML string fixtures (no network, no browser) and assert on
 * the markdown / title / fallback outputs. The key behaviors are (a) main
 * content isolation strips chrome, (b) markdown formatting is faithful, and
 * (c) sparse pages degrade to a flagged whole-body fallback.
 */

import { describe, it, expect, vi } from 'vitest';
import { Readability } from '@mozilla/readability';
import { extractReadableMarkdown, THIN_CONTENT_CHARS } from './extract.js';

/** A realistic article page with nav, sidebar, and footer chrome around it. */
function articlePage(): string {
  const paragraphs = Array.from(
    { length: 6 },
    (_, i) =>
      `<p>This is paragraph ${i + 1} of the main article body. It contains ` +
      `enough prose for Readability to treat the container as the primary ` +
      `article content rather than boilerplate navigation or footer chrome.</p>`,
  ).join('\n');
  return `<!DOCTYPE html><html><head><title>The Real Title</title></head><body>
    <nav><a href="/home">Home</a> <a href="/about">About</a></nav>
    <header><h1 class="site">SiteName Global Header</h1></header>
    <article>
      <h1>The Real Title</h1>
      ${paragraphs}
      <h2>A subsection</h2>
      <p>More body text with a <a href="/relative/link">relative link</a> inside it
      so we can verify hrefs are resolved against the document URL.</p>
    </article>
    <aside class="sidebar">Subscribe to our newsletter! Ads ads ads.</aside>
    <footer>Copyright 2026 SiteName. All rights reserved.</footer>
  </body></html>`;
}

describe('extractReadableMarkdown — main content isolation', () => {
  it('isolates the article and strips nav/sidebar/footer chrome', () => {
    const out = extractReadableMarkdown(articlePage(), 'https://example.com/post');
    expect(out.usedFallback).toBe(false);
    expect(out.markdown).toContain('main article body');
    // Chrome should be gone.
    expect(out.markdown).not.toContain('Subscribe to our newsletter');
    expect(out.markdown).not.toContain('All rights reserved');
    expect(out.markdown).not.toContain('About');
  });

  it('derives the title', () => {
    const out = extractReadableMarkdown(articlePage(), 'https://example.com/post');
    expect(out.title).toBe('The Real Title');
  });

  it('reports a non-trivial textLength above the thin threshold', () => {
    const out = extractReadableMarkdown(articlePage(), 'https://example.com/post');
    expect(out.textLength).toBeGreaterThan(THIN_CONTENT_CHARS);
  });

  it('resolves relative links to absolute URLs', () => {
    const out = extractReadableMarkdown(articlePage(), 'https://example.com/post');
    expect(out.markdown).toContain('https://example.com/relative/link');
  });
});

describe('extractReadableMarkdown — markdown formatting', () => {
  it('emits ATX headings and fenced code blocks', () => {
    const html = `<!DOCTYPE html><html><head><title>Doc</title></head><body><article>
      <h2>Heading Two</h2>
      <p>Intro paragraph with enough text to be considered an article body by the
      Readability heuristics, which require a reasonable amount of prose content
      before they will select a container as the main article region of a page.</p>
      <pre><code>const x = 1;</code></pre>
      <ul><li>first</li><li>second</li></ul>
    </article></body></html>`;
    const out = extractReadableMarkdown(html, 'https://example.com/doc');
    expect(out.markdown).toMatch(/^#+ Heading Two/m);
    expect(out.markdown).toContain('```');
    expect(out.markdown).toContain('const x = 1;');
    // Turndown pads the bullet marker to a tab stop ("-   first"); match flexibly.
    expect(out.markdown).toMatch(/^-\s+first/m);
  });
});

describe('extractReadableMarkdown — thin / fallback paths', () => {
  it('reports a thin textLength for a JS-gated app shell (escalation signal)', () => {
    const html = `<!DOCTYPE html><html><head><title>App Shell</title></head>
      <body><div id="root"><p>Loading…</p></div></body></html>`;
    const out = extractReadableMarkdown(html, 'https://example.com/app');
    expect(out.title).toBe('App Shell');
    expect(out.markdown).toContain('Loading');
    // The escalation signal is a thin extraction — Readability may or may not
    // treat the shell as an "article", so the scraper keys on textLength, not
    // usedFallback alone.
    expect(out.textLength).toBeLessThan(THIN_CONTENT_CHARS);
  });

  it('drops script and style content in the fallback path', () => {
    const html = `<!DOCTYPE html><html><head><title>X</title></head><body>
      <script>console.log('should not appear');</script>
      <style>.a{color:red}</style>
      <div>visible text</div>
    </body></html>`;
    const out = extractReadableMarkdown(html, 'https://example.com/x');
    expect(out.markdown).toContain('visible text');
    expect(out.markdown).not.toContain('should not appear');
    expect(out.markdown).not.toContain('color:red');
  });

  it('handles an empty document without throwing', () => {
    const out = extractReadableMarkdown('<html></html>', 'https://example.com/empty');
    expect(out.usedFallback).toBe(true);
    expect(out.markdown).toBe('');
    expect(out.textLength).toBe(0);
  });
});

describe('extractReadableMarkdown — Readability.parse() throws (safeExtract catch branch)', () => {
  it('falls back to whole-body content when Readability.parse() throws', () => {
    // Branch: extract.ts lines 84-89 — the try/catch around `new Readability(clone).parse()`.
    // When parse() throws (degenerate DOM or internal error), article is set to
    // null and the function falls through to the whole-body fallback path.
    // We spy on Readability.prototype.parse to simulate the throw deterministically.
    const parseSpy = vi.spyOn(Readability.prototype, 'parse').mockImplementationOnce(() => {
      throw new Error('simulated Readability parse failure');
    });

    // Provide an HTML page with visible body content so the fallback path
    // returns something we can assert on.
    const html = `<!DOCTYPE html><html><head><title>Throws Doc</title></head>
      <body><div>fallback body content</div></body></html>`;

    const out = extractReadableMarkdown(html, 'https://example.com/throws');

    // The throw was swallowed; we fell back to the whole-body path.
    expect(out.usedFallback).toBe(true);
    expect(out.title).toBe('Throws Doc');
    expect(out.markdown).toContain('fallback body content');

    parseSpy.mockRestore();
  });
});
