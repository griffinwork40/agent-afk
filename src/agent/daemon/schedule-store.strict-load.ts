/**
 * Strict schedule loader for read-modify-write paths.
 *
 * `loadSchedules` is deliberately lenient for read-only callers: invalid JSON
 * logs and returns [], and the parsed value is cast without validation. That
 * is safe for display and daemon boot, but fatal for a read-modify-write:
 * `addSchedule` would push onto the empty fallback and `saveSchedules` would
 * replace a hand-edited file containing one typo with only the new task,
 * deleting every existing schedule.
 *
 * Invariant: every function that loads, mutates, then saves the store MUST
 * load through `loadSchedulesForWrite`, so an unreadable file aborts the
 * mutation before anything is written. The file is left byte-for-byte intact
 * for the operator to repair; no backup copy is needed because nothing is
 * overwritten.
 *
 * @module agent/daemon/schedule-store.strict-load
 */

import { existsSync, readFileSync } from 'node:fs';
import { errorMessage } from '../../utils/errors.js';
import type { ScheduledTaskConfig } from './schedule-store.js';

/** Thrown when schedules.json exists but cannot safely be rewritten. */
export class UnreadableSchedulesError extends Error {
  readonly path: string;

  constructor(path: string, problem: string) {
    super(
      `[schedule-store] refusing to modify ${path}: ${problem}. ` +
        'No changes were written. Repair the file so it is a JSON array of schedules, ' +
        'or move it aside to start with an empty schedule list, then retry.',
    );
    this.name = 'UnreadableSchedulesError';
    this.path = path;
  }
}

/**
 * Load the schedule list for a read-modify-write. Returns [] only when the
 * file does not exist. Throws `UnreadableSchedulesError` when the file exists
 * but is not valid JSON or is not a JSON array. Read errors (EACCES, EISDIR)
 * propagate unchanged.
 */
export function loadSchedulesForWrite(storePath: string): ScheduledTaskConfig[] {
  if (!existsSync(storePath)) return [];
  const raw = readFileSync(storePath, 'utf-8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new UnreadableSchedulesError(storePath, `file is not valid JSON (${errorMessage(err)})`);
  }
  if (!Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : typeof parsed;
    throw new UnreadableSchedulesError(storePath, `file is not a JSON array (found ${kind})`);
  }
  return parsed as ScheduledTaskConfig[];
}
