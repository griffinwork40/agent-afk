/**
 * Tests for the ripgrep-binary availability check ({@link describeRgUnavailable}).
 *
 * Covers the failure mode this module exists to catch: a misresolved or
 * missing `rgPath` (e.g. a platform optional-dependency that didn't install,
 * or a corrupted `node_modules`) surfaces from `spawn()` as a bare
 * `spawn <path> ENOENT` — indistinguishable, by error shape alone, from the
 * dead-cwd masquerade `describeSpawnCwdError` already handles (#441). This
 * helper is checked FIRST in the grep handler's `error` listener so a bad
 * `rgPath` is diagnosed as "ripgrep binary is missing/not executable", never
 * misattributed to a deleted worktree.
 */

import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, chmodSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describeRgUnavailable } from './_rg-availability.js';
import { describeSpawnCwdError } from '../../../utils/spawn-cwd-error.js';

describe('describeRgUnavailable', () => {
  it('returns undefined for a real, executable file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rg-availability-test-'));
    try {
      const fakeRg = join(dir, 'rg');
      writeFileSync(fakeRg, '#!/bin/sh\necho hi\n');
      chmodSync(fakeRg, 0o755);
      expect(describeRgUnavailable(fakeRg)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns a message mentioning "ripgrep binary" (not "deleted worktree") for a nonexistent path', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rg-availability-test-'));
    rmSync(dir, { recursive: true, force: true }); // the dir (and any path under it) is now gone
    const missingRgPath = join(dir, 'rg');

    const message = describeRgUnavailable(missingRgPath);

    expect(message).toBeDefined();
    expect(message).toContain('ripgrep binary');
    expect(message).not.toContain('deleted worktree');
  });

  // chmod 0o000 does not reliably deny X_OK on Windows (no POSIX permission
  // bits), so this case is skipped there — parity with the existing
  // list-directory permission-denied test.
  it.skipIf(process.platform === 'win32')(
    'returns a message for an existing-but-non-executable file',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'rg-availability-test-'));
      try {
        const nonExecRg = join(dir, 'rg');
        writeFileSync(nonExecRg, 'not actually a binary');
        chmodSync(nonExecRg, 0o000);

        const message = describeRgUnavailable(nonExecRg);

        expect(message).toBeDefined();
        expect(message).toContain('ripgrep binary');
      } finally {
        chmodSync(join(dir, 'rg'), 0o755); // restore so rmSync can clean up
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('produces a message textually distinguishable from describeSpawnCwdError (the two failure modes must never collide)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rg-availability-test-'));
    rmSync(dir, { recursive: true, force: true });
    const missingRgPath = join(dir, 'rg');

    const rgMessage = describeRgUnavailable(missingRgPath) ?? '';

    // The dead-cwd path names a deleted directory as a "working directory"
    // and mentions "deleted worktree?" — the rg-unavailable path must not.
    const cwdErr = new Error(`spawn ${missingRgPath} ENOENT`) as Error & {
      code: string;
      syscall: string;
    };
    cwdErr.code = 'ENOENT';
    cwdErr.syscall = `spawn ${missingRgPath}`;
    const cwdMessage = describeSpawnCwdError(cwdErr, dir);

    expect(rgMessage).not.toContain('working directory does not exist');
    expect(rgMessage).not.toContain('deleted worktree');
    expect(cwdMessage).not.toContain('ripgrep binary');
    expect(rgMessage).not.toBe(cwdMessage);
  });
});
