/**
 * Tests for the `isExecError` type guard in worktree.errors.ts.
 *
 * The guard must return `true` only for Error instances that carry at least one
 * of the `stderr` / `stdout` properties (the shape produced by Node's
 * promisified `child_process.execFile` on failure).  A plain `Error` with
 * neither property must return `false` so callers fall through to their
 * `String(err)` fallback and still surface the message.
 */

import { describe, it, expect } from 'vitest';
import { isExecError } from './worktree.errors.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeExecError(stderr?: string, stdout?: string): Error & { stderr?: string; stdout?: string } {
  const err = new Error('command failed');
  if (stderr !== undefined) (err as Record<string, unknown>)['stderr'] = stderr;
  if (stdout !== undefined) (err as Record<string, unknown>)['stdout'] = stdout;
  return err;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('isExecError', () => {
  it('returns false for a plain Error with no stderr/stdout properties', () => {
    expect(isExecError(new Error('something went wrong'))).toBe(false);
  });

  it('returns true for an Error with a stderr property', () => {
    expect(isExecError(makeExecError('fatal: not a git repo', undefined))).toBe(true);
  });

  it('returns true for an Error with a stdout property', () => {
    expect(isExecError(makeExecError(undefined, 'some output'))).toBe(true);
  });

  it('returns true for an Error with both stderr and stdout', () => {
    expect(isExecError(makeExecError('err output', 'std output'))).toBe(true);
  });

  it('returns true for an Error with an empty-string stderr (property is present but empty)', () => {
    expect(isExecError(makeExecError(''))).toBe(true);
  });

  it('returns false for non-Error values', () => {
    expect(isExecError(null)).toBe(false);
    expect(isExecError(undefined)).toBe(false);
    expect(isExecError('string error')).toBe(false);
    expect(isExecError(42)).toBe(false);
    expect(isExecError({ message: 'looks like an error', stderr: 'oops' })).toBe(false);
  });

  it('narrows the type so TypeScript allows stderr/stdout access after the guard', () => {
    // Compile-time type-narrowing check (exercised at runtime for coverage).
    const err = makeExecError('git: not found');
    if (isExecError(err)) {
      // If the guard did not narrow the type, accessing .stderr would be a TS
      // error and this test would not compile.
      expect(typeof err.stderr === 'string' || err.stderr === undefined).toBe(true);
    } else {
      // Should not reach here for this input.
      expect.fail('expected isExecError to return true');
    }
  });
});
