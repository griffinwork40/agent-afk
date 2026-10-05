/**
 * Tests for deadLetterHandoffFile unlink-fallback branches.
 *
 * Lives in its own file because vi.mock('node:fs/promises', ...) is hoisted to
 * module scope and replaces the module for the entire import graph. Isolating
 * here prevents the mock from contaminating handoff-consume.test.ts.
 *
 * Covered branches (mirrors queue-store-poison-fallback.test.ts pattern):
 *   Branch 1: both rename attempts throw -> falls back to unlink so the sweep
 *     unblocks instead of re-processing the file every ~30s tick.
 *   Branch 2: rename AND unlink both throw -> deadLetterHandoffFile still does
 *     NOT rethrow; the entry is left in place and retried on the next sweep.
 *
 * @module agent/daemon/handoff-consume.dead-letter-fallback.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as realFs from 'node:fs';
import { writeFile as realWriteFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mock strategy:
//
//   Replace `rename` and `unlink` from node:fs/promises with controlled fakes;
//   delegate everything else (mkdir, readFile, etc.) to the real implementation.
//   Module-scoped flags arm specific branches per test.
// ---------------------------------------------------------------------------

let renameShouldThrow = false;
let unlinkShouldThrow = false;

vi.mock('node:fs/promises', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...original,
    rename: async (...args: Parameters<typeof original.rename>): Promise<void> => {
      if (renameShouldThrow) {
        const err = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      return original.rename(...args);
    },
    unlink: async (...args: Parameters<typeof original.unlink>): Promise<void> => {
      if (unlinkShouldThrow) {
        const err = new Error('EACCES: permission denied, unlink') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      return original.unlink(...args);
    },
  };
});

// Import AFTER vi.mock (hoisting ensures the mock is in place).
import { deadLetterHandoffFile } from './handoff-consume.dead-letter.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  renameShouldThrow = false;
  unlinkShouldThrow = false;
  tmpDir = realFs.mkdtempSync(join(tmpdir(), 'afk-deadletter-fallback-test-'));
});

afterEach(() => {
  renameShouldThrow = false;
  unlinkShouldThrow = false;
  realFs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('deadLetterHandoffFile - unlink fallback (branch 1: rename fails, unlink succeeds)', () => {
  it('unlinks the file when both rename attempts fail', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const srcFile = join(tmpDir, 'malformed.json');
    await realWriteFile(srcFile, 'bad-json');

    renameShouldThrow = true;

    await deadLetterHandoffFile(tmpDir, srcFile, 'malformed.json', 'test reason');

    // The source file must have been unlinked (not left in place).
    expect(realFs.existsSync(srcFile)).toBe(false);

    // Log must mention "removing to unblock sweep".
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('removing to unblock sweep'),
    );

    errorSpy.mockRestore();
  });
});

describe('deadLetterHandoffFile - stuck entry (branch 2: rename AND unlink fail)', () => {
  it('does not throw when both rename and unlink fail', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const srcFile = join(tmpDir, 'stuck.json');
    await realWriteFile(srcFile, 'bad-json');

    renameShouldThrow = true;
    unlinkShouldThrow = true;

    // Must complete without propagating any error.
    await expect(
      deadLetterHandoffFile(tmpDir, srcFile, 'stuck.json', 'test reason'),
    ).resolves.toBeUndefined();

    // Log must mention "could not remove unquarantinable".
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('could not remove unquarantinable'),
    );

    errorSpy.mockRestore();
  });

  it('leaves the file in place for retry when unlink also fails', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const srcFile = join(tmpDir, 'stuck.json');
    await realWriteFile(srcFile, 'bad-json');

    renameShouldThrow = true;
    unlinkShouldThrow = true;

    await deadLetterHandoffFile(tmpDir, srcFile, 'stuck.json', 'test reason');

    // File must still exist (neither rename nor unlink succeeded).
    expect(realFs.existsSync(srcFile)).toBe(true);

    errorSpy.mockRestore();
  });
});
