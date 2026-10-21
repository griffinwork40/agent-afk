/**
 * Error-head normalization and clustering for the tool-failure-density detector.
 *
 * `errorHead` (the first ≤200 chars of a failed tool result, redacted) differs
 * slightly across invocations even when the root cause is identical — e.g. the
 * timeout value varies, a session/tool-use id is embedded, or a path is
 * machine-specific. Normalizing before grouping collapses those variants into
 * one cluster so the card names the actual cause instead of listing 95 rows of
 * `"unclassified"` with subtly different text.
 *
 * ## Normalization rules (applied in order)
 *
 * 1. Lowercase.
 * 2. Strip common prefixes (`Error:`, `TypeError:`, etc.) so the message body
 *    drives the cluster key, not the error constructor name.
 * 3. Replace absolute paths (`/home/…`, `/Users/…`) with `<path>`.
 * 4. Replace AFK-style ids (`bg-…`, `toolu_…`, `call_…`, `session-…`,
 *    hex-like run ids) with `<id>`.
 * 5. Replace quoted strings (single or double) with `<str>`.
 * 6. Replace duration tokens (`123ms`, `45s elapsed`) with `<Nms>`.
 * 7. Replace remaining digit sequences with `<N>`.
 * 8. Collapse repeated whitespace and trim.
 *
 * The result is a stable cluster key: two heads that differ only in
 * numbers, ids, paths, or quoted values will produce the same key.
 *
 * @module improve/scan/detectors/tool-failure-density.normalize
 */

/** Maximum number of clusters surfaced per tool card. */
export const MAX_ERROR_CLUSTERS = 5;

/** One entry in `detail.errorClusters`. */
export interface ErrorCluster {
  /** Normalized cluster key (human-readable, not a hash). */
  key: string;
  /** Number of failures that matched this cluster. */
  count: number;
  /** One raw `errorHead` sample from the first matching failure. */
  sample: string;
}

/**
 * Normalize an `errorHead` string to a stable cluster key.
 *
 * Exported so tests and sibling modules can verify the normalization rules
 * independently of the full clustering pipeline.
 */
export function normalizeErrorHead(head: string): string {
  let s = head.toLowerCase();

  // 1. Strip common error prefixes (keep the descriptive part).
  s = s.replace(/^(error|typeerror|rangeerror|referenceerror|syntaxerror|urierror)\s*:\s*/i, '');

  // 2. Absolute paths → <path>  (Unix and Windows-style)
  s = s.replace(/(?:\/(?:home|users|var|tmp|opt|usr|etc|private|workspaces|runner|app)[^\s,;:"'`\])}]+)/gi, '<path>');
  s = s.replace(/[a-z]:\\[^\s,;:"'`\])}]+/gi, '<path>');

  // 3. AFK / LLM ids: bg-XXXX, toolu_XXXX, call_XXXX, session-XXXX, job-XXXX,
  //    and generic hex run ids (≥8 hex chars).
  s = s.replace(/\b(?:bg|toolu|call|session|job|req|task|run)[-_][a-z0-9_-]+/gi, '<id>');
  s = s.replace(/\b[0-9a-f]{8,}\b/g, '<id>');

  // 4. Quoted strings (single or double) → <str>
  s = s.replace(/"[^"]*"/g, '<str>');
  s = s.replace(/'[^']*'/g, '<str>');

  // 5. Duration tokens: "123ms", "45s elapsed", "after 1000ms"
  s = s.replace(/\b\d+(\.\d+)?\s*ms\b(?:\s+elapsed)?/g, '<nms>');
  s = s.replace(/\b\d+(\.\d+)?\s*s\s+elapsed\b/g, '<nms>');

  // 6. Remaining digit sequences → <N>
  s = s.replace(/\b\d+(\.\d+)?\b/g, '<N>');

  // 7. Collapse whitespace.
  s = s.replace(/\s+/g, ' ').trim();

  return s || '<empty>';
}

/**
 * Cluster an array of `errorHead` strings (one per failure sighting) into at
 * most {@link MAX_ERROR_CLUSTERS} buckets, sorted descending by count.
 *
 * Each cluster carries:
 * - `key`    — the normalized text that defines the bucket.
 * - `count`  — how many failures landed in this bucket.
 * - `sample` — the raw (un-normalized) head from the first failure in the bucket.
 *
 * Failures with no `errorHead` (older traces) are silently skipped and do not
 * appear in any cluster — they continue to be counted in `failureClassBreakdown`
 * as `"unclassified"`.
 */
export function clusterErrorHeads(
  heads: (string | undefined)[],
  maxClusters = MAX_ERROR_CLUSTERS,
): ErrorCluster[] {
  const buckets = new Map<string, { count: number; sample: string }>();

  for (const raw of heads) {
    if (raw === undefined || raw === '') continue;
    const key = normalizeErrorHead(raw);
    const existing = buckets.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      buckets.set(key, { count: 1, sample: raw });
    }
  }

  // Sort descending by count, take top N.
  return Array.from(buckets.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, maxClusters)
    .map(([key, { count, sample }]) => ({ key, count, sample }));
}
