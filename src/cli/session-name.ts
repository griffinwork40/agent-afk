/**
 * Derive a short, human-readable, filesystem-safe session name from free text
 * (the first user message) or sanitize a user-supplied name.
 *
 * The result is session METADATA (the `name` field on StoredSession), never a
 * filename — sessions are always stored at <sessionId>.json. The slug is what
 * `/resume` shows and what `--resume <name>` / `/resume <name>` match against.
 */

/** Max characters in a derived name — keeps it typeable on the resume line. */
const MAX_LEN = 48;
/** Max words pulled from free text — enough to be meaningful, not a sentence. */
const MAX_WORDS = 6;

/**
 * Common English stop words filtered out of auto-derived session names so the
 * slug captures meaningful signal rather than grammatical glue. Applied after
 * lowercasing and punctuation stripping, before the word-count cap. When ALL
 * words are stop words the filter is bypassed to avoid an empty slug.
 */
const STOP_WORDS = new Set([
  'the', 'an', 'i', 'we', 'do', 'you', 'is', 'are', 'it', 'to', 'of',
  'in', 'my', 'this', 'that', 'what', 'whats', 'how', 'why', 'oops', 'sorry',
  'continue', 'just', 'can', 'could', 'would', 'should', 'lets', 'hey', 'hi',
  'hello', 'ok', 'okay', 'yeah', 'yes', 'now', 'so', 'but', 'and', 'or',
  'for', 'on', 'at', 'was', 'were', 'has', 'have', 'had', 'been', 'be', 'will',
  'its', 'im', 'ive', 'weve', 'youre', 'dont', 'doesnt', 'didnt', 'wont',
  'cant', 'thats', 'heres', 'theres', 'about',
]);

/**
 * Slugify arbitrary text into a kebab-case name. Lowercases, drops markdown
 * emphasis and punctuation, collapses whitespace/underscores to single
 * hyphens, strips stop words, caps word-count and length, and trims trailing
 * hyphens left by the length cap. Returns '' when the input has no usable
 * characters — callers decide the fallback (usually the sessionId).
 *
 * Slash-command handling: when input starts with `/`, strip the leading `/`,
 * remove all `--flag` tokens (double-dash only, to avoid corrupting hyphenated
 * command names like `pr-triage`), and for `/god` also strip the `god` prefix
 * so the rest of the message is slugified.
 */
export function slugifySessionName(text: string): string {
  let src = text.trim();

  // Handle slash commands: /cmd [args] [--flags]
  if (src.startsWith('/')) {
    src = src.slice(1); // strip leading /
    // Remove only --double-dash flags (with optional value). Single-char flags
    // (-f) are intentionally excluded because they share the `-` char with
    // hyphenated command names like `pr-triage` and would corrupt them.
    src = src.replace(/--[\w-]+(?:=\S+)?/g, ' ').trim();
    // For /god, strip the leading "god" word so we name after the task.
    src = src.replace(/^god\b\s*/i, '');
  }

  const cleaned = src
    .toLowerCase()
    .replace(/[`*_~]/g, ' ') // markdown emphasis → space
    .replace(/[^\w\s-]/g, ' ') // strip punctuation/symbols, keep word chars + hyphen
    .replace(/[\s_]+/g, ' ') // collapse whitespace + underscores
    .trim();

  if (!cleaned) return '';

  const allWords = cleaned.split(' ').filter(Boolean);
  const filtered = allWords.filter((w) => !STOP_WORDS.has(w));
  // Fall back to unfiltered words when every word was a stop word.
  const words = (filtered.length > 0 ? filtered : allWords).slice(0, MAX_WORDS);

  return words
    .join('-')
    .slice(0, MAX_LEN)
    .replace(/-+$/g, ''); // length cap may sever a word mid-hyphen
}
