/**
 * Shared agent workspace — per-session SQLite-backed scratchpad for sibling
 * sub-agents to exchange structured findings.
 *
 * @module agent/workspace
 */


export {
  WorkspaceStore,
} from './workspace-store.js';
export type {
  WorkspaceEntryType,
  WorkspaceEntry,
  WorkspacePublishInput,
  WorkspaceRelationType,
} from './workspace-store.js';

export {
  workspacePublishTool,
  workspaceToolSchemas,
  createWorkspaceHandlers,
} from './workspace-tools.js';

export {
  renderWorkspacePreamble,
  injectWorkspacePreamble,
} from './workspace-preamble.js';
