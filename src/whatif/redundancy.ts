/**
 * Preflight redundancy check for the what-if prediction engine.
 *
 * For each paragraph added in the system diff, finds the most similar
 * paragraph in the baseline system prompt using deterministic lexical
 * similarity (token-set Jaccard over normalized word tokens).  When a match
 * exceeds the threshold, surfaces a warning message before any model call.
 * Also informs the prediction prompt so the analyst can flag "no change
 * expected, already covered" predictions.
 *
 * No I/O.  No model calls.  All similarity is computed deterministically.
 *
 * @module whatif/redundancy
 *
 * ## Similarity algorithm
 *
 * Token-set Jaccard similarity:
 *   J(A, B) = |A ∩ B| / |A ∪ B|
 *
 * where A and B are sets of normalized tokens (lowercase, punctuation
 * stripped, stopwords removed).  The threshold is documented in
 * REDUNDANCY_THRESHOLD.
 *
 * ## Markdown section detection
 *
 * The "source section" is the nearest preceding `## Heading` line in the
 * baseline system prompt above the matched paragraph.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Jaccard similarity threshold above which a match is considered redundant.
 * Empirically calibrated: 0.35 catches near-paraphrases while avoiding
 * false positives on paragraphs that merely share common vocabulary.
 */
export const REDUNDANCY_THRESHOLD = 0.35;

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

/**
 * Common English stopwords excluded from Jaccard computation to prevent
 * false positives driven by shared function words.
 */
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for',
  'of', 'with', 'by', 'from', 'as', 'is', 'it', 'its', 'be', 'are',
  'was', 'were', 'been', 'has', 'have', 'had', 'do', 'does', 'did',
  'not', 'no', 'nor', 'so', 'yet', 'both', 'either', 'neither', 'each',
  'than', 'too', 'very', 'can', 'will', 'just', 'should', 'now', 'if',
  'when', 'where', 'how', 'what', 'which', 'who', 'that', 'this', 'these',
  'those', 'such', 'any', 'all', 'more', 'most', 'also', 'then',
  'into', 'over', 'after', 'before', 'between', 'out', 'about', 'up',
]);

// ---------------------------------------------------------------------------
// Light stemmer
// ---------------------------------------------------------------------------

/**
 * Apply a minimal suffix-stripping stem to a token.
 *
 * Handles the most common English inflection forms that prevent near-identical
 * words from matching (e.g. "edits" / "edit", "subagent" / "subagents",
 * "spawning" / "spawn", "reads" / "read").  This is intentionally conservative
 * — only high-frequency suffixes are removed to avoid over-stemming technical
 * vocabulary.
 *
 * Applied AFTER stopword removal and length filtering, so the result is
 * always at least 2 characters long.
 */
function stem(token: string): string {
  // Guard: only strip a suffix when at least 3 characters remain after removal.
  // `-ings` removes 4 chars → guard is length > 7 (≥8 chars keeps ≥4 after strip).
  // Prevents "strings" (7 chars) from stemming via -ings to "str" instead of
  // reaching the -s rule → "string".
  // `-ing` removes 3 chars → guard is length > 6 (≥7 chars keeps ≥4 after strip).
  // Prevents "running" (7 chars) from stemming to "runn" — but a minimum
  // remainder of 4 chars means 7-letter tokens ending in -ing stem correctly:
  // "running" → "runn" still happens at length > 6. We need > 7 to require ≥5
  // chars, so "running" (run+ning) → guarded away → falls through to no-op,
  // which is acceptable for this conservative stemmer.
  if (token.length > 7 && token.endsWith('ings')) return token.slice(0, -4);
  if (token.length > 7 && token.endsWith('ing')) return token.slice(0, -3);
  if (token.length > 5 && token.endsWith('ied')) return token.slice(0, -3) + 'y';
  if (token.length > 5 && token.endsWith('ies')) return token.slice(0, -3) + 'y';
  if (token.length > 4 && token.endsWith('ed')) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith('es')) return token.slice(0, -2);
  if (token.length > 3 && token.endsWith('s')) return token.slice(0, -1);
  return token;
}

// ---------------------------------------------------------------------------
// Tokenization
// ---------------------------------------------------------------------------

/**
 * Normalize a string into a set of meaningful tokens.
 *
 * Steps:
 *   1. Lowercase
 *   2. Strip punctuation (keep alphanumerics and spaces)
 *   3. Split on whitespace
 *   4. Remove stopwords and tokens shorter than 2 characters
 *   5. Apply light suffix stemming (plurals, gerunds, past tense)
 */
export function tokenize(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOPWORDS.has(t))
    .map(stem);
  return new Set(tokens);
}

/**
 * Compute token-set Jaccard similarity between two strings.
 *
 * Returns a value in [0, 1].  Returns 0 when both token sets are empty.
 */
export function jaccardSimilarity(a: string, b: string): number {
  const tokA = tokenize(a);
  const tokB = tokenize(b);
  if (tokA.size === 0 && tokB.size === 0) return 0;
  let intersection = 0;
  for (const t of tokA) {
    if (tokB.has(t)) intersection++;
  }
  const union = tokA.size + tokB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Paragraph extraction
// ---------------------------------------------------------------------------

/**
 * Split a text into non-empty paragraphs (separated by one or more blank
 * lines).  Each paragraph is a single string with internal newlines preserved.
 */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Extract paragraphs that are newly added in the system diff.
 *
 * A "diff paragraph" is a contiguous block of `+` lines (with no `-` lines
 * mixed in), extracted from the unified diff rendered by structural.ts.
 * Each block is treated as a candidate paragraph for the redundancy check.
 *
 * Lines starting with `@@` (hunk headers) or `+` are considered part of
 * added content; lines starting with `-` or ` ` (context) are not.
 * We collect runs of `+` lines and group them into paragraph-sized blocks
 * by splitting on blank `+`-only lines within the same run.
 */
export function extractAddedParagraphs(systemDiff: string): string[] {
  if (!systemDiff) return [];

  const result: string[] = [];
  let currentLines: string[] = [];

  for (const rawLine of systemDiff.split('\n')) {
    if (rawLine.startsWith('@@')) continue; // skip hunk headers

    if (rawLine.startsWith('+')) {
      const content = rawLine.slice(1); // strip leading '+'
      currentLines.push(content);
    } else {
      // End of an added run — flush any accumulated lines as a paragraph
      if (currentLines.length > 0) {
        const block = currentLines.join('\n').trim();
        if (block.length > 0) {
          // Further split on blank lines within the block
          for (const para of splitParagraphs(block)) {
            result.push(para);
          }
        }
        currentLines = [];
      }
    }
  }

  // Flush the last run
  if (currentLines.length > 0) {
    const block = currentLines.join('\n').trim();
    if (block.length > 0) {
      for (const para of splitParagraphs(block)) {
        result.push(para);
      }
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Section detection
// ---------------------------------------------------------------------------

/**
 * Find the nearest preceding markdown heading (## or ###, any level) in the
 * baseline system prompt above the given paragraph text.
 *
 * Searches line by line for a line that contains the paragraph start, then
 * scans backward for the nearest heading.  Returns the heading text (without
 * `#` prefix and trimmed) or `undefined` when no heading is found above.
 *
 * When the paragraph spans multiple lines, matches on the first line.
 */
export function findNearestHeading(
  baselineSystem: string,
  paragraph: string,
): string | undefined {
  const lines = baselineSystem.split('\n');
  const paraFirstLine = paragraph.split('\n')[0]?.trim() ?? '';
  if (!paraFirstLine) return undefined;

  // Find the line index of the paragraph in the baseline.
  // Use trimmed full-line equality to avoid false matches when two paragraphs
  // share a common opening phrase.
  let paraIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() === paraFirstLine) {
      paraIndex = i;
      break;
    }
  }

  if (paraIndex < 0) return undefined;

  // Scan backward for the nearest heading
  for (let i = paraIndex - 1; i >= 0; i--) {
    const line = lines[i] ?? '';
    const headingMatch = line.match(/^#{1,6}\s+(.+)/);
    if (headingMatch) {
      return headingMatch[1]?.trim();
    }
  }

  return undefined;
}

// ---------------------------------------------------------------------------
// RedundancyWarning type
// ---------------------------------------------------------------------------

/**
 * A single redundancy warning produced by {@link checkRedundancy}.
 */
export interface RedundancyWarning {
  /** The added paragraph that may be redundant. */
  addedParagraph: string;
  /** The existing baseline paragraph with the highest similarity. */
  matchingParagraph: string;
  /** Jaccard similarity score in [0, 1]. */
  similarity: number;
  /** Nearest preceding markdown heading in the baseline prompt, if any. */
  sourceSection?: string;
  /** Human-readable warning message. */
  message: string;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Check whether any added paragraphs in the system diff restate existing
 * instructions in the baseline system prompt.
 *
 * For each added paragraph, computes token-set Jaccard similarity against
 * every baseline paragraph.  When the best match exceeds
 * {@link REDUNDANCY_THRESHOLD}, a {@link RedundancyWarning} is emitted.
 *
 * Returns an empty array when no redundancies are found.
 *
 * No I/O.  No model calls.  Deterministic.
 *
 * @param baselineSystem  The baseline system prompt text.
 * @param systemDiff      The unified-style system diff from structural.ts.
 */
export function checkRedundancy(
  baselineSystem: string,
  systemDiff: string,
): RedundancyWarning[] {
  const addedParas = extractAddedParagraphs(systemDiff);
  if (addedParas.length === 0) return [];

  const baselineParas = splitParagraphs(baselineSystem);
  if (baselineParas.length === 0) return [];

  const warnings: RedundancyWarning[] = [];

  for (const added of addedParas) {
    // Skip very short additions (likely noise — single words or symbols)
    if (added.length < 20) continue;

    let bestScore = 0;
    let bestMatch = '';

    for (const base of baselineParas) {
      const score = jaccardSimilarity(added, base);
      if (score > bestScore) {
        bestScore = score;
        bestMatch = base;
      }
    }

    if (bestScore >= REDUNDANCY_THRESHOLD) {
      const sourceSection = findNearestHeading(baselineSystem, bestMatch);
      const excerptLen = 120;
      const excerpt =
        bestMatch.length > excerptLen
          ? bestMatch.slice(0, excerptLen) + '…'
          : bestMatch;
      const sectionNote = sourceSection ? ` (§ ${sourceSection})` : '';
      const message =
        `This change may restate an existing rule: "${excerpt}"${sectionNote}`;
      warnings.push({
        addedParagraph: added,
        matchingParagraph: bestMatch,
        similarity: bestScore,
        ...(sourceSection !== undefined ? { sourceSection } : {}),
        message,
      });
    }
  }

  return warnings;
}

// ---------------------------------------------------------------------------
// Prompt injection helper
// ---------------------------------------------------------------------------

/**
 * Format redundancy warnings as a section to inject into the prediction
 * prompt, so the analyst model can say "no change expected, already covered"
 * when appropriate.
 *
 * Returns `undefined` when there are no warnings (so callers can skip the
 * section entirely with a simple truthy check).
 */
export function formatRedundancySection(warnings: RedundancyWarning[]): string | undefined {
  if (warnings.length === 0) return undefined;

  const lines: string[] = [
    '## Redundancy preflight',
    '',
    'The following added paragraph(s) closely resemble existing baseline instructions.',
    'When a change restates an existing rule the baseline already follows, the correct',
    'prediction is an EMPTY array [] — the change has no behavioral effect.',
    '',
  ];

  for (let i = 0; i < warnings.length; i++) {
    const w = warnings[i];
    if (!w) continue;
    const sectionNote = w.sourceSection ? ` (§ ${w.sourceSection})` : '';
    lines.push(`${i + 1}. ${w.message}`);
    lines.push(`   Similarity: ${(w.similarity * 100).toFixed(0)}%${sectionNote}`);
    lines.push('');
  }

  lines.push(
    'If the change is truly novel despite the similarity, predict normally.',
    'If it merely restates an existing rule, return [].',
  );

  return lines.join('\n');
}
