/**
 * Persistent goal store — cross-session objective tracking.
 *
 * Goals are durable JSON documents in the shared StateStore under namespace
 * `"goals"`. Each goal has a status lifecycle: active → paused | completed.
 * Only one goal can be active at a time (enforced at the store layer).
 *
 * Persistence: goals survive across sessions, compaction, and terminal
 * disconnects — they live in `~/.afk/state/kv/kv.db`, not in the context
 * window.
 *
 * Per-project scoping
 * -------------------
 * Goals are now scoped per git repository. The `projectKey` parameter accepted
 * by each exported function determines which StateStore key is used:
 *
 * - Pass a pre-derived key (e.g. from `projectKeyForCwd()`) to use the
 *   project-scoped goal for that repository.
 * - Omit it (or pass `undefined`) to fall back to `'current'` — the original
 *   global key preserved for backward compatibility.
 *
 * Callers that know their working directory (CLI handlers, session injectors)
 * should derive the key via `projectKeyForCwd(cwd)` and pass it here.
 *
 * @module agent/goals/goal-store
 */

import { StateStore } from '../state/state-store.js';
import { getStateDatabasePath } from '../../paths.js';
import { FALLBACK_KEY } from './goal-utils.js';

export type GoalStatus = 'active' | 'paused' | 'completed';

export interface Goal {
  /** Human-readable objective text. */
  text: string;
  status: GoalStatus;
  /** ISO timestamp when the goal was created. */
  createdAt: string;
  /** ISO timestamp of last status change. */
  updatedAt: string;
  /** Session ID that created this goal (informational). */
  createdBy?: string;
}

const NAMESPACE = 'goals';
/** Hard cap on goal text to prevent system-prompt inflation. */
export const MAX_GOAL_CHARS = 500;
/** Key prefix for the single-slot archive of the displaced goal. */
const PREV_PREFIX = 'prev.';

// Invariant: _store is a process-global singleton shared across all concurrent
// sessions in this process (REPL, Telegram, daemon). This is intentional —
// goals are cross-session state persisted in kv.db, visible to every surface.
// A session calling setGoal mutates what all sibling sessions observe at the
// store layer; already-constructed sessions see the change only on next start
// (goalPrompt is baked at construction time — see inject.ts).
let _store: StateStore | undefined;
function store(): StateStore {
  _store ??= new StateStore(getStateDatabasePath());
  return _store;
}

/**
 * Close the underlying SQLite connection and reset the module-scope singleton.
 * Required for test teardown on Windows where SQLite file handles prevent
 * directory deletion until the connection is explicitly closed.
 */
export function closeStore(): void {
  _store?.close();
  _store = undefined;
}

/**
 * Read the current goal (any status). Returns null when no goal is set.
 *
 * @param projectKey - StateStore key for the project goal. Defaults to
 *   `'current'` (global fallback). Derive via `projectKeyForCwd()`.
 */
export function getGoal(projectKey?: string): Goal | null {
  const key = projectKey ?? FALLBACK_KEY;
  const row = store().get(NAMESPACE, key);
  if (!row) return null;
  return row.value as Goal;
}

/**
 * Archive the current goal (if any) to the single-slot `prev.<key>` position
 * before a destructive mutation. Called internally by setGoal and clearGoal.
 */
function archivePrev(key: string): void {
  const row = store().get(NAMESPACE, key);
  if (!row) return;
  store().put(NAMESPACE, `${PREV_PREFIX}${key}`, row.value);
}

/**
 * Read the most recently displaced goal. Returns null when no archive exists.
 *
 * @param projectKey - StateStore key for the project goal. Defaults to
 *   `'current'` (global fallback). Derive via `projectKeyForCwd()`.
 */
export function getArchivedGoal(projectKey?: string): Goal | null {
  const key = projectKey ?? FALLBACK_KEY;
  const row = store().get(NAMESPACE, `${PREV_PREFIX}${key}`);
  if (!row) return null;
  return row.value as Goal;
}

/**
 * Restore the most recently displaced goal, replacing the current one.
 * Deletes the archive slot after restoring. Returns the restored goal,
 * or null when no archive exists.
 *
 * @param projectKey - StateStore key for the project goal. Defaults to
 *   `'current'` (global fallback). Derive via `projectKeyForCwd()`.
 */
export function restoreGoal(projectKey?: string): Goal | null {
  const key = projectKey ?? FALLBACK_KEY;
  const prevKey = `${PREV_PREFIX}${key}`;
  const row = store().get(NAMESPACE, prevKey);
  if (!row) return null;
  const archived = row.value as Goal;
  store().put(NAMESPACE, key, archived);
  store().del(NAMESPACE, prevKey);
  return archived;
}

/**
 * Set a new active goal. Replaces any existing goal (active or paused).
 * When replacing, the displaced goal is archived for one-level undo.
 *
 * @param projectKey - StateStore key for the project goal. Defaults to
 *   `'current'` (global fallback). Derive via `projectKeyForCwd()`.
 */
export function setGoal(text: string, sessionId?: string, projectKey?: string): Goal {
  if (text.length > MAX_GOAL_CHARS) {
    throw new Error(`Goal text exceeds the ${MAX_GOAL_CHARS}-character limit (got ${text.length}). Shorten it and try again.`);
  }
  const key = projectKey ?? FALLBACK_KEY;
  archivePrev(key);
  const now = new Date().toISOString();
  const goal: Goal = {
    text,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...(sessionId ? { createdBy: sessionId } : {}),
  };
  store().put(NAMESPACE, key, goal);
  return goal;
}

/**
 * Pause the current goal. Returns the updated goal on actual transition
 * (active → paused), or null when no state change occurred (no goal, already
 * paused, or completed). Callers distinguish success from no-op by checking
 * for null rather than inspecting the returned status field.
 *
 * @param projectKey - StateStore key for the project goal. Defaults to
 *   `'current'` (global fallback). Derive via `projectKeyForCwd()`.
 */
export function pauseGoal(projectKey?: string): Goal | null {
  const goal = getGoal(projectKey);
  if (!goal || goal.status !== 'active') return null;
  const key = projectKey ?? FALLBACK_KEY;
  goal.status = 'paused';
  goal.updatedAt = new Date().toISOString();
  store().put(NAMESPACE, key, goal);
  return goal;
}

/**
 * Resume a paused goal. Returns the updated goal on actual transition
 * (paused → active), or null when no state change occurred (no goal, already
 * active, or completed).
 *
 * @param projectKey - StateStore key for the project goal. Defaults to
 *   `'current'` (global fallback). Derive via `projectKeyForCwd()`.
 */
export function resumeGoal(projectKey?: string): Goal | null {
  const goal = getGoal(projectKey);
  if (!goal || goal.status !== 'paused') return null;
  const key = projectKey ?? FALLBACK_KEY;
  goal.status = 'active';
  goal.updatedAt = new Date().toISOString();
  store().put(NAMESPACE, key, goal);
  return goal;
}

/**
 * Mark the current goal as completed. Only transitions from `active` — a
 * paused goal must be resumed first. Returns null when no goal exists, when
 * the goal is already completed, or when the goal is paused.
 *
 * @param projectKey - StateStore key for the project goal. Defaults to
 *   `'current'` (global fallback). Derive via `projectKeyForCwd()`.
 */
export function completeGoal(projectKey?: string): Goal | null {
  const goal = getGoal(projectKey);
  if (!goal || goal.status !== 'active') return null;
  const key = projectKey ?? FALLBACK_KEY;
  goal.status = 'completed';
  goal.updatedAt = new Date().toISOString();
  store().put(NAMESPACE, key, goal);
  return goal;
}

/**
 * Remove the current goal entirely (any status).
 * The displaced goal is archived for one-level undo.
 *
 * @param projectKey - StateStore key for the project goal. Defaults to
 *   `'current'` (global fallback). Derive via `projectKeyForCwd()`.
 */
export function clearGoal(projectKey?: string): boolean {
  const key = projectKey ?? FALLBACK_KEY;
  archivePrev(key);
  return store().del(NAMESPACE, key).deleted;
}
