import { describe, it, expect, beforeEach } from 'vitest';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  leaseTask,
  renewLease,
  completeTask,
  recoverExpiredLeases,
  getTaskRecord,
  listActiveTasks,
} from './lease-store.js';
import { enqueue, dequeueNext } from './queue-store.js';
import type { QueuedTask } from './queue-store.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function tmpQueueDir(): string {
  const dir = join(tmpdir(), `lease-store-test-${randomBytes(6).toString('hex')}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function makeTask(queueDir: string, command = '/test-cmd'): { task: QueuedTask; srcPath: string } {
  // Enqueue and find the file path.
  const task = enqueue(command, {}, queueDir);
  const files = require('node:fs').readdirSync(queueDir).filter(
    (f: string) => f.endsWith('.json') && !f.startsWith('.tmp-') && !f.includes('/'),
  );
  // Find the queue file for this task (before leasing removes it).
  let srcPath = '';
  for (const f of files) {
    const p = join(queueDir, f);
    try {
      const t = JSON.parse(readFileSync(p, 'utf-8')) as QueuedTask;
      if (t.id === task.id) { srcPath = p; break; }
    } catch { /* skip */ }
  }
  return { task, srcPath };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('leaseTask', () => {
  it('moves file from queue to leased/ and writes TaskRecord', () => {
    const queueDir = tmpQueueDir();
    const { task, srcPath } = makeTask(queueDir);
    expect(existsSync(srcPath)).toBe(true);

    const record = leaseTask(task, srcPath, undefined, queueDir);

    expect(existsSync(srcPath)).toBe(false); // queue file removed
    expect(existsSync(join(queueDir, 'leased', `${task.id}.json`))).toBe(true);
    expect(record.id).toBe(task.id);
    expect(record.state).toBe('leased');
    expect(record.attempts).toBe(1);
    expect(record.maxAttempts).toBe(1);
    expect(record.leaseExpiry).toBeGreaterThan(Date.now());
  });

  it('stores the command and meta from the QueuedTask', () => {
    const queueDir = tmpQueueDir();
    const { task, srcPath } = makeTask(queueDir, '/my-command');
    const record = leaseTask(task, srcPath, undefined, queueDir);
    expect(record.command).toBe('/my-command');
    expect(record.meta?.sequence).toBe(task.sequence);
    expect(record.meta?.enqueuedAt).toBe(task.enqueuedAt);
  });

  it('honours custom leaseTtlMs', () => {
    const queueDir = tmpQueueDir();
    const { task, srcPath } = makeTask(queueDir);
    const before = Date.now();
    const record = leaseTask(task, srcPath, 5_000, queueDir);
    const after = Date.now();
    expect(record.leaseExpiry).toBeGreaterThanOrEqual(before + 5_000);
    expect(record.leaseExpiry).toBeLessThanOrEqual(after + 5_000 + 10);
  });
});

describe('renewLease', () => {
  it('updates leaseExpiry in the leased file', () => {
    const queueDir = tmpQueueDir();
    const { task, srcPath } = makeTask(queueDir);
    leaseTask(task, srcPath, 1_000, queueDir); // short TTL

    renewLease(task.id, 60_000, queueDir);

    const record = getTaskRecord(task.id, queueDir)!;
    expect(record.leaseExpiry).toBeGreaterThan(Date.now() + 50_000);
  });

  it('is a no-op when the leased file does not exist', () => {
    const queueDir = tmpQueueDir();
    // Should not throw.
    expect(() => renewLease('nonexistent-id', undefined, queueDir)).not.toThrow();
  });
});

describe('completeTask', () => {
  it('moves lease file to completed/ on success', () => {
    const queueDir = tmpQueueDir();
    const { task, srcPath } = makeTask(queueDir);
    leaseTask(task, srcPath, undefined, queueDir);

    completeTask(task.id, 'succeeded', undefined, queueDir);

    expect(existsSync(join(queueDir, 'leased', `${task.id}.json`))).toBe(false);
    expect(existsSync(join(queueDir, 'completed', `${task.id}.json`))).toBe(true);
    const record = getTaskRecord(task.id, queueDir)!;
    expect(record.state).toBe('succeeded');
    expect(record.leaseExpiry).toBeUndefined();
  });

  it('moves lease file to dead-letter/ when failed and maxAttempts=1', () => {
    const queueDir = tmpQueueDir();
    const { task, srcPath } = makeTask(queueDir);
    leaseTask(task, srcPath, undefined, queueDir);

    completeTask(task.id, 'failed', 'session error', queueDir);

    expect(existsSync(join(queueDir, 'leased', `${task.id}.json`))).toBe(false);
    expect(existsSync(join(queueDir, 'dead-letter', `${task.id}.json`))).toBe(true);
    const record = getTaskRecord(task.id, queueDir)!;
    expect(record.state).toBe('failed');
    expect(record.lastError).toBe('session error');
  });

  it('is graceful when the lease file is already missing', () => {
    const queueDir = tmpQueueDir();
    // Should not throw even if lease file never existed.
    expect(() => completeTask('ghost-id', 'succeeded', undefined, queueDir)).not.toThrow();
  });

  it('re-enqueues (not archives) when status=failed and attempts < maxAttempts', () => {
    const queueDir = tmpQueueDir();
    const { task, srcPath } = makeTask(queueDir);
    // Lease with maxAttempts=3 so first failure is retryable.
    const fs = require('node:fs');
    const path = require('node:path');
    leaseTask(task, srcPath, undefined, queueDir);
    // Patch lease file to set maxAttempts=3 (attempts is already 1).
    const leasedFilePath = path.join(queueDir, 'leased', `${task.id}.json`);
    const record = JSON.parse(fs.readFileSync(leasedFilePath, 'utf-8'));
    record.maxAttempts = 3;
    fs.writeFileSync(leasedFilePath, JSON.stringify(record));

    completeTask(task.id, 'failed', 'transient error', queueDir);

    // Must NOT be in completed/ or dead-letter/.
    expect(existsSync(path.join(queueDir, 'completed', `${task.id}.json`))).toBe(false);
    expect(existsSync(path.join(queueDir, 'dead-letter', `${task.id}.json`))).toBe(false);
    // Lease file must be removed.
    expect(existsSync(leasedFilePath)).toBe(false);
    // A new queue file must exist (re-enqueued for retry).
    const queueFiles = fs.readdirSync(queueDir).filter(
      (f: string) => f.endsWith('.json') && !f.startsWith('.tmp-'),
    );
    expect(queueFiles.length).toBeGreaterThan(0);
    // The re-enqueued file must carry the retry state.
    const requeued = JSON.parse(fs.readFileSync(path.join(queueDir, queueFiles[0]), 'utf-8'));
    expect(requeued.maxAttempts).toBe(3);
    expect(requeued.attempts).toBe(1); // carried from the TaskRecord (attempt 1 just finished)
  });
});

describe('recoverExpiredLeases', () => {
  it('returns empty array when leased/ does not exist', () => {
    const queueDir = tmpQueueDir();
    expect(recoverExpiredLeases(queueDir)).toEqual([]);
  });

  it('leaves non-expired leases alone', () => {
    const queueDir = tmpQueueDir();
    const { task, srcPath } = makeTask(queueDir);
    leaseTask(task, srcPath, 60_000, queueDir); // far-future expiry

    const recovered = recoverExpiredLeases(queueDir);
    expect(recovered).toHaveLength(0);
    expect(existsSync(join(queueDir, 'leased', `${task.id}.json`))).toBe(true);
  });

  it('re-enqueues an expired lease when attempts < maxAttempts', () => {
    const queueDir = tmpQueueDir();
    const { task, srcPath } = makeTask(queueDir);
    leaseTask(task, srcPath, undefined, queueDir);

    // Manually set the leaseExpiry to the past and bump maxAttempts.
    const leasedPath = join(queueDir, 'leased', `${task.id}.json`);
    const record = JSON.parse(readFileSync(leasedPath, 'utf-8'));
    record.leaseExpiry = Date.now() - 1;
    record.maxAttempts = 3; // allow retry
    writeFileSync(leasedPath, JSON.stringify(record));

    const recovered = recoverExpiredLeases(queueDir);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.state).toBe('retrying');
    expect(existsSync(leasedPath)).toBe(false); // removed from leased/

    // A new queue file should exist.
    const fs = require('node:fs');
    const queueFiles = fs.readdirSync(queueDir).filter(
      (f: string) => f.endsWith('.json') && !f.startsWith('.tmp-'),
    );
    expect(queueFiles.length).toBeGreaterThan(0);
  });

  it('dead-letters an expired lease when attempts >= maxAttempts', () => {
    const queueDir = tmpQueueDir();
    const { task, srcPath } = makeTask(queueDir);
    leaseTask(task, srcPath, undefined, queueDir);

    // Manually set the leaseExpiry to the past (maxAttempts=1 by default).
    const leasedPath = join(queueDir, 'leased', `${task.id}.json`);
    const record = JSON.parse(readFileSync(leasedPath, 'utf-8'));
    record.leaseExpiry = Date.now() - 1;
    writeFileSync(leasedPath, JSON.stringify(record));

    const recovered = recoverExpiredLeases(queueDir);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.state).toBe('dead-letter');
    expect(existsSync(leasedPath)).toBe(false);
    expect(existsSync(join(queueDir, 'dead-letter', `${task.id}.json`))).toBe(true);
  });
});

describe('getTaskRecord', () => {
  it('returns null for an unknown task id', () => {
    const queueDir = tmpQueueDir();
    expect(getTaskRecord('nope', queueDir)).toBeNull();
  });

  it('finds a record in leased/', () => {
    const queueDir = tmpQueueDir();
    const { task, srcPath } = makeTask(queueDir);
    leaseTask(task, srcPath, undefined, queueDir);
    const record = getTaskRecord(task.id, queueDir);
    expect(record).not.toBeNull();
    expect(record?.state).toBe('leased');
  });

  it('finds a record in completed/', () => {
    const queueDir = tmpQueueDir();
    const { task, srcPath } = makeTask(queueDir);
    leaseTask(task, srcPath, undefined, queueDir);
    completeTask(task.id, 'succeeded', undefined, queueDir);
    const record = getTaskRecord(task.id, queueDir);
    expect(record?.state).toBe('succeeded');
  });
});

describe('listActiveTasks', () => {
  it('returns empty array when no leased tasks exist', () => {
    const queueDir = tmpQueueDir();
    expect(listActiveTasks(queueDir)).toEqual([]);
  });

  it('returns leased tasks', () => {
    const queueDir = tmpQueueDir();
    const { task, srcPath } = makeTask(queueDir);
    leaseTask(task, srcPath, undefined, queueDir);
    const active = listActiveTasks(queueDir);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(task.id);
  });
});

describe('dequeueNext integration — lease behaviour preserved', () => {
  it('dequeueNext returns the task and creates a lease file', () => {
    const queueDir = tmpQueueDir();
    enqueue('/cmd-a', {}, queueDir);
    enqueue('/cmd-b', {}, queueDir);

    const dequeued = dequeueNext(queueDir);
    expect(dequeued).not.toBeNull();
    expect(dequeued?.command).toBe('/cmd-a'); // FIFO

    // Lease file should exist.
    const active = listActiveTasks(queueDir);
    expect(active).toHaveLength(1);
    expect(active[0]!.id).toBe(dequeued?.id);
    expect(active[0]!.state).toBe('leased');
  });

  it('dequeueNext returns null when queue is empty', () => {
    const queueDir = tmpQueueDir();
    expect(dequeueNext(queueDir)).toBeNull();
  });
});

describe('leaseTask — retry state carry-through (P2 fix)', () => {
  it('uses defaults (attempts:1, maxAttempts:1) for a fresh task without retry fields', () => {
    const queueDir = tmpQueueDir();
    const { task, srcPath } = makeTask(queueDir);
    const record = leaseTask(task, srcPath, undefined, queueDir);
    expect(record.attempts).toBe(1);
    expect(record.maxAttempts).toBe(1);
    expect(record.backoffStrategy).toBe('fixed');
    expect(record.backoffBaseMs).toBe(30_000);
  });

  it('increments attempts and preserves maxAttempts from a re-enqueued task', () => {
    const queueDir = tmpQueueDir();
    // Simulate a task re-enqueued by recoverExpiredLeases by adding retry fields.
    const task = enqueue('/retry-cmd', {}, queueDir);
    // Manually read and patch the queue file to add retry fields
    const fs = require('node:fs');
    const files = fs.readdirSync(queueDir).filter(
      (f: string) => f.endsWith('.json') && !f.startsWith('.tmp-'),
    );
    let srcPath = '';
    for (const f of files) {
      const p = require('node:path').join(queueDir, f);
      try {
        const t = JSON.parse(fs.readFileSync(p, 'utf-8'));
        if (t.id === task.id) { srcPath = p; break; }
      } catch { /* skip */ }
    }
    // Patch the queue file to carry retry fields (as reEnqueue would write them).
    const queuedWithRetry = {
      ...JSON.parse(fs.readFileSync(srcPath, 'utf-8')),
      attempts: 1,
      maxAttempts: 3,
      backoffStrategy: 'exponential',
      backoffBaseMs: 5_000,
    };
    fs.writeFileSync(srcPath, JSON.stringify(queuedWithRetry));

    const record = leaseTask(queuedWithRetry, srcPath, undefined, queueDir);

    // attempts should be prior (1) + 1 = 2
    expect(record.attempts).toBe(2);
    expect(record.maxAttempts).toBe(3);
    expect(record.backoffStrategy).toBe('exponential');
    expect(record.backoffBaseMs).toBe(5_000);
  });

  it('recoverExpiredLeases re-enqueues with retry fields that leaseTask reads back', () => {
    const queueDir = tmpQueueDir();
    const { task, srcPath } = makeTask(queueDir);
    // Create initial lease with maxAttempts=3
    const leasedFilePath = require('node:path').join(queueDir, 'leased', `${task.id}.json`);
    leaseTask(task, srcPath, undefined, queueDir);
    // Patch to allow retry and expire the lease
    const fs = require('node:fs');
    const record = JSON.parse(fs.readFileSync(leasedFilePath, 'utf-8'));
    record.leaseExpiry = Date.now() - 1;
    record.maxAttempts = 3;
    record.backoffStrategy = 'exponential';
    record.backoffBaseMs = 2_000;
    fs.writeFileSync(leasedFilePath, JSON.stringify(record));

    const recovered = recoverExpiredLeases(queueDir);
    expect(recovered[0]!.state).toBe('retrying');

    // The re-enqueued file must carry the retry state.
    const queueFiles = fs.readdirSync(queueDir).filter(
      (f: string) => f.endsWith('.json') && !f.startsWith('.tmp-'),
    );
    expect(queueFiles.length).toBeGreaterThan(0);
    const requeued = JSON.parse(
      fs.readFileSync(require('node:path').join(queueDir, queueFiles[0]), 'utf-8'),
    );
    expect(requeued.attempts).toBe(record.attempts); // carried from the TaskRecord
    expect(requeued.maxAttempts).toBe(3);
    expect(requeued.backoffStrategy).toBe('exponential');

    // Now lease again — attempts should be prior+1
    const newRecord = leaseTask(requeued, require('node:path').join(queueDir, queueFiles[0]), undefined, queueDir);
    expect(newRecord.attempts).toBe(record.attempts + 1);
    expect(newRecord.maxAttempts).toBe(3);
  });
});

describe('leaseTask — multi-process safety (rename-as-claim)', () => {
  it('throws when srcPath does not exist (atomic claim via rename guards double-dequeue)', () => {
    const queueDir = tmpQueueDir();
    const task: import('./queue-store.js').QueuedTask = {
      id: 'ghost-id',
      command: '/test',
      enqueuedAt: new Date().toISOString(),
      sequence: 1,
    };
    // srcPath does not exist — renameSync(srcPath → dest) throws ENOENT,
    // which is the signal that another process already claimed this task.
    const ghostPath = require('node:path').join(queueDir, '0001-ghost-id.json');
    expect(() => leaseTask(task, ghostPath, undefined, queueDir)).toThrow();
  });

  it('second leaseTask on same srcPath throws (rename is single-winner)', () => {
    // Simulate two processes racing to lease the same queue file.
    // The first call succeeds; the second gets ENOENT from renameSync.
    const queueDir = tmpQueueDir();
    const { task, srcPath } = makeTask(queueDir);

    // First caller wins — succeeds.
    expect(() => leaseTask(task, srcPath, undefined, queueDir)).not.toThrow();

    // Second caller loses — srcPath is gone; must throw, not silently skip.
    expect(() => leaseTask(task, srcPath, undefined, queueDir)).toThrow();
  });
});

describe('recoverExpiredLeases — stale .claim-* file recovery (second pass)', () => {
  it('recovers a stale .claim-* file left by an interrupted prior recovery', () => {
    const queueDir = tmpQueueDir();
    const leasedDir = join(queueDir, 'leased');
    mkdirSync(leasedDir, { recursive: true });

    // Simulate a crash-interrupted recovery: a .claim-<hex>.json file sits in
    // leased/ with a valid expired TaskRecord — left behind because the prior
    // recovery process crashed after renaming but before re-enqueueing.
    const record = {
      id: 'q-stale-claim-test',
      command: '/stale-cmd',
      state: 'leased',
      attempts: 1,
      maxAttempts: 2,
      leaseExpiry: Date.now() - 60_000,
      createdAt: Date.now() - 120_000,
      updatedAt: Date.now() - 60_000,
    };
    const claimFile = join(leasedDir, '.claim-deadbeef.json');
    writeFileSync(claimFile, JSON.stringify(record));

    const recovered = recoverExpiredLeases(queueDir);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.id).toBe('q-stale-claim-test');
    expect(recovered[0]!.state).toBe('retrying');

    // The claim file must be gone.
    expect(existsSync(claimFile)).toBe(false);

    // Exactly one re-enqueued file in the queue dir.
    const fs = require('node:fs');
    const queueFiles = fs.readdirSync(queueDir).filter(
      (f: string) => f.endsWith('.json') && !f.startsWith('.tmp-'),
    );
    expect(queueFiles).toHaveLength(1);
  });

  it('removes a corrupt .claim-* file without crashing', () => {
    const queueDir = tmpQueueDir();
    const leasedDir = join(queueDir, 'leased');
    mkdirSync(leasedDir, { recursive: true });

    const claimFile = join(leasedDir, '.claim-corrupt01.json');
    writeFileSync(claimFile, 'NOT VALID JSON!!!');

    // Must not throw and must produce zero recoveries.
    const recovered = recoverExpiredLeases(queueDir);
    expect(recovered).toHaveLength(0);

    // The corrupt file should be cleaned up.
    expect(existsSync(claimFile)).toBe(false);
  });

  it('concurrent second-pass recovery on the same .claim-* file produces exactly one re-enqueue', () => {
    // Simulates the race: two sequential calls where the first claims the
    // .claim-* file via rename; the second should find it gone and skip.
    const queueDir = tmpQueueDir();
    const leasedDir = join(queueDir, 'leased');
    mkdirSync(leasedDir, { recursive: true });

    const record = {
      id: 'q-race-claim-test',
      command: '/race-cmd',
      state: 'leased',
      attempts: 1,
      maxAttempts: 2,
      leaseExpiry: Date.now() - 60_000,
      createdAt: Date.now() - 120_000,
      updatedAt: Date.now() - 60_000,
    };
    writeFileSync(join(leasedDir, '.claim-racetest1.json'), JSON.stringify(record));

    const first = recoverExpiredLeases(queueDir);
    expect(first).toHaveLength(1);

    // Second call: .claim-* file is gone (renamed by first call).
    const second = recoverExpiredLeases(queueDir);
    expect(second).toHaveLength(0);

    // Exactly one queue file.
    const fs = require('node:fs');
    const queueFiles = fs.readdirSync(queueDir).filter(
      (f: string) => f.endsWith('.json') && !f.startsWith('.tmp-'),
    );
    expect(queueFiles).toHaveLength(1);
  });
});

describe('recoverExpiredLeases — multi-process safety (claim-rename)', () => {
  it('concurrent recoverExpiredLeases on the same expired lease produces exactly one re-enqueue', () => {
    // This test verifies that the rename-based claim prevents double-enqueue
    // when two daemon processes run recoverExpiredLeases concurrently.
    // We simulate concurrency by running two sequential calls on a queue
    // where the first call has already claimed the lease file (the file is
    // gone from leased/ after the first call).
    const queueDir = tmpQueueDir();
    const { task, srcPath } = makeTask(queueDir);
    leaseTask(task, srcPath, undefined, queueDir);

    // Expire the lease and set maxAttempts=2 so recovery re-enqueues.
    const leasedPath = join(queueDir, 'leased', `${task.id}.json`);
    const record = JSON.parse(readFileSync(leasedPath, 'utf-8'));
    record.leaseExpiry = Date.now() - 1;
    record.maxAttempts = 2;
    writeFileSync(leasedPath, JSON.stringify(record));

    // First call: claims and re-enqueues.
    const first = recoverExpiredLeases(queueDir);
    expect(first).toHaveLength(1);
    expect(first[0]!.state).toBe('retrying');

    // Second call: lease file is gone (claimed by first call); should produce
    // zero recoveries — NOT a second re-enqueue for the same task.
    const second = recoverExpiredLeases(queueDir);
    expect(second).toHaveLength(0);

    // Exactly one queue file must exist.
    const fs = require('node:fs');
    const queueFiles = fs.readdirSync(queueDir).filter(
      (f: string) => f.endsWith('.json') && !f.startsWith('.tmp-'),
    );
    expect(queueFiles).toHaveLength(1);
  });
});
