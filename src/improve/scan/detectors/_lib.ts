/**
 * Shared helpers for the scan detector family.
 *
 * ## clampExcerpt
 *
 * Every detector caps evidence excerpts at 2,000 characters to satisfy the
 * `FailureEvidenceSchema`'s `excerpt` max-length constraint and to avoid
 * bloating cards with raw trace lines that can exceed several kilobytes.
 * The constant and the clamp function were duplicated across four detectors;
 * centralising them here makes the cap a single edit point.
 *
 * ## MAX_EVIDENCE_PER_CARD
 *
 * Hard cap on the number of evidence rows attached per detection result.
 * Reviewers only need enough rows to confirm the pattern; more rows add noise
 * without signal.  All detectors use the same cap (8) and are kept in sync by
 * importing from here.
 *
 * @module improve/scan/detectors/_lib
 */

/**
 * Hard cap on evidence rows attached per detection result.  Higher values
 * bloat cards without adding diagnostic value — reviewers need enough lines
 * to confirm the pattern, not an exhaustive replay.
 */
export const MAX_EVIDENCE_PER_CARD = 8;

/**
 * Cap a raw trace line at 2,000 characters.  The schema enforces this limit
 * on `FailureEvidence.excerpt`; truncating here avoids a Zod rejection and
 * keeps card files from growing unbounded on verbose trace lines.
 *
 * The `'...'` suffix signals truncation without losing the RFC3339 timestamp
 * at the start of the line, which is the most important part for diagnosis.
 */
export function clampExcerpt(rawLine: string): string {
  if (rawLine.length <= 2000) return rawLine;
  return rawLine.slice(0, 1997) + '...';
}
