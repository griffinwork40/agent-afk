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
  // Strip ALL XML-like tags from goal text — not just <active-goal>.
  // A crafted goal containing <cross-session-memory>, <thinking>, or other
  // agent-structural tags would be interpolated verbatim into the system
  // prompt. Stripping all tags neutralizes the class of injection.
  const sanitized = goal.text.replace(/<\/?[a-z_][\w-]*(\s[^>]*)?\/?>/gi, '');
  // Sanitize createdAt: the value is always a valid ISO timestamp when
  // written by setGoal(), but is read from SQLite via an unchecked cast.
  // Strip newlines and angle brackets to prevent prompt-block escape.
  const safeTs = goal.createdAt.replace(/[\r\n<>]/g, '');
  return [
    '<active-goal>',
    sanitized,
    `(set: ${safeTs})`,
    '</active-goal>',
  ].join('\n');
}
