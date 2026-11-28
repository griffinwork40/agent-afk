/**
 * Regression tests for done-evidence.ts classification functions.
 *
 * Covers the evidence-classification fix in PR "feat(hooks): fire Stop on every
 * top-level surface from the session layer":
 *   - edit_file then `pnpm test` → 'verified'
 *   - edit_file only → 'unverified'
 *   - no mutations → 'no-code-changes'
 *   - a FAILED test command does not count as verification
 *
 * @module agent/done-evidence.test
 */
import { describe, it, expect } from 'vitest';
import {
  classifyDoneEvidence,
  doneHasCorroboratingEvidence,
  isVerificationCommand,
  type ToolEventMin,
} from './done-evidence.js';
import { classifyBashCommand } from './tools/readonly-bash.js';

// ---------------------------------------------------------------------------
// classifyDoneEvidence
// ---------------------------------------------------------------------------

describe('classifyDoneEvidence', () => {
  it('returns "no-code-changes" when no mutation tools fired', () => {
    const events: ToolEventMin[] = [
      { toolName: 'read_file', input: 'src/foo.ts', isError: false },
      { toolName: 'bash', input: 'echo hi', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('no-code-changes');
  });

  it('returns "verified" when edit_file is followed by pnpm test', () => {
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: '', isError: false },
      { toolName: 'bash', input: 'pnpm test src/agent/done-evidence.test.ts', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('verified');
  });

  it('returns "unverified" when edit_file has NO subsequent verification', () => {
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: '', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('unverified');
  });

  it('returns "unverified" when edit_file follows the verification bash command', () => {
    // Verification BEFORE mutation → stale, not verified.
    const events: ToolEventMin[] = [
      { toolName: 'bash', input: 'pnpm test', isError: false },
      { toolName: 'edit_file', input: '', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('unverified');
  });

  it('returns "no-code-changes" when the mutation tool errored', () => {
    // An errored write_file does not count as a code mutation.
    const events: ToolEventMin[] = [
      { toolName: 'write_file', input: '', isError: true },
      { toolName: 'bash', input: 'pnpm test', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('no-code-changes');
  });

  it('returns "unverified" when the bash verification command errored (failed test)', () => {
    // A FAILED test run does NOT count as verification — isError: true is skipped.
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: '', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: true },
    ];
    expect(classifyDoneEvidence(events)).toBe('unverified');
  });

  it('returns "verified" for write_file followed by cargo test', () => {
    const events: ToolEventMin[] = [
      { toolName: 'write_file', input: 'src/lib.rs', isError: false },
      { toolName: 'bash', input: 'cargo test', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('verified');
  });

  it('returns "verified" when pnpm exec tsc runs after an edit', () => {
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: '', isError: false },
      { toolName: 'bash', input: 'pnpm exec tsc --noEmit', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('verified');
  });

  it('returns "no-code-changes" for an empty event list', () => {
    expect(classifyDoneEvidence([])).toBe('no-code-changes');
  });

  // Regression: #3822 — a bash command that matches isVerificationCommand AND
  // is mutating (redirect / tee) must advance lastMutationIndex so a subsequent
  // write invalidates the earlier verification.  The else-if short-circuit meant
  // isVerificationCommand won and lastMutationIndex was never updated.
  it('#3822: "pnpm test > results.txt" is both a verification command and a write — lastMutationIndex must advance', () => {
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
      // pnpm test prefix matches isVerificationCommand; > results.txt is also a write.
      // classifyBashCommand marks this mutating (output redirection to a real path).
      { toolName: 'bash', input: 'pnpm test > results.txt', isError: false },
    ];
    // The test did NOT run cleanly against a clean file — it also wrote results.txt.
    // The write must advance lastMutationIndex so no later clean verification exists.
    expect(classifyDoneEvidence(events)).toBe('unverified');
  });

  it('#3822: "pnpm test 2>&1 | tee test-log.txt" — tee write after test must be unverified', () => {
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test 2>&1 | tee test-log.txt', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('unverified');
  });

  // F2: verify that test-path args containing FS-verb substrings (rm, mv) do
  // NOT trigger false 'unverified' classification — the narrow SHELL_WRITE_OPERATOR
  // check must not match word-boundary tokens inside path components.
  it('edit_file then pnpm test src/rm.test.ts → verified (path arg must not trigger false mutation)', () => {
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/agent/done-evidence.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test src/rm.test.ts', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('verified');
  });

  it('edit_file then vitest src/mv-files.test.ts → verified (path arg must not trigger false mutation)', () => {
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/agent/done-evidence.ts', isError: false },
      { toolName: 'bash', input: 'vitest src/mv-files.test.ts', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('verified');
  });

  it('#3822: read-only bash (grep, cat, git status) after edit+test must remain verified', () => {
    // False-positive guard: read-only commands must not be treated as mutations.
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: 'src/foo.ts', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
      { toolName: 'bash', input: 'grep -r foo src/', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('verified');
  });
});

// ---------------------------------------------------------------------------
// isVerificationCommand — Cause 1 (#5408): prefixed / compound commands
// ---------------------------------------------------------------------------

describe('isVerificationCommand — prefixed commands (#5408 Cause 1)', () => {
  it.each([
    ['pnpm lint', true],
    ['cd /home/me/project && pnpm lint', true],
    ['(pnpm lint 2>&1 | tail -n 12)', true],
    ['CI=1 pnpm test', true],
    ['time pnpm test', true],
    ['cd website && pnpm build', true],
    ['ls -la', false],
    ['cd /repo && git status', false],
    ['echo done', false],
  ])('%s -> %s', (cmd, expected) => {
    expect(isVerificationCommand(cmd)).toBe(expected);
  });
});

// ---------------------------------------------------------------------------
// classifyDoneEvidence — Cause 2 (#5408): pre-classified booleans bypass truncation
// ---------------------------------------------------------------------------

describe('classifyDoneEvidence — pre-classified booleans bypass truncation (#5408 Cause 2)', () => {
  it('isVerificationBash:true counts as verification even when input is truncated/garbled', () => {
    // Simulate a command that was truncated mid-string in the 160-char summary.
    // Without the fix this would not be recognised as verification.
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: '', isError: false },
      {
        toolName: 'bash',
        input: 'some truncated garbage…', // truncated — would not match VERIFICATION_COMMANDS
        isError: false,
        isVerificationBash: true, // pre-classified from full command
        isMutatingBash: false,
      },
    ];
    expect(classifyDoneEvidence(events)).toBe('verified');
  });

  it('isMutatingBash:true counts as mutation even when mutation appears after char 160', () => {
    // Simulate a command whose mutation (e.g. rm -rf build/) appears after char 160.
    // Without the fix classifyBashCommand would see only the truncated prefix and
    // return mutating:false, so the Done would appear verified when it isn\'t.
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: '', isError: false },
      // A command that looks like verification at the front but is mutating overall
      { toolName: 'bash', input: 'pnpm test', isError: false, isMutatingBash: true, isVerificationBash: false },
    ];
    // The pre-classified isMutatingBash:true should advance lastMutationIndex;
    // since isVerificationBash is false, there is no subsequent verification,
    // so the result should be unverified.
    expect(classifyDoneEvidence(events)).toBe('unverified');
  });

  it('falls back to input-string classification when booleans are absent (legacy fixtures)', () => {
    // No isMutatingBash/isVerificationBash: must still work via e.input fallback.
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: '', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
    ];
    expect(classifyDoneEvidence(events)).toBe('verified');
  });
});

// ---------------------------------------------------------------------------
// doneHasCorroboratingEvidence
// ---------------------------------------------------------------------------

describe('doneHasCorroboratingEvidence', () => {
  it('returns false when no evidence tools fired', () => {
    const events: ToolEventMin[] = [
      { toolName: 'read_file', input: '', isError: false },
    ];
    expect(doneHasCorroboratingEvidence(events)).toBe(false);
  });

  it('returns true when edit_file fired and verification followed', () => {
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: '', isError: false },
      { toolName: 'bash', input: 'pnpm test', isError: false },
    ];
    expect(doneHasCorroboratingEvidence(events)).toBe(true);
  });

  it('returns false when edit_file fired but NO verification followed', () => {
    const events: ToolEventMin[] = [
      { toolName: 'edit_file', input: '', isError: false },
    ];
    expect(doneHasCorroboratingEvidence(events)).toBe(false);
  });

  it('returns true when bash (non-verify) fired — general corroboration', () => {
    // A side-effecting bash call (not a test runner) still counts as evidence
    // if there are no code mutations (no 'unverified' path).
    const events: ToolEventMin[] = [
      { toolName: 'bash', input: 'git status', isError: false },
    ];
    expect(doneHasCorroboratingEvidence(events)).toBe(true);
  });

  it('returns false when a failed test command is the only evidence', () => {
    // A FAILED bash call is skipped by isError guard — no corroboration.
    const events: ToolEventMin[] = [
      { toolName: 'bash', input: 'pnpm test', isError: true },
    ];
    expect(doneHasCorroboratingEvidence(events)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Cause 3 (#5408): curl -o /dev/null must NOT be treated as mutating
// ---------------------------------------------------------------------------

describe('classifyBashCommand — curl /dev/null exemption (#5408 Cause 3)', () => {
  it('curl -o /dev/null is NOT mutating', () => {
    expect(classifyBashCommand('curl -o /dev/null https://example.com').mutating).toBe(false);
  });

  it('curl --output /dev/null is NOT mutating', () => {
    expect(classifyBashCommand('curl --output /dev/null https://example.com').mutating).toBe(false);
  });

  it('curl -o /dev/null with timing flags is NOT mutating', () => {
    expect(classifyBashCommand('curl -o /dev/null -w "%{time_total}" https://api.example.com').mutating).toBe(false);
  });

  it('curl -o realfile.json IS still mutating', () => {
    expect(classifyBashCommand('curl -o data.json https://example.com').mutating).toBe(true);
  });

  it('curl -O IS still mutating (saves with remote filename)', () => {
    expect(classifyBashCommand('curl -O https://example.com/file.zip').mutating).toBe(true);
  });
});
