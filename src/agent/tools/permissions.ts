/**
 * Tool permission gate.
 *
 * Allowlist-based permission checking for the session-level tool system.
 * Read-only tools are auto-allowed by default; write tools (bash, write_file,
 * edit_file) require explicit configuration.
 *
 * @module agent/tools/permissions
 */

export interface ToolPermissionConfig {
  allowedTools?: string[];
}

export interface PermissionCheckResult {
  allowed: boolean;
  reason?: string;
}

export function checkToolPermission(
  toolName: string,
  config?: ToolPermissionConfig,
): PermissionCheckResult {
  if (!config?.allowedTools) {
    return { allowed: true };
  }

  const allowed = config.allowedTools.includes(toolName);
  if (!allowed) {
    return {
      allowed: false,
      reason: `Tool "${toolName}" is not in the configured allowlist`,
    };
  }
  return { allowed: true };
}

/**
 * Union live MCP tool wire-names into a base permission allowlist.
 *
 * Invariant: the base allowlist is snapshotted ONCE at provider construction
 * (see `cli/shared-helpers.ts:allowedToolsFor`). OAuth-backed MCP servers
 * discover their tools asynchronously — the handshake completes AFTER that
 * snapshot — so freshly-bridged tools land in the dispatcher's `schemas` and
 * `handlers` (read live each query) but are absent from the frozen allowlist.
 * The permission gate then rejects them with "not in the configured allowlist"
 * even though the model can see them. Re-unioning the live wire-names at
 * dispatcher-build time (every query) keeps the gate in lockstep with the
 * registry without mutating the shared base config.
 *
 * Only the top-level provider receives an `mcpManager`; restricted sub-agent
 * providers (recon / read-only / skill-scoped, built in `tools/nesting.ts`) do
 * not, so this never widens a sub-agent's allowlist — no privilege escalation.
 *
 * Returns `base` unchanged (same reference) when there is no allowlist
 * (`undefined` → all tools allowed), when `mcpToolWireNames` is empty, or when
 * every wire-name is already present — avoiding needless allocation per query.
 * Otherwise returns a NEW config; `base.allowedTools` is never mutated.
 */
export function withMcpToolsAllowed(
  base: ToolPermissionConfig | undefined,
  mcpToolWireNames: readonly string[],
): ToolPermissionConfig | undefined {
  return unionAllowedTools(base, mcpToolWireNames);
}

/**
 * Union consumer-registered custom-tool names into a base permission allowlist.
 *
 * Mirrors {@link withMcpToolsAllowed}: a custom tool the consumer registered via
 * `tool()` + `AgentConfig.customTools` is allowed by the gate when an allowlist
 * is configured, because registering it IS the grant. Without this, a consumer
 * who sets `allowedTools` sees their custom tool denied ("not in the configured
 * allowlist") even though the model can see it. No-op when there is no allowlist
 * (`undefined` → all tools allowed) or `customToolNames` is empty.
 *
 * Only the top-level provider in the library `query()` path carries
 * `customTools`; restricted sub-agent providers (built in `tools/nesting.ts`)
 * receive none, so this never widens a sub-agent's allowlist — no privilege
 * escalation (same containment as the MCP union).
 */
export function withCustomToolsAllowed(
  base: ToolPermissionConfig | undefined,
  customToolNames: readonly string[],
): ToolPermissionConfig | undefined {
  return unionAllowedTools(base, customToolNames);
}

/**
 * Shared allowlist-union impl behind {@link withMcpToolsAllowed} and
 * {@link withCustomToolsAllowed}. Returns `base` unchanged (same reference)
 * when there is no allowlist (`undefined` → all tools allowed), when `names`
 * is empty, or when every name is already present — avoiding needless
 * allocation per query. Otherwise returns a NEW config; `base.allowedTools`
 * is never mutated.
 */
function unionAllowedTools(
  base: ToolPermissionConfig | undefined,
  names: readonly string[],
): ToolPermissionConfig | undefined {
  if (!base?.allowedTools || names.length === 0) return base;
  const merged = new Set(base.allowedTools);
  let changed = false;
  for (const name of names) {
    if (!merged.has(name)) {
      merged.add(name);
      changed = true;
    }
  }
  return changed ? { ...base, allowedTools: [...merged] } : base;
}
