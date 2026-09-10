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

/** Lazy singleton — avoids opening the DB until first use. */
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
 * Pause the current goal. No-op if no goal exists or goal is already
 * paused/completed.
 */
export function pauseGoal(): Goal | null {
  const goal = getGoal();
  if (!goal || goal.status !== 'active') return goal;
  goal.status = 'paused';
  goal.updatedAt = new Date().toISOString();
  store().put(NAMESPACE, ACTIVE_KEY, goal);
  return goal;
}

/**
 * Resume a paused goal. No-op if no goal exists or goal is not paused.
 */
export function resumeGoal(): Goal | null {
  const goal = getGoal();
  if (!goal || goal.status !== 'paused') return goal;
  goal.status = 'active';
  goal.updatedAt = new Date().toISOString();
  store().put(NAMESPACE, ACTIVE_KEY, goal);
  return goal;
}

/**
 * Mark the current goal as completed.
 */
export function completeGoal(): Goal | null {
  const goal = getGoal();
  if (!goal) return null;
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
