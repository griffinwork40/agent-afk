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
  it.fails(
    'should return "unverified" when bash mutates the file after the test passed [DEFECT: bash writes excluded from lastMutationIndex]',
    () => {
      const events: ToolEventMin[] = [
        { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
        { toolName: 'bash', input: 'pnpm test src/foo.test.ts', isError: false },
        // Agent runs a bash command that writes to the file AFTER tests passed.
        // bash is excluded from CODE_MUTATION_TOOLS so classifyDoneEvidence
        // cannot see this mutation.
        { toolName: 'bash', input: 'sed -i "s/foo/bar/g" src/foo.ts', isError: false },
      ];
      // Desired: 'unverified' — the post-test bash write invalidates the earlier pass
      expect(classifyDoneEvidence(events)).toBe('unverified');
    },
  );

  it(
    'current behaviour (status-quo pin): returns "verified" when bash mutates file after test [bash excluded from mutation tracking]',
    () => {
      const events: ToolEventMin[] = [
        { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
        { toolName: 'bash', input: 'pnpm test src/foo.test.ts', isError: false },
        { toolName: 'bash', input: 'sed -i "s/foo/bar/g" src/foo.ts', isError: false },
      ];
      // DEFECT: returns 'verified' because bash is not in CODE_MUTATION_TOOLS;
      // the pnpm-test still appears to be the last "relevant" event after the
      // edit_file mutation. This test flips to a failure when the defect is fixed.
      expect(classifyDoneEvidence(events)).toBe('verified');
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
  it.fails(
    'should return false when bash mutates artifact after test passed [DEFECT: bash writes excluded from mutation tracking]',
    () => {
      const events: ToolEventMin[] = [
        { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
        { toolName: 'bash', input: 'pnpm test', isError: false },
        { toolName: 'bash', input: 'echo "// extra" >> src/foo.ts', isError: false },
      ];
      // Desired: false — post-test bash mutation means the test no longer certifies the artifact
      expect(doneHasCorroboratingEvidence(events)).toBe(false);
    },
  );

  it('current behaviour (status-quo pin): returns true when bash writes after test [bash not tracked as mutation]', () => {
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
      { toolName: 'bash', input: 'echo "// extra" >> src/foo.ts', isError: false },
    ];
    // DEFECT: returns true because bash post-test write is invisible to the classifier.
    expect(doneHasCorroboratingEvidence(events)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// lfVerification — same gap at the outcomes layer
//
// lfVerification uses WRITE_TOOLS = {write_file, edit_file, patch_apply}
// (lf-immediate.ts:38-41). A bash write after lastWriteIdx is not detected.
// ---------------------------------------------------------------------------

describe('lfVerification – bash write after passing test (Scenario 4)', () => {
  it.fails(
    'should return vote -1 (unverified) when bash mutates file after verification command [DEFECT: bash excluded from WRITE_TOOLS]',
    () => {
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
          // Agent then writes a bash command that mutates the artifact on disk.
          // WRITE_TOOLS does not include bash, so lfVerification cannot see this.
          { toolName: 'bash', input: 'printf "export const x = 2;" > src/foo.ts', isError: false },
        ]),
      ];

      const vote = lfVerification(turns, NOW);
      // Desired: vote -1 — the artifact was mutated after the test; the pass is stale
      expect(vote).not.toBeNull();
      expect(vote!.vote).toBe(-1);
    },
  );

  it('current behaviour (status-quo pin): returns vote +1 even when bash modifies artifact after test [WRITE_TOOLS excludes bash]', () => {
    const turns: Turn[] = [
      makeTurn([
        { toolName: 'write_file', input: 'src/foo.ts', isError: false },
        {
          toolName: 'bash',
          input: 'pnpm test',
          isError: false,
          resultTail: '1 passed (1)',
        },
        // Post-test bash write — invisible to lfVerification's lastWriteIdx scan
        { toolName: 'bash', input: 'printf "export const x = 2;" > src/foo.ts', isError: false },
      ]),
    ];

    const vote = lfVerification(turns, NOW);
    // DEFECT: returns +1 ("verified") because the pnpm test resultTail is
    // parsed as a pass and the bash write after it is not tracked.
    expect(vote).not.toBeNull();
    expect(vote!.vote).toBe(1);
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
