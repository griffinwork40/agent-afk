/**
 * Detects when Readability extraction dropped a large share of a page's visible
 * text, and tells the model so it can switch modes instead of re-fetching.
 *
 * Readability strips collapsed, tabbed, and accordion regions along with real
 * boilerplate. When it drops a section the caller wanted, `web_scrape` still
 * returns a healthy-looking body and reports success — the model has no signal
 * that anything is missing, so it retries the SAME url with mode/byte variations
 * until the host starts refusing connections. This module turns that silent gap
 * into one advisory line on an otherwise successful result.
 *
 * @module web/extraction-advisory
 */

// Invariant: the ratio's denominator is the source's VISIBLE-TEXT length, not
// its byte length. Byte length is unusable as a baseline: doc sites ship large
// inline JSON/JS/CSS payloads (a Mintlify page is mostly hydration state), so a
// perfectly complete extraction can retain under 5% of the bytes while a
// half-dropped page on a lean site retains 30%. Comparing text-to-text makes
// the number mean "of the words a human would see, this fraction survived",
// which is the question the advisory answers.
//
// Both thresholds below are a FIRST CALIBRATION, chosen conservatively so the
// advisory stays rare enough to be worth reading; they are deliberately easy to
// retune. To re-measure, run extraction over a sample of real pages and compare
// `textLength` against `visibleTextLength(html)` — the gap between "kept the
// article, dropped nav/footer" and "dropped a content section" is what the
// ratio floor has to sit between.

/**
 * Minimum visible-text length of the SOURCE before the ratio is meaningful.
 * Under this, an absolute-size check is the right tool and the existing
 * `THIN_CONTENT_CHARS` render escalation already covers it: on a 300-character
 * page, dropping a nav label swings the ratio wildly with nothing at stake.
 */
export const MIN_SOURCE_TEXT_CHARS = 2_000;

/**
 * Retention floor. Above this, the loss is consistent with ordinary boilerplate
 * stripping (nav, sidebar, footer, cookie banner) — which is extraction working
 * as intended. Below it, more than half the visible page is gone, which is the
 * signature of a dropped content region rather than trimmed chrome.
 */
export const MIN_RETAINED_RATIO = 0.5;

/** Blocks whose text is never "visible" and must not inflate the denominator. */
const NON_VISIBLE_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg']);

/**
 * Contract: approximate the visible-text length of an HTML document.
 *
 * Deliberately a linear scanner, not a DOM parse: this runs on every successful
 * markdown scrape, and paying for a second JSDOM construction to produce a
 * denominator for a heuristic would cost more than the heuristic is worth. Over-
 * counting slightly (leftover attribute text, entities counted as their escaped
 * form) is acceptable — it biases the ratio DOWN, i.e. toward advising, and the
 * advisory is a non-blocking note on a successful result.
 */
export function visibleTextLength(html: string): number {
  const visible: string[] = [];
  const hiddenCounts = new Map<string, number>();
  let hiddenDepth = 0;
  let cursor = 0;

  while (cursor < html.length) {
    const tagStart = html.indexOf('<', cursor);
    if (tagStart === -1) {
      if (hiddenDepth === 0) visible.push(html.slice(cursor));
      break;
    }
    if (hiddenDepth === 0) visible.push(html.slice(cursor, tagStart), ' ');

    if (html.startsWith('<!--', tagStart)) {
      const commentEnd = html.indexOf('-->', tagStart + 4);
      cursor = commentEnd === -1 ? html.length : commentEnd + 3;
      continue;
    }

    const tagEnd = html.indexOf('>', tagStart + 1);
    if (tagEnd === -1) break;
    const token = html.slice(tagStart + 1, tagEnd).trimStart();
    const closing = token.startsWith('/');
    const nameStart = closing ? 1 : 0;
    const nameMatch = /^[a-z][\w:-]*/i.exec(token.slice(nameStart));
    const name = nameMatch?.[0].toLowerCase();
    if (name !== undefined && NON_VISIBLE_TAGS.has(name)) {
      if (closing) {
        const count = hiddenCounts.get(name) ?? 0;
        if (count > 0) {
          hiddenDepth--;
          if (count === 1) hiddenCounts.delete(name);
          else hiddenCounts.set(name, count - 1);
        }
      } else if (!token.endsWith('/')) {
        hiddenDepth++;
        hiddenCounts.set(name, (hiddenCounts.get(name) ?? 0) + 1);
      }
    }
    cursor = tagEnd + 1;
  }

  return visible.join('').replace(/\s+/g, ' ').trim().length;
}

/**
 * Contract: return an advisory when extraction retained suspiciously little of
 * the source's visible text, else `undefined`.
 *
 * Fires only when BOTH thresholds are crossed. Degenerate inputs (empty html,
 * zero-length source text, a longer extraction than source) return `undefined`
 * rather than dividing by zero or reporting a nonsense ratio.
 */
export function extractionAdvisory(opts: {
  html: string;
  extractedTextLength: number;
}): string | undefined {
  const sourceChars = visibleTextLength(opts.html);
  if (sourceChars < MIN_SOURCE_TEXT_CHARS) return undefined;

  const retained = opts.extractedTextLength / sourceChars;
  if (!Number.isFinite(retained) || retained >= MIN_RETAINED_RATIO) return undefined;

  const pct = Math.round(retained * 100);
  return (
    `[web_scrape: extraction kept ~${pct}% of this page's visible text ` +
    `(${opts.extractedTextLength} of ~${sourceChars} chars). Readability strips collapsed, ` +
    `tabbed, and accordion sections along with page chrome, so a section you expect may be ` +
    `absent from the markdown above. If something specific is missing, re-request this url ` +
    `once with mode: "raw" and read the HTML — do not re-fetch it in markdown mode.]`
  );
}

/**
 * Contract: append an advisory to a markdown body, or return it unchanged.
 *
 * Call this before applying the final model byte cap. Head-and-tail truncation
 * preserves the advisory at the tail while keeping the combined output within
 * the caller's `max_bytes` contract.
 */
export function withAdvisory(markdown: string, advisory: string | undefined): string {
  if (advisory === undefined || advisory === '') return markdown;
  return `${markdown}\n\n${advisory}`;
}
