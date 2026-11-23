export { getGoal, setGoal, pauseGoal, resumeGoal, completeGoal, clearGoal } from './goal-store.js';
export type { Goal, GoalStatus } from './goal-store.js';
export { buildGoalPromptFragment } from './goal-prompt.js';
export { injectGoalPrompt } from './inject.js';
export { projectKeyForCwd, FALLBACK_KEY } from './goal-utils.js';
export {
  parseChecksEnv,
  runGoalQualityGates,
  MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  CHECKS_SEPARATOR,
} from './goal-quality-gate.js';
export type {
  GateStatus,
  GateResult,
  GateReport,
  SpawnResult,
  SpawnFn,
  RunGatesOptions,
} from './goal-quality-gate.js';
