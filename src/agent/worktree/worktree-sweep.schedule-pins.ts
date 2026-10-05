/**
 * Schedule-pins guard for the worktree sweep engine.
 *
 * Reads the scheduled-task store and returns the set of worktree paths that
 * are pinned by a scheduled task's `cwd` field.  A task's cwd pins a worktree
 * when the task cwd is the same path as, or is nested inside, the worktree --
 * matching the same `isPathWithin` semantics already used for live-session
 * presence.
 *
 * Disabled tasks are included deliberately: a disabled schedule may be
 * re-enabled at any time and its cwd must survive the sweep interval.
 *
 * Contract: this module must never throw.  On any read / parse error it
 * returns an empty pin set and appends a diagnostic note to `warnings`.
 *
 * @module agent/worktree/worktree-sweep.schedule-pins
 */

import { promises as fs } from 'node:fs';
import { getSchedulesPath } from '../../paths.js';
import type { ScheduledTaskConfig } from '../daemon/schedule-store.js';
import { isPathWithin } from './worktree-sweep.classify.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SchedulePinResult {
  /**
   * Map from worktree-path -> first task id that pins it.
   * Only worktree paths that are pinned appear in this map.
   */
  pinnedByTask: Map<string, string>;
  /**
   * Diagnostic messages to append to SweepResult.warnings.
   * Non-empty when the schedules file was missing (info) or unparseable (warn).
   */
  notes: string[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Load raw task configs from the schedules store.
 * Returns `null` when the file is missing, `undefined` on any other error.
 * The distinction lets callers emit different diagnostic levels.
 */
async function loadRawSchedules(
  schedulesPath: string,
): Promise<ScheduledTaskConfig[] | null | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(schedulesPath, 'utf-8');
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    // ENOENT = file simply does not exist yet; not an error condition.
    if (code === 'ENOENT') return null;
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    // A non-array document is treated like any other invalid file: degrade,
    // never throw (iterating a plain object would throw a TypeError).
    return Array.isArray(parsed) ? (parsed as ScheduledTaskConfig[]) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Given the list of registered worktree paths (from `git worktree list`),
 * return a map of which paths are pinned by a scheduled task cwd, plus any
 * diagnostic notes.
 *
 * @param worktreePaths - Absolute paths of all registered worktrees to check.
 * @param schedulesPathOverride - Override the schedules file path (for tests).
 */
export async function resolveSchedulePins(
  worktreePaths: readonly string[],
  schedulesPathOverride?: string,
): Promise<SchedulePinResult> {
  const schedulesPath = schedulesPathOverride ?? getSchedulesPath();
  const notes: string[] = [];
  const pinnedByTask = new Map<string, string>();

  if (worktreePaths.length === 0) return { pinnedByTask, notes };

  const tasks = await loadRawSchedules(schedulesPath);

  if (tasks === null) {
    // File simply absent — normal on a fresh install.
    notes.push(`[INFO] schedules file not found (${schedulesPath}); no schedule pins applied`);
    return { pinnedByTask, notes };
  }
  if (tasks === undefined) {
    // Read or parse error — degrade gracefully.
    notes.push(
      `[WARN] schedules file unreadable or invalid JSON (${schedulesPath}); no schedule pins applied`,
    );
    return { pinnedByTask, notes };
  }

  // For each task that has a cwd, check whether any registered worktree path
  // is on the containment path.  `isPathWithin(taskCwd, worktreePath)` is true
  // when taskCwd is the worktreePath itself or is inside it -- meaning the task
  // would be running from within that worktree.
  for (const task of tasks) {
    if (typeof task.cwd !== 'string' || task.cwd.length === 0) continue;
    for (const wt of worktreePaths) {
      if (!pinnedByTask.has(wt) && isPathWithin(task.cwd, wt)) {
        pinnedByTask.set(wt, task.id);
      }
    }
  }

  return { pinnedByTask, notes };
}

/**
 * Sweep-side wrapper: resolve pins for every non-main, non-bare registered
 * worktree and append any diagnostic notes to `warnings`. Never throws.
 */
export async function loadSchedulePinsForSweep(
  entries: ReadonlyArray<{ path: string; isBare?: boolean }>,
  warnings: string[],
  schedulesPathOverride?: string,
): Promise<SchedulePinResult> {
  const mainPath = entries[0]?.path;
  const paths = entries.filter((e) => !e.isBare && e.path !== mainPath).map((e) => e.path);
  const pins = await resolveSchedulePins(paths, schedulesPathOverride);
  for (const note of pins.notes) warnings.push(note);
  return pins;
}

/**
 * Apply the schedule pin to a classifier verdict: a pinned worktree that would
 * otherwise be a removal candidate is reported as 'active' with an INFO note.
 * 'active' and 'locked' verdicts are already safe and pass through unchanged.
 */
export function applySchedulePin<V extends string>(
  verdict: V,
  worktreePath: string,
  pins: SchedulePinResult,
  warnings: string[],
): V | 'active' {
  const taskId = pins.pinnedByTask.get(worktreePath);
  if (taskId === undefined || verdict === 'active' || verdict === 'locked') return verdict;
  warnings.push(
    `[INFO] worktree schedule-pinned by task '${taskId}' (will not be reaped): ${worktreePath}`,
  );
  return 'active';
}
