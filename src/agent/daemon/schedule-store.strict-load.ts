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
 * Shared per-entry `_schemaVersion` guard used by both `loadSchedules` (read-
 * only) and `loadSchedulesForWrite` (read-modify-write).
 *
 * Iterates over `entries` and throws when any entry carries a `_schemaVersion`
 * field that exceeds `currentVersion`.  The `throwFn` callback lets callers
 * inject the appropriate error type (`SchedulesVersionError` for the read-only
 * path, `UnreadableSchedulesError` for the write path) without creating a
 * circular module dependency between the two files.
 *
 * @param storePath      - Path to schedules.json (for error messages).
 * @param entries        - Parsed array of schedule entries.
 * @param currentVersion - The schema version this build understands.
 * @param throwFn        - Called with (storePath, message, entryVersion) when
 *                         a future-schema entry is detected; must throw.
 */
export function checkEntrySchemaVersions(
  storePath: string,
  entries: unknown[],
  currentVersion: number,
  throwFn: (path: string, message: string, entryVersion: number) => never,
): void {
  for (const entry of entries) {
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const entryVersion = (entry as Record<string, unknown>)['_schemaVersion'];
      if (typeof entryVersion === 'number' && entryVersion > currentVersion) {
        throwFn(
          storePath,
          `[schedule-store] ${storePath} contains an entry with _schemaVersion ${entryVersion} ` +
            `but this build only understands schema version ${currentVersion}. ` +
            'Upgrade afk to load this file.',
          entryVersion,
        );
      }
    }
  }
}

/**
 * Load the schedule list for a read-modify-write. Returns [] only when the
 * file does not exist. Throws `UnreadableSchedulesError` when the file exists
 * but is not valid JSON, is not a JSON array, or contains an entry whose
 * `_schemaVersion` exceeds `currentSchemaVersion`. Read errors (EACCES,
 * EISDIR) propagate unchanged.
 *
 * The `currentSchemaVersion` parameter is injected by the caller
 * (`schedule-store.ts`) to avoid a circular module dependency: strict-load
 * cannot import `SCHEDULES_SCHEMA_VERSION` from schedule-store because
 * schedule-store already imports `loadSchedulesForWrite` from strict-load.
 */
export function loadSchedulesForWrite(
  storePath: string,
  currentSchemaVersion: number,
): ScheduledTaskConfig[] {
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
  checkEntrySchemaVersions(
    storePath,
    parsed,
    currentSchemaVersion,
    (path, _message, entryVersion) => {
      throw new UnreadableSchedulesError(
        path,
        `contains an entry with _schemaVersion ${entryVersion} but this build only understands schema version ${currentSchemaVersion}. Upgrade afk to load this file.`,
      );
    },
  );
  return parsed as ScheduledTaskConfig[];
}
