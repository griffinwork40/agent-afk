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
  // Strip any injected tag wrappers before interpolation, mirroring the
  // hot-memory sanitize in memory-loader.ts — prevents prompt injection
  // via a crafted goal text that embeds </active-goal> to escape the block.
  const sanitized = goal.text.replace(/<\/?active-goal\b[^>]*>/gi, '');
  return [
    '<active-goal>',
    sanitized,
    `(set: ${goal.createdAt})`,
    '</active-goal>',
  ].join('\n');
}
