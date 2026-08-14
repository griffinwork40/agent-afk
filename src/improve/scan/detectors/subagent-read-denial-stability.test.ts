/**
 * Golden-fingerprint stability test for the sub-agent read-denial detector.
 *
 * ## Why this test exists (#853)
 *
 * `src/improve/scan/detectors/subagent-read-denial.ts` fingerprints the FULL
 * denial reason string (after path-normalization) with SHA-256 to derive each
 * failure-card's slug, e.g.:
 *
 *   subagent-read-denial-a47734dbbb44
 *
 * The denial reason is produced by `buildForkPathDenialReason` (in
 * `src/agent/tools/hooks/fork-denial-remedy.ts`) and assembled in
 * `path-approval-hook.ts` as:
 *
 *   `buildForkPathDenialReason({ mode: 'read', resolvedPath })`
 *
 * Any reword of that prose — even a minor punctuation fix — produces a new
 * fingerprint → new slug → ORPHANS every failure card accumulated under the
 * old slug. The severity ladder resets to zero, historical evidence is
 * permanently disconnected, and nothing in CI signals the rotation.
 *
 * ## What this test does
 *
 * It imports the REAL complete-reason producer used by `path-approval-hook.ts`,
 * normalizes its output, hashes it, and
 * asserts the resulting fingerprint matches a checked-in golden constant. A
 * reword that changes the fingerprint makes this test fail, which is the
 * signal that was missing before.
 *
 * The constants at the top of the file ARE the authoritative golden values.
 * When you INTENTIONALLY change the wording (knowing that doing so orphans
 * existing cards), you must update the golden constants in this file AND
 * document the rotation in the commit message.
 *
 * ## What this test does NOT test
 *
 * - Whether the denial reason is assembled correctly in path-approval-hook.ts
 *   (that is covered by path-approval-hook.test.ts).
 * - Whether the fingerprinting algorithm itself is correct (covered by
 *   subagent-read-denial.test.ts).
 *
 * @see src/agent/tools/hooks/fork-denial-remedy.ts — producer
 * @see src/improve/scan/detectors/subagent-read-denial.ts — consumer
 * @see src/agent/tools/denial-circuit-breaker.ts — prefix source
 */

import { describe, it, expect } from 'vitest';
import { buildForkPathDenialReason } from '../../../agent/tools/hooks/fork-denial-remedy.js';
import { SUBAGENT_PATH_DENIAL_REASON_PREFIX } from '../../../agent/tools/denial-circuit-breaker.js';
import { computeFingerprint, normalizeReason } from './subagent-read-denial.js';

// ---------------------------------------------------------------------------
// Golden constants — the stable fingerprints for the current denial wording.
//
// These are the AUTHORITATIVE values. A test failure here means the denial
// prose changed and existing failure cards will be orphaned. If the reword is
// intentional, update these constants AND document the slug rotation in the
// commit message. Do NOT silently regenerate without understanding the impact.
// ---------------------------------------------------------------------------

/**
 * Golden fingerprint for a READ denial:
 *   `Sub-agent path access denied: <path> is outside the session's granted
 *    read roots. Reads are confined to this fork's granted read roots. To
 *    allow it, the parent must re-dispatch you via the `agent` tool with
 *    `readRoots: ["<path>"]`, or read the path itself and pass the content
 *    to you in the prompt. A grant made after you were dispatched cannot reach
 *    you — your roots were fixed at dispatch. Return this exact path
 *    requirement to your parent.`
 */
const GOLDEN_FINGERPRINT_READ =
  'a47734dbbb44aafcea3d44f17a35d8a422eee7e1d47a86bdcdf88a6670fc26dd';

// A single representative path used to drive the producer; it is normalized
// away by `normalizeReason` so the golden value is path-independent.
const TEST_PATH = '/test/path';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Assemble the full denial reason string exactly as `path-approval-hook.ts`
 * does when it auto-denies a forked sub-agent's out-of-scope path access:
 *
 *   `Sub-agent path access denied: ${result.resolved} is outside the
 *    session's granted ${mode} roots. ${remedy}`
 */
function readDenialReason(resolvedPath: string): string {
  return buildForkPathDenialReason({ mode: 'read', resolvedPath });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('subagent-read-denial: golden fingerprint stability (#853)', () => {
  it('READ denial fingerprint is stable (changing prose rotates failure-card slugs)', () => {
    const fullReason = readDenialReason(TEST_PATH);
    const normalizedReason = normalizeReason(fullReason);
    const fingerprint = computeFingerprint({ hookEvent: 'PreToolUse', normalizedReason });

    expect(fingerprint).toBe(GOLDEN_FINGERPRINT_READ);
  });

  it('fingerprint is path-independent — different paths yield the same hash', () => {
    const paths = [TEST_PATH, '/another/path/foo.ts', '/Users/griffinlong/proj/bar.ts'];
    const fingerprints = paths.map((p) => {
      const reason = readDenialReason(p);
      const normalized = normalizeReason(reason);
      return computeFingerprint({ hookEvent: 'PreToolUse', normalizedReason: normalized });
    });
    // All paths should produce the same fingerprint after normalization.
    expect(new Set(fingerprints).size).toBe(1);
    // And it must match the golden value.
    expect(fingerprints[0]).toBe(GOLDEN_FINGERPRINT_READ);
  });

  it('SUBAGENT_PATH_DENIAL_REASON_PREFIX matches the substring the detector keys on', () => {
    // The detector uses `reason.includes('Sub-agent path access denied:')` to
    // classify a containment denial. If the prefix changes here, the detector
    // would stop classifying the denial as 'read-root-containment' and would
    // instead mark it 'unclassified', silently breaking the card pipeline.
    expect(SUBAGENT_PATH_DENIAL_REASON_PREFIX).toBe('Sub-agent path access denied:');
    const fullReason = readDenialReason(TEST_PATH);
    expect(fullReason).toContain(SUBAGENT_PATH_DENIAL_REASON_PREFIX);
  });
});
