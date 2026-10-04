/**
 * LF: cross_session_reask — weak -1 vote.
 *
 * When a NEW root session's first prompt arrives in the same cwd within
 * 30 minutes of a previous root session's end and closely matches that
 * session's prompt fingerprint (normalized-token Jaccard >= REASK_THRESHOLD),
 * this LF upserts a -1 vote onto the PREVIOUS session's record.
 *
 * Thresholds and design decisions (documented per proposal):
 *   - Time window: 30 minutes (REASK_WINDOW_MS). The window is checked using
 *     the outcome record's settles_after field for new sessions and falling
 *     back to record mtime from the first_prompt_tokens/first_cwd write
 *     timestamp. Since we don't record session end time in the outcome record
 *     directly, we use listRecords() to scan recent records and compare
 *     first_prompt_tokens.
 *   - Jaccard threshold: 0.6 (REASK_THRESHOLD). Normalized tokens = lowercased
 *     alphanumeric runs, stopwords removed. 0.6 means 60% of unique token
 *     types overlap — tight enough to avoid false-positives on common words,
 *     loose enough to catch "same task restated differently".
 *   - Scan limit: 20 most-recently-listed records (REASK_SCAN_LIMIT). The
 *     outcomes dir is written at teardown and listing order is filesystem-
 *     dependent, but only very recent sessions are candidates.
 *   - Weak -1: it cannot flip succeeded→failed on its own.
 *   - Fire-and-forget: called from the outcome session-end hook without await.
 *
 * @module agent/outcomes/lf-reask
 */

import { statSync } from 'node:fs';
import { getOutcomeRecordPath } from '../../paths.js';
import { listRecords, readRecord, upsertVotes } from './store.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Maximum age of a prior session for it to be a reask candidate (30 min). */
const REASK_WINDOW_MS = 30 * 60 * 1000;

/**
 * Normalized-token Jaccard similarity threshold.
 * 0.6 = 60% of unique token types must overlap. Documented in the proposal.
 */
export const REASK_THRESHOLD = 0.6;

/** Number of recent outcome records to scan for prior sessions. */
const REASK_SCAN_LIMIT = 20;

/**
 * Maximum number of tokens stored in a prompt fingerprint (issue #2449).
 * Caps fingerprint length symmetrically for both new and stored prompts.
 */
export const FINGERPRINT_MAX_TOKENS = 64;

// ---------------------------------------------------------------------------
// Token normalization
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'been', 'but', 'by', 'can',
  'do', 'for', 'from', 'has', 'have', 'i', 'if', 'in', 'is', 'it', 'its',
  'me', 'my', 'not', 'of', 'on', 'or', 'so', 'that', 'the', 'this', 'to',
  'up', 'was', 'we', 'with', 'you',
]);

/**
 * Normalize a prompt to a set of meaningful tokens.
 * Pure function — suitable for unit testing.
 */
export function normalizeTokens(text: string): Set<string> {
  const tokens = text
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
  const filtered = tokens.filter((t) => t.length >= 2 && !STOP_WORDS.has(t));
  return new Set(filtered);
}

/**
 * Build a prompt fingerprint: deduplicated, sorted, capped token list.
 *
 * Collects ALL unique qualifying tokens first, sorts them lexicographically,
 * then slices to at most FINGERPRINT_MAX_TOKENS. Sorting before slicing
 * ensures that two prompts containing the same vocabulary (but with tokens
 * appearing in different order) always produce the same fingerprint, which
 * gives correct Jaccard recall for cross_session_reask (issue #2561).
 *
 * The fingerprint is stored in `first_prompt_tokens`; raw prompt text is
 * never persisted (issue #2449).
 */
export function promptFingerprint(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .match(/[a-z0-9]+/g) ?? [];
  const seen = new Set<string>();
  for (const t of tokens) {
    if (t.length >= 2 && !STOP_WORDS.has(t) && !seen.has(t)) {
      seen.add(t);
    }
  }
  return Array.from(seen).sort().slice(0, FINGERPRINT_MAX_TOKENS);
}

/**
 * Jaccard similarity between two token sets: |A ∩ B| / |A ∪ B|.
 * Returns 0 when both sets are empty.
 */
export function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const tok of a) {
    if (b.has(tok)) intersection++;
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

// ---------------------------------------------------------------------------
// Main LF
// ---------------------------------------------------------------------------

/**
 * Scan the most recent outcome records for a session in the same cwd whose
 * first_prompt closely matches `newPrompt`. When found and within the time
 * window, upsert a weak -1 vote onto that prior session's record.
 *
 * Called fire-and-forget at the end of `_runImmediatePass` in session-end-hook.
 */
export function lfReask(
  newSessionId: string,
  newPrompt: string,
  newCwd: string | undefined,
  now: string,
): void {
  if (!newCwd) return; // cwd required to scope the match

  const newTokens = new Set(promptFingerprint(newPrompt));
  if (newTokens.size === 0) return;

  const recentIds = listRecords(REASK_SCAN_LIMIT);
  const windowStart = Date.now() - REASK_WINDOW_MS;

  for (const priorId of recentIds) {
    if (priorId === newSessionId) continue;

    const record = readRecord(priorId);
    if (!record) continue;
    if (record.first_cwd !== newCwd) continue;
    const storedTokens = record.first_prompt_tokens;
    if (!storedTokens || storedTokens.length === 0) continue;

    // Check time window using the record file's mtime as a proxy for session end
    try {
      const mtime = statSync(getOutcomeRecordPath(priorId)).mtimeMs;
      if (mtime < windowStart) continue;
    } catch {
      continue; // file disappeared between list and stat
    }

    // Similarity check using stored fingerprint
    const priorTokens = new Set(storedTokens);
    const similarity = jaccardSimilarity(newTokens, priorTokens);
    if (similarity < REASK_THRESHOLD) continue;

    // Match: upsert a weak -1 onto the prior session
    upsertVotes(priorId, [
      {
        lf: 'cross_session_reask',
        vote: -1,
        strength: 'weak',
        evidence: `new session ${newSessionId} in same cwd within 30min (Jaccard=${similarity.toFixed(2)})`,
        observed_at: now,
      },
    ]);
    // Only vote on the first match to avoid double-counting
    break;
  }
}
