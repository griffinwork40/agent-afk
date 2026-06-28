/**
 * Tests for quarantinePoisonEntry fallback branches in queue-store.
 *
 * Lives in its own file because vi.mock('node:fs', ...) is hoisted to module
 * scope and replaces the fs module for the entire module graph of this file.
 * Isolating here prevents the mock from contaminating queue-store.test.ts.
 *
 * Covered branches (issue #253):
 *   Branch 1 (outer-catch): both renameSync attempts throw → falls back to
 *     unlinkSync so the queue unblocks.
 *   Branch 2 (inner-catch): both renameSync AND unlinkSync throw →
 *     quarantinePoisonEntry still does NOT rethrow; the entry is left in place
 *     and retried on the next tick.
 *
 * @module agent/daemon/queue-store-poison-fallback.test
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as realFs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Mock strategy:
//
//   We replace `renameSync` and `unlinkSync` with controlled fakes while
//   delegating everything else (mkdirSync, readdirSync, readFileSync,
//   writeFileSync, mkdtempSync, rmSync, …) to the real implementation so
//   that test setup/teardown and assertions against real disk state work.
//
//   `renameSyncShouldThrow` and `unlinkSyncShouldThrow` are module-scoped
//   flags that individual tests flip on/off to arm specific branches.
//   Flags are reset to false in beforeEach so tests are independent.
//
//   vi.mock is hoisted above imports by vitest so the mock is in place when
//   queue-store.ts is first imported.
// ---------------------------------------------------------------------------

let renameSyncShouldThrow = false;
let unlinkSyncShouldThrow = false;

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    renameSync: (...args: Parameters<typeof original.renameSync>): void => {
      if (renameSyncShouldThrow) {
        const err = new Error('EPERM: operation not permitted, rename') as NodeJS.ErrnoException;
        err.code = 'EPERM';
        throw err;
      }
      original.renameSync(...args);
    },
    unlinkSync: (...args: Parameters<typeof original.unlinkSync>): void => {
      if (unlinkSyncShouldThrow) {
        const err = new Error('EACCES: permission denied, unlink') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        throw err;
      }
      original.unlinkSync(...args);
    },
  };
});

// Import AFTER vi.mock is registered (hoisting ensures this executes first).
import { dequeueNext } from './queue-store.js';

// ---------------------------------------------------------------------------
// Fixtures — use realFs for setup/teardown to bypass the rename/unlink mock
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  renameSyncShouldThrow = false;
  unlinkSyncShouldThrow = false;
  tmpDir = realFs.mkdtempSync(join(tmpdir(), 'afk-queue-fallback-test-'));
});

afterEach(() => {
  renameSyncShouldThrow = false;
  unlinkSyncShouldThrow = false;
  realFs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('quarantinePoisonEntry — outer-catch fallback (branch 1: both renames fail)', () => {
  it('unlinks the entry and unblocks the queue when both renameSync calls throw', () => {
    // Arm: all renameSync calls throw EPERM (simulating a permission error that
    // blocks every rename attempt, including the timestamp-suffixed retry).
    renameSyncShouldThrow = true;

    // Write a malformed entry followed by a valid task.
    realFs.writeFileSync(join(tmpDir, '0001-q-poison.json'), 'not-json');
    realFs.writeFileSync(join(tmpDir, '0002-q-valid.json'), JSON.stringify({
      id: 'q-1-valid',
      command: 'echo hi',
      enqueuedAt: new Date().toISOString(),
      sequence: 2,
    }));

    // dequeueNext must not throw even though rename fails.
    // quarantinePoisonEntry falls back to unlinkSync (which succeeds — only
    // renameSync is mocked to throw), removes the poison entry, then continues
    // the loop and returns the valid task — all in a single call.
    const result = dequeueNext(tmpDir);

    // The valid task behind the poison entry was reached — queue unblocked.
    expect(result).not.toBeNull();
    expect(result!.command).toBe('echo hi');

    // The FIFO path is now clear: both entries were consumed on the single call.
    const remaining = realFs.readdirSync(tmpDir).filter(
      (f) => f.endsWith('.json') && !f.startsWith('.tmp-'),
    );
    expect(remaining).toHaveLength(0);
  });

  it('does not throw even when both renames fail (outer-catch is never-throw)', () => {
    renameSyncShouldThrow = true;

    realFs.writeFileSync(join(tmpDir, '0001-q-poison.json'), 'garbage');

    // Must complete without propagating the rename error.
    expect(() => dequeueNext(tmpDir)).not.toThrow();
  });
});

describe('quarantinePoisonEntry — inner-catch (branch 2: rename AND unlink fail)', () => {
  it('does not throw when both renameSync and unlinkSync fail', () => {
    // Arm: every rename AND unlink throws — the "unremovable entry" scenario.
    renameSyncShouldThrow = true;
    unlinkSyncShouldThrow = true;

    realFs.writeFileSync(join(tmpDir, '0001-q-stuck.json'), 'bad-json');

    // quarantinePoisonEntry must swallow the unlinkSync error too — never rethrows.
    expect(() => dequeueNext(tmpDir)).not.toThrow();
  });

  it('leaves the entry in place (for retry on next tick) when unlink also fails', () => {
    renameSyncShouldThrow = true;
    unlinkSyncShouldThrow = true;

    const poisonFile = '0001-q-stuck.json';
    realFs.writeFileSync(join(tmpDir, poisonFile), 'bad-json');

    dequeueNext(tmpDir);

    // The entry could not be moved or removed — it stays in the queue dir.
    // dequeueNext's loop still exits (did not deadlock), but the file remains
    // for the next tick to retry.
    const entries = realFs.readdirSync(tmpDir).filter(
      (f) => f.endsWith('.json') && !f.startsWith('.tmp-'),
    );
    expect(entries).toContain(poisonFile);
  });

  it('returns null (not a crash) when every entry is stuck', () => {
    renameSyncShouldThrow = true;
    unlinkSyncShouldThrow = true;

    realFs.writeFileSync(join(tmpDir, '0001-q-stuck.json'), 'garbage');

    // dequeueNext returns null — the stuck entry is logged and skipped for
    // this tick, and the loop terminates cleanly.
    const result = dequeueNext(tmpDir);
    expect(result).toBeNull();
  });
});
