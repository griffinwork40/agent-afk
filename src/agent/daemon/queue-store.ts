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
 * Subdirectory (relative to `queueDir`) used to quarantine malformed queue
 * entries instead of silently dropping them or letting them block the FIFO
 * queue forever. See `dequeueNext` for the poison-handling contract.
 */
const POISON_SUBDIR = 'poison';

/**
 * Dequeue the next pending task (FIFO order) and remove it from disk.
 *
 * ORDERING INVARIANT: the queue file is removed from disk BEFORE this
 * function returns a task. Callers (e.g. `pullTick`) must spawn the session
 * only after `dequeueNext` has returned a non-null result — reverse order
 * risks double-fire on daemon restart if the process crashes between dequeue
 * and spawn.
 *
 * POISON-HANDLING CONTRACT: a malformed entry (truncated write, corrupted
 * JSON, or a stray non-JSON file dropped into the queue dir) is moved aside
 * into `<queueDir>/poison/` and skipped — NOT returned and NOT left in the
 * FIFO path. This keeps the queue draining past corrupt entries while
 * preserving them for diagnosis. Previously a parse error threw before the
 * file was removed and `pullTick` swallowed it, leaving a single poison
 * entry to silently deadlock every subsequent task with no log or telemetry.
 *
 * @param queueDir - Override the queue directory (defaults to `getQueueDir()`).
 * @returns The dequeued `QueuedTask`, or `null` if the queue is empty or every
 *          remaining entry is malformed (all quarantined).
 */
export function dequeueNext(queueDir: string = getQueueDir()): QueuedTask | null {
  mkdirSync(queueDir, { recursive: true });

  const sorted = readdirSync(queueDir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.tmp-'))
    .sort();

  for (const filename of sorted) {
    const filePath = join(queueDir, filename);
    let raw: string;
    try {
      raw = readFileSync(filePath, 'utf-8');
    } catch (err) {
      quarantinePoisonEntry(queueDir, filename, err);
      continue;
    }
    let task: QueuedTask;
    try {
      task = JSON.parse(raw) as QueuedTask;
    } catch (err) {
      quarantinePoisonEntry(queueDir, filename, err);
      continue;
    }
    // ORDERING INVARIANT: remove from disk BEFORE returning task.
    // See JSDoc above — do NOT move this after the return.
    unlinkSync(filePath);
    return task;
  }
  return null;
}

/**
 * Move an unparseable queue file into `<queueDir>/poison/` so it stops
 * blocking FIFO dequeue but is preserved for diagnosis. Uses an atomic
 * same-directory rename (`poison/` is created lazily). On a name collision
 * inside `poison/` (e.g. the same corrupt filename re-quarantined after a
 * manual restore), a timestamp + random suffix is appended so nothing is
 * ever overwritten. Never throws — if the entry cannot be moved aside it is
 * best-effort unlinked so the queue unblocks instead of deadlocking. Every
 * outcome is logged to stderr so the operator can investigate.
 */
function quarantinePoisonEntry(queueDir: string, filename: string, err: unknown): void {
  const reason = err instanceof Error ? err.message : String(err);
  const poisonDir = join(queueDir, POISON_SUBDIR);
  const src = join(queueDir, filename);
  try {
    mkdirSync(poisonDir, { recursive: true });
    let dest = join(poisonDir, filename);
    try {
      renameSync(src, dest);
    } catch {
      // Collision or transient failure — disambiguate and retry once.
      dest = join(poisonDir, `${Date.now()}-${randomBytes(3).toString('hex')}-${filename}`);
      renameSync(src, dest);
    }
    // eslint-disable-next-line no-console
    console.error(
      `[daemon] pull-queue: quarantined malformed entry ${filename} → ${POISON_SUBDIR}/ (${reason})`,
    );
  } catch (moveErr) {
    // Last resort: if we cannot move it aside, unlink so the queue unblocks
    // rather than deadlocking on every subsequent tick.
    const moveReason = moveErr instanceof Error ? moveErr.message : String(moveErr);
    // eslint-disable-next-line no-console
    console.error(
      `[daemon] pull-queue: failed to quarantine malformed entry ${filename}; removing to unblock queue (${moveReason})`,
    );
    try {
      unlinkSync(src);
    } catch {
      // ignore — nothing more we can do; the next readdir will retry.
    }
  }
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
