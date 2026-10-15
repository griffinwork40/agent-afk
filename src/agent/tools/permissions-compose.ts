import { withMcpToolsAllowed, withCustomToolsAllowed, type ToolPermissionConfig } from './permissions.js';
import { withOperatorDenied } from './operator-denied.js';
import { resolveSlotDeniedTools } from './operator-denied.slots.js';

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
 *   3. Apply operator denies (`tools.disabled`, already in `base.deniedTools`
 *      from the construction-time snapshot, plus the per-slot
 *      `tools.disabledBySlot` list for `slotModel`) LAST, so a re-union in
 *      steps 1-2 can never resurrect a tool the operator disabled.
 * `slotModel` is the session's active model input (alias or raw id). Absent,
 * or not a configured slot with a list => no extra denies (pre-feature path).
 * One implementation for both providers keeps the two from drifting.
 */
export function composeDispatcherPermissions(
  base: ToolPermissionConfig | undefined,
  mcpWireNames: readonly string[] | undefined,
  customToolNames: readonly string[],
  slotModel?: unknown,
): ToolPermissionConfig | undefined {
  const withMcp = mcpWireNames ? withMcpToolsAllowed(base, mcpWireNames) : base;
  const withCustom = withCustomToolsAllowed(withMcp, customToolNames);
  const slotDenied = resolveSlotDeniedTools(slotModel, customToolNames);
  return withOperatorDenied(withCustom, [...(withCustom?.deniedTools ?? []), ...slotDenied]);
}
