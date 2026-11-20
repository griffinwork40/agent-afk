/**
 * Red team 4, item 3: subagent checkpoint git filter guard.
 *
 * Verifies that captureWorkspaceCheckpoint is fail-closed when
 * enumerateFilterDrivers is slow, fails, or the outer deadline fires before
 * enumeration completes.  All tests assert the SAFE behaviour; they pass on the
 * current code (held).
 */
import { describe, it, expect, vi } from 'vitest';
import {
  captureWorkspaceCheckpoint,
  captureCheckpointWithin,
  type CheckpointEnumDrivers,
  type CheckpointGitExec,
} from '../../agent/subagent/continuation-guards.js';
import type { FilterDriverParse } from '../../agent/tools/handlers/git-read.exec-guard.js';

const CWD = '/workspace/session';

/** Fake git exec that always says "yes, inside a git repo". */
const fakeInsideRepo: CheckpointGitExec = async (_cwd, args) => {
  const joined = args.join(' ');
  if (joined.includes('--is-inside-work-tree')) return { ok: true, stdout: 'true\n' };
  if (joined.includes('--abbrev-ref')) return { ok: true, stdout: 'main\n' };
  if (joined.includes('rev-parse') && !joined.includes('--abbrev-ref') && !joined.includes('--is-inside')) return { ok: true, stdout: 'abc123def0\n' };
  if (joined.includes('--porcelain=v1')) return { ok: true, stdout: '' };
  return { ok: true, stdout: '' };
};

/** Fake enum that returns a parse error (simulates corrupt driver list). */
const enumFailsWithError: CheckpointEnumDrivers = async () =>
  ({ ok: false, error: 'git config parse error' });

/** Fake enum that times out (never resolves until AbortSignal fires). */
const enumTimesOut: CheckpointEnumDrivers = (_globalArgs, _cwd, _env, signal): Promise<FilterDriverParse> =>
  new Promise((_resolve, _reject) => {
    // Hangs until AbortSignal fires or the promise is abandoned.
    // In the production code the ENUM_TIMEOUT_MS on execFileCallback would
    // fire; here we simulate it by never resolving.
    signal.addEventListener('abort', () => {
      // Even if aborted we do not resolve — simulates a truly stuck process
      // whose pipe stays open past kill. The checkpoint deadline handles it.
    });
  });

/** Fake enum that returns no drivers (happy path). */
const enumNoDrivers: CheckpointEnumDrivers = async () =>
  ({ ok: true, names: [] });

describe('redteam4 item 3: checkpoint filter guard (all should PASS = held)', () => {
  it('returns unavailable when enumerateFilterDrivers returns ok:false (error)', async () => {
    const checkpoint = await captureWorkspaceCheckpoint(CWD, fakeInsideRepo, enumFailsWithError);
    expect(checkpoint.unavailable).toBe(true);
    // git status must NOT have been called — if the checkpoint is unavailable
    // the status call never ran, which is what we're verifying.
  });

  it('git status is never called when enumeration fails', async () => {
    const statusCalled = vi.fn();
    const fakeExec: CheckpointGitExec = async (_cwd, args) => {
      const joined = args.join(' ');
      if (joined.includes('--is-inside-work-tree')) return { ok: true, stdout: 'true\n' };
      if (joined.includes('--porcelain=v1')) {
        statusCalled();
        return { ok: true, stdout: '' };
      }
      return { ok: true, stdout: '' };
    };
    await captureWorkspaceCheckpoint(CWD, fakeExec, enumFailsWithError);
    expect(statusCalled).not.toHaveBeenCalled();
  });

  it('outer deadline makes checkpoint unavailable even when enumeration hangs', async () => {
    // Use a very short deadline (10 ms) so the test does not hang.
    const checkpoint = await captureCheckpointWithin(
      CWD,
      (cwd) => captureWorkspaceCheckpoint(cwd, fakeInsideRepo, enumTimesOut),
      10, // 10 ms deadline
    );
    expect(checkpoint.unavailable).toBe(true);
  });

  it('healthy path (no drivers) returns a usable checkpoint, not unavailable', async () => {
    const checkpoint = await captureWorkspaceCheckpoint(CWD, fakeInsideRepo, enumNoDrivers);
    // Should not be unavailable — the happy path produces branch/head/dirty data.
    expect(checkpoint.unavailable).toBeUndefined();
    expect(checkpoint.git).toBe(true);
  });
});
