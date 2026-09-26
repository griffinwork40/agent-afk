export { MemoryStore, estimateTokens } from './memory-store.js';
export { loadHotMemory, injectHotMemory } from './memory-loader.js';
export { injectGoalPrompt } from '../goals/inject.js';
export { createMemorySessionEndHook, createChildMemoryHotBlockHook } from './memory-hooks.js';
export { guardChildHotWrites, CHILD_HOT_WRITE_DENIED } from './memory-hot-guard.js';
export {
  memorySearchTool,
  memoryUpdateTool,
  procedureWriteTool,
  memoryToolSchemas,
  MEMORY_TOOL_NAMES,
  createMemoryHandlers,
} from './memory-tools.js';
export type {
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
