/**
 * Build a workspace-enabled provider for a compose DAG node.
 *
 * Extracted from `compose-executor.ts` to stay under the 350-LOC ceiling.
 * The function is a thin dispatch to {@link buildComposeNodeProvider} —
 * factored out so the executor's node-builder loop stays focused on schema
 * and security-boundary logic.
 */

import type { ModelProvider } from '../provider.js';
import type { WorkspaceStore } from '../workspace/workspace-store.js';
import { buildComposeNodeProvider } from './nesting.js';
import type { AgentModelInput } from '../types/model-types.js';

/**
 * When the parent session has a `WorkspaceStore`, build a purpose-specific
 * provider that carries the store so the DAG node can call
 * `workspace_publish` / `workspace_query`. Without it, the node's
 * `AgentSession` falls back to bare `resolveProvider` which never carries
 * `workspaceStore`, silently stripping both workspace tools from the API
 * schema.
 *
 * Safety: `buildComposeNodeProvider` deliberately omits `subagentExecutor`
 * and `skillExecutor`, preserving the invariant that compose nodes cannot
 * spawn nested DAGs or invoke skills. `childProviderFactory` must NOT be
 * used here — it bundles both executors.
 */
export function resolveComposeNodeProvider(
  nodeModel: AgentModelInput,
  workspaceStore: WorkspaceStore | undefined,
  openaiBaseUrl: string | undefined,
): { provider: ModelProvider } | Record<string, never> {
  if (workspaceStore === undefined) return {};
  return { provider: buildComposeNodeProvider(nodeModel, workspaceStore, openaiBaseUrl) };
}
