/**
 * Agent situational-awareness barrel.
 *
 * Phase 1: read-only runtime snapshot (get_runtime_state tool with self/tools/subagents/all views).
 * Phase 2: workspace baseline (workspace view), presence files (session lifecycle registry).
 *
 * @module agent/awareness
 */

export type {
  Surface,
  PhaseRole,
  SubagentStatusLite,
  SubagentStatusLiteValue,
  BgJobLite,
  BgJobStatus,
  McpServerSummary,
  RuntimeSelf,
  RuntimeTools,
  RuntimeSubagents,
  RuntimeWorkspace,
  RuntimeSnapshot,
  RuntimeView,
  RuntimeStateSource,
} from './types.js';

export {
  buildRuntimeSnapshot,
  parseView,
  formatEnvironmentFragment,
} from './runtime-snapshot.js';

export {
  buildRuntimeStateSource,
  type RuntimeSourceDeps,
} from './runtime-source.js';

export {
  getRuntimeStateTool,
  AWARENESS_TOOL_NAMES,
  createGetRuntimeStateHandler,
  wrapDispatcherWithRuntimeState,
} from './tool.js';

export { gatherWorkspace } from './workspace-source.js';

export {
  writePresenceFile,
  removePresenceFile,
  removePresenceFileSync,
  readPresenceFiles,
  type PresenceFileInfo,
  type PresenceRecord,
} from './presence.js';
