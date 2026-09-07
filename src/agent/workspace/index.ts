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
  workspaceQueryTool,
  workspaceSubscribeTool,
  workspaceToolSchemas,
  createWorkspaceHandlers,
  WORKSPACE_TOOL_NAMES,
} from './workspace-tools.js';

export {
  WORKSPACE_DELIVERY_RING_CAPACITY,
  WORKSPACE_DELIVERY_MAX_BYTES,
} from './workspace-subscription-constants.js';

export type { WorkspaceSubscription } from './workspace-subscription.js';
export {
  notifySubscribers,
  formatWorkspaceDeliveryEnvelope,
  generateSubscriptionId,
} from './workspace-subscription.js';

export {
  renderWorkspacePreamble,
  injectWorkspacePreamble,
} from './workspace-preamble.js';
