/**
 * System-prompt fragment for active goals.
 *
 * Reads the current goal from the durable store and formats it for injection
 * into the system prompt. The fragment sits between hot memory and the
 * `# Environment` block so the model sees the active objective before each
 * turn — surviving compaction, session restarts, and terminal disconnects.
 *
 * @module agent/goals/goal-prompt
 */

import { getGoal } from './goal-store.js';

/**
 * Build the goal-injection fragment. Returns an empty string when no active
 * goal exists (paused and completed goals are not injected).
 */
export function buildGoalPromptFragment(): string {
  const goal = getGoal();
  if (!goal || goal.status !== 'active') return '';
  return [
    '<active-goal>',
    goal.text,
    `(set: ${goal.createdAt})`,
    '</active-goal>',
  ].join('\n');
}
