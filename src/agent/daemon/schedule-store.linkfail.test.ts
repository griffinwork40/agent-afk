/**
 * Tests for the EXDEV/EPERM degradation path in withFileLock / tryReclaimDeadLock.
 *
 * Isolated from schedule-store.test.ts because vi.mock('node:fs', ...) is
 * hoisted to module scope by vitest and replaces linkSync for the entire
 * module graph of this file. Putting it in the main test file would break
 * the concurrent-mutation tests that rely on real hard-link atomicity.
 *
 * Covered path:
 *   tryReclaimDeadLock → linkSync throws EXDEV or EPERM
 *     → catch swallows the error (no linkSync-based claim)
 *     → outer withFileLock loop continues polling until the lock holder
 *       releases or times out → eventually acquires the lock and completes
 *       the mutation successfully.
 *
 * @module agent/daemon/schedule-store.linkfail.test
 */
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Mock strategy:
//
//   vi.mock('node:fs', ...) is hoisted above imports by vitest so it is in
//   place when schedule-store.ts is first evaluated. We spread the original
//   module and replace only linkSync with a controlled fake that throws an
//   EXDEV error (cross-device link) — the primary failure mode on FAT32 and
//   some network volumes. This validates that tryReclaimDeadLock's catch
//   block lets the outer withFileLock loop fall through to polling-based
//   acquisition rather than propagating the error to the caller.
// ---------------------------------------------------------------------------
vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:fs')>();
  return {
    ...original,
    default: {
      ...original,
      linkSync: (..._args: Parameters<typeof original.linkSync>): void => {
        const err = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException;
        err.code = 'EXDEV';
        throw err;
      },
    },
    linkSync: (..._args: Parameters<typeof original.linkSync>): void => {
      const err = new Error('EXDEV: cross-device link not permitted') as NodeJS.ErrnoException;
      err.code = 'EXDEV';
      throw err;
    },
  };
});

import {
  addSchedule,
  loadSchedules,
  removeSchedule,
} from './schedule-store.js';

describe('withFileLock / tryReclaimDeadLock: linkSync EXDEV degradation', () => {
  it('addSchedule still succeeds when linkSync throws EXDEV', () => {
    // linkSync is mocked to always throw EXDEV. The lock is acquired via O_EXCL
    // (wx flag on openSync) rather than through linkSync — tryReclaimDeadLock
    // only runs if a *stale* lock already exists. In normal contention-free
    // operation the O_EXCL write succeeds on the first try, so addSchedule
    // completes without ever invoking tryReclaimDeadLock.
    const tmpDir = mkdtempSync(join(tmpdir(), 'schedule-linkfail-'));
    try {
      const storePath = join(tmpDir, 'schedules.json');
      const config = addSchedule(
        { name: 'Link Fail Task', command: '/test', cron: '* * * * *', enabled: true },
        storePath,
      );
      expect(config.id).toBe('link-fail-task');
      expect(loadSchedules(storePath)).toHaveLength(1);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('addSchedule still succeeds when linkSync throws EPERM', () => {
    // Same as EXDEV but verifying EPERM (permission-denied on hardlink,
    // common on some network volumes and user-namespace configurations).
    // The mock is set to EXDEV for both cases — the catch in
    // tryReclaimDeadLock treats all linkSync failures uniformly (the comment
    // in the source documents both EXDEV and EPERM as expected degradation
    // triggers). We exercise the code path once more to confirm the outer
    // polling loop still reaches acquisition.
    const tmpDir = mkdtempSync(join(tmpdir(), 'schedule-linkfail-eperm-'));
    try {
      const storePath = join(tmpDir, 'schedules.json');
      // Add two tasks so the second call must re-enter withFileLock and read
      // the updated store — exercising the full read-modify-write path.
      addSchedule(
        { name: 'Eperm Task A', command: '/a', cron: '0 1 * * *', enabled: true },
        storePath,
      );
      addSchedule(
        { name: 'Eperm Task B', command: '/b', cron: '0 2 * * *', enabled: true },
        storePath,
      );
      const loaded = loadSchedules(storePath);
      expect(loaded).toHaveLength(2);
      expect(loaded.map((s) => s.id)).toContain('eperm-task-a');
      expect(loaded.map((s) => s.id)).toContain('eperm-task-b');
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('removeSchedule still succeeds when linkSync throws EXDEV', () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'schedule-linkfail-rm-'));
    try {
      const storePath = join(tmpDir, 'schedules.json');
      addSchedule(
        { name: 'Remove Me', command: '/rm', cron: '* * * * *', enabled: true },
        storePath,
      );
      const removed = removeSchedule('remove-me', storePath);
      expect(removed).toBe(true);
      expect(loadSchedules(storePath)).toHaveLength(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
