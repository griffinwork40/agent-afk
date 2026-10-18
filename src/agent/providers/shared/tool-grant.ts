/**
 * Provider-side tool-grant answers (#4060).
 *
 * A provider's tool surface is decided in two places: the permission gate
 * (`checkToolPermission` over the provider's snapshotted `ToolPermissionConfig`)
 * and registration (store-backed tools such as `workspace_publish` exist only
 * when the provider holds a `WorkspaceStore`). Prompt text that tells a model
 * to call a tool must agree with both, or the model calls a tool it does not
 * have. These helpers give prompt assemblers ONE answer derived from the same
 * two inputs the dispatcher uses, so the text cannot drift from the grant.
 *
 * @module agent/providers/shared/tool-grant
 */

import { checkToolPermission, type ToolPermissionConfig } from '../../tools/permissions.js';
import { WORKSPACE_CHILD_TOOL_NAMES } from '../../workspace/index.js';

/** Tools whose handlers are registered only when a workspace store is present. */
const STORE_BACKED_TOOLS: ReadonlySet<string> = new Set<string>(WORKSPACE_CHILD_TOOL_NAMES);

/**
 * Whether a provider with these permissions and store presence would let a
 * call to `toolName` through.
 *
 * Contract: `false` means the call is certain to be refused (blocked by the
 * permission gate, or a store-backed tool with no store to back it). `true`
 * means the permission gate admits it; it does not prove a handler exists
 * for tools outside the store-backed set (executor tools, MCP, custom tools).
 */
export function providerGrantsTool(
  toolName: string,
  permissions: ToolPermissionConfig | undefined,
  hasWorkspaceStore: boolean,
): boolean {
  if (STORE_BACKED_TOOLS.has(toolName) && !hasWorkspaceStore) return false;
  return checkToolPermission(toolName, permissions).allowed;
}

/**
 * Whether the `# Shared Workspace` system-prompt section may be included.
 * That section instructs the model to call BOTH `workspace_publish` and
 * `workspace_query`, so it is included only when both are granted.
 */
export function grantsWorkspacePrompt(grantsTool: (toolName: string) => boolean): boolean {
  return grantsTool('workspace_publish') && grantsTool('workspace_query');
}
