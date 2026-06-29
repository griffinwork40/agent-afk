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

import { mkdirSync, readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { getQueueDir } from '../../paths.js';
import { redactInlineSecrets } from '../session/prompt-dump.js';

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
 *
 * NOTE(#337-poison-gc): quarantined files are never auto-pruned — `poison/`
 * grows unbounded and is expected to be inspected and cleared manually by the
 * operator. A periodic sweep (e.g. prune entries older than N days) is a
 * tracked follow-up, kept out of this fix to limit its scope.
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
  // Redact every caller-supplied string before logging. The filename comes from
  // the OS readdir listing — normally safe (<seq>-q-<ts>-<hex>.json), but a
  // stray file with a secret-shaped name dropped into the queue dir would be
  // logged unredacted without this guard. Error-derived strings (reason,
  // moveReason, unlinkReason) carry the same risk: a JSON.parse SyntaxError
  // can embed a snippet of the malformed entry's bytes, and a queue `command`
  // may carry an inline secret. This matches the daemon's existing convention
  // for error-derived logs (see redactInlineSecrets use in scheduler.ts runOnce).
  // NOTE(#337-poison-telemetry): quarantines are logged to stderr only — a
  // structured `status:'poison'` telemetry record for parity with runOnce is a
  // tracked follow-up, not added here to keep the change focused.
  const redactedFilename = redactInlineSecrets(filename);
  // Invariant: SyntaxError messages from JSON.parse embed a verbatim snippet of
  // the file content (≤20 chars, or the first ~10 chars for longer inputs). That
  // window is structurally too short for redactInlineSecrets's {16,}-value
  // patterns to match, so any short or truncated secret in the malformed bytes
  // would reach stderr unredacted. For SyntaxError we therefore use a
  // content-free label; only non-SyntaxError errors (filesystem errors from
  // readFileSync, etc.) carry paths — not file content — and are safe to redact
  // and log with their message.
  const reason =
    err instanceof SyntaxError
      ? 'SyntaxError: invalid JSON'
      : redactInlineSecrets(err instanceof Error ? err.message : String(err));
  const poisonDir = join(queueDir, POISON_SUBDIR);
  const src = join(queueDir, filename);
  try {
    mkdirSync(poisonDir, { recursive: true });
    let dest = join(poisonDir, filename);
    try {
      renameSync(src, dest);
    } catch {
      // First rename failed — almost always a name collision with a file of the
      // same name already in poison/ (e.g. re-quarantined after a manual
      // restore). Retry once with a unique timestamp+random prefix so an
      // existing poison file is never overwritten. poison/ is a subdir of
      // queueDir, so a cross-device (EXDEV) rename cannot occur here; any other
      // rename failure rethrows and is handled by the outer catch.
      dest = join(poisonDir, `${Date.now()}-${randomBytes(3).toString('hex')}-${filename}`);
      renameSync(src, dest);
    }
    // eslint-disable-next-line no-console
    console.error(
      `[daemon] pull-queue: quarantined malformed entry ${redactedFilename} → ${POISON_SUBDIR}/ (${reason})`,
    );
  } catch (moveErr) {
    // Last resort: if we cannot move it aside, unlink so the queue unblocks
    // rather than deadlocking on every subsequent tick.
    const moveReason = redactInlineSecrets(moveErr instanceof Error ? moveErr.message : String(moveErr));
    // eslint-disable-next-line no-console
    console.error(
      `[daemon] pull-queue: failed to quarantine malformed entry ${redactedFilename}; removing to unblock queue (${moveReason})`,
    );
    try {
      unlinkSync(src);
    } catch (unlinkErr) {
      // Even the unlink failed (e.g. queue-dir permission loss). Surface it
      // instead of swallowing — otherwise the stuck entry re-fails silently on
      // every tick. The queue is NOT deadlocked (dequeueNext's loop still
      // reaches valid entries behind it); the next readdir retries this one.
      const unlinkReason = redactInlineSecrets(
        unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr),
      );
      // eslint-disable-next-line no-console
      console.error(
        `[daemon] pull-queue: could not remove unquarantinable entry ${redactedFilename}; will retry next tick (${unlinkReason})`,
      );
    }
  }
}

/**
 * List all pending tasks in FIFO order without removing them.
 *
 * Mirrors `dequeueNext`'s tolerance for malformed entries: a poison file
 * (unreadable or unparseable) is SKIPPED rather than thrown on, so one corrupt
 * file cannot crash a `queue list` view. Unlike `dequeueNext`, this read-only
 * path does NOT quarantine (move) the entry — a listing must not mutate the
 * queue, and quarantining here could race the daemon's concurrent dequeue. The
 * dequeue path stays responsible for moving poison aside.
 *
 * @param queueDir - Override the queue directory (defaults to `getQueueDir()`).
 * @returns Array of `QueuedTask` sorted by sequence (FIFO); malformed entries omitted.
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

  const tasks: QueuedTask[] = [];
  for (const filename of sorted) {
    const filePath = join(queueDir, filename);
    try {
      tasks.push(JSON.parse(readFileSync(filePath, 'utf-8')) as QueuedTask);
    } catch (err) {
      const redactedFilename = redactInlineSecrets(filename);
      // Invariant: SyntaxError messages from JSON.parse embed a verbatim snippet of
      // the file content (≤20 chars, or the first ~10 chars for longer inputs). That
      // window is structurally too short for redactInlineSecrets's {16,}-value
      // patterns to match, so any short or truncated secret in the malformed bytes
      // would reach stderr unredacted. For SyntaxError we therefore use a
      // content-free label; only non-SyntaxError errors (filesystem errors from
      // readFileSync, etc.) carry paths — not file content — and are safe to redact
      // and log with their message.
      const reason =
        err instanceof SyntaxError
          ? 'SyntaxError: invalid JSON'
          : redactInlineSecrets(err instanceof Error ? err.message : String(err));
      // eslint-disable-next-line no-console
      console.error(
        `[daemon] pull-queue: skipping unreadable entry ${redactedFilename} in listPending (${reason})`,
      );
    }
  }
  return tasks;
}

/**
 * Remove a single pending task by id.
 *
 * Scans the queue directory for a JSON file whose body contains the given
 * `id`. The search is a linear scan — queue lengths are expected to be small
 * (single-operator CLI use) so this is fine. Skips directories and temp files
 * matching the same glob, mirroring `listPending`'s filter.
 *
 * @param queueDir - Override the queue directory (defaults to `getQueueDir()`).
 * @param id       - The task id to remove (e.g. `q-1716000000000-abc123`).
 * @returns `true` if a matching file was found and removed; `false` if no
 *          matching task was found (id unknown or already dequeued).
 * @throws If the matching file exists but cannot be unlinked (e.g. permission
 *         error). The caller is responsible for surfacing this to the user.
 */
export function removePending(queueDir: string = getQueueDir(), id: string): boolean {
  try {
    mkdirSync(queueDir, { recursive: true });
  } catch {
    return false;
  }

  const sorted = readdirSync(queueDir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.tmp-'))
    .sort();

  for (const filename of sorted) {
    const filePath = join(queueDir, filename);
    // Skip directories (e.g. `poison/` subdir) — only real files hold tasks.
    try {
      if (statSync(filePath).isDirectory()) continue;
    } catch {
      continue;
    }
    let task: QueuedTask;
    try {
      task = JSON.parse(readFileSync(filePath, 'utf-8')) as QueuedTask;
    } catch {
      // Malformed entry — cannot match by id, skip.
      continue;
    }
    if (task.id === id) {
      unlinkSync(filePath);
      return true;
    }
  }
  return false;
}

/**
 * Remove all pending tasks from the queue directory.
 *
 * Mirrors `listPending`'s filter (`.json`, not `.tmp-`, not directories) and
 * deletes every matching file. The `poison/` subdirectory is left intact.
 * Skips individual files that cannot be unlinked and logs each skip to stderr,
 * so a single permission error does not abort the whole clear.
 *
 * @param queueDir - Override the queue directory (defaults to `getQueueDir()`).
 * @returns The number of task files successfully removed.
 */
export function clearPending(queueDir: string = getQueueDir()): number {
  try {
    mkdirSync(queueDir, { recursive: true });
  } catch {
    return 0;
  }

  const sorted = readdirSync(queueDir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('.tmp-'))
    .sort();

  let removed = 0;
  for (const filename of sorted) {
    const filePath = join(queueDir, filename);
    // Skip directories (e.g. `poison/` subdir if it somehow has a .json suffix).
    try {
      if (statSync(filePath).isDirectory()) continue;
    } catch {
      continue;
    }
    try {
      unlinkSync(filePath);
      removed += 1;
    } catch (err) {
      const redactedFilename = redactInlineSecrets(filename);
      const reason = redactInlineSecrets(err instanceof Error ? err.message : String(err));
      // eslint-disable-next-line no-console
      console.error(
        `[daemon] pull-queue: failed to remove entry ${redactedFilename} in clearPending (${reason})`,
      );
    }
  }
  return removed;
}
