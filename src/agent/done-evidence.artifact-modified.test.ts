/**
 * Scenario 4 (#3714): The artifact changes after its tests passed.
 *
 * The question: when a file is edited, tests pass, then the file is modified
 * again through a bash command (sed -i, git apply, write redirect, etc.),
 * does the earlier passing test still certify the artifact?
 *
 * Expected behaviour: NO — `classifyDoneEvidence` must return `'unverified'`
 * when any mutating bash command follows the last successful verification,
 * because the test result no longer covers the current content of the file.
 *
 * The mechanism: `classifyDoneEvidence` tracks `lastMutationIndex` and
 * `lastVerificationIndex` by position in the event stream.  A mutating bash
 * command (detected via `classifyBashCommand`) advances `lastMutationIndex`,
 * so if it lands after the verification, `lastVerificationIndex <=
 * lastMutationIndex` and the function returns `'unverified'`.
 *
 * These tests pin that behaviour so a future refactor cannot silently drop the
 * bash-mutation guard and let a stale test pass certify a modified artifact.
 *
 * Note: `classifyDoneEvidence` operates on the ordered tool-event stream; it
 * has no content hash or on-disk read — the hash gap is tracked separately.
 * These tests cover the ordering guarantee only.
 *
 * Refs #3714
 */

import { describe, it, expect } from 'vitest';
import {
  classifyDoneEvidence,
  doneHasCorroboratingEvidence,
  type ToolEventMin,
} from './done-evidence.js';

// ---------------------------------------------------------------------------
// Scenario 4 – artifact modified via bash after tests passed
// ---------------------------------------------------------------------------

describe('classifyDoneEvidence – artifact modified after tests passed (Scenario 4 / #3714)', () => {
  // ── core case: sed -i after passing test ─────────────────────────────────

  it('returns "unverified" when sed -i follows a passing pnpm test', () => {
    // edit_file → pnpm test (PASS) → sed -i (mutating bash)
    // The sed -i invalidates the earlier test result.
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
      { toolName: 'bash', input: 'sed -i "s/old/new/g" src/foo.ts', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('unverified');
  });

  it('returns "unverified" when write_file is used after a passing test', () => {
    // edit_file → pnpm test (PASS) → write_file (file content replaced)
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/bar.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
      { toolName: 'write_file', input: 'src/bar.ts', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('unverified');
  });

  it('returns "unverified" when edit_file is applied after a passing test', () => {
    // Sequence: edit → test passes → another edit_file (stale certification)
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
      { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('unverified');
  });

  it('returns "unverified" when write_file is the initial mutation and edit_file follows a passing test', () => {
    // Exercises write_file in the initial-mutation position (CODE_MUTATION_TOOLS branch).
    // Sequence: write_file → test passes → edit_file (stale certification)
    const events: ToolEventMin[] = [
      { toolName: 'write_file', input: 'src/foo.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
      { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('unverified');
  });

  it('returns "unverified" when patch_apply is used after a passing test', () => {
    // Regression test for the defect fixed in #3714 (scenario 4):
    // `patch_apply` was absent from CODE_MUTATION_TOOLS so a patch applied
    // after tests passed was not detected as a mutation — the earlier test
    // result incorrectly certified the artifact.
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/qux.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
      { toolName: 'patch_apply', input: '', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('unverified');
  });

  it('returns "verified" when a test pass follows patch_apply', () => {
    // patch_apply → pnpm test: corroboration restored by the subsequent test.
    const events: ToolEventMin[] = [
      { toolName: 'patch_apply', input: '', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('verified');
  });

  it('returns "no-code-changes" for patch_apply with dry_run: true (no mutation)', () => {
    // dry_run writes nothing — must not count as a mutation or as evidence.
    const dryRunRaw = JSON.stringify({ dry_run: true });
    const events: ToolEventMin[] = [
      { toolName: 'patch_apply', input: '', inputRaw: dryRunRaw, isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('no-code-changes');
  });

  it('doneHasCorroboratingEvidence returns false for dry_run patch_apply only', () => {
    // A turn consisting solely of a dry-run patch_apply has no real evidence.
    const dryRunRaw = JSON.stringify({ dry_run: true });
    const events: ToolEventMin[] = [
      { toolName: 'patch_apply', input: '', inputRaw: dryRunRaw, isError: false },
    ];
    expect(doneHasCorroboratingEvidence(events)).toBe(false);
  });

  it('returns "no-code-changes" for patch_apply with empty changes[] (no file written)', () => {
    // changes: [] — the handler returns synthetic 'applied' success but writes
    // nothing.  Must not count as a mutation or as done-evidence (#5257 item 2).
    const emptyRaw = JSON.stringify({ changes: [] });
    const events: ToolEventMin[] = [
      { toolName: 'patch_apply', input: '', inputRaw: emptyRaw, isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('no-code-changes');
  });

  it('doneHasCorroboratingEvidence returns false for empty-changes patch_apply only', () => {
    // A turn consisting solely of a patch_apply with no changes has no real evidence.
    const emptyRaw = JSON.stringify({ changes: [] });
    const events: ToolEventMin[] = [
      { toolName: 'patch_apply', input: '', inputRaw: emptyRaw, isError: false },
    ];
    expect(doneHasCorroboratingEvidence(events)).toBe(false);
  });

  it('returns "verified" when dry_run:false patch_apply with real changes follows a passing test (not empty)', () => {
    // Confirm that a non-empty, non-dry-run patch_apply still counts as a mutation
    // and that a subsequent test restores 'verified'.
    const realRaw = JSON.stringify({ changes: [{ path: 'src/foo.ts' }] });
    const events: ToolEventMin[] = [
      { toolName: 'patch_apply', input: '', inputRaw: realRaw, isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('verified');
  });

  it('returns "unverified" when patch_apply (real write) follows test in an edit→test→patch→retest sequence', () => {
    // edit → test (PASS) → patch_apply → (no retest): stale certification.
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
      { toolName: 'patch_apply', input: '', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('unverified');
  });

  it('returns "verified" for edit→test→patch_apply→retest sequence', () => {
    // edit → test (PASS) → patch_apply → test (PASS again): correctly certified.
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
      { toolName: 'patch_apply', input: '', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('verified');
  });

  it('returns "verified" when dry_run patch_apply follows a passing test (not a mutation)', () => {
    // A dry-run preview after a passing test must NOT invalidate the certification.
    const dryRunRaw = JSON.stringify({ dry_run: true });
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
      { toolName: 'patch_apply', input: '', inputRaw: dryRunRaw, isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('verified');
  });

  it('returns "verified" when FAILED patch_apply does not advance mutation index', () => {
    // isError: true — the patch did not apply, so the artifact is unchanged.
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
      { toolName: 'patch_apply', input: '', isError: true },
    ];
    // The failed patch_apply is skipped; last mutation was edit_file (index 0),
    // last verification was pnpm test (index 1) — so still verified.
    expect(classifyDoneEvidence(events)).toBe('verified');
  });

  it('returns "unverified" when a bash output-redirect follows a passing test', () => {
    // `echo "new content" > src/foo.ts` must invalidate the earlier verification.
    // Detection path: classifyBashCommand(e.input).mutating via Pass 3 REAL_REDIRECT
    // (shell write-redirect operator), not via isVerificationCommand.
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
      { toolName: 'bash', input: 'echo "new content" > src/foo.ts', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('unverified');
  });

  it('returns "unverified" when git apply follows a passing test', () => {
    // git apply patches files on disk — a mutating bash command.
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
      { toolName: 'bash', input: 'git apply fix.patch', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('unverified');
  });

  // ── contrast: a second passing test after the mutation restores certification ─

  it('returns "verified" when a second test pass follows the bash mutation', () => {
    // edit → test (PASS) → sed -i → test (PASS again) — correctly certified.
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
      { toolName: 'bash', input: 'sed -i "s/old/new/g" src/foo.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('verified');
  });

  // ── contrast: read-only bash after passing test must not invalidate ───────

  it('returns "verified" when only a read-only bash follows the passing test', () => {
    // grep, cat, git status — none of these mutate the artifact.
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
      { toolName: 'bash', input: 'grep -n "new" src/foo.ts', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('verified');
  });

  it('returns "verified" when git status follows the passing test', () => {
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
      { toolName: 'bash', input: 'git status', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('verified');
  });

  // ── failed mutating bash must not advance mutation index ─────────────────

  it('returns "verified" when a FAILED sed -i follows the passing test', () => {
    // isError:true — the mutation did not execute, so the artifact is unchanged.
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
      { toolName: 'bash', input: 'sed -i "s/old/new/g" src/foo.ts', isError: true },
    ];
    expect(classifyDoneEvidence(events)).toBe('verified');
  });

  // ── baseline: the normal edit → test path still works ────────────────────

  it('returns "verified" for the baseline edit → pnpm test sequence', () => {
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('verified');
  });

  it('returns "unverified" for edit with no subsequent test', () => {
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('unverified');
  });
});
