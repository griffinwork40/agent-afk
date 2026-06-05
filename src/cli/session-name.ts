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
 * Slugify arbitrary text into a kebab-case name. Lowercases, drops markdown
 * emphasis and punctuation, collapses whitespace/underscores to single
 * hyphens, caps word-count and length, and trims trailing hyphens left by the
 * length cap. Returns '' when the input has no usable characters — callers
 * decide the fallback (usually the sessionId).
 */
export function slugifySessionName(text: string): string {
  const cleaned = text
    .toLowerCase()
    .replace(/[`*_~]/g, ' ') // markdown emphasis → space
    .replace(/[^\w\s-]/g, ' ') // strip punctuation/symbols, keep word chars + hyphen
    .replace(/[\s_]+/g, ' ') // collapse whitespace + underscores
    .trim();
  if (!cleaned) return '';
  const words = cleaned.split(' ').filter(Boolean).slice(0, MAX_WORDS);
  return words
    .join('-')
    .slice(0, MAX_LEN)
    .replace(/-+$/g, ''); // length cap may sever a word mid-hyphen
}
