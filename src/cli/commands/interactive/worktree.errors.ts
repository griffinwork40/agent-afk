/**
 * Shared error type guard for the worktree subsystem.
 *
 * Extracted to eliminate the identical `ExecError` interface + `isExecError`
 * guard that was duplicated across worktree.ts, worktree.cleanup.ts, and
 * worktree.refs.ts (#2963).
 */

// ---------------------------------------------------------------------------
// Canonical ExecError type guard
// ---------------------------------------------------------------------------

export interface ExecError extends Error {
  stderr?: string;
  stdout?: string;
}

export function isExecError(value: unknown): value is ExecError {
  return value instanceof Error;
}
