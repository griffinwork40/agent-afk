export { getGoal, setGoal, pauseGoal, resumeGoal, completeGoal, clearGoal, getArchivedGoal, restoreGoal } from './goal-store.js';
export type { Goal, GoalStatus } from './goal-store.js';
export { buildGoalPromptFragment } from './goal-prompt.js';
export { injectGoalPrompt } from './inject.js';
export { projectKeyForCwd, FALLBACK_KEY } from './goal-utils.js';
