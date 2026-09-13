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
 * @module agent/goals/goal-store
 */

import { StateStore } from '../state/state-store.js';
import { getStateDatabasePath } from '../../paths.js';

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
const ACTIVE_KEY = 'current';
/** Hard cap on goal text to prevent system-prompt inflation. */
export const MAX_GOAL_CHARS = 500;

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
 * Read the current goal (any status). Returns null when no goal is set.
 */
export function getGoal(): Goal | null {
  const row = store().get(NAMESPACE, ACTIVE_KEY);
  if (!row) return null;
  return row.value as Goal;
}

/**
 * Set a new active goal. Replaces any existing goal (active or paused).
 */
export function setGoal(text: string, sessionId?: string): Goal {
  if (text.length > MAX_GOAL_CHARS) {
    throw new Error(`Goal text exceeds the ${MAX_GOAL_CHARS}-character limit (got ${text.length}). Shorten it and try again.`);
  }
  const now = new Date().toISOString();
  const goal: Goal = {
    text,
    status: 'active',
    createdAt: now,
    updatedAt: now,
    ...(sessionId ? { createdBy: sessionId } : {}),
  };
  store().put(NAMESPACE, ACTIVE_KEY, goal);
  return goal;
}

/**
 * Pause the current goal. Returns the updated goal on actual transition
 * (active → paused), or null when no state change occurred (no goal, already
 * paused, or completed). Callers distinguish success from no-op by checking
 * for null rather than inspecting the returned status field.
 */
export function pauseGoal(): Goal | null {
  const goal = getGoal();
  if (!goal || goal.status !== 'active') return null;
  goal.status = 'paused';
  goal.updatedAt = new Date().toISOString();
  store().put(NAMESPACE, ACTIVE_KEY, goal);
  return goal;
}

/**
 * Resume a paused goal. Returns the updated goal on actual transition
 * (paused → active), or null when no state change occurred (no goal, already
 * active, or completed).
 */
export function resumeGoal(): Goal | null {
  const goal = getGoal();
  if (!goal || goal.status !== 'paused') return null;
  goal.status = 'active';
  goal.updatedAt = new Date().toISOString();
  store().put(NAMESPACE, ACTIVE_KEY, goal);
  return goal;
}

/**
 * Mark the current goal as completed. Only transitions from `active` — a
 * paused goal must be resumed first. Returns null when no goal exists, when
 * the goal is already completed, or when the goal is paused.
 */
export function completeGoal(): Goal | null {
  const goal = getGoal();
  if (!goal || goal.status !== 'active') return null;
  goal.status = 'completed';
  goal.updatedAt = new Date().toISOString();
  store().put(NAMESPACE, ACTIVE_KEY, goal);
  return goal;
}

/**
 * Remove the current goal entirely (any status).
 */
export function clearGoal(): boolean {
  return store().del(NAMESPACE, ACTIVE_KEY).deleted;
}
