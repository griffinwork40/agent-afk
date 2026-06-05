/**
 * HTML → markdown extraction pipeline.
 *
 * This is the shared core both scrape paths feed into: the plain-`fetch` path
 * and the Playwright-`render` escalation path each produce an HTML string,
 * then call `extractReadableMarkdown()` here. Keeping a single pipeline is a
 * deliberate invariant — the two fetch strategies must yield identical output
 * shape so the model can't tell which path produced a given result.
 *
 * Strategy:
 *   1. Parse the HTML into a DOM with jsdom (no script execution — the input
 *      is either static HTML or already-rendered DOM from Playwright).
 *   2. Run Mozilla Readability to isolate the main article, stripping nav,
 *      ads, footers, and chrome — the local equivalent of Firecrawl's
 *      `onlyMainContent: true`.
 *   3. Convert the isolated article HTML to markdown with Turndown.
 *   4. If Readability finds no article (landing pages, apps, sparse markup),
 *      fall back to converting the whole `<body>` and flag `usedFallback`.
 *
 * Pure module: no network, no browser, no filesystem. Fully unit-testable on
 * HTML string fixtures.
 *
 * @module web/extract
 */

import { JSDOM } from 'jsdom';
import { Readability } from '@mozilla/readability';
import TurndownService from 'turndown';
import type { ExtractedContent } from './types.js';

/**
 * Below this many characters of extracted plain text, the scraper treats a
 * fetch-first result as "thin" (likely JS-gated) and escalates to a render.
 * Exported so the scraper and its tests share one source of truth.
 */
export const THIN_CONTENT_CHARS = 200;

// Invariant: one Turndown instance is safe to reuse across calls — it holds no
// per-document state between `.turndown()` calls. Configured for ATX headings
// (`# h1`) and fenced code blocks, which render more cleanly in chat surfaces
// than the setext/indented defaults.
const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  bulletListMarker: '-',
});

// Drop elements that never carry readable content. Readability removes most of
// these already, but the fallback path (whole-body conversion) needs its own
// guard so we don't emit script bodies or style sheets as markdown.
turndown.remove(['script', 'style', 'noscript', 'iframe']);

/** Collapse 3+ blank lines to a single blank line and trim edges. */
function tidyMarkdown(md: string): string {
  return md.replace(/\n{3,}/g, '\n\n').trim();
}

/** Best-effort plain-text length of a DOM node's subtree. */
function textLengthOf(node: { textContent: string | null } | null | undefined): number {
  return (node?.textContent ?? '').replace(/\s+/g, ' ').trim().length;
}

/**
 * Extract the main readable content of an HTML document and convert it to
 * markdown.
 *
 * @param html  Raw HTML (static or already-rendered).
 * @param url   The document's URL — used by jsdom to resolve relative links so
 *              the emitted markdown carries absolute hrefs.
 * @returns     Title, markdown, extracted-text length, and a fallback flag.
 *              Never throws for well-formed HTML; a jsdom parse failure on
 *              pathological input propagates to the caller, which degrades
 *              gracefully.
 */
export function extractReadableMarkdown(html: string, url: string): ExtractedContent {
  const dom = new JSDOM(html, { url });
  const doc = dom.window.document;
  const docTitle = (doc.title ?? '').trim();

  // Contract: Readability MUTATES the document it is given (it strips nodes
  // in place). We clone first so the fallback path below still has the
  // original body to convert when Readability returns null.
  let article: ReturnType<Readability['parse']> = null;
  try {
    const clone = doc.cloneNode(true) as Document;
    article = new Readability(clone).parse();
  } catch {
    // Readability can throw on degenerate DOMs — fall through to whole-body.
    article = null;
  }

  if (article && typeof article.content === 'string' && article.content.trim().length > 0) {
    const markdown = tidyMarkdown(turndown.turndown(article.content));
    const title = (article.title ?? '').trim() || docTitle;
    // article.length is Readability's own char count of the extracted text;
    // fall back to measuring textContent when it is absent.
    const textLength =
      typeof article.length === 'number' && article.length > 0
        ? article.length
        : (article.textContent ?? '').replace(/\s+/g, ' ').trim().length;
    return { title, markdown, textLength, usedFallback: false };
  }

  // Fallback: no article isolated. Convert the whole body so the caller still
  // gets *something*, and flag it so the scraper prefers a render result.
  const body = doc.body;
  const bodyHtml = body?.innerHTML ?? '';
  const markdown = tidyMarkdown(turndown.turndown(bodyHtml));
  return {
    title: docTitle,
    markdown,
    textLength: textLengthOf(body),
    usedFallback: true,
  };
}
