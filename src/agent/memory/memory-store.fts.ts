/**
 * FTS5 query sanitization and result mapping for MemoryStore.
 *
 * FTS5 treats certain characters as operator or column-filter syntax when they
 * appear in unquoted tokens. The most common culprit is the hyphen (`-`), which
 * causes queries like `agent-afk` to fail with "no such column: afk". This
 * module provides a sanitizer that wraps problematic bare tokens in
 * double-quotes while preserving intentional FTS5 syntax (AND/OR/NOT operators,
 * already-quoted phrases, and prefix wildcards).
 *
 * @module agent/memory/memory-store.fts
 */

import type { Fact, MemorySearchResult } from './types.js';

/**
 * FTS5 operator keywords that must never be wrapped in quotes (they direct the
 * search engine). See https://www.sqlite.org/fts5.html#full_text_query_syntax
 */
const FTS5_OPERATORS = new Set(['AND', 'OR', 'NOT']);

/**
 * Characters that FTS5 treats as query-syntax tokens when they appear unquoted
 * in a bare word. A token containing any of these causes FTS5 to try to
 * interpret it as a column filter or arithmetic expression, producing errors
 * like "no such column: afk" for the query `agent-afk`. Includes `+`, `^`,
 * `(`, `)` so that queries like `C++` or `foo(bar)` are also quoted safely.
 */
const FTS5_BAREWORD_SPECIAL = /[-:/.,+^()]/;

/**
 * Map a Fact[] returned by searchFacts into MemorySearchResult entries.
 * Extracted here so the mapping logic is shared between the primary and
 * sanitized-retry paths in MemoryStore.search() without duplication.
 *
 * The `evidence` field is passed through raw; the verdict + [unverified] tag
 * are applied by the memory-tool handler (policy layer) only when the gate is
 * enabled.
 */
export function factsToResults(facts: Fact[]): MemorySearchResult[] {
  return facts.map((f) => ({
    type: 'fact' as const,
    content: f.content,
    category: f.category as MemorySearchResult['category'],
    created_at: f.created_at,
    source_session: f.session_id,
    confidence: f.confidence,
    evidence: f.evidence ?? null,
  }));
}

/**
 * Sanitize a raw FTS5 query so it survives the MATCH call without a syntax
 * error, while preserving intentional FTS5 syntax:
 *
 * - Explicit boolean operators (AND, OR, NOT) are kept as-is.
 * - Already-quoted phrases ("foo bar") are kept as-is.
 * - Prefix wildcards (term*) are kept as-is (valid FTS5 syntax).
 * - Bare tokens that contain FTS5 special characters (`-`, `:`, `/`, `.`, `,`,
 *   `+`, `^`, `(`, `)`) are wrapped in double-quotes so FTS5 treats them as
 *   literal phrases.
 *
 * The return value equals the input when no substitution was needed, which lets
 * callers skip the retry when sanitization is a no-op.
 *
 * Examples:
 *   "agent-afk"          → '"agent-afk"'
 *   "foo AND bar*"       → "foo AND bar*"   (unchanged)
 *   "ground-state"       → '"ground-state"'
 *   '"exact phrase"'     → '"exact phrase"' (unchanged)
 *   "foo:bar"            → '"foo:bar"'
 *   "C++"                → '"C++"'
 *   "foo(bar)"           → '"foo(bar)"'
 *
 * @internal Exported only for MemoryStore and its unit tests.
 */
export function sanitizeFtsQuery(query: string): string {
  const tokens: string[] = [];
  // Walk the query character by character, emitting tokens split on whitespace
  // while treating double-quoted substrings as atomic units.
  let i = 0;
  while (i < query.length) {
    // Skip whitespace between tokens.
    if (query[i] === ' ' || query[i] === '\t') {
      i++;
      continue;
    }
    // Quoted phrase — keep verbatim (find the closing quote).
    if (query[i] === '"') {
      const end = query.indexOf('"', i + 1);
      if (end === -1) {
        // Unclosed quote — take the rest as-is and let FTS5 report its own error.
        tokens.push(query.slice(i));
        break;
      }
      tokens.push(query.slice(i, end + 1));
      i = end + 1;
      continue;
    }
    // Bare token — collect until next whitespace or end.
    let j = i + 1;
    while (j < query.length && query[j] !== ' ' && query[j] !== '\t') j++;
    const token = query.slice(i, j);
    i = j;

    if (FTS5_OPERATORS.has(token)) {
      // Boolean operator — preserve as-is.
      tokens.push(token);
    } else if (FTS5_BAREWORD_SPECIAL.test(token)) {
      // Token contains FTS5-special characters. Strip any trailing * (prefix
      // wildcard) before quoting, then re-append it outside the quotes so the
      // wildcard still works: FTS5 supports "term"* but requires the * to be
      // outside the quoted string.
      if (token.endsWith('*')) {
        tokens.push(`"${token.slice(0, -1)}"*`);
      } else {
        tokens.push(`"${token}"`);
      }
    } else {
      // Plain token — keep as-is (includes prefix wildcards like `term*`).
      tokens.push(token);
    }
  }
  return tokens.join(' ');
}
