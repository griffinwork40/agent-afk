/**
 * Detector-version staleness guard for `afk improve eval-run`.
 *
 * When an eval-case is generated, the writer records the detector identity
 * that fired (e.g. `'repeated-tool-use@v1'`) in `assertion.detectorVersion`.
 * If the live detector is later bumped to `@v2`, a naïve eval-run would replay
 * the old fixture through the new detector and silently report as current —
 * masking the version drift.
 *
 * This module provides {@link checkDetectorVersion}, which the runner calls
 * immediately after the fixture-integrity check.  When the recorded and live
 * versions match the check is `pass` and downstream is unchanged.  When they
 * differ the check is `fail`, the run surfaces as `fail`, and a human-readable
 * {@link TriageNote} names both versions and the remediation command.
 *
 * @module improve/eval-run/runner.staleness
 */

import type { EvalCase, EvalCheck, FailurePattern, TriageNote } from '../schemas.js';
import { makeCheck } from './contracts.js';

// ---------------------------------------------------------------------------
// Current detector version map
// ---------------------------------------------------------------------------

// Contract: this map MUST be kept in sync with the `detector:` string each
// detector emits in its `DetectorResult.detail['detector']` field (the same
// source of truth the eval-gen writer reads from `card.detail['detector']`).
// When a detector bumps its version (e.g. from `@v1` to `@v2`), update the
// entry here so existing eval-cases built under the old version surface as
// stale on the next eval-run instead of silently replaying through the bumped
// detector.  Patterns with no entry are skipped (no staleness check fired).
//
// Sources (grep `detector:` in src/improve/scan/detectors/):
//   repeated-tool-use.ts:303    detector: 'repeated-tool-use@v1'
//   closure-anomaly.ts:218      detector: 'closure-anomaly@v2'
//   subagent-block.ts:184       detector: 'subagent-block@v1'
//   tool-failure-density.ts:257 detector: 'tool-failure-density@v2'
//   subagent-read-denial.ts:261 detector: 'subagent-read-denial@v2'
export const CURRENT_DETECTOR_VERSIONS: Readonly<Partial<Record<FailurePattern, string>>> = {
  'repeated-tool-use': 'repeated-tool-use@v1',
  'closure-anomaly': 'closure-anomaly@v2',
  'subagent-block': 'subagent-block@v1',
  'tool-failure-density': 'tool-failure-density@v2',
  'subagent-read-denial': 'subagent-read-denial@v2',
};

// ---------------------------------------------------------------------------
// Guard
// ---------------------------------------------------------------------------

/** Check name for the staleness guard check. Exported for test assertions. */
export const DETECTOR_VERSION_CHECK = 'detector-version-current';

export interface DetectorVersionCheckResult {
  check: EvalCheck;
  /** Non-null only when the version is stale — surfaces additional context. */
  note: TriageNote | null;
}

/**
 * Compare `evalCase.assertion.detectorVersion` to the live detector version
 * from {@link CURRENT_DETECTOR_VERSIONS}.  Returns `null` when the pattern has
 * no registered current version (unknown/future patterns); otherwise returns a
 * check that passes when the versions match and fails when they differ.
 *
 * A failing check forces the overall run status to `fail`, signalling that the
 * eval-case must be regenerated before its verdict can be trusted.  A passing
 * check (matching versions) leaves all downstream checks and the final status
 * completely unchanged — this is the behaviour-preserving path.
 */
export function checkDetectorVersion(
  evalCase: EvalCase,
  nowIso: string,
): DetectorVersionCheckResult | null {
  const patternId = evalCase.assertion.patternId;
  const current = CURRENT_DETECTOR_VERSIONS[patternId];
  if (current === undefined) return null; // unknown pattern — skip guard

  const recorded = evalCase.assertion.detectorVersion;
  const match = recorded === current;
  const check = makeCheck({
    name: DETECTOR_VERSION_CHECK,
    description:
      'The detector version the eval-case was generated under matches the live detector version',
    pass: match,
    expected: current,
    actual: recorded,
  });

  const note: TriageNote | null = match
    ? null
    : {
        at: nowIso,
        text:
          `Eval-case is stale: generated under detector '${recorded}' but ` +
          `the live detector is now '${current}'. ` +
          `Re-run \`afk improve eval-gen\` against this card to produce a ` +
          `fresh eval-case before trusting this eval-run's verdict.`,
      };

  return { check, note };
}
