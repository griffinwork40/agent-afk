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
  type ToolEventMin,
} from './done-evidence.js';

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
