/**
 * Tests for queue-store — file-based task queue with atomic writes.
 * @module agent/daemon/queue-store.test
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, readdirSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { enqueue, dequeueNext, listPending } from './queue-store.js';

// Use a fresh temp dir for each test to guarantee isolation
let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'afk-queue-test-'));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('enqueue', () => {
  it('writes a .json file with correct filename format', () => {
    enqueue('echo hello', {}, tmpDir);
    const files = readdirSync(tmpDir);
    expect(files).toHaveLength(1);
    const name = files[0]!;
    // Expected: 0001-q-<timestamp>-<random>.json
    expect(name).toMatch(/^\d{4}-q-\d+-[a-z0-9]+\.json$/);
  });

  it('returns a QueuedTask with correct fields', () => {
    const before = Date.now();
    const task = enqueue('/forge-friction --auto', {}, tmpDir);
    const after = Date.now();

    expect(task.id).toMatch(/^q-\d+-[a-z0-9]+$/);
    expect(task.command).toBe('/forge-friction --auto');
    expect(task.sequence).toBe(1);
    // enqueuedAt is an ISO string within the test window
    const ts = new Date(task.enqueuedAt).getTime();
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
  });

  it('increments sequence for successive enqueues', () => {
    const t1 = enqueue('cmd1', {}, tmpDir);
    const t2 = enqueue('cmd2', {}, tmpDir);
    expect(t1.sequence).toBe(1);
    expect(t2.sequence).toBe(2);
  });

  it('creates the queue directory if it does not exist', () => {
    const nested = join(tmpDir, 'does', 'not', 'exist');
    const task = enqueue('echo hi', {}, nested);
    expect(task.sequence).toBe(1);
    const files = readdirSync(nested);
    expect(files).toHaveLength(1);
  });

  it('stores notifyOn in the task when provided', () => {
    const task = enqueue('cmd', { notifyOn: 'failure' }, tmpDir);
    expect(task.notifyOn).toBe('failure');
  });
});

describe('dequeueNext', () => {
  it('returns null on an empty directory', () => {
    const result = dequeueNext(tmpDir);
    expect(result).toBeNull();
  });

  it('removes the file from disk and returns the parsed task', () => {
    enqueue('/forge', {}, tmpDir);
    expect(readdirSync(tmpDir)).toHaveLength(1);

    const task = dequeueNext(tmpDir);
    expect(task).not.toBeNull();
    expect(task!.command).toBe('/forge');
    // File must be removed after dequeue
    expect(readdirSync(tmpDir)).toHaveLength(0);
  });

  it('respects FIFO order for two queued tasks', () => {
    enqueue('first', {}, tmpDir);
    enqueue('second', {}, tmpDir);

    const t1 = dequeueNext(tmpDir);
    const t2 = dequeueNext(tmpDir);
    expect(t1!.command).toBe('first');
    expect(t2!.command).toBe('second');
  });

  it('returns null on the second call after all tasks are dequeued', () => {
    enqueue('only', {}, tmpDir);
    dequeueNext(tmpDir);
    expect(dequeueNext(tmpDir)).toBeNull();
  });
});

describe('dequeueNext — malformed (poison) entries', () => {
  it('quarantines a malformed JSON entry at the FIFO head and returns the next valid task', () => {
    // Drop a corrupt file that sorts before any enqueued task.
    writeFileSync(join(tmpDir, '0000-q-poison.json'), '{ not valid json');
    enqueue('valid-task', {}, tmpDir);

    const task = dequeueNext(tmpDir);
    expect(task).not.toBeNull();
    expect(task!.command).toBe('valid-task');

    // No malformed entry left in the FIFO path; valid task consumed.
    const remaining = readdirSync(tmpDir).filter(
      (f) => f.endsWith('.json') && !f.startsWith('.tmp-'),
    );
    expect(remaining).toHaveLength(0);

    // Malformed entry preserved in poison/ for diagnosis.
    const poison = readdirSync(join(tmpDir, 'poison'));
    expect(poison).toHaveLength(1);
  });

  it('returns null when every entry is malformed (all quarantined, queue unblocked)', () => {
    writeFileSync(join(tmpDir, '0001-q-a.json'), 'garbage');
    writeFileSync(join(tmpDir, '0002-q-b.json'), 'also{bad');

    expect(dequeueNext(tmpDir)).toBeNull();

    // Both moved aside — a subsequent call finds an empty FIFO path.
    const remaining = readdirSync(tmpDir).filter(
      (f) => f.endsWith('.json') && !f.startsWith('.tmp-'),
    );
    expect(remaining).toHaveLength(0);
    expect(readdirSync(join(tmpDir, 'poison'))).toHaveLength(2);
    // And the queue is unblocked: another dequeue returns null cleanly.
    expect(dequeueNext(tmpDir)).toBeNull();
  });

  it('preserves the malformed entry bytes in poison/ (not deleted)', () => {
    writeFileSync(join(tmpDir, '0001-q-x.json'), '!!broken!!');
    dequeueNext(tmpDir);

    const poison = readdirSync(join(tmpDir, 'poison'));
    expect(poison).toHaveLength(1);
    const restored = readFileSync(join(tmpDir, 'poison', poison[0]!), 'utf-8');
    expect(restored).toBe('!!broken!!');
  });

  it('does not treat the poison/ subdir itself as a queue entry', () => {
    // Create a poison dir first, then a valid task. dequeueNext must not
    // try to read `poison` as a .json file (it is filtered out by suffix).
    mkdirSync(join(tmpDir, 'poison'), { recursive: true });
    writeFileSync(join(tmpDir, 'poison', 'stale.json'), 'old');
    enqueue('valid', {}, tmpDir);

    const task = dequeueNext(tmpDir);
    expect(task).not.toBeNull();
    expect(task!.command).toBe('valid');
  });
});

describe('listPending', () => {
  it('returns an empty array when queue is empty', () => {
    expect(listPending(tmpDir)).toEqual([]);
  });

  it('returns tasks in FIFO (sequence) order', () => {
    enqueue('alpha', {}, tmpDir);
    enqueue('beta', {}, tmpDir);
    enqueue('gamma', {}, tmpDir);

    const tasks = listPending(tmpDir);
    expect(tasks).toHaveLength(3);
    expect(tasks[0]!.command).toBe('alpha');
    expect(tasks[1]!.command).toBe('beta');
    expect(tasks[2]!.command).toBe('gamma');
  });

  it('does not remove files from disk', () => {
    enqueue('keep', {}, tmpDir);
    listPending(tmpDir);
    expect(readdirSync(tmpDir)).toHaveLength(1);
  });
});
