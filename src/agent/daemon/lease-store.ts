/**
 * File-based lease management for durable task execution.
 *
 * Lease flow:
 *   1. `leaseTask`             — move file from queue/ to leased/, write TaskRecord
 *   2. `renewLease`            — heartbeat: update leaseExpiry in leased/<id>.json
 *   3. `completeTask`          — succeeded/exhausted-failed → completed/ or dead-letter/; retrying → re-enqueue
 *   4. `recoverExpiredLeases`  — scan leased/ for expired entries; re-enqueue or dead-letter
 *
 * Directory layout under queueDir:
 *   leased/<taskId>.json      — tasks currently being processed
 *   completed/<taskId>.json   — terminal archive (succeeded or failed)
 *   dead-letter/<taskId>.json — tasks that exhausted maxAttempts
 *
 * Atomic writes use tmp+rename (same pattern as queue-store.ts).
 *
 * @module agent/daemon/lease-store
 */

import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getQueueDir } from '../../paths.js';
import { env } from '../../config/env.js';
import { type QueuedTask } from './queue-store.js';
import {
  type TaskRecord,
  type TaskState,
  DEFAULT_LEASE_TTL_MS,
} from './task-lifecycle.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LEASED_SUBDIR = 'leased';
const COMPLETED_SUBDIR = 'completed';
const DEAD_LETTER_SUBDIR = 'dead-letter';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function resolveLeaseTtlMs(override?: number): number {
  if (override !== undefined && override > 0) return override;
  const raw = env.AFK_LEASE_TTL_MS;
  if (raw !== undefined) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_LEASE_TTL_MS;
}

function leasedDir(queueDir: string): string {
  return join(queueDir, LEASED_SUBDIR);
}

function completedDir(queueDir: string): string {
  return join(queueDir, COMPLETED_SUBDIR);
}

function deadLetterDir(queueDir: string): string {
  return join(queueDir, DEAD_LETTER_SUBDIR);
}

function leasedPath(queueDir: string, taskId: string): string {
  return join(leasedDir(queueDir), `${taskId}.json`);
}

function completedPath(queueDir: string, taskId: string): string {
  return join(completedDir(queueDir), `${taskId}.json`);
}

function deadLetterPath(queueDir: string, taskId: string): string {
  return join(deadLetterDir(queueDir), `${taskId}.json`);
}

/** Atomically write JSON to dest via a tmp file in the same directory. */
function atomicWriteJson(dest: string, data: unknown): void {
  const dir = join(dest, '..');
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.tmp-${randomBytes(4).toString('hex')}.json`);
  try {
    writeFileSync(tmp, JSON.stringify(data), 'utf-8');
    renameSync(tmp, dest);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* ignore */ }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Create a TaskRecord from a QueuedTask and move the queue file to leased/.
 *
 * Multi-process safety: the queue file is atomically claimed via
 * `renameSync(srcPath → leased/<id>.json)` as the FIRST write operation.
 * POSIX rename(2) is atomic on the same filesystem — when two processes race
 * to lease the same task, the rename is the single-winner gate:
 *   - The winner's rename succeeds; the queue file is gone from the FIFO.
 *   - The loser's rename throws ENOENT (src is already gone); leaseTask
 *     propagates that error so the caller knows it did NOT win the race.
 * The lease record (TaskRecord JSON) is written AFTER the atomic claim so the
 * file content reflects the winner's process ID / timestamp. This is safe:
 * after the rename, the winner is the sole owner of leased/<id>.json and can
 * overwrite it without a further race.
 *
 * @param task       - The QueuedTask dequeued from queue-store.
 * @param srcPath    - Absolute path to the queue file (before deletion).
 *                     Caller must NOT have deleted it yet.
 * @param leaseTtlMs - Override the lease TTL (defaults to AFK_LEASE_TTL_MS or 10 min).
 * @param queueDir   - Queue root directory.
 * @returns The newly created TaskRecord in state 'leased'.
 * @throws If srcPath does not exist (ENOENT) — signals that another process
 *         already claimed this task and the caller must not proceed.
 */
export function leaseTask(
  task: QueuedTask,
  srcPath: string,
  leaseTtlMs?: number,
  queueDir: string = getQueueDir(),
): TaskRecord {
  const ttl = resolveLeaseTtlMs(leaseTtlMs);
  const now = Date.now();
  // Restore retry state from the QueuedTask when present (set by reEnqueue
  // on recovered tasks).  A re-enqueued task already had attempt N; the new
  // lease increments to N+1 so exhaustion is tracked correctly.  For a
  // fresh task (no retry fields) the defaults (attempts:1, maxAttempts:1)
  // preserve the existing no-retry behaviour.
  const priorAttempts = task.attempts ?? 0;
  const record: TaskRecord = {
    id: task.id,
    command: task.command,
    state: 'leased',
    attempts: priorAttempts + 1,
    maxAttempts: task.maxAttempts ?? 1,
    leaseExpiry: now + ttl,
    createdAt: now,
    updatedAt: now,
    backoffStrategy: task.backoffStrategy ?? 'fixed',
    backoffBaseMs: task.backoffBaseMs ?? 30_000,
    meta: {
      enqueuedAt: task.enqueuedAt,
      sequence: task.sequence,
      ...(task.notifyOn !== undefined ? { notifyOn: task.notifyOn } : {}),
    },
  };

  mkdirSync(leasedDir(queueDir), { recursive: true });
  const dest = leasedPath(queueDir, task.id);

  // Invariant: renameSync is the single-winner atomic claim for multi-process
  // safety. It MUST execute before atomicWriteJson so that a concurrent
  // process racing to lease the same task gets ENOENT here and aborts,
  // rather than overwriting the winner's lease record after the fact.
  // Do NOT reorder: write-then-rename loses the atomicity guarantee.
  renameSync(srcPath, dest);

  // We are now the sole owner of leased/<id>.json.  Overwrite it with the
  // proper TaskRecord content.  A crash between the rename and this write
  // leaves the file with stale QueuedTask JSON, which recoverExpiredLeases
  // will parse successfully (all fields it needs are present) and recover.
  atomicWriteJson(dest, record);

  return record;
}

/**
 * Renew the lease expiry for a currently-leased task (heartbeat).
 *
 * No-op if the leased file does not exist (task may have been completed
 * by another process or the lease file was manually removed).
 *
 * @param taskId     - Task ID to renew.
 * @param leaseTtlMs - New TTL from now (defaults to AFK_LEASE_TTL_MS).
 * @param queueDir   - Queue root directory.
 */
export function renewLease(
  taskId: string,
  leaseTtlMs?: number,
  queueDir: string = getQueueDir(),
): void {
  const path = leasedPath(queueDir, taskId);
  if (!existsSync(path)) return;
  let record: TaskRecord;
  try {
    record = JSON.parse(readFileSync(path, 'utf-8')) as TaskRecord;
  } catch {
    return; // Corrupt lease file — skip.
  }
  const ttl = resolveLeaseTtlMs(leaseTtlMs);
  const now = Date.now();
  record.leaseExpiry = now + ttl;
  record.updatedAt = now;
  atomicWriteJson(path, record);
}

/**
 * Mark a task as terminal (succeeded or failed) and archive it.
 *
 * On success: moves lease file to completed/.
 * On failure with attempts >= maxAttempts: moves to dead-letter/.
 * On failure with attempts < maxAttempts: re-enqueues into queue/ (state →
 * 'retrying') and removes the lease file — does NOT archive to completed/.
 * Only terminal states (succeeded, failed) are written to completed/.
 *
 * @param taskId   - Task ID to complete.
 * @param status   - Terminal state: 'succeeded' or 'failed'.
 * @param error    - Error message if status === 'failed'.
 * @param queueDir - Queue root directory.
 */
export function completeTask(
  taskId: string,
  status: 'succeeded' | 'failed',
  error?: string,
  queueDir: string = getQueueDir(),
): void {
  const src = leasedPath(queueDir, taskId);
  let record: TaskRecord;
  if (existsSync(src)) {
    try {
      record = JSON.parse(readFileSync(src, 'utf-8')) as TaskRecord;
    } catch {
      record = buildFallbackRecord(taskId, status);
    }
  } else {
    record = buildFallbackRecord(taskId, status);
  }

  const now = Date.now();
  const finalState: TaskState =
    status === 'succeeded'
      ? 'succeeded'
      : record.attempts >= record.maxAttempts
        ? 'failed'
        : 'retrying';

  record.state = finalState;
  record.updatedAt = now;
  delete record.leaseExpiry;
  if (error !== undefined) record.lastError = error;

  if (finalState === 'retrying') {
    // Re-enqueue for retry — only terminal states go to completed/.
    reEnqueue(record, queueDir);
    // Clean up the lease file now that the queue entry is written.
    if (existsSync(src)) {
      try { unlinkSync(src); } catch { /* ignore */ }
    }
    return;
  }

  // Archive terminal states (succeeded → completed/, failed → dead-letter/).
  const dest =
    finalState === 'failed'
      ? deadLetterPath(queueDir, taskId)
      : completedPath(queueDir, taskId);

  const destDir =
    finalState === 'failed' ? deadLetterDir(queueDir) : completedDir(queueDir);
  mkdirSync(destDir, { recursive: true });
  atomicWriteJson(dest, record);

  // Remove the lease file now that the archive is written.
  if (existsSync(src)) {
    try { unlinkSync(src); } catch { /* ignore */ }
  }
}

/**
 * Scan leased/ for tasks with expired leases and recover them.
 *
 * For each expired lease:
 *   - If attempts < maxAttempts: re-enqueue into queue/ (state → 'retrying')
 *   - If attempts >= maxAttempts: dead-letter (state → 'dead-letter')
 *
 * Returns the list of recovered TaskRecords for logging.
 *
 * Multi-process safety: before re-enqueueing or dead-lettering, the lease
 * file is atomically claimed by renaming it to a `.claim-<random>.json`
 * scratch file.  If two daemon processes run recoverExpiredLeases
 * concurrently, both may enumerate the same expired file; but only the one
 * whose `renameSync` succeeds actually owns the recovery — the loser gets
 * ENOENT and skips that entry.  This prevents the double-enqueue that would
 * otherwise occur when both processes call `reEnqueue` for the same task.
 *
 * @param queueDir - Queue root directory.
 * @returns Array of TaskRecords that were processed (re-enqueued or dead-lettered).
 */
export function recoverExpiredLeases(queueDir: string = getQueueDir()): TaskRecord[] {
  const dir = leasedDir(queueDir);
  if (!existsSync(dir)) return [];

  const now = Date.now();
  const recovered: TaskRecord[] = [];

  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.tmp-') && !f.startsWith('.claim-'));

  for (const filename of files) {
    const filePath = join(dir, filename);

    // Invariant: claim the lease file via atomic rename BEFORE reading its
    // content or acting on it.  If two processes race to recover the same
    // expired lease, only the winner's rename succeeds; the loser gets ENOENT
    // and skips.  This is the same single-winner primitive used in leaseTask.
    // The claim file is a scratch name in the same directory so the rename is
    // guaranteed to be on the same filesystem (no EXDEV).
    const claimPath = join(dir, `.claim-${randomBytes(4).toString('hex')}.json`);
    try {
      renameSync(filePath, claimPath);
    } catch {
      continue; // ENOENT: another process already claimed this file — skip.
    }

    let record: TaskRecord;
    try {
      record = JSON.parse(readFileSync(claimPath, 'utf-8')) as TaskRecord;
    } catch {
      // Claim file is unreadable (corrupt) — remove the scratch file and skip.
      try { unlinkSync(claimPath); } catch { /* ignore */ }
      continue;
    }

    const expiry = record.leaseExpiry ?? 0;
    if (expiry > now) {
      // Lease is not actually expired — rename it back so the running task
      // keeps its lease file in the expected location.
      try { renameSync(claimPath, filePath); } catch { /* ignore */ }
      continue;
    }

    // Lease expired — recover.
    record.updatedAt = now;

    if (record.attempts < record.maxAttempts) {
      // Re-enqueue: write a new queue file and move the lease to completed.
      record.state = 'retrying';
      reEnqueue(record, queueDir);
    } else {
      // Exhausted attempts — dead-letter.
      record.state = 'dead-letter';
      record.lastError = record.lastError ?? 'lease expired';
      delete record.leaseExpiry;
      mkdirSync(deadLetterDir(queueDir), { recursive: true });
      atomicWriteJson(deadLetterPath(queueDir, record.id), record);
    }

    // Remove the claim scratch file now that recovery is complete.
    try { unlinkSync(claimPath); } catch { /* ignore */ }
    recovered.push(record);
  }

  return recovered;
}

/**
 * Read a TaskRecord from any of leased/, completed/, or dead-letter/ subdirs.
 *
 * @param taskId   - Task ID to look up.
 * @param queueDir - Queue root directory.
 * @returns TaskRecord if found in any subdir, null otherwise.
 */
export function getTaskRecord(
  taskId: string,
  queueDir: string = getQueueDir(),
): TaskRecord | null {
  const candidates = [
    leasedPath(queueDir, taskId),
    completedPath(queueDir, taskId),
    deadLetterPath(queueDir, taskId),
  ];
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      return JSON.parse(readFileSync(p, 'utf-8')) as TaskRecord;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * List all currently-leased TaskRecords (state 'leased').
 *
 * @param queueDir - Queue root directory.
 */
export function listActiveTasks(queueDir: string = getQueueDir()): TaskRecord[] {
  const dir = leasedDir(queueDir);
  if (!existsSync(dir)) return [];
  const result: TaskRecord[] = [];
  for (const f of readdirSync(dir).filter((f) => f.endsWith('.json') && !f.startsWith('.tmp-'))) {
    try {
      result.push(JSON.parse(readFileSync(join(dir, f), 'utf-8')) as TaskRecord);
    } catch { /* skip corrupt */ }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function buildFallbackRecord(taskId: string, status: 'succeeded' | 'failed'): TaskRecord {
  const now = Date.now();
  return {
    id: taskId,
    command: '(unknown — lease file missing)',
    state: status,
    attempts: 1,
    maxAttempts: 1,
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Write a new queue file for a recovered task so it re-enters the FIFO.
 * The new queue file carries the same id so downstream telemetry can correlate.
 */
function reEnqueue(record: TaskRecord, queueDir: string): void {
  mkdirSync(queueDir, { recursive: true });
  const existing = readdirSync(queueDir).filter((f) => f.endsWith('.json') && !f.startsWith('.tmp-'));
  const sequence = existing.length + 1;
  const seq = String(sequence).padStart(4, '0');
  // Re-use the same id so audit can correlate attempts.
  const filename = `${seq}-${record.id}.json`;
  const queuedTask: QueuedTask = {
    id: record.id,
    command: record.command,
    enqueuedAt: new Date().toISOString(),
    sequence,
    ...(record.meta?.['notifyOn'] !== undefined
      ? { notifyOn: record.meta['notifyOn'] as QueuedTask['notifyOn'] }
      : {}),
    // Carry retry state through re-enqueue so leaseTask can restore the
    // attempt count and retry policy in the new TaskRecord.  Without this,
    // every recovered task looks like a fresh attempt (attempts:1 / maxAttempts:1)
    // and exhausted-retry detection in completeTask is broken.
    attempts: record.attempts,
    maxAttempts: record.maxAttempts,
    ...(record.backoffStrategy !== undefined ? { backoffStrategy: record.backoffStrategy } : {}),
    ...(record.backoffBaseMs !== undefined ? { backoffBaseMs: record.backoffBaseMs } : {}),
  };
  atomicWriteJson(join(queueDir, filename), queuedTask);
}
