/**
 * Shared agent workspace — per-session SQLite-backed scratchpad for sibling
 * sub-agents to exchange structured findings.
 *
 * @module agent/workspace
 */

// Integration plan (wired in a follow-up commit):
// 1. provider-options.ts: add `workspaceStore?: WorkspaceStore` to AnthropicDirectProviderOptions
// 2. provider-runtime.ts: instantiate WorkspaceStore in constructor (opts.workspaceStore ?? new WorkspaceStore())
// 3. build-dispatcher.ts: add workspaceStore to BuildDispatcherDeps, register workspace handlers
//    via createWorkspaceHandlers(deps.workspaceStore, opts.sessionId ?? '', deps.agentId)
// 4. openai-compatible/index.ts: same as above for the OpenAI provider
// 5. nesting.ts: add 'workspace_publish' to CHILD_ALLOWED_TOOLS
// 6. fork-child-config.ts: call injectWorkspacePreamble after injectToolBudgetPreamble,
//    passing entries from workspaceStore.queryRelevant(sessionId, taskPrompt)
// 7. schemas.ts: add workspaceToolSchemas to ALL_TOOL_SCHEMAS

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
