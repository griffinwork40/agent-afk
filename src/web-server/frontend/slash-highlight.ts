/**
 * Live slash-command highlighting for the composer.
 *
 * A `<textarea>` cannot style its own content, so this uses the standard
 * backdrop technique: a mirror element sits exactly behind the textarea and
 * renders the same text with spans, while the textarea itself paints its text
 * transparent and keeps only its caret. The operator sees the mirror; they
 * interact with the textarea.
 *
 * Invariant: the mirror and the textarea must share identical text metrics —
 * font, size, line-height, padding, border width, and wrapping. Any divergence
 * shows up immediately as ghosting, because two copies of the same string are
 * being painted on top of each other. The metrics are declared once in
 * `styles.css` under a shared selector list for exactly this reason; do not
 * restyle one without the other.
 */

/** One run of text sharing a single visual treatment. */
export interface HighlightToken {
  text: string;
  /**
   * `known` — a registered command name; `slash` — slash-shaped but not
   * registered; `plain` — everything else, including all whitespace.
   */
  kind: 'known' | 'slash' | 'plain';
}

/** Slash-shaped token: a leading slash, then a letter, then word-ish chars. */
const SLASH_TOKEN = /^\/[A-Za-z][\w:-]*$/;

/**
 * Split a buffer into styled runs.
 *
 * Splitting on whitespace runs (rather than a lookbehind regex, as the terminal
 * colorizer uses) keeps every character — including the separators — in the
 * output, which is what lets the mirror reproduce the textarea's wrapping
 * exactly. It also sidesteps lookbehind support entirely.
 *
 * Pure: the caller supplies command recognition, so this is unit-testable with
 * no registry, no DOM, and no network.
 */
export function tokenizeInput(
  value: string,
  isKnown: (name: string) => boolean,
): HighlightToken[] {
  if (value === '') return [];
  return value
    .split(/(\s+)/)
    .filter((part) => part !== '')
    .map((part) => {
      if (!SLASH_TOKEN.test(part)) return { text: part, kind: 'plain' as const };
      return { text: part, kind: isKnown(part) ? ('known' as const) : ('slash' as const) };
    });
}

/**
 * Paint `tokens` into `mirror`, replacing its contents.
 *
 * `createElement` + `textContent` only — never `innerHTML`. This element
 * renders operator-typed text verbatim, so it is precisely the surface where
 * markup injection would land.
 */
export function paintMirror(mirror: HTMLElement, tokens: readonly HighlightToken[]): void {
  mirror.textContent = '';
  for (const token of tokens) {
    if (token.kind === 'plain') {
      mirror.appendChild(document.createTextNode(token.text));
      continue;
    }
    const span = document.createElement('span');
    span.className = token.kind === 'known' ? 'tok-known' : 'tok-slash';
    span.textContent = token.text;
    mirror.appendChild(span);
  }
  // A trailing newline is not rendered by the browser unless something follows
  // it, which would let the mirror fall one line short of the textarea while
  // the operator is typing at the start of a fresh line.
  mirror.appendChild(document.createTextNode('\u200b'));
}

/**
 * Wire live highlighting onto a composer textarea.
 *
 * Returns a teardown function. Teardown is written before setup below so the
 * inverse operation is never orphaned when this is edited later.
 */
export function mountSlashHighlight(
  input: HTMLTextAreaElement,
  mirror: HTMLElement,
  isKnown: (name: string) => boolean,
): () => void {
  const repaint = (): void => {
    paintMirror(mirror, tokenizeInput(input.value, isKnown));
    // The textarea scrolls independently once content overflows; the mirror
    // has no scrollbar of its own and must be dragged along.
    mirror.scrollTop = input.scrollTop;
    mirror.scrollLeft = input.scrollLeft;
  };
  const onScroll = (): void => {
    mirror.scrollTop = input.scrollTop;
    mirror.scrollLeft = input.scrollLeft;
  };

  const teardown = (): void => {
    input.removeEventListener('input', repaint);
    input.removeEventListener('scroll', onScroll);
    mirror.textContent = '';
  };

  input.addEventListener('input', repaint);
  input.addEventListener('scroll', onScroll);
  repaint();
  return teardown;
}
