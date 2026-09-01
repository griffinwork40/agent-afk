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
