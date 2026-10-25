/**
 * Failure-injection test for #3714 Scenario 4:
 * "The artifact changes after its tests passed."
 *
 * The gap: `classifyDoneEvidence` (done-evidence.ts) treats `bash` as a
 * verification tool but NOT as a code-mutation tool (by design — lf-immediate.ts:317-319
 * explains why). `lfVerification` (lf-immediate.ts) uses WRITE_TOOLS =
 * {write_file, edit_file, patch_apply} to find `lastWriteIdx`; a bare `bash`
 * call that modifies the file on disk is invisible to that scan (lf-immediate.ts:325-343).
 * Neither function records a content hash or SHA of the artifact, so there is
 * no way to detect that the on-disk bytes changed between the test run and the
 * Done claim. The daemon's `isDoneUnverified` check (daemon.action.ts:64-78)
 * only tests whether any DONE_EVIDENCE_TOOLS name appears in
 * `successfulToolNames` — it never re-reads the file to compare content.
 *
 * Scenario under test:
 *   edit_file  →  pnpm test (passes)  →  bash (mutates file on disk)  →  Done
 *
 * With the current classifiers the sequence is "verified" even though the
 * bash write happened AFTER the test. The it.fails cases document the desired
 * behaviour; the it cases document the current (defective) behaviour so the
 * suite stays green and flips naturally when the feature lands.
 *
 * Suite rules: local, deterministic, no model calls, no network, no sleeps.
 *
 * @module agent/outcomes/lf-immediate.artifact-stale.test
 */

import { describe, it, expect } from 'vitest';
import {
  classifyDoneEvidence,
  doneHasCorroboratingEvidence,
  type ToolEventMin,
} from '../done-evidence.js';
import { lfVerification } from './lf-immediate.js';
import type { Turn } from './artifacts.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTurn(events: Turn['toolEvents']): Turn {
  return { toolEvents: events };
}

const NOW = '2026-10-15T00:00:00.000Z';

// ---------------------------------------------------------------------------
// classifyDoneEvidence — bash-write-after-test
//
// The classifier uses CODE_MUTATION_TOOLS = {write_file, edit_file}; bash is
// NOT in that set (done-evidence.ts). So a bash command that modifies a file
// on disk is invisible to `lastMutationIndex`, and the earlier verification
// still "wins".
// ---------------------------------------------------------------------------

describe('classifyDoneEvidence – bash write after passing test (Scenario 4)', () => {
  /**
   * Current behaviour (DEFECT): classified as 'verified' because bash is not
   * tracked as a mutation tool, so the test's position after edit_file is
   * still the last known event order that matters.
   *
   * Desired behaviour: should be 'unverified' — the artifact was mutated via
   * bash AFTER the test passed, so the earlier pass no longer certifies it.
   */
  it(
    'returns "unverified" when bash mutates the file after the test passed',
    () => {
      const events: ToolEventMin[] = [
        { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
        { toolName: 'bash', input: 'pnpm test src/foo.test.ts', isError: false },
        // A bash command that writes to the file AFTER tests passed.
        // classifyBashCommand detects `sed -i` as mutating, so lastMutationIndex
        // advances past the test run and the result is 'unverified'.
        { toolName: 'bash', input: 'sed -i "s/foo/bar/g" src/foo.ts', isError: false },
      ];
      expect(classifyDoneEvidence(events)).toBe('unverified');
    },
  );

  /**
   * Same defect, write_file variant: write_file is properly tracked, so a
   * write_file AFTER the test correctly returns 'unverified'. This establishes
   * that the ordering logic itself works — only bash is missing from it.
   */
  it('returns "unverified" when write_file follows the test (ordering works for tracked tools)', () => {
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test src/foo.test.ts', isError: false },
      { toolName: 'write_file', input: 'src/foo.ts', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('unverified');
  });
});

// ---------------------------------------------------------------------------
// doneHasCorroboratingEvidence — same gap, end-to-end wrapper
// ---------------------------------------------------------------------------

describe('doneHasCorroboratingEvidence – bash write after passing test (Scenario 4)', () => {
  it('returns false when bash mutates artifact after test passed', () => {
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
      // `echo … >>` is an output redirection — classifyBashCommand marks it mutating.
      { toolName: 'bash', input: 'echo "// extra" >> src/foo.ts', isError: false },
    ];
    expect(doneHasCorroboratingEvidence(events)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// lfVerification — same gap at the outcomes layer
//
// lfVerification uses WRITE_TOOLS = {write_file, edit_file, patch_apply}
// (lf-immediate.ts:38-41). A bash write after lastWriteIdx is not detected.
// ---------------------------------------------------------------------------

describe('lfVerification – bash write after passing test (Scenario 4)', () => {
  it('does not return a positive verification when bash mutates file after test', () => {
    const turns: Turn[] = [
      makeTurn([
        { toolName: 'write_file', input: 'src/foo.ts', isError: false },
        // Test passes
        {
          toolName: 'bash',
          input: 'pnpm test',
          isError: false,
          resultTail: '1 passed (1)',
        },
        // Bash output-redirect after the test — classifyBashCommand marks it
        // mutating (output redirection to a real path), so lastWriteIdx advances
        // past the test run. lfVerification finds no verification after the new
        // lastWriteIdx and returns null (no positive vote).
        { toolName: 'bash', input: 'printf "export const x = 2;" > src/foo.ts', isError: false },
      ]),
    ];

    const vote = lfVerification(turns, NOW);
    // #3822 fixed via Option 1: mutating bash advances lastWriteIdx past the
    // test run, so no verification is found after the last write → null.
    expect(vote).toBeNull();
  });

  /**
   * Baseline: write_file after test IS correctly detected as unverified.
   * Confirms the comparison logic works for tracked tools.
   */
  it('returns vote null (no verification found after last write) when write_file follows test', () => {
    // write_file resets lastWriteIdx past the test run, so no verification
    // event is found after it → lfVerification returns null (no vote).
    const turns: Turn[] = [
      makeTurn([
        { toolName: 'write_file', input: 'src/foo.ts', isError: false },
        {
          toolName: 'bash',
          input: 'pnpm test',
          isError: false,
          resultTail: '1 passed (1)',
        },
        // A second write_file AFTER the test — advances lastWriteIdx past test
        { toolName: 'write_file', input: 'src/foo.ts', isError: false },
      ]),
    ];

    const vote = lfVerification(turns, NOW);
    // No verification command found after the final write_file → null
    expect(vote).toBeNull();
  });

  /**
   * No-content-hash gap: even a "clean" edit→test sequence produces a +1
   * vote with no SHA or hash recorded in the vote evidence. Pinning this
   * so the addition of hash-based evidence is detectable.
   */
  it('current behaviour (status-quo pin): vote evidence contains no content hash or SHA [no hash recorded]', () => {
    const turns: Turn[] = [
      makeTurn([
        { toolName: 'write_file', input: 'src/foo.ts', isError: false },
        {
          toolName: 'bash',
          input: 'pnpm test',
          isError: false,
          resultTail: '1 passed (1)',
        },
      ]),
    ];

    const vote = lfVerification(turns, NOW);
    expect(vote).not.toBeNull();
    expect(vote!.vote).toBe(1);
    // DEFECT: no content hash / SHA in evidence — if the file changes after
    // this point via bash, there is no record to detect the staleness.
    expect(vote!.evidence).not.toMatch(/sha|hash|checksum/i);
  });
});
