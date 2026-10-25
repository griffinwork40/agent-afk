/**
 * Single-lease reclaim helper for the crash-path handoff expiry (#3880).
 *
 * Extracted from lease-store.ts to keep that file within the code-line ceiling.
 * Imports from lease-store are intentionally kept minimal.
 *
 * @module agent/daemon/lease-reclaim
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getQueueDir } from '../../paths.js';
import { type TaskRecord } from './task-lifecycle.js';
import { atomicWriteJson, reEnqueueRecord } from './lease-store.js';

const LEASED_SUBDIR = 'leased';
const DEAD_LETTER_SUBDIR = 'dead-letter';

function leasedDir(queueDir: string): string {
  return join(queueDir, LEASED_SUBDIR);
}

function deadLetterDir(queueDir: string): string {
  return join(queueDir, DEAD_LETTER_SUBDIR);
}

function leasedPath(queueDir: string, taskId: string): string {
  return join(leasedDir(queueDir), `${taskId}.json`);
}

function deadLetterPath(queueDir: string, taskId: string): string {
  return join(deadLetterDir(queueDir), `${taskId}.json`);
}

/**
 * Reclaim a single lease that was just restored from 'waiting_human_input'
 * back to 'leased' by setLeaseState (crash-path only, called from
 * expireHandoff).  Applies the same re-enqueue / dead-letter semantics as
 * recoverExpiredLeases but for ONE known task, so no directory scan is needed.
 *
 * The `isInFlight` predicate guards against double-run: if the task is still
 * executing (scheduler in-flight map), the lease is left in place.  This is
 * the correct guard because `renewLease` has no production caller — any task
 * running longer than the 10-minute lease TTL has leaseExpiry < now, and
 * calling recoverExpiredLeases would reclaim it mid-run.
 *
 * Records that are missing `attempts` or `maxAttempts` (crash-window writes) are
 * reconstructed with `attempts: 0, maxAttempts: 1`.  On the first reclaim the
 * check `attempts (0) < maxAttempts (1)` is true, so the record is re-enqueued.
 * When `acquireLease` picks it up it increments `attempts` to 1; if the task
 * crashes again the second reclaim sees `1 < 1` → false and dead-letters it.
 * Dead-lettering therefore occurs on the **second** reclaim attempt, not the first.
 *
 * @param taskId    - The task whose restored lease should be reclaimed.
 * @param queueDir  - Queue root directory.
 * @param isInFlight - Optional predicate; when it returns true the lease is
 *                    left untouched (task is still running).
 * @returns The processed TaskRecord, or null if the file was missing / in-flight.
 */
export function reclaimSingleLease(
  taskId: string,
  queueDir: string = getQueueDir(),
  isInFlight?: (taskId: string) => boolean,
): TaskRecord | null {
  if (isInFlight?.(taskId)) return null;

  const filePath = leasedPath(queueDir, taskId);
  if (!existsSync(filePath)) return null;

  let record: TaskRecord;
  try {
    record = JSON.parse(readFileSync(filePath, 'utf-8')) as TaskRecord;
  } catch {
    return null; // Corrupt file — skip.
  }

  // Apply same crash-window reconstruction as recoverExpiredLeases.
  // Records that are missing attempt fields are reconstructed with
  // attempts: 0, maxAttempts: 1.  They are re-enqueued on the first reclaim
  // (0 < 1) and dead-lettered only on the second (1 < 1 → false).
  if (record.attempts === undefined || record.maxAttempts === undefined) {
    record = {
      ...record,
      state: 'leased',
      attempts: 0,
      maxAttempts: 1,
      leaseExpiry: 0,
      createdAt: record.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    } as TaskRecord;
  }

  const now = Date.now();
  record.updatedAt = now;

  // Claim via atomic rename so concurrent recovery skips this file.
  const claimPath = join(leasedDir(queueDir), `.claim-${randomBytes(4).toString('hex')}.json`);
  try {
    renameSync(filePath, claimPath);
  } catch {
    return null; // ENOENT: another process already claimed it.
  }

  if (record.attempts < record.maxAttempts) {
    record.state = 'retrying';
    reEnqueueRecord(record, queueDir);
  } else {
    record.state = 'dead-letter';
    record.lastError = record.lastError ?? 'lease expired';
    delete record.leaseExpiry;
    mkdirSync(deadLetterDir(queueDir), { recursive: true });
    atomicWriteJson(deadLetterPath(queueDir, record.id), record);
  }

  try { unlinkSync(claimPath); } catch { /* ignore */ }
  return record;
}

