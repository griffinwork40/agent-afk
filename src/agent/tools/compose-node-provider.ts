/**
 * Build the provider for a compose DAG node.
 *
 * Extracted from `compose-executor.ts` to stay under the 350-LOC ceiling.
 * The function is a thin dispatch to {@link buildComposeNodeProvider} —
 * factored out so the executor's node-builder loop stays focused on schema
 * and security-boundary logic.
 */

import type { ModelProvider } from '../provider.js';
import type { WorkspaceStore } from '../workspace/workspace-store.js';
import type { CanUseTool } from '../types.js';
import { buildComposeNodeProvider } from './nesting.js';
import type { AgentModelInput } from '../types/model-types.js';

/** Named-agent restrictions resolved for one node (compose-agent-resolve.ts). */
export interface ComposeNodeRestrictions {
  canUseTool?: CanUseTool;
  readOnlyBash?: boolean;
}

/**
 * When the parent session has a `WorkspaceStore`, build a purpose-specific
 * provider that carries the store so the DAG node can call
 * `workspace_publish` / `workspace_query`. Without it, the node's
 * `AgentSession` falls back to bare `resolveProvider` which never carries
 * `workspaceStore`, silently stripping both workspace tools from the API
 * schema.
 *
 * Invariant (named-agent enforcement): the node's `canUseTool` allowlist and
 * `readOnlyBash` gate are threaded into the provider CONSTRUCTOR — the only
 * place either provider reads them once `config.provider` is preset. On the
 * AFK_WORKSPACE_DISABLED fallback (no store) a restricted node still gets a
 * constructed provider, because the bare `resolveProvider` fallback honors
 * `config.canUseTool` but not `readOnlyBash`. Unrestricted nodes without a
 * store keep the legacy no-provider path unchanged.
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
  restrictions: ComposeNodeRestrictions = {},
): { provider: ModelProvider } | Record<string, never> {
  const { canUseTool, readOnlyBash } = restrictions;
  const restricted = canUseTool !== undefined || readOnlyBash === true;
  if (workspaceStore === undefined && !restricted) return {};
  return {
    provider: buildComposeNodeProvider(nodeModel, workspaceStore, openaiBaseUrl, readOnlyBash, canUseTool),
  };
}
