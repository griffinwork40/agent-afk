/**
 * Severity reconciliation for card merges.
 *
 * Split out of `card-writer.ts` (already at its size ceiling) so the decision
 * has one obvious home and its own tests.
 *
 * @module improve/scan/severity-merge
 */

import type { FailureCard, DetectorResult } from '../schemas.js';

type Severity = FailureCard['severity'];

const SEVERITY_RANK: Record<Severity, number> = {
  low: 0,
  medium: 1,
  high: 2,
};

/** Escalate-only: the higher of the two ranks wins. */
export function maxSeverity(a: Severity, b: Severity): Severity {
  return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/**
 * Read the `detector` version tag out of a card/detection `detail` bag.
 *
 * Contract: `detail` is an open `z.record(z.string(), z.unknown())`, so the tag
 * is optional and may be any type. Anything that is not a non-empty string
 * reads as `undefined` — an untagged card can then never be mistaken for a
 * version CHANGE (see {@link reconcileSeverity}), which keeps the default path
 * escalate-only for every detector that does not version itself.
 */
export function detectorTag(detail: Record<string, unknown> | undefined): string | undefined {
  const raw = detail?.['detector'];
  return typeof raw === 'string' && raw.length > 0 ? raw : undefined;
}

/**
 * Invariant: severity only ever RATCHETS UP — except across a detector version
 * change, where the fresh detection's severity is authoritative.
 *
 * Escalate-only is deliberate: a card that was once high stays high even if a
 * later quieter scan would rate it lower, so a real incident cannot be silently
 * downgraded by a quiet window.
 *
 * That rule breaks when the detector's own ARITHMETIC changes. `closure-anomaly`
 * shipped a v1 that counted one closure EVENT as one session and reported only
 * the largest instance's cost; v2 counts sessions and sums the disjoint
 * per-instance costs. A card whose `high` was computed from v1's inflated
 * session count could never come back down under escalate-only, so the fix
 * would correct every number on the card while leaving the headline severity
 * wrong — the exact failure the fix set out to remove.
 *
 * A version change is therefore treated as "these two severities are not
 * comparable, trust the newer one". Both directions are allowed: a version bump
 * can lower a severity as well as raise it. When the tags match, or either side
 * is untagged, this is exactly `maxSeverity`.
 */
export function reconcileSeverity(existing: FailureCard, detection: DetectorResult): Severity {
  const existingTag = detectorTag(existing.detail);
  const detectionTag = detectorTag(detection.detail);

  const versionChanged =
    existingTag !== undefined && detectionTag !== undefined && existingTag !== detectionTag;

  return versionChanged ? detection.severity : maxSeverity(existing.severity, detection.severity);
}
