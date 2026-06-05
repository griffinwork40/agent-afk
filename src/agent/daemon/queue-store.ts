/**
 * File-based task queue for the pull-trigger daemon mode.
 *
 * Tasks are persisted as JSON files in `getQueueDir()`. Each file is named
 * with a zero-padded sequence prefix for FIFO ordering:
 *   `<seq>-q-<timestamp>-<random>.json`
 *
 * Writes are atomic: the payload is written to a temp file in the same
 * directory then renamed into place, so no partial files are ever visible.
 *
 * The `sequence` field is stored in the JSON body (known at enqueue time)
 * and also derivable from the filename prefix — the body value is
 * authoritative; the filename prefix is for lexicographic sort only.
 *
 * @module agent/daemon/queue-store
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { getQueueDir } from '../../paths.js';

export interface QueuedTask {
  /** Unique task identifier, e.g. `q-1716000000000-abc123`. */
  id: string;
  /** The slash command or message to run, e.g. `/forge-friction --auto`. */
  command: string;
  /** ISO 8601 timestamp when the task was enqueued. */
  enqueuedAt: string;
  /** 1-based FIFO position at enqueue time (stored in JSON body). */
  sequence: number;
  /**
   * Controls when out-of-band notifications fire for this task.
   * Mirrors `ScheduledTask.notifyOn`. Omitted means "always notify".
   */
  notifyOn?: 'failure' | 'always' | 'never';
}

export interface EnqueueOptions {
  notifyOn?: 'failure' | 'always' | 'never';
}

/**
 * Enqueue a new task by writing an atomic JSON file to `queueDir`.
 *
 * @param command - The command to run (e.g. `/forge-friction --auto`).
 * @param opts    - Optional task options (notifyOn).
 * @param queueDir - Override the queue directory (defaults to `getQueueDir()`).
 * @returns The enqueued `QueuedTask` (sequence derived from existing file count).
 */
export function enqueue(
  command: string,
  opts: EnqueueOptions = {},
  queueDir: string = getQueueDir(),
): QueuedTask {
  mkdirSync(queueDir, { recursive: true });

  // Count existing .json files to determine next sequence number.
  // NOTE(#337-seq): for concurrent high-throughput scenarios a
  // collision-safe atomic counter would be preferable; for the
  // single-operator CLI use-case this counting approach is sufficient.
  const existing = readdirSync(queueDir).filter((f) => f.endsWith('.json'));
  const sequence = existing.length + 1;

  const id = `q-${Date.now()}-${randomBytes(3).toString('hex')}`;
  const enqueuedAt = new Date().toISOString();
  const task: QueuedTask = {
    id,
    command,
    enqueuedAt,
    sequence,
    ...(opts.notifyOn !== undefined ? { notifyOn: opts.notifyOn } : {}),
  };

  // Zero-pad sequence to 4 digits for reliable lexicographic (FIFO) sort.
  const seq = String(sequence).padStart(4, '0');
  const filename = `${seq}-${id}.json`;
  const filePath = join(queueDir, filename);
  const tmpSuffix = randomBytes(4).toString('hex');
  const tmpPath = join(queueDir, `.tmp-${tmpSuffix}.json`);

  try {
    writeFileSync(tmpPath, JSON.stringify(task), 'utf-8');
    renameSync(tmpPath, filePath);
  } catch (err) {
    // Best-effort cleanup of the temp file on failure.
    try { unlinkSync(tmpPath); } catch { /* ignore */ }
    throw err;
  }

  return task;
}

/**
 * Dequeue the next pending task (FIFO order) and remove it from disk.
 *
 * ORDERING INVARIANT: the queue file is removed from disk BEFORE this
 * function returns. Callers (e.g. `pullTick`) must spawn the session only
 * after `dequeueNext` has returned a non-null result — reverse order risks
 * double-fire on daemon restart if the process crashes between dequeue and
 * spawn.
 *
 * @param queueDir - Override the queue directory (defaults to `getQueueDir()`).
 * @returns The dequeued `QueuedTask`, or `null` if the queue is empty.
 */
export function dequeueNext(queueDir: string = getQueueDir()): QueuedTask | null {
  mkdirSync(queueDir, { recursive: true });

  const sorted = readdirSync(queueDir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.tmp-'))
    .sort();

  // noUncheckedIndexedAccess guard
  const first = sorted[0];
  if (first === undefined) return null;

  const filePath = join(queueDir, first);
  const raw = readFileSync(filePath, 'utf-8');
  const task = JSON.parse(raw) as QueuedTask;

  // ORDERING INVARIANT: remove from disk BEFORE returning task.
  // See JSDoc above — do NOT move this after the return.
  unlinkSync(filePath);

  return task;
}

/**
 * List all pending tasks in FIFO order without removing them.
 *
 * @param queueDir - Override the queue directory (defaults to `getQueueDir()`).
 * @returns Array of `QueuedTask` sorted by sequence (FIFO).
 */
export function listPending(queueDir: string = getQueueDir()): QueuedTask[] {
  try {
    mkdirSync(queueDir, { recursive: true });
  } catch {
    return [];
  }

  const sorted = readdirSync(queueDir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.tmp-'))
    .sort();

  return sorted.map((filename) => {
    const filePath = join(queueDir, filename);
    const raw = readFileSync(filePath, 'utf-8');
    return JSON.parse(raw) as QueuedTask;
  });
}
