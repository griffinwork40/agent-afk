export { MemoryStore, estimateTokens } from './memory-store.js';
export { loadHotMemory, injectHotMemory } from './memory-loader.js';
export { injectGoalPrompt } from '../goals/inject.js';
export { createMemorySessionEndHook, createChildMemoryHotBlockHook } from './memory-hooks.js';
// isForkedChildSession is @internal — package-private, not public API.
export { guardChildHotWrites, isForkedChildSession, CHILD_HOT_WRITE_DENIED, type ForkSignals } from './memory-hot-guard.js';
export {
  memorySearchTool,
  memoryUpdateTool,
  procedureWriteTool,
  memoryToolSchemas,
  MEMORY_TOOL_NAMES,
  createMemoryHandlers,
} from './memory-tools.js';
export type {
  AccessStats,
  Fact,
  NewFact,
  FactCategory,
  SessionRecord,
  NewSession,
  SessionOutcome,
  Procedure,
  SearchOpts,
  MemorySearchResult,
  MemoryUpdateAction,
  MemoryUpdateTarget,
  WALEntry,
} from './types.js';
