/**
 * Pure detector module for pre-existing-defect flags in assistant text.
 *
 * Takes assistant turn text and returns structured entries — NO prose is
 * persisted, only locus tokens, signal kind, and a coarse category.
 *
 * Two signals:
 *   1. "pre-existing" sentences (pre-existing / preexisting / pre existing)
 *      that contain a defect cue AND at least one concrete locus.
 *   2. Markdown `Deferred:` bullets (end-of-turn blocks), excluding "none"
 *      and equivalents, that contain at least one concrete locus.
 *
 * A locus is one of:
 *   - A repo-relative file path (contains a `/` and ends with a known
 *     extension, OR looks like a test file).
 *   - A test file name (e.g. `session.test.ts`, `trigger.test.ts`).
 *   - A CI/audit gate name (e.g. `audit:filesize:check`, `scan:env:check`).
 *
 * Design constraints:
 *   - No I/O, no side effects, no LLM calls.
 *   - Deterministic and sync.
 *   - No sentence text persisted.
 *
 * @module agent/preexisting-ledger/detector
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SignalKind = 'preexisting-sentence' | 'deferred-bullet';

export type DefectCategory =
  | 'failing-test'
  | 'gate'
  | 'size-ceiling'
  | 'other';

export interface DetectedEntry {
  /** Signal that triggered detection. */
  signal: SignalKind;
  /** Coarse, deterministic category. */
  category: DefectCategory;
  /** Extracted locus tokens (file paths, test names, gate names). */
  loci: string[];
}

// ---------------------------------------------------------------------------
// Regexes — all pure, no flags that require I/O
// ---------------------------------------------------------------------------

/**
 * Match sentences that contain a pre-existing phrase (case-insensitive).
 * A "sentence" here is text between sentence-ending punctuation or newlines.
 * We split on sentence boundaries and test each chunk.
 */
const RE_PREEXISTING = /pre[\s-]?existing/i;

/**
 * Defect cue words that distinguish real flags from noise like "tests pass".
 * Uses prefix matching for inflected forms (fails, failed, failing, failure;
 * exceeds, exceeded; errors, errored) so we don't need to enumerate each.
 * The trailing \b prevents matching inside larger words (e.g. "redline").
 */
const RE_DEFECT_CUE =
  /\b(?:fail\w*|red(?=\b)|error\w*|violation\w*|stale\w*|drift\w*|bugs?\b|broken|flaky|grew\b|ceiling|exceed\w*|oversized|lint|warning)\b/i;

/**
 * Gate / audit name: colon-delimited identifiers like `audit:filesize:check`
 * or `scan:env:check` or `fix:pins:check`. Must have at least one colon.
 */
const RE_GATE = /\b[a-z][\w-]*(?::[a-z][\w-]*)+\b/g;

/**
 * Test file name: ends with `.test.ts`, `.test.js`, `.spec.ts`, `.spec.js`
 * (with or without a directory prefix).
 */
const RE_TEST_FILE =
  /\b(?:[\w./-]*\/)?[\w.-]+\.(?:test|spec)\.[jt]sx?\b/g;

/**
 * Repo-relative file path: contains at least one `/`, ends with a known
 * source extension. We avoid matching bare URLs (has ://).
 */
const RE_FILE_PATH =
  /\b(?!https?:\/\/)[\w.-]+\/[\w./-]+\.(?:ts|js|tsx|jsx|mts|mjs|cjs|md|json|yaml|yml)\b/g;

/**
 * Inline code span: `backtick-enclosed content`. Used to find loci embedded
 * in backtick spans first (more reliable than free-text scanning).
 */
const RE_BACKTICK = /`([^`]+)`/g;

/**
 * Kebab/snake-case module-style identifiers that appear inside backticks
 * (e.g. `anthropic-direct`, `session-end-hook`). These are concrete component
 * references even without a file extension or colon. Must contain a dash or
 * underscore to avoid matching plain English words like `compact`.
 */
const RE_MODULE_IDENT = /^[\w][\w]*[-_][\w][\w-_]*$/;

// ---------------------------------------------------------------------------
// Deferred-bullet detection
// ---------------------------------------------------------------------------

/**
 * Match lines that look like `Deferred: ...` bullets in markdown list or
 * paragraph form, including bold-wrapped variants like `**Deferred:**`.
 * Case-insensitive for the keyword.
 */
const RE_DEFERRED_LINE = /^\s*(?:[-*]\s*)?(?:\*{1,2})?deferred(?:\*{1,2})?\s*:\s*(.+)$/im;

/**
 * Values that mean "nothing deferred" — skip these lines.
 */
const RE_NONE_EQUIVALENT = /^\s*(?:none|n\/a|nothing|—|-)\s*$/i;

// ---------------------------------------------------------------------------
// Category classification
// ---------------------------------------------------------------------------

function classifyCategory(loci: string[]): DefectCategory {
  const joined = loci.join(' ').toLowerCase();
  // Gate names (colons)
  if (joined.includes(':')) return 'gate';
  // Test files
  if (/\.(test|spec)\.[jt]sx?/.test(joined)) return 'failing-test';
  // Size references
  if (/\b(?:loc|line|ceiling|size)\b/.test(joined)) return 'size-ceiling';
  return 'other';
}

function categoryForSentence(sentence: string, loci: string[]): DefectCategory {
  const lower = sentence.toLowerCase();
  if (/\b(?:loc|line|ceiling|size)\b/.test(lower)) return 'size-ceiling';
  return classifyCategory(loci);
}

// ---------------------------------------------------------------------------
// Locus extraction helpers
// ---------------------------------------------------------------------------

/** Extract all gate-style tokens from a text snippet. */
function extractGates(text: string): string[] {
  return [...new Set([...text.matchAll(RE_GATE)].map((m) => m[0]))];
}

/** Extract all test-file tokens from a text snippet. */
function extractTestFiles(text: string): string[] {
  return [...new Set([...text.matchAll(RE_TEST_FILE)].map((m) => m[0]))];
}

/** Extract all file-path tokens from a text snippet. */
function extractFilePaths(text: string): string[] {
  return [...new Set([...text.matchAll(RE_FILE_PATH)].map((m) => m[0]))];
}

/** Extract loci from backtick spans first, then free text. */
function extractLoci(text: string): string[] {
  const loci: string[] = [];

  // Phase 1: extract from backtick spans (highest confidence).
  let m: RegExpExecArray | null;
  RE_BACKTICK.lastIndex = 0;
  while ((m = RE_BACKTICK.exec(text)) !== null) {
    const inner = m[1]!;
    loci.push(...extractGates(inner));
    loci.push(...extractTestFiles(inner));
    loci.push(...extractFilePaths(inner));
    // Also capture kebab/snake-case identifiers like `anthropic-direct` that
    // are concrete component references even without a file extension or colon.
    const trimmed = inner.trim();
    if (loci.indexOf(trimmed) === -1 && RE_MODULE_IDENT.test(trimmed)) {
      loci.push(trimmed);
    }
  }

  // Phase 2: free-text scan (for loci not enclosed in backticks).
  loci.push(...extractGates(text));
  loci.push(...extractTestFiles(text));
  loci.push(...extractFilePaths(text));

  return [...new Set(loci)];
}

// ---------------------------------------------------------------------------
// Sentence splitter
// ---------------------------------------------------------------------------

/**
 * Split text into sentence-like chunks. We split on:
 *   - Newlines (each line may be its own claim)
 *   - Sentence-ending punctuation followed by whitespace
 *
 * We keep a generous window — false negatives (missing a pre-existing flag)
 * are worse than false positives (detecting a non-defect sentence that still
 * lacks a locus and gets filtered out).
 */
function splitSentences(text: string): string[] {
  // Split on newlines first, then on `. ` / `! ` / `? ` boundaries.
  // We deliberately do NOT split on `...` (ellipsis) because flag text often
  // spans an ellipsis: "`src/types.ts` is 560 LOC ... Pre-existing on main".
  const lines = text.split(/\n+/);
  const sentences: string[] = [];
  for (const line of lines) {
    if (line.trim() === '') continue;
    // Split only on a single `.`, `!`, or `?` (not `..` or `...`), followed by
    // whitespace. The negative lookbehind `[^.]` ensures we don't split on `..`.
    const parts = line.split(/(?<=[^.][.!?]|(?<![.])[!?])\s+/);
    sentences.push(...parts);
  }
  return sentences;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Maximum number of characters to scan from assistant text. Sessions can be
 * very large; we cap scanning to bound CPU at session teardown.
 *
 * Exported so the hook can document its bounding behaviour.
 */
export const MAX_SCAN_CHARS = 500_000;

/**
 * Analyse assistant text from ONE turn and return detected entries.
 *
 * Deduplication across turns is the caller's responsibility (the hook tracks
 * seen loci across turns within a session).
 */
export function detectInText(text: string): DetectedEntry[] {
  const capped = text.length > MAX_SCAN_CHARS ? text.slice(0, MAX_SCAN_CHARS) : text;
  const results: DetectedEntry[] = [];

  // ── Signal 1: pre-existing sentences ────────────────────────────────────
  const sentences = splitSentences(capped);
  for (const sentence of sentences) {
    if (!RE_PREEXISTING.test(sentence)) continue;
    if (!RE_DEFECT_CUE.test(sentence)) continue;
    const loci = extractLoci(sentence);
    if (loci.length === 0) continue;
    results.push({
      signal: 'preexisting-sentence',
      category: categoryForSentence(sentence, loci),
      loci,
    });
  }

  // ── Signal 2: Deferred: bullets ─────────────────────────────────────────
  const deferredMatches = [...capped.matchAll(new RegExp(RE_DEFERRED_LINE.source, 'gim'))];
  for (const match of deferredMatches) {
    const body = match[1]?.trim() ?? '';
    if (!body || RE_NONE_EQUIVALENT.test(body)) continue;
    const loci = extractLoci(body);
    if (loci.length === 0) continue;
    results.push({
      signal: 'deferred-bullet',
      // Body-aware, like the sentence signal: "src/x.ts is over the size
      // ceiling" names only a path, so loci alone would classify it 'other'.
      category: categoryForSentence(body, loci),
      loci,
    });
  }

  return results;
}
