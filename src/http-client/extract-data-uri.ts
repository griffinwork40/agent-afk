/**
 * Data-URI elision helpers for the HTML → markdown extraction pipeline.
 *
 * `data:` URIs that appear in scrape output (particularly base64-encoded
 * images on error pages like GitHub's 404) can be enormous — 75 KB of a
 * single `data:image/svg+xml;base64,…` payload is useless to a model and
 * wastes context tokens on every such scrape. See #2579.
 *
 * Two complementary passes:
 *
 *   1. {@link applyDataUriTurndownRule} — registers a Turndown rule that
 *      intercepts `<img src="data:…">` elements before they reach the
 *      standard image rule, replacing each with its alt text and a
 *      human-readable elision marker. Must be called once, on the shared
 *      TurndownService instance.
 *
 *   2. {@link elideDataUriPayloads} — a fast linear-time post-pass that
 *      rewrites any remaining `data:` URIs embedded in markdown link targets
 *      or raw inline references. Handles both base64 and plain-text data URIs.
 *      Safe to run on every extraction result — pages with no data URIs pass
 *      through with no allocation beyond the `includes()` fast-path check.
 *
 * @module web/extract-data-uri
 */

/**
 * Matches a `data:` URI: `data:<mime>[;encoding],<payload>` where payload is
 * a maximal run of non-whitespace, non-markdown-terminator characters.
 *
 * The negative lookahead `(?!\u2026)` after the comma prevents matching an
 * already-elided marker (which starts with `…elided`) — without it, the
 * post-pass would double-elide output produced by the Turndown rule.
 *
 * The regex is linear-time: each alternative in the character class is
 * disjoint and the quantifier is not inside a group that can backtrack into
 * an outer group. On a 75 KB single-line payload this completes in O(n).
 *
 * Named capturing groups:
 *   mime    — everything between "data:" and the first "," (e.g. "image/svg+xml;base64")
 *   payload — everything after the first ","
 */
const DATA_URI_RE = /data:(?<mime>[^,\s"')>]{1,200}),(?!\u2026)(?<payload>[^\s"')>]+)/g;

/**
 * Build an elision marker that preserves MIME type (and encoding label when
 * present) so the model still knows what kind of data was there.
 *
 * The byte count is reported as `payload.length` (character count), which is
 * an exact count for base64 ASCII payloads and a reasonable approximation for
 * URL-encoded or plain-text payloads.
 *
 * @param mime     Everything between `data:` and the first `,`, e.g.
 *                 `image/svg+xml;base64` or `text/plain`.
 * @param payload  The raw payload string after the first `,`.
 * @returns        A short marker, e.g.
 *                 `data:image/svg+xml;base64,…elided 75677 bytes`.
 */
export function buildElisionMarker(mime: string, payload: string): string {
  return `data:${mime},\u2026elided ${payload.length} bytes`;
}

/**
 * Register a Turndown rule that replaces `<img src="data:…">` elements with
 * an elided representation before the standard image rule fires.
 *
 * Safe to call multiple times on the same Turndown instance — subsequent
 * calls overwrite the same named rule with an identical implementation.
 *
 * Emits:
 *   - `![alt text](data:<mime>,…elided N bytes)` when an alt attribute is present.
 *   - `![](data:<mime>,…elided N bytes)` when none.
 *
 * @param turndown  The shared TurndownService instance from `importExtractDeps`.
 */
export function applyDataUriTurndownRule(turndown: {
  addRule: (
    key: string,
    rule: {
      filter: (node: { nodeName: string; getAttribute: (a: string) => string | null }) => boolean;
      replacement: (
        content: string,
        node: { getAttribute: (a: string) => string | null },
      ) => string;
    },
  ) => void;
}): void {
  turndown.addRule('data-uri-img', {
    filter(node) {
      if (node.nodeName !== 'IMG') return false;
      const src = node.getAttribute('src') ?? '';
      return src.startsWith('data:');
    },
    replacement(_content, node) {
      const src = node.getAttribute('src') ?? '';
      const alt = (node.getAttribute('alt') ?? '').trim();
      // Locate the first comma that separates header from payload.
      const commaIdx = src.indexOf(',');
      if (commaIdx === -1) {
        // Malformed data URI with no payload separator — emit as-is or just alt.
        return alt ? `![${alt}](${src})` : '';
      }
      // src is "data:<mime>,<payload>"; slice off the leading "data:".
      const mime = src.slice(5, commaIdx);
      const payload = src.slice(commaIdx + 1);
      const marker = buildElisionMarker(mime, payload);
      return alt ? `![${alt}](${marker})` : `![](${marker})`;
    },
  });
}

/**
 * Post-pass: rewrite any `data:` URIs that survived Turndown (e.g. in link
 * `href` attributes or inline text) with elision markers.
 *
 * The fast path (`!markdown.includes('data:')`) makes this a no-op —
 * effectively a single scan — for pages without data URIs, guaranteeing
 * byte-identical pass-through at minimal cost.
 *
 * @param markdown  Markdown string produced by Turndown.
 * @returns         The same string with `data:` payloads elided, or the
 *                  original reference-identical string when none were present.
 */
export function elideDataUriPayloads(markdown: string): string {
  if (!markdown.includes('data:')) return markdown;

  return markdown.replace(
    DATA_URI_RE,
    (_match, mime: string, payload: string) => buildElisionMarker(mime, payload),
  );
}
