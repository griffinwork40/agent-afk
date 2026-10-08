import { withMcpToolsAllowed, withCustomToolsAllowed, type ToolPermissionConfig } from './permissions.js';
import { withOperatorDenied } from './operator-denied.js';

/**
 * Per-query permission composition shared by BOTH providers' dispatcher
 * builders (anthropic-direct/build-dispatcher.ts, openai-compatible/index.ts).
 *
 * Invariant: order is load-bearing.
 *   1. Union live MCP wire-names into the (statically snapshotted) allowlist.
 *   2. Union consumer-registered custom-tool names. Registering a custom tool
 *      or connecting an MCP server is the grant; restricted sub-agents carry
 *      no customTools, so this never widens their allowlist. Both unions are
 *      no-ops when there is no allowlist (undefined => all allowed).
 *   3. Apply operator denies (`tools.disabled`) LAST, so a re-union in steps
 *      1-2 can never resurrect a tool the operator disabled.
 * One implementation for both providers keeps the two from drifting.
 */
export function composeDispatcherPermissions(
  base: ToolPermissionConfig | undefined,
  mcpWireNames: readonly string[] | undefined,
  customToolNames: readonly string[],
): ToolPermissionConfig | undefined {
  const withMcp = mcpWireNames ? withMcpToolsAllowed(base, mcpWireNames) : base;
  const withCustom = withCustomToolsAllowed(withMcp, customToolNames);
  return withOperatorDenied(withCustom, withCustom?.deniedTools ?? []);
}
